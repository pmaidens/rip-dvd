import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

const executable = "/usr/local/bin/rip-dvd-dvdcss-reader";
const testExecutable = "/tmp/rip-dvd-dvdcss-reader-test";
const sourcePath = "/tmp/rip-dvd-reader-source.img";
const replacementSourcePath = "/tmp/rip-dvd-reader-replacement-source.img";
const recoveryResultPrefix = "rip-dvd-recovery-result ";
const readFailureResultPrefix = "rip-dvd-read-failure ";
const scsiSessionResultPrefix = "rip-dvd-scsi-session-result ";
const scsiExitResultPrefix = "rip-dvd-scsi-exit-result ";
const content = Buffer.alloc(40 * 2_048);
for (let index = 0; index < content.length; index += 1) {
  content[index] = index % 251;
}
writeFileSync(sourcePath, content);
writeFileSync(replacementSourcePath, Buffer.alloc(content.byteLength, 173));

function fixedSense(lba, senseKey, asc, ascq = 0) {
  const sense = Buffer.alloc(18);
  sense[0] = 0xf0;
  sense[2] = senseKey;
  sense.writeUInt32BE(lba, 3);
  sense[7] = 10;
  sense[12] = asc;
  sense[13] = ascq;
  return sense.toString("hex");
}

function descriptorSense(lba, senseKey, asc, ascq = 0) {
  const sense = Buffer.alloc(20);
  sense[0] = 0x72;
  sense[1] = senseKey;
  sense[2] = asc;
  sense[3] = ascq;
  sense[7] = 12;
  sense[8] = 0;
  sense[9] = 10;
  sense[10] = 0x80;
  sense.writeBigUInt64BE(BigInt(lba), 12);
  return sense.toString("hex");
}

function fixedTerminalSense(senseKey, asc, ascq) {
  const sense = Buffer.alloc(18);
  sense[0] = 0x70;
  sense[2] = senseKey;
  sense[7] = 10;
  sense[12] = asc;
  sense[13] = ascq;
  return sense.toString("hex");
}

function descriptorTerminalSense(senseKey, asc, ascq) {
  const sense = Buffer.alloc(8);
  sense[0] = 0x72;
  sense[1] = senseKey;
  sense[2] = asc;
  sense[3] = ascq;
  return sense.toString("hex");
}

function fixedMediumSense(lba, ascq = 0) {
  return fixedSense(lba, 0x03, 0x11, ascq);
}

function descriptorMediumSense(lba, ascq = 0) {
  return descriptorSense(lba, 0x03, 0x11, ascq);
}

function fixedOutOfRangeSense(lba) {
  return fixedSense(lba, 0x05, 0x21);
}

function descriptorOutOfRangeSense(lba) {
  return descriptorSense(lba, 0x05, 0x21);
}

function rawCompletionFault(
  lba,
  remainingFailures,
  sense,
  { scsiStatus = 2, hostStatus = 0, driverStatus = 8 } = {},
) {
  return `raw@${lba}@${remainingFailures}@${scsiStatus}@${hostStatus}@${driverStatus}@${sense.length / 2}@${sense}`;
}

const fixedMediumAtFive = fixedMediumSense(5);
const descriptorMediumAtFive = descriptorMediumSense(5);
const fixedRetriesExhaustedAtFive = fixedMediumSense(5, 1);
const descriptorRetriesExhaustedAtFive = descriptorMediumSense(5, 1);
const readinessSenseFixtures = [
  {
    name: "fixed-not-ready",
    category: "not_ready",
    responseCode: 0x70,
    senseKey: 0x02,
    asc: 0x04,
    ascq: 0x01,
    sense: fixedTerminalSense(0x02, 0x04, 0x01),
  },
  {
    name: "descriptor-not-ready",
    category: "not_ready",
    responseCode: 0x72,
    senseKey: 0x02,
    asc: 0x04,
    ascq: 0x02,
    sense: descriptorTerminalSense(0x02, 0x04, 0x02),
  },
  {
    name: "fixed-unit-attention",
    category: "unit_attention",
    responseCode: 0x70,
    senseKey: 0x06,
    asc: 0x28,
    ascq: 0x00,
    sense: fixedTerminalSense(0x06, 0x28, 0x00),
  },
  {
    name: "descriptor-unit-attention",
    category: "unit_attention",
    responseCode: 0x72,
    senseKey: 0x06,
    asc: 0x29,
    ascq: 0x00,
    sense: descriptorTerminalSense(0x06, 0x29, 0x00),
  },
];

const categorizedReadFailures = [
  {
    category: "hardware_error",
    fixtures: [
      ["fixed-hardware", fixedSense(5, 0x04, 0x44)],
      ["descriptor-hardware", descriptorSense(5, 0x04, 0x44)],
    ],
  },
  {
    category: "transport_error",
    fixtures: [
      [
        "fixed-host-transport-precedence",
        fixedMediumAtFive,
        { hostStatus: 7 },
      ],
      [
        "descriptor-host-transport-precedence",
        descriptorMediumAtFive,
        { hostStatus: 7 },
      ],
      ["driver-transport", fixedMediumAtFive, { driverStatus: 6 }],
    ],
  },
  {
    category: "protection_error",
    fixtures: [
      ["fixed-protection", fixedSense(5, 0x05, 0x6f, 0x04)],
      ["descriptor-protection", descriptorSense(5, 0x05, 0x6f, 0x04)],
    ],
  },
];

function prepareOutput(path) {
  rmSync(path, { force: true });
  return path;
}

function prefixedResult(stderr, prefix, label) {
  const lines = stderr.trim().split("\n");
  const results = lines.filter((line) => line.startsWith(prefix));
  if (results.length !== 1) {
    throw new Error(`expected one ${label}, received: ${stderr}`);
  }
  return JSON.parse(results[0].slice(prefix.length));
}

function recoveryResult(stderr) {
  return prefixedResult(stderr, recoveryResultPrefix, "recovery result");
}

function readFailureResult(stderr) {
  return prefixedResult(
    stderr,
    readFailureResultPrefix,
    "read failure result",
  );
}

function scsiSessionResult(stderr) {
  return prefixedResult(
    stderr,
    scsiSessionResultPrefix,
    "SCSI session result",
  );
}

function badSectorRanges(result, totalSectorCount) {
  const bitmap = Buffer.from(result.badSectorBitmapHex, "hex");
  const ranges = [];
  let startLba;
  for (let lba = 0; lba < totalSectorCount; lba += 1) {
    const bad = (bitmap[Math.floor(lba / 8)] & (1 << (lba % 8))) !== 0;
    if (bad && startLba === undefined) {
      startLba = lba;
    } else if (!bad && startLba !== undefined) {
      ranges.push({ startLba, sectorCount: lba - startLba });
      startLba = undefined;
    }
  }
  if (startLba !== undefined) {
    ranges.push({ startLba, sectorCount: totalSectorCount - startLba });
  }
  return ranges;
}

function testReads(stderr) {
  return stderr.split("\n").flatMap((line) => {
    const match = /^test-read (\d+) (\d+)$/.exec(line);
    return match ? [{ lba: Number(match[1]), blocks: Number(match[2]) }] : [];
  });
}

function runTestCopy(name, faults, mode = "valid") {
  const outputPath = prepareOutput(`/tmp/rip-dvd-reader-${name}.img`);
  const result = spawnSync(
    testExecutable,
    [
      "copy-test",
      sourcePath,
      outputPath,
      String(content.byteLength),
      faults,
      "0",
      mode,
    ],
    { encoding: "utf8" },
  );
  return { ...result, outputPath };
}

function runTestCopyWithDeclaredSectors(name, faults, declaredSectorCount) {
  const outputPath = prepareOutput(`/tmp/rip-dvd-reader-${name}.img`);
  const result = spawnSync(
    testExecutable,
    [
      "copy-test",
      sourcePath,
      outputPath,
      String(declaredSectorCount * 2_048),
      faults,
      "0",
      "valid",
    ],
    { encoding: "utf8" },
  );
  return { ...result, outputPath };
}

function runTestResume(outputPath, faults, bitmapHex) {
  const output = statSync(outputPath);
  const result = spawnSync(
    testExecutable,
    [
      "resume-test",
      sourcePath,
      outputPath,
      String(content.byteLength),
      faults,
      "0",
      "valid",
      bitmapHex,
      `${output.dev}:${output.ino}`,
    ],
    { encoding: "utf8" },
  );
  return { ...result, outputPath };
}

function runScsiSessionTest(scenario) {
  return spawnSync(
    testExecutable,
    ["scsi-session-test", scenario, sourcePath, replacementSourcePath],
    { encoding: "utf8" },
  );
}

function assertScsiMetrics(result, label, expected, parse = scsiSessionResult) {
  const actual = parse(result.stderr);
  if (
    result.status !== 0 ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(`libdvdcss ${label} check failed: ${result.stderr}`);
  }
}

function waitForStderrMarker(child, stderr, marker, label) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onData = () => {
      if (stderr().includes(marker)) {
        finish();
      }
    };
    const onClose = (status, signal) => {
      finish(
        new Error(
          `${label} exited before ${marker}: status=${status} signal=${signal} stderr=${stderr()}`,
        ),
      );
    };
    const onError = (error) => finish(error);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${label} timed out waiting for ${marker}: ${stderr()}`));
    }, 10_000);

    child.stderr.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
    onData();
  });
}

function runTestBoundaryResume(outputPath, faults, imageByteCount) {
  const output = statSync(outputPath);
  const result = spawnSync(
    testExecutable,
    [
      "resume-boundary-test",
      sourcePath,
      outputPath,
      String(content.byteLength),
      faults,
      "0",
      "valid",
      String(imageByteCount),
      `${output.dev}:${output.ino}`,
    ],
    { encoding: "utf8" },
  );
  return { ...result, outputPath };
}

const expectedHash = createHash("sha256")
  .update("rip-dvd-content-v2\0")
  .update(String(content.byteLength))
  .update(content)
  .digest("hex");
const hash = spawnSync(
  executable,
  ["hash", sourcePath, String(content.byteLength)],
  { encoding: "utf8" },
);
if (hash.status !== 0 || hash.stdout !== `sha256:${expectedHash}`) {
  throw new Error(`libdvdcss reader hash check failed: ${hash.stderr}`);
}
const hashProgress = hash.stderr.trim().split("\n").map((line) => {
  const match = /^(\d+) bytes hashed$/.exec(line);
  return match ? Number(match[1]) : Number.NaN;
});
if (
  hashProgress.length === 0 ||
  hashProgress.some((bytes, index) =>
    !Number.isSafeInteger(bytes) ||
    bytes <= (hashProgress[index - 1] ?? -1) ||
    bytes > content.byteLength
  ) ||
  hashProgress.at(-1) !== content.byteLength ||
  hash.stderr.length > 1_024
) {
  throw new Error(`libdvdcss reader hash progress check failed: ${hash.stderr}`);
}

const copyPath = prepareOutput("/tmp/rip-dvd-reader-copy.img");
const copy = spawnSync(
  executable,
  ["copy", sourcePath, copyPath, String(content.byteLength)],
  { encoding: "utf8" },
);
const copyProgress = copy.stderr
  .trim()
  .split("\n")
  .filter((line) => / bytes copied$/.test(line));
const cleanResult = recoveryResult(copy.stderr);
if (
  copy.status !== 0 ||
  !readFileSync(copyPath).equals(content) ||
  copyProgress.length !== 2 ||
  copyProgress.at(-1) !== `${content.byteLength} bytes copied` ||
  cleanResult.badSectorCount !== 0 ||
  cleanResult.badAreaCount !== 0 ||
  cleanResult.badSectorBitmapHex !== ""
) {
  throw new Error(`libdvdcss reader copy check failed: ${copy.stderr}`);
}

const cleanSession = runTestCopy("clean-session", "none");
assertScsiMetrics(cleanSession, "clean SCSI session", {
  discoveryCount: 1,
  openCount: 1,
  closeCount: 1,
  contentReadCount: 2,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [
    { lba: 0, blocks: 31 },
    { lba: 31, blocks: 9 },
  ],
});
if (
  !readFileSync(cleanSession.outputPath).equals(content) ||
  JSON.stringify(testReads(cleanSession.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
    ])
) {
  throw new Error(
    `libdvdcss clean SCSI session check failed: ${cleanSession.stderr}`,
  );
}

const wrappedAutosense = runTestCopy(
  "wrapped-autosense",
  "none",
  "wrapped-medium-error",
);
assertScsiMetrics(wrappedAutosense, "wrapped autosense recovery", {
  discoveryCount: 1,
  openCount: 1,
  closeCount: 1,
  contentReadCount: 3,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [
    { lba: 0, blocks: 31 },
    { lba: 0, blocks: 31 },
    { lba: 31, blocks: 9 },
  ],
});
const wrappedAutosenseResult = recoveryResult(wrappedAutosense.stderr);
if (
  !readFileSync(wrappedAutosense.outputPath).equals(content) ||
  wrappedAutosenseResult.badSectorCount !== 0 ||
  wrappedAutosenseResult.badAreaCount !== 0 ||
  wrappedAutosenseResult.badSectorBitmapHex !== "" ||
  JSON.stringify(testReads(wrappedAutosense.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
    ])
) {
  throw new Error(
    `libdvdcss wrapped autosense recovery check failed: ${wrappedAutosense.stderr}`,
  );
}

const overlappingSources = runScsiSessionTest("source-change");
assertScsiMetrics(overlappingSources, "overlapping source session", {
  discoveryCount: 2,
  openCount: 2,
  closeCount: 2,
  contentReadCount: 3,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [
    { lba: 0, blocks: 31 },
    { lba: 0, blocks: 31 },
    { lba: 0, blocks: 31 },
  ],
});

const reusedSource = runScsiSessionTest("descriptor-reuse");
assertScsiMetrics(reusedSource, "descriptor reuse invalidation", {
  discoveryCount: 2,
  openCount: 2,
  closeCount: 2,
  contentReadCount: 2,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [
    { lba: 0, blocks: 31 },
    { lba: 0, blocks: 31 },
  ],
});

const changedDrive = runScsiSessionTest("drive-identity-change");
assertScsiMetrics(changedDrive, "optical drive identity invalidation", {
  discoveryCount: 2,
  openCount: 2,
  closeCount: 2,
  contentReadCount: 2,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [
    { lba: 0, blocks: 31 },
    { lba: 0, blocks: 31 },
  ],
});

const changedSgIdentity = runScsiSessionTest("sg-identity-change");
assertScsiMetrics(changedSgIdentity, "SCSI-generic identity mismatch", {
  discoveryCount: 1,
  openCount: 1,
  closeCount: 1,
  contentReadCount: 1,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [{ lba: 0, blocks: 31 }],
});

const failedIdentityCheck = runScsiSessionTest("identity-check-failure");
assertScsiMetrics(failedIdentityCheck, "source identity failure caching", {
  discoveryCount: 1,
  openCount: 1,
  closeCount: 1,
  contentReadCount: 1,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [{ lba: 0, blocks: 31 }],
});

const concurrentSources = runScsiSessionTest("concurrent-sources");
assertScsiMetrics(concurrentSources, "concurrent per-read evidence", {
  discoveryCount: 2,
  openCount: 2,
  closeCount: 2,
  contentReadCount: 2,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [
    { lba: 0, blocks: 31 },
    { lba: 0, blocks: 31 },
  ],
});

for (const [scenario, openCount] of [
  ["discovery-failure", 0],
  ["open-failure", 1],
]) {
  const unavailableSession = runScsiSessionTest(scenario);
  assertScsiMetrics(unavailableSession, `${scenario} retry suppression`, {
    discoveryCount: 1,
    openCount,
    closeCount: 0,
    contentReadCount: 0,
    requestSenseCount: 0,
    diagnosticCommandCount: 0,
    requests: [],
  });
}

const failedSession = runScsiSessionTest("read-failure");
assertScsiMetrics(failedSession, "failed SCSI session cleanup", {
  discoveryCount: 1,
  openCount: 1,
  closeCount: 1,
  contentReadCount: 1,
  requestSenseCount: 0,
  diagnosticCommandCount: 0,
  requests: [{ lba: 0, blocks: 31 }],
});

const normalExitSession = runScsiSessionTest("normal-exit");
assertScsiMetrics(
  normalExitSession,
  "normal-exit cleanup",
  {
    discoveryCount: 1,
    openCount: 1,
    closeCount: 1,
    contentReadCount: 1,
  },
  (stderr) =>
    prefixedResult(stderr, scsiExitResultPrefix, "SCSI exit result"),
);

const authorizedCopyPath = prepareOutput(
  "/tmp/rip-dvd-reader-authorized-copy.img",
);
const authorizedCopy = spawn(
  executable,
  ["copy-authorized", sourcePath, authorizedCopyPath, String(content.byteLength)],
  { stdio: ["ignore", "ignore", "pipe", "ignore", "pipe", "pipe"] },
);
const [ready] = await once(authorizedCopy.stdio[4], "data");
if (
  ready.toString("utf8") !== "rip-dvd-copy-authorization-ready\n" ||
  existsSync(authorizedCopyPath)
) {
  throw new Error("libdvdcss reader began before copy authorization");
}
authorizedCopy.stdio[5].end("1");
const [authorizedStatus] = await once(authorizedCopy, "close");
if (
  authorizedStatus !== 0 ||
  !readFileSync(authorizedCopyPath).equals(content)
) {
  throw new Error("libdvdcss reader authorized copy check failed");
}

const retry = runTestCopy(
  "retry",
  rawCompletionFault(5, 1, fixedMediumAtFive),
);
const retryReads = testReads(retry.stderr);
if (
  retry.status !== 0 ||
  !readFileSync(retry.outputPath).equals(content) ||
  recoveryResult(retry.stderr).badSectorCount !== 0 ||
  retryReads[0]?.blocks !== 31 ||
  retryReads[1]?.blocks !== 31
) {
  throw new Error(`libdvdcss retry check failed: ${retry.stderr}`);
}

for (const [name, sense] of [
  ["fixed-medium", fixedMediumAtFive],
  ["descriptor-medium", descriptorMediumAtFive],
  ["fixed-retries-exhausted", fixedRetriesExhaustedAtFive],
  ["descriptor-retries-exhausted", descriptorRetriesExhaustedAtFive],
]) {
  const exactMedium = runTestCopy(
    name,
    rawCompletionFault(5, "always", sense),
  );
  const exactMediumResult = recoveryResult(exactMedium.stderr);
  if (
    exactMedium.status !== 0 ||
    exactMediumResult.badSectorCount !== 1 ||
    JSON.stringify(badSectorRanges(exactMediumResult, 40)) !==
      JSON.stringify([{ startLba: 5, sectorCount: 1 }])
  ) {
    throw new Error(
      `libdvdcss ${name} classification check failed: ${exactMedium.stderr}`,
    );
  }
}

const continuedBoundary = runTestCopy(
  "continued-boundary-initial",
  rawCompletionFault(35, "always", fixedOutOfRangeSense(35)),
);
const continuedBoundaryResult = runTestBoundaryResume(
  continuedBoundary.outputPath,
  "none",
  31 * 2_048,
);
if (
  continuedBoundaryResult.status !== 0 ||
  !readFileSync(continuedBoundary.outputPath).equals(content) ||
  recoveryResult(continuedBoundaryResult.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(continuedBoundaryResult.stderr)) !==
    JSON.stringify([{ lba: 31, blocks: 9 }])
) {
  throw new Error(
    `libdvdcss boundary continuation check failed: ${continuedBoundaryResult.stderr}`,
  );
}

const rolledBackBoundary = runTestCopy(
  "rolled-back-boundary-initial",
  rawCompletionFault(35, "always", fixedOutOfRangeSense(35)),
);
const committedBoundaryByteCount = 31 * 2_048;
writeFileSync(
  rolledBackBoundary.outputPath,
  Buffer.concat([
    content.subarray(0, committedBoundaryByteCount),
    Buffer.alloc(2 * 2_048, 255),
  ]),
);
const rolledBackBoundaryResult = runTestBoundaryResume(
  rolledBackBoundary.outputPath,
  "none",
  committedBoundaryByteCount,
);
if (
  rolledBackBoundaryResult.status !== 0 ||
  !readFileSync(rolledBackBoundary.outputPath).equals(content) ||
  JSON.stringify(testReads(rolledBackBoundaryResult.stderr)) !==
    JSON.stringify([{ lba: 31, blocks: 9 }])
) {
  throw new Error(
    `libdvdcss boundary rollback check failed: ${rolledBackBoundaryResult.stderr}`,
  );
}

const transientExactMedium = runTestCopy(
  "transient-exact-medium",
  rawCompletionFault(5, 1, fixedMediumAtFive),
);
if (
  transientExactMedium.status !== 0 ||
  !readFileSync(transientExactMedium.outputPath).equals(content) ||
  recoveryResult(transientExactMedium.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(transientExactMedium.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
    ])
) {
  throw new Error(
    `libdvdcss transient raw completion check failed: ${transientExactMedium.stderr}`,
  );
}

for (const { category, fixtures } of categorizedReadFailures) {
  for (const [name, sense, completion] of fixtures) {
    const failure = runTestCopy(
      name,
      rawCompletionFault(5, "always", sense, completion),
    );
    const result = readFailureResult(failure.stderr);
    if (
      failure.status !== 3 ||
      statSync(failure.outputPath).size !== 0 ||
      failure.stderr.includes(recoveryResultPrefix) ||
      JSON.stringify(testReads(failure.stderr)) !==
        JSON.stringify([{ lba: 0, blocks: 31 }]) ||
      result.category !== category ||
      result.requestedLba !== 0 ||
      result.requestedBlockCount !== 31 ||
      result.retryOrdinal !== 0
    ) {
      throw new Error(
        `libdvdcss ${name} classification check failed: ${failure.stderr}`,
      );
    }
  }
}

const fixedUnknownSense = "f00005000000050a00000000200000000000";
const persistentUnknown = runTestCopy(
  "persistent-unknown",
  `raw@5@always@2@0@8@${fixedUnknownSense.length / 2}@${fixedUnknownSense}`,
);
const persistentUnknownResult = readFailureResult(persistentUnknown.stderr);
if (
  persistentUnknown.status !== 3 ||
  statSync(persistentUnknown.outputPath).size !== 0 ||
  persistentUnknown.stderr.includes(recoveryResultPrefix) ||
  JSON.stringify(testReads(persistentUnknown.stderr)) !==
    JSON.stringify([{ lba: 0, blocks: 31 }]) ||
  JSON.stringify(persistentUnknownResult) !==
    JSON.stringify({
      protocolVersion: 1,
      classifierVersion: "scsi-read-classifier-v1",
      category: "unknown",
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode: 112,
      senseKey: 5,
      asc: 32,
      ascq: 0,
      informationLba: 5,
      requestedLba: 0,
      requestedBlockCount: 31,
      retryOrdinal: 0,
    })
) {
  throw new Error(
    `libdvdcss persistent unknown check failed: ${persistentUnknown.stderr}`,
  );
}

for (const fixture of readinessSenseFixtures) {
  const terminal = runTestCopy(
    fixture.name,
    rawCompletionFault(5, "always", fixture.sense),
  );
  const result = readFailureResult(terminal.stderr);
  if (
    terminal.status !== 3 ||
    statSync(terminal.outputPath).size !== 0 ||
    terminal.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(terminal.stderr)) !==
      JSON.stringify([{ lba: 0, blocks: 31 }]) ||
    result.category !== fixture.category ||
    result.senseResponseCode !== fixture.responseCode ||
    result.senseKey !== fixture.senseKey ||
    result.asc !== fixture.asc ||
    result.ascq !== fixture.ascq ||
    result.informationLba !== null ||
    result.requestedLba !== 0 ||
    result.requestedBlockCount !== 31 ||
    result.retryOrdinal !== 0
  ) {
    throw new Error(
      `libdvdcss ${fixture.name} initial-copy check failed: ${terminal.stderr}`,
    );
  }
}

for (const [name, sense] of [
  ["fixed-out-of-range", fixedOutOfRangeSense(35)],
  ["descriptor-out-of-range", descriptorOutOfRangeSense(35)],
]) {
  const outOfRange = runTestCopy(
    name,
    rawCompletionFault(35, "always", sense),
  );
  const result = readFailureResult(outOfRange.stderr);
  if (
    outOfRange.status !== 3 ||
    statSync(outOfRange.outputPath).size !== 31 * 2_048 ||
    !readFileSync(outOfRange.outputPath).equals(content.subarray(0, 31 * 2_048)) ||
    outOfRange.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(outOfRange.stderr)) !==
      JSON.stringify([
        { lba: 0, blocks: 31 },
        { lba: 31, blocks: 9 },
      ]) ||
    result.category !== "out_of_range" ||
    result.declaredByteCount !== content.byteLength ||
    result.firstFailingLba !== 35 ||
    result.informationLba !== 35 ||
    result.requestedLba !== 31 ||
    result.requestedBlockCount !== 9 ||
    result.retryOrdinal !== 0
  ) {
    throw new Error(
      `libdvdcss ${name} boundary check failed: ${outOfRange.stderr}`,
    );
  }
}

for (const excludedSectorCount of [114_301, 73_400]) {
  const boundaryLba = content.byteLength / 2_048;
  const declaredSectorCount = boundaryLba + excludedSectorCount;
  const outOfRange = runTestCopyWithDeclaredSectors(
    `out-of-range-suffix-${excludedSectorCount}`,
    rawCompletionFault(
      boundaryLba,
      "always",
      fixedOutOfRangeSense(boundaryLba),
    ),
    declaredSectorCount,
  );
  const result = readFailureResult(outOfRange.stderr);
  if (
    outOfRange.status !== 3 ||
    result.category !== "out_of_range" ||
    result.firstFailingLba !== boundaryLba ||
    result.declaredByteCount !== declaredSectorCount * 2_048 ||
    testReads(outOfRange.stderr).length !== 2 ||
    outOfRange.stderr.includes(recoveryResultPrefix)
  ) {
    throw new Error(
      `libdvdcss ${excludedSectorCount}-sector suffix regression failed: ${outOfRange.stderr}`,
    );
  }
}

const malformedUnknownFixtures = [
  ["missing", "generic@5@always"],
  ["empty", "raw@5@always@2@0@8@0@-"],
  ["truncated", "raw@5@always@2@0@8@7@70000300000000"],
  ["oversized", "raw@5@always@2@0@8@253@-"],
  ["inconsistent", "raw@5@always@2@0@8@8@700003000000000a"],
  [
    "fixed-undeclared-trailing-byte",
    `raw@5@always@2@0@8@19@${fixedMediumAtFive}ff`,
  ],
  [
    "descriptor-undeclared-trailing-byte",
    `raw@5@always@2@0@8@21@${descriptorMediumAtFive}ff`,
  ],
  [
    "fixed-declared-length-excludes-asc",
    "raw@5@always@2@0@8@14@f000030000000504000000001100",
  ],
  [
    "fixed-reserved-sense-key-bit",
    "raw@5@always@2@0@8@18@f00013000000050a00000000110000000000",
  ],
  [
    "fixed-sense-key-specific-reserved-bit",
    "raw@5@always@2@0@8@18@f00003000000050a00000000110000400000",
  ],
  [
    "fixed-declared-vendor-byte",
    "raw@5@always@2@0@8@19@f00003000000050b00000000110000000000ff",
  ],
  [
    "fixed-command-specific-information",
    "raw@5@always@2@0@8@18@f00003000000050a01000000110000000000",
  ],
  [
    "fixed-invalid-information",
    "raw@5@always@2@0@8@18@700003000000050a00000000110000000000",
  ],
  [
    "fixed-contradictory-medium-tuple",
    "raw@5@always@2@0@8@18@f00003000000050a00000000210000000000",
  ],
  [
    "fixed-unrecognized-medium-tuple",
    "raw@5@always@2@0@8@18@f00003000000050a000000007f7f00000000",
  ],
  ["unsupported", "raw@5@always@2@0@8@1@7f"],
  [
    "driver-status-reserved-upper-bit",
    `raw@5@always@2@0@264@${fixedMediumAtFive.length / 2}@${fixedMediumAtFive}`,
  ],
  [
    "driver-status-abort-suggestion",
    `raw@5@always@2@0@40@${fixedMediumAtFive.length / 2}@${fixedMediumAtFive}`,
  ],
  [
    "driver-media-status",
    `raw@5@always@2@0@3@${fixedMediumAtFive.length / 2}@${fixedMediumAtFive}`,
  ],
  [
    "driver-invalid-status",
    `raw@5@always@2@0@5@${fixedMediumAtFive.length / 2}@${fixedMediumAtFive}`,
  ],
  [
    "driver-hard-status",
    `raw@5@always@2@0@7@${fixedMediumAtFive.length / 2}@${fixedMediumAtFive}`,
  ],
  [
    "descriptor-response-reserved-bit",
    "raw@5@always@2@0@8@8@f203110000000000",
  ],
  [
    "descriptor-unknown-descriptor",
    "raw@5@always@2@0@8@10@72031100000000027f00",
  ],
  [
    "descriptor-header-reserved-byte-4",
    "raw@5@always@2@0@8@20@720311000100000c000a80000000000000000005",
  ],
  [
    "descriptor-header-reserved-byte-5",
    "raw@5@always@2@0@8@20@720311000001000c000a80000000000000000005",
  ],
  [
    "descriptor-header-reserved-byte-6",
    "raw@5@always@2@0@8@20@720311000000010c000a80000000000000000005",
  ],
  [
    "descriptor-information-reserved-bits",
    "raw@5@always@2@0@8@20@720311000000000c000a81000000000000000005",
  ],
  [
    "descriptor-invalid-information",
    "raw@5@always@2@0@8@20@720311000000000c000a00000000000000000005",
  ],
  [
    "descriptor-contradictory-medium-tuple",
    "raw@5@always@2@0@8@20@720321000000000c000a80000000000000000005",
  ],
  [
    "descriptor-unrecognized-medium-tuple",
    "raw@5@always@2@0@8@20@72037f7f0000000c000a80000000000000000005",
  ],
  [
    "descriptor-reserved-byte",
    "raw@5@always@2@0@8@20@720311000000000c000a80010000000000000005",
  ],
  [
    "contradictory",
    `raw@5@always@0@0@0@${fixedMediumAtFive.length / 2}@${fixedMediumAtFive}`,
  ],
];
for (const [name, fault] of malformedUnknownFixtures) {
  const malformedUnknown = runTestCopy(`unknown-${name}`, fault);
  const result = readFailureResult(malformedUnknown.stderr);
  if (
    malformedUnknown.status !== 3 ||
    result.category !== "unknown" ||
    result.classifierVersion !== "scsi-read-classifier-v1" ||
    result.requestedLba !== 0 ||
    result.requestedBlockCount !== 31 ||
    result.retryOrdinal !== 0 ||
    (name === "missing" &&
      (result.scsiStatus !== null ||
        result.hostStatus !== null ||
        result.driverStatus !== null)) ||
    (name === "fixed-declared-length-excludes-asc" &&
      (result.asc !== null || result.ascq !== null)) ||
    malformedUnknown.stderr.includes(recoveryResultPrefix) ||
    testReads(malformedUnknown.stderr).length !== 1
  ) {
    throw new Error(
      `libdvdcss ${name} unknown evidence check failed: ${malformedUnknown.stderr}`,
    );
  }
}

for (const [name, sense] of [
  ["fixed", fixedMediumAtFive],
  ["descriptor", descriptorMediumAtFive],
]) {
  const contradictoryInformation = runTestCopy(
    `unknown-${name}-information-lba`,
    `raw@35@always@2@0@8@${sense.length / 2}@${sense}`,
  );
  const result = readFailureResult(contradictoryInformation.stderr);
  if (
    contradictoryInformation.status !== 3 ||
    result.category !== "unknown" ||
    result.informationLba !== null ||
    result.requestedLba !== 31 ||
    result.requestedBlockCount !== 9 ||
    contradictoryInformation.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(contradictoryInformation.stderr)) !==
      JSON.stringify([
        { lba: 0, blocks: 31 },
        { lba: 31, blocks: 9 },
      ])
  ) {
    throw new Error(
      `libdvdcss contradictory ${name} information check failed: ${contradictoryInformation.stderr}`,
    );
  }
}

const isolated = runTestCopy(
  "isolated",
  rawCompletionFault(5, "always", fixedMediumAtFive),
);
const isolatedResult = recoveryResult(isolated.stderr);
const isolatedContent = readFileSync(isolated.outputPath);
const isolatedReads = testReads(isolated.stderr);
if (
  isolated.status !== 0 ||
  !isolatedContent.subarray(0, 5 * 2_048).equals(content.subarray(0, 5 * 2_048)) ||
  !isolatedContent.subarray(5 * 2_048, 6 * 2_048).equals(Buffer.alloc(2_048)) ||
  !isolatedContent.subarray(6 * 2_048).equals(content.subarray(6 * 2_048)) ||
  isolatedResult.badSectorCount !== 1 ||
  isolatedResult.badAreaCount !== 1 ||
  JSON.stringify(badSectorRanges(isolatedResult, 40)) !==
    JSON.stringify([{ startLba: 5, sectorCount: 1 }]) ||
  !isolatedReads.some(({ lba, blocks }) => lba === 5 && blocks === 1)
) {
  throw new Error(`libdvdcss isolated recovery check failed: ${isolated.stderr}`);
}

const persistentResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-persistent-resume.img",
);
const contaminatedPersistentResumeContent = Buffer.from(isolatedContent);
contaminatedPersistentResumeContent.fill(91, 5 * 2_048, 6 * 2_048);
writeFileSync(persistentResumePath, contaminatedPersistentResumeContent);
const persistentResume = runTestResume(
  persistentResumePath,
  rawCompletionFault(5, "always", descriptorMediumAtFive),
  isolatedResult.badSectorBitmapHex,
);
const persistentResumeResult = recoveryResult(persistentResume.stderr);
if (
  persistentResume.status !== 0 ||
  !readFileSync(persistentResumePath)
    .subarray(5 * 2_048, 6 * 2_048)
    .equals(Buffer.alloc(2_048)) ||
  persistentResumeResult.badSectorCount !== 1 ||
  persistentResumeResult.badSectorBitmapHex !==
    isolatedResult.badSectorBitmapHex ||
  JSON.stringify(testReads(persistentResume.stderr)) !==
    JSON.stringify([
      { lba: 5, blocks: 1 },
      { lba: 5, blocks: 1 },
    ])
) {
  throw new Error(
    `libdvdcss persistent resume check failed: ${persistentResume.stderr}`,
  );
}

const unknownResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-unknown-resume.img",
);
const unknownResumeContent = Buffer.from(contaminatedPersistentResumeContent);
writeFileSync(unknownResumePath, unknownResumeContent);
const unknownResume = runTestResume(
  unknownResumePath,
  `raw@5@always@2@0@8@${fixedUnknownSense.length / 2}@${fixedUnknownSense}`,
  isolatedResult.badSectorBitmapHex,
);
const unknownResumeResult = readFailureResult(unknownResume.stderr);
if (
  unknownResume.status !== 3 ||
  !readFileSync(unknownResumePath).equals(unknownResumeContent) ||
  unknownResume.stderr.includes(recoveryResultPrefix) ||
  JSON.stringify(testReads(unknownResume.stderr)) !==
    JSON.stringify([{ lba: 5, blocks: 1 }]) ||
  unknownResumeResult.category !== "unknown" ||
  unknownResumeResult.informationLba !== 5 ||
  unknownResumeResult.requestedLba !== 5 ||
  unknownResumeResult.requestedBlockCount !== 1 ||
  unknownResumeResult.retryOrdinal !== 0
) {
  throw new Error(
    `libdvdcss unknown resume check failed: ${unknownResume.stderr}`,
  );
}

for (const fixture of readinessSenseFixtures) {
  const readinessResumePath = prepareOutput(
    `/tmp/rip-dvd-reader-${fixture.name}-resume.img`,
  );
  writeFileSync(readinessResumePath, unknownResumeContent);
  const terminal = runTestResume(
    readinessResumePath,
    rawCompletionFault(5, "always", fixture.sense),
    isolatedResult.badSectorBitmapHex,
  );
  const result = readFailureResult(terminal.stderr);
  if (
    terminal.status !== 3 ||
    !readFileSync(readinessResumePath).equals(unknownResumeContent) ||
    terminal.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(terminal.stderr)) !==
      JSON.stringify([{ lba: 5, blocks: 1 }]) ||
    result.category !== fixture.category ||
    result.senseResponseCode !== fixture.responseCode ||
    result.senseKey !== fixture.senseKey ||
    result.asc !== fixture.asc ||
    result.ascq !== fixture.ascq ||
    result.informationLba !== null ||
    result.requestedLba !== 5 ||
    result.requestedBlockCount !== 1 ||
    result.retryOrdinal !== 0
  ) {
    throw new Error(
      `libdvdcss ${fixture.name} resume check failed: ${terminal.stderr}`,
    );
  }
}

for (const { category, fixtures } of categorizedReadFailures) {
  const [name, sense, completion] = fixtures[0];
  const resumePath = prepareOutput(
    `/tmp/rip-dvd-reader-${name}-resume.img`,
  );
  writeFileSync(resumePath, unknownResumeContent);
  const failure = runTestResume(
    resumePath,
    rawCompletionFault(5, "always", sense, completion),
    isolatedResult.badSectorBitmapHex,
  );
  const result = readFailureResult(failure.stderr);
  if (
    failure.status !== 3 ||
    !readFileSync(resumePath).equals(unknownResumeContent) ||
    failure.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(failure.stderr)) !==
      JSON.stringify([{ lba: 5, blocks: 1 }]) ||
    result.category !== category ||
    result.requestedLba !== 5 ||
    result.requestedBlockCount !== 1 ||
    result.retryOrdinal !== 0
  ) {
    throw new Error(
      `libdvdcss ${name} resume classification check failed: ${failure.stderr}`,
    );
  }
}

const outOfRangeResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-out-of-range-resume.img",
);
writeFileSync(outOfRangeResumePath, unknownResumeContent);
const outOfRangeResume = runTestResume(
  outOfRangeResumePath,
  rawCompletionFault(5, "always", descriptorOutOfRangeSense(5)),
  isolatedResult.badSectorBitmapHex,
);
const outOfRangeResumeResult = readFailureResult(outOfRangeResume.stderr);
if (
  outOfRangeResume.status !== 3 ||
  !readFileSync(outOfRangeResumePath).equals(unknownResumeContent) ||
  outOfRangeResume.stderr.includes(recoveryResultPrefix) ||
  JSON.stringify(testReads(outOfRangeResume.stderr)) !==
    JSON.stringify([{ lba: 5, blocks: 1 }]) ||
  outOfRangeResumeResult.category !== "out_of_range" ||
  outOfRangeResumeResult.firstFailingLba !== 5 ||
  outOfRangeResumeResult.declaredByteCount !== content.byteLength
) {
  throw new Error(
    `libdvdcss out-of-range resume check failed: ${outOfRangeResume.stderr}`,
  );
}

const fullyMappedResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-fully-mapped-resume.img",
);
writeFileSync(fullyMappedResumePath, Buffer.alloc(content.byteLength, 37));
const fullyMappedResume = runTestResume(
  fullyMappedResumePath,
  "none",
  Buffer.alloc(content.byteLength / 2_048 / 8, 0xff).toString("hex"),
);
const fullyMappedProgress = fullyMappedResume.stderr
  .trim()
  .split("\n")
  .filter((line) => / bytes copied$/.test(line));
if (
  fullyMappedResume.status !== 0 ||
  !readFileSync(fullyMappedResumePath).equals(content) ||
  fullyMappedProgress.length > 2 ||
  fullyMappedProgress.at(-1) !== `${content.byteLength} bytes copied`
) {
  throw new Error(
    `libdvdcss reader resume progress check failed: ${fullyMappedResume.stderr}`,
  );
}

const resumed = runTestResume(
  isolated.outputPath,
  rawCompletionFault(5, 1, fixedMediumAtFive),
  isolatedResult.badSectorBitmapHex,
);
if (
  resumed.status !== 0 ||
  !readFileSync(resumed.outputPath).equals(content) ||
  recoveryResult(resumed.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(resumed.stderr)) !==
    JSON.stringify([
      { lba: 5, blocks: 1 },
      { lba: 5, blocks: 1 },
    ])
) {
  throw new Error(`libdvdcss resumed recovery check failed: ${resumed.stderr}`);
}

const authorizedResume = spawn(
  executable,
  [
    "resume-authorized",
    sourcePath,
    persistentResumePath,
    String(content.byteLength),
    `${statSync(persistentResumePath).dev}:${statSync(persistentResumePath).ino}`,
  ],
  { stdio: ["ignore", "ignore", "pipe", "ignore", "pipe", "pipe"] },
);
let authorizedResumeStderr = "";
authorizedResume.stderr.on("data", (chunk) => {
  authorizedResumeStderr += chunk.toString("utf8");
});
const [resumeReady] = await once(authorizedResume.stdio[4], "data");
if (
  resumeReady.toString("utf8") !== "rip-dvd-copy-authorization-ready\n"
) {
  throw new Error("libdvdcss reader resume authorization did not become ready");
}
authorizedResume.stdio[5].end(`1${isolatedResult.badSectorBitmapHex}`);
const [authorizedResumeStatus] = await once(authorizedResume, "close");
if (
  authorizedResumeStatus !== 0 ||
  !readFileSync(persistentResumePath).equals(content) ||
  recoveryResult(authorizedResumeStderr).badSectorCount !== 0
) {
  throw new Error(
    `libdvdcss reader authorized resume check failed: ${authorizedResumeStderr}`,
  );
}

const replacementRacePath = prepareOutput(
  "/tmp/rip-dvd-reader-replacement-race.img",
);
writeFileSync(replacementRacePath, isolatedContent);
const expectedReplacementIdentity = statSync(replacementRacePath);
const replacementContent = Buffer.alloc(content.byteLength, 91);
const replacementCandidatePath = prepareOutput(`${replacementRacePath}.new`);
writeFileSync(replacementCandidatePath, replacementContent);
renameSync(replacementCandidatePath, replacementRacePath);
const replacementRace = spawn(
  executable,
  [
    "resume-authorized",
    sourcePath,
    replacementRacePath,
    String(content.byteLength),
    `${expectedReplacementIdentity.dev}:${expectedReplacementIdentity.ino}`,
  ],
  { stdio: ["ignore", "ignore", "pipe", "ignore", "pipe", "pipe"] },
);
let replacementRaceStderr = "";
replacementRace.stderr.on("data", (chunk) => {
  replacementRaceStderr += chunk.toString("utf8");
});
await once(replacementRace.stdio[4], "data");
replacementRace.stdio[5].end(`1${isolatedResult.badSectorBitmapHex}`);
const [replacementRaceStatus] = await once(replacementRace, "close");
if (
  replacementRaceStatus === 0 ||
  !replacementRaceStderr.includes(
    "DVD rescue image does not match its recovery map",
  ) ||
  !readFileSync(replacementRacePath).equals(replacementContent)
) {
  throw new Error(
    `libdvdcss reader replacement race check failed: ${replacementRaceStderr}`,
  );
}

const contiguous = runTestCopy(
  "contiguous",
  [
    rawCompletionFault(5, "always", fixedMediumAtFive),
    rawCompletionFault(6, "always", descriptorMediumSense(6)),
  ].join(","),
);
const contiguousResult = recoveryResult(contiguous.stderr);
const contiguousContent = readFileSync(contiguous.outputPath);
if (
  contiguous.status !== 0 ||
  !contiguousContent.subarray(5 * 2_048, 7 * 2_048)
    .equals(Buffer.alloc(2 * 2_048)) ||
  contiguousResult.badSectorCount !== 2 ||
  contiguousResult.badAreaCount !== 1 ||
  JSON.stringify(badSectorRanges(contiguousResult, 40)) !==
    JSON.stringify([{ startLba: 5, sectorCount: 2 }])
) {
  throw new Error(
    `libdvdcss contiguous recovery check failed: ${contiguous.stderr}`,
  );
}

const malformed = runTestCopy("malformed", "none", "malformed");
let malformedRejected = false;
try {
  recoveryResult(malformed.stderr);
} catch {
  malformedRejected = true;
}
if (malformed.status !== 0 || !malformedRejected) {
  throw new Error(
    `libdvdcss malformed recovery result check failed: ${malformed.stderr}`,
  );
}

const cancellationPath = prepareOutput(
  "/tmp/rip-dvd-reader-cancellation.img",
);
const cancellation = spawn(
  testExecutable,
  [
    "copy-test",
    sourcePath,
    cancellationPath,
    String(content.byteLength),
    "none",
    "0",
    "cancellation",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let cancellationStderr = "";
cancellation.stderr.on("data", (chunk) => {
  cancellationStderr += chunk.toString("utf8");
});
await waitForStderrMarker(
  cancellation,
  () => cancellationStderr,
  "test-read ",
  "libdvdcss cancellation fixture",
);
const cancellationFdDirectory = `/proc/${cancellation.pid}/fd`;
const sourceDescriptorCount = readdirSync(cancellationFdDirectory).filter(
  (descriptor) => {
    try {
      return readlinkSync(`${cancellationFdDirectory}/${descriptor}`) === sourcePath;
    } catch {
      return false;
    }
  },
).length;
cancellation.kill("SIGTERM");
const [cancellationStatus, cancellationSignal] = await once(
  cancellation,
  "close",
);
if (
  cancellationStatus !== null ||
  cancellationSignal !== "SIGTERM" ||
  sourceDescriptorCount !== 2 ||
  existsSync(cancellationFdDirectory) ||
  !existsSync(cancellationPath) ||
  statSync(cancellationPath).size >= content.byteLength ||
  cancellationStderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss cancellation check failed: ${cancellationStderr}`,
  );
}

const interruptedReadFailurePath = prepareOutput(
  "/tmp/rip-dvd-reader-interrupted-read-failure.img",
);
const interruptedReadFailure = spawn(
  testExecutable,
  [
    "copy-test",
    sourcePath,
    interruptedReadFailurePath,
    String(content.byteLength),
    `raw@5@always@2@0@8@${fixedUnknownSense.length / 2}@${fixedUnknownSense}`,
    "0",
    "interrupted-read-failure",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let interruptedReadFailureStderr = "";
interruptedReadFailure.stderr.on("data", (chunk) => {
  interruptedReadFailureStderr += chunk.toString("utf8");
});
await waitForStderrMarker(
  interruptedReadFailure,
  () => interruptedReadFailureStderr,
  readFailureResultPrefix,
  "libdvdcss interrupted read-failure fixture",
);
interruptedReadFailure.kill("SIGTERM");
const [interruptedStatus, interruptedSignal] = await once(
  interruptedReadFailure,
  "close",
);
let interruptedResultAccepted = false;
try {
  readFailureResult(interruptedReadFailureStderr);
  interruptedResultAccepted = true;
} catch {
  // A partial terminal record must not parse.
}
if (
  interruptedStatus !== null ||
  interruptedSignal !== "SIGTERM" ||
  interruptedResultAccepted ||
  interruptedReadFailureStderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss interrupted read failure check failed: ${interruptedReadFailureStderr}`,
  );
}

const invalid = spawnSync(executable, ["hash", sourcePath, "4095"], {
  encoding: "utf8",
});
if (invalid.status !== 2 || !invalid.stderr.includes("size is invalid")) {
  throw new Error("libdvdcss reader accepted a partial DVD block");
}
