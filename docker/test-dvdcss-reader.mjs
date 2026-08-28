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
const classificationVectors = JSON.parse(
  readFileSync(
    "/tmp/scsi-read-classification-v2-vectors.json",
    "utf8",
  ),
);
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

function descriptorMediumSenseWithPeripheralDescriptors(
  lba,
  informationPosition,
) {
  const information = Buffer.from(descriptorMediumSense(lba), "hex").subarray(
    8,
  );
  const commandSpecific = Buffer.from([
    0x01, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  ]);
  const senseKeySpecific = Buffer.from([0x02, 0x06, 0x80, 0, 0, 0, 0, 1]);
  const fieldReplaceableUnit = Buffer.from([0x03, 0x02, 0, 1]);
  const peripheralDescriptors = [
    commandSpecific,
    senseKeySpecific,
    fieldReplaceableUnit,
  ];
  peripheralDescriptors.splice(informationPosition, 0, information);
  const descriptors = Buffer.concat(peripheralDescriptors);
  const sense = Buffer.alloc(8);
  sense[0] = 0x72;
  sense[1] = 0x03;
  sense[2] = 0x11;
  sense[7] = descriptors.length;
  return Buffer.concat([sense, descriptors]).toString("hex");
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

function fixedMediumSenseWithActualRetryCount(lba, retryCount, ascq = 0) {
  const sense = Buffer.from(fixedMediumSense(lba, ascq), "hex");
  sense[15] = 0x80;
  sense.writeUInt16BE(retryCount, 16);
  return sense.toString("hex");
}

function descriptorMediumSense(lba, ascq = 0) {
  return descriptorSense(lba, 0x03, 0x11, ascq);
}

function fixedNoSeekCompleteSense(lba) {
  return fixedSense(lba, 0x03, 0x02);
}

function descriptorNoSeekCompleteSense(lba) {
  return descriptorSense(lba, 0x03, 0x02);
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

function rawTailCompletionFault(
  lba,
  remainingFailures,
  sense,
  { scsiStatus = 2, hostStatus = 0, driverStatus = 8 } = {},
) {
  return `raw-tail@${lba}@${remainingFailures}@${scsiStatus}@${hostStatus}@${driverStatus}@${sense.length / 2}@${sense}`;
}

function rawRequestCompletionFault(lba, remainingFailures, sense) {
  return `raw-request@${lba}@${remainingFailures}@2@0@8@${sense.length / 2}@${sense}`;
}

function corruptRequestFault(lba, remainingFailures) {
  return `corrupt-request@${lba}@${remainingFailures}`;
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
      ["future-host-transport", fixedMediumAtFive, { hostStatus: 0x13 }],
      ["driver-transport", fixedMediumAtFive, { driverStatus: 6 }],
      ["driver-transport-suggestion", fixedMediumAtFive, { driverStatus: 0x16 }],
    ],
  },
  {
    category: "protection_error",
    fixtures: [
      ["fixed-protection", fixedSense(5, 0x05, 0x6f, 0x04)],
      ["descriptor-protection", descriptorSense(5, 0x05, 0x6f, 0x04)],
      ["fixed-protection-newer-ascq", fixedSense(5, 0x05, 0x6f, 0x0a)],
    ],
  },
];

for (const vector of classificationVectors) {
  const lba = vector.category === "out_of_range" ? 35 : 5;
  const sense = fixedSense(lba, vector.senseKey, vector.asc, vector.ascq);
  const completion = {
    scsiStatus: vector.scsiStatus,
    hostStatus: vector.hostStatus,
    driverStatus: vector.driverStatus,
  };
  if (vector.category === "recognized_medium_error") {
    const recovered = runTestCopy(
      `classification-vector-${vector.name}`,
      rawCompletionFault(lba, "always", sense, completion),
    );
    const result = recoveryResult(recovered.stderr);
    if (
      recovered.status !== 0 ||
      result.badSectorCount !== 1 ||
      JSON.stringify(badSectorRanges(result, 40)) !==
        JSON.stringify([{ startLba: lba, sectorCount: 1 }])
    ) {
      throw new Error(
        `libdvdcss ${vector.name} classification vector failed: ${recovered.stderr}`,
      );
    }
    continue;
  }
  const failure = runTestCopy(
    `classification-vector-${vector.name}`,
    vector.category === "out_of_range"
      ? rawTailCompletionFault(lba, "always", sense, completion)
      : rawCompletionFault(lba, "always", sense, completion),
  );
  const result = readFailureResult(failure.stderr);
  if (failure.status !== 3 || result.category !== vector.category) {
    throw new Error(
      `libdvdcss ${vector.name} classification vector failed: ${failure.stderr}`,
    );
  }
}

const invalidBoundaryProbeFaults = [
  ["medium", rawCompletionFault(35, "always", fixedMediumSense(35))],
  [
    "not-ready",
    rawCompletionFault(
      35,
      "always",
      fixedTerminalSense(0x02, 0x04, 0x01),
    ),
  ],
  [
    "unit-attention",
    rawCompletionFault(
      35,
      "always",
      fixedTerminalSense(0x06, 0x28, 0x00),
    ),
  ],
  [
    "hardware",
    rawCompletionFault(35, "always", fixedSense(35, 0x04, 0x44)),
  ],
  [
    "transport",
    rawCompletionFault(35, "always", fixedMediumSense(35), {
      hostStatus: 7,
    }),
  ],
  [
    "protection",
    rawCompletionFault(35, "always", fixedSense(35, 0x05, 0x6f, 0x04)),
  ],
  [
    "unknown",
    rawCompletionFault(35, "always", fixedSense(35, 0x05, 0x20)),
  ],
  ["generic", "generic@35@always"],
  ["malformed", "raw@35@always@2@0@8@7@70000500000000"],
  [
    "descriptor-information-reserved-bits",
    rawCompletionFault(
      35,
      "always",
      "720521000000000c000a81000000000000000023",
    ),
  ],
  [
    "descriptor-information-reserved-byte",
    rawCompletionFault(
      35,
      "always",
      "720521000000000c000a80010000000000000023",
    ),
  ],
  [
    "inconsistent-confirmations",
    [
      rawCompletionFault(35, 1, fixedOutOfRangeSense(35)),
      rawCompletionFault(35, "always", fixedMediumSense(35)),
    ].join(","),
  ],
  [
    "conflicting-out-of-range-confirmations",
    [
      rawCompletionFault(35, 1, fixedOutOfRangeSense(35)),
      rawCompletionFault(35, "always", descriptorOutOfRangeSense(35)),
    ].join(","),
  ],
  [
    "conflicting-initiating-evidence",
    rawTailCompletionFault(
      35,
      "always",
      descriptorOutOfRangeSense(35),
    ),
  ],
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
  ["fixed-no-seek-complete", fixedNoSeekCompleteSense(5)],
  ["descriptor-no-seek-complete", descriptorNoSeekCompleteSense(5)],
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

const boundaryDriveA = runTestCopy(
  "cross-drive-boundary-drive-a",
  rawTailCompletionFault(35, "always", fixedOutOfRangeSense(35)),
);
const boundaryRescueIdentity = statSync(boundaryDriveA.outputPath);
const boundaryMatchingDrive = runTestBoundaryResume(
  boundaryDriveA.outputPath,
  "none",
  35 * 2_048,
);
if (
  boundaryMatchingDrive.status !== 0 ||
  !readFileSync(boundaryDriveA.outputPath).equals(content) ||
  recoveryResult(boundaryMatchingDrive.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(boundaryMatchingDrive.stderr)) !==
    JSON.stringify([{ lba: 35, blocks: 5 }]) ||
  statSync(boundaryDriveA.outputPath).dev !== boundaryRescueIdentity.dev ||
  statSync(boundaryDriveA.outputPath).ino !== boundaryRescueIdentity.ino
) {
  throw new Error(
    `libdvdcss cross-drive boundary continuation check failed: ${boundaryMatchingDrive.stderr}`,
  );
}

const rolledBackBoundary = runTestCopy(
  "rolled-back-boundary-initial",
  rawTailCompletionFault(35, "always", fixedOutOfRangeSense(35)),
);
const committedBoundaryByteCount = 35 * 2_048;
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
    JSON.stringify([{ lba: 35, blocks: 5 }])
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

const transientNoSeekComplete = runTestCopy(
  "transient-no-seek-complete",
  rawCompletionFault(5, 1, fixedNoSeekCompleteSense(5)),
);
if (
  transientNoSeekComplete.status !== 0 ||
  !readFileSync(transientNoSeekComplete.outputPath).equals(content) ||
  recoveryResult(transientNoSeekComplete.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(transientNoSeekComplete.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
    ])
) {
  throw new Error(
    `libdvdcss transient no-seek-complete check failed: ${transientNoSeekComplete.stderr}`,
  );
}

const transientFixedMediumWithActualRetryCount = runTestCopy(
  "transient-fixed-medium-with-actual-retry-count",
  rawCompletionFault(5, 1, fixedMediumSenseWithActualRetryCount(5, 2)),
);
if (
  transientFixedMediumWithActualRetryCount.status !== 0 ||
  !readFileSync(transientFixedMediumWithActualRetryCount.outputPath).equals(
    content,
  ) ||
  recoveryResult(transientFixedMediumWithActualRetryCount.stderr)
      .badSectorCount !== 0 ||
  JSON.stringify(testReads(transientFixedMediumWithActualRetryCount.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
    ])
) {
  throw new Error(
    `libdvdcss fixed medium actual retry count check failed: ${transientFixedMediumWithActualRetryCount.stderr}`,
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
      classifierVersion: "scsi-read-classifier-v2",
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
    rawTailCompletionFault(35, "always", sense),
  );
  const result = readFailureResult(outOfRange.stderr);
  if (
    outOfRange.status !== 3 ||
    statSync(outOfRange.outputPath).size !== 35 * 2_048 ||
    !readFileSync(outOfRange.outputPath).equals(
      content.subarray(0, 35 * 2_048),
    ) ||
    outOfRange.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(outOfRange.stderr)) !==
      JSON.stringify([
        { lba: 0, blocks: 31 },
        { lba: 31, blocks: 9 },
        { lba: 31, blocks: 4 },
        { lba: 34, blocks: 1 },
        { lba: 35, blocks: 1 },
        { lba: 35, blocks: 1 },
        { lba: 36, blocks: 1 },
        { lba: 39, blocks: 1 },
      ]) ||
    result.category !== "out_of_range" ||
    result.boundaryProofVersion !== "dvd-sector-boundary-proof-v1" ||
    result.candidateConfirmationCount !== 2 ||
    result.precedingSectorLba !== 34 ||
    result.declaredByteCount !== content.byteLength ||
    result.firstFailingLba !== 35 ||
    result.retainedImageByteCount !== 35 * 2_048 ||
    result.informationLba !== 35 ||
    result.requestedLba !== 35 ||
    result.requestedBlockCount !== 1 ||
    result.retryOrdinal !== 1
  ) {
    throw new Error(
      `libdvdcss ${name} boundary check failed: ${outOfRange.stderr}`,
    );
  }
}

for (const [name, precedingFault] of [
  [
    "unreadable-preceding-sector",
    rawRequestCompletionFault(34, "always", fixedMediumSense(34)),
  ],
  ["mismatched-preceding-sector", corruptRequestFault(34, "always")],
]) {
  const invalidPrecedingSector = runTestCopy(
    name,
    [
      rawCompletionFault(35, 1, fixedOutOfRangeSense(35)),
      precedingFault,
    ].join(","),
  );
  const result = readFailureResult(invalidPrecedingSector.stderr);
  if (
    invalidPrecedingSector.status !== 3 ||
    result.category !== "out_of_range" ||
    result.boundaryProofVersion !== undefined ||
    result.firstFailingLba !== 35 ||
    result.retainedImageByteCount !== 35 * 2_048 ||
    statSync(invalidPrecedingSector.outputPath).size !== 35 * 2_048 ||
    !readFileSync(invalidPrecedingSector.outputPath).equals(
      content.subarray(0, 35 * 2_048),
    ) ||
    invalidPrecedingSector.stderr.includes(recoveryResultPrefix) ||
    JSON.stringify(testReads(invalidPrecedingSector.stderr)) !==
      JSON.stringify([
        { lba: 0, blocks: 31 },
        { lba: 31, blocks: 9 },
        { lba: 31, blocks: 4 },
        { lba: 34, blocks: 1 },
      ])
  ) {
    throw new Error(
      `libdvdcss ${name} boundary check failed: ${invalidPrecedingSector.stderr}`,
    );
  }
}

const readableAboveCandidate = runTestCopy(
  "readable-above-boundary-candidate",
  rawCompletionFault(35, "always", fixedOutOfRangeSense(35)),
);
const readableAboveCandidateResult = readFailureResult(
  readableAboveCandidate.stderr,
);
if (
  readableAboveCandidate.status !== 3 ||
  readableAboveCandidateResult.category !== "out_of_range" ||
  readableAboveCandidateResult.boundaryProofVersion !== undefined ||
  readableAboveCandidateResult.retainedImageByteCount !== 35 * 2_048 ||
  JSON.stringify(testReads(readableAboveCandidate.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
      { lba: 31, blocks: 4 },
      { lba: 34, blocks: 1 },
      { lba: 35, blocks: 1 },
      { lba: 35, blocks: 1 },
      { lba: 36, blocks: 1 },
    ]) ||
  readableAboveCandidate.stderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss readable-above boundary check failed: ${readableAboveCandidate.stderr}`,
  );
}

const transientOutOfRange = runTestCopy(
  "transient-out-of-range-candidate",
  rawCompletionFault(35, 1, fixedOutOfRangeSense(35)),
);
const transientOutOfRangeResult = readFailureResult(
  transientOutOfRange.stderr,
);
if (
  transientOutOfRange.status !== 3 ||
  transientOutOfRangeResult.category !== "out_of_range" ||
  transientOutOfRangeResult.boundaryProofVersion !== undefined ||
  transientOutOfRangeResult.firstFailingLba !== 35 ||
  transientOutOfRangeResult.retainedImageByteCount !== 35 * 2_048 ||
  statSync(transientOutOfRange.outputPath).size !== 35 * 2_048 ||
  transientOutOfRange.stderr.includes(recoveryResultPrefix) ||
  JSON.stringify(testReads(transientOutOfRange.stderr)) !==
    JSON.stringify([
      { lba: 0, blocks: 31 },
      { lba: 31, blocks: 9 },
      { lba: 31, blocks: 4 },
      { lba: 34, blocks: 1 },
      { lba: 35, blocks: 1 },
    ])
) {
  throw new Error(
    `libdvdcss transient boundary proof check failed: ${transientOutOfRange.stderr}`,
  );
}

for (const [name, candidateFaults] of invalidBoundaryProbeFaults) {
  const invalidProbe = runTestCopy(
    `invalid-boundary-probe-${name}`,
    [
      rawCompletionFault(35, 1, fixedOutOfRangeSense(35)),
      candidateFaults,
    ].join(","),
  );
  const result = readFailureResult(invalidProbe.stderr);
  if (
    invalidProbe.status !== 3 ||
    result.category !== "out_of_range" ||
    result.boundaryProofVersion !== undefined ||
    result.firstFailingLba !== 35 ||
    result.retainedImageByteCount !== 35 * 2_048 ||
    statSync(invalidProbe.outputPath).size !== 35 * 2_048 ||
    invalidProbe.stderr.includes(recoveryResultPrefix) ||
    testReads(invalidProbe.stderr).length !==
      (name.endsWith("confirmations") ? 6 : 5)
  ) {
    throw new Error(
      `libdvdcss ${name} invalid boundary probe check failed: ${invalidProbe.stderr}`,
    );
  }
}

const damagedThenBoundary = runTestCopy(
  "medium-then-out-of-range",
  [
    rawCompletionFault(5, "always", fixedMediumAtFive),
    rawTailCompletionFault(35, "always", fixedOutOfRangeSense(35)),
  ].join(","),
);
const damagedThenBoundaryResult = readFailureResult(
  damagedThenBoundary.stderr,
);
const damagedBoundaryImage = Buffer.from(content.subarray(0, 35 * 2_048));
damagedBoundaryImage.fill(0, 5 * 2_048, 6 * 2_048);
if (
  damagedThenBoundary.status !== 3 ||
  damagedThenBoundaryResult.protocolVersion !== 2 ||
  damagedThenBoundaryResult.category !== "out_of_range" ||
  damagedThenBoundaryResult.boundaryProofVersion !==
    "dvd-sector-boundary-proof-v1" ||
  damagedThenBoundaryResult.firstFailingLba !== 35 ||
  damagedThenBoundaryResult.retainedImageByteCount !== 35 * 2_048 ||
  damagedThenBoundaryResult.recoveryProtocol?.badSectorCount !== 1 ||
  damagedThenBoundaryResult.recoveryProtocol?.badAreaCount !== 1 ||
  damagedThenBoundaryResult.recoveryProtocol?.badSectorBitmapHex !==
    "2000000000" ||
  statSync(damagedThenBoundary.outputPath).size !== 35 * 2_048 ||
  !readFileSync(damagedThenBoundary.outputPath).equals(
    damagedBoundaryImage,
  ) ||
  damagedThenBoundary.stderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss damaged boundary composition check failed: ${damagedThenBoundary.stderr}`,
  );
}

const sameRequestDamagedThenBoundary = runTestCopy(
  "same-request-medium-then-out-of-range",
  [
    rawCompletionFault(5, "always", fixedMediumAtFive),
    rawTailCompletionFault(20, "always", fixedOutOfRangeSense(20)),
  ].join(","),
);
const sameRequestDamagedThenBoundaryResult = readFailureResult(
  sameRequestDamagedThenBoundary.stderr,
);
const sameRequestDamagedBoundaryImage = Buffer.from(
  content.subarray(0, 20 * 2_048),
);
sameRequestDamagedBoundaryImage.fill(0, 5 * 2_048, 6 * 2_048);
if (
  sameRequestDamagedThenBoundary.status !== 3 ||
  sameRequestDamagedThenBoundaryResult.protocolVersion !== 2 ||
  sameRequestDamagedThenBoundaryResult.category !== "out_of_range" ||
  sameRequestDamagedThenBoundaryResult.boundaryProofVersion !==
    "dvd-sector-boundary-proof-v1" ||
  sameRequestDamagedThenBoundaryResult.firstFailingLba !== 20 ||
  sameRequestDamagedThenBoundaryResult.retainedImageByteCount !== 20 * 2_048 ||
  sameRequestDamagedThenBoundaryResult.recoveryProtocol?.badSectorCount !== 1 ||
  sameRequestDamagedThenBoundaryResult.recoveryProtocol?.badAreaCount !== 1 ||
  sameRequestDamagedThenBoundaryResult.recoveryProtocol?.badSectorBitmapHex !==
    "2000000000" ||
  statSync(sameRequestDamagedThenBoundary.outputPath).size !== 20 * 2_048 ||
  !readFileSync(sameRequestDamagedThenBoundary.outputPath).equals(
    sameRequestDamagedBoundaryImage,
  ) ||
  sameRequestDamagedThenBoundary.stderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss same-request damaged boundary composition check failed: ${sameRequestDamagedThenBoundary.stderr}`,
  );
}

const conflictingSameRequestBoundary = runTestCopy(
  "conflicting-same-request-medium-boundary",
  [
    rawCompletionFault(5, "always", fixedMediumAtFive),
    rawCompletionFault(20, 1, fixedMediumSense(20)),
    rawTailCompletionFault(20, "always", fixedOutOfRangeSense(20)),
  ].join(","),
);
const conflictingSameRequestBoundaryResult = readFailureResult(
  conflictingSameRequestBoundary.stderr,
);
if (
  conflictingSameRequestBoundary.status !== 3 ||
  conflictingSameRequestBoundaryResult.protocolVersion !== 1 ||
  conflictingSameRequestBoundaryResult.category !== "out_of_range" ||
  conflictingSameRequestBoundaryResult.boundaryProofVersion !== undefined ||
  conflictingSameRequestBoundaryResult.firstFailingLba !== 20 ||
  conflictingSameRequestBoundaryResult.retainedImageByteCount !== 5 * 2_048 ||
  statSync(conflictingSameRequestBoundary.outputPath).size !== 5 * 2_048 ||
  conflictingSameRequestBoundary.stderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss conflicting same-request boundary check failed: ${conflictingSameRequestBoundary.stderr}`,
  );
}

for (const excludedSectorCount of [114_301, 73_400]) {
  const boundaryLba = content.byteLength / 2_048;
  const declaredSectorCount = boundaryLba + excludedSectorCount;
  const outOfRange = runTestCopyWithDeclaredSectors(
    `out-of-range-suffix-${excludedSectorCount}`,
    rawTailCompletionFault(
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
    result.boundaryProofVersion !== "dvd-sector-boundary-proof-v1" ||
    result.candidateConfirmationCount !== 2 ||
    result.precedingSectorLba !== boundaryLba - 1 ||
    result.declaredByteCount !== declaredSectorCount * 2_048 ||
    result.retainedImageByteCount !== statSync(outOfRange.outputPath).size ||
    testReads(outOfRange.stderr).length !== 8 ||
    outOfRange.stderr.includes(recoveryResultPrefix)
  ) {
    throw new Error(
      `libdvdcss ${excludedSectorCount}-sector suffix regression failed: ${outOfRange.stderr}`,
    );
  }
}

const optionalMediumSenseFixtures = [
  [
    "fixed-captured-truncated-record",
    rawCompletionFault(5, "always", "f00003000000050a000000001100"),
  ],
  [
    "fixed-fourteen-byte-record",
    rawCompletionFault(5, "always", "f000030000000506000000001100"),
  ],
  [
    "fixed-undeclared-trailing-byte",
    rawCompletionFault(5, "always", `${fixedMediumAtFive}ff`),
  ],
  [
    "descriptor-undeclared-trailing-byte",
    rawCompletionFault(5, "always", `${descriptorMediumAtFive}ff`),
  ],
  [
    "fixed-sdat-overflow",
    rawCompletionFault(
      5,
      "always",
      "f00013000000050a00000000110000000000",
    ),
  ],
  [
    "fixed-sense-key-specific-data",
    rawCompletionFault(
      5,
      "always",
      "f00003000000050a00000000110000400000",
    ),
  ],
  [
    "fixed-declared-vendor-byte",
    rawCompletionFault(
      5,
      "always",
      "f00003000000050b00000000110000000000ff",
    ),
  ],
  [
    "fixed-command-specific-information",
    rawCompletionFault(
      5,
      "always",
      "f00003000000050a01000000110000000000",
    ),
  ],
  [
    "fixed-obsolete-flags-and-fru",
    rawCompletionFault(
      5,
      "always",
      "f0ffe3000000050a0000000011007f000000",
    ),
  ],
  [
    "fixed-invalid-information",
    rawCompletionFault(
      5,
      "always",
      "700003000000050a00000000110000000000",
    ),
  ],
  [
    "fixed-medium-with-out-of-range-asc",
    rawCompletionFault(
      5,
      "always",
      "f00003000000050a00000000210000000000",
    ),
  ],
  [
    "fixed-unfamiliar-asc",
    rawCompletionFault(
      5,
      "always",
      "f00003000000050a000000007f7f00000000",
    ),
  ],
  [
    "driver-status-reserved-upper-bit",
    rawCompletionFault(5, "always", fixedMediumAtFive, {
      driverStatus: 0x108,
    }),
  ],
  [
    "driver-status-sense-suggestion",
    rawCompletionFault(5, "always", fixedMediumAtFive, {
      driverStatus: 0x28,
    }),
  ],
  [
    "masked-check-condition",
    rawCompletionFault(5, "always", fixedMediumAtFive, { scsiStatus: 3 }),
  ],
  [
    "descriptor-vendor-descriptor",
    rawCompletionFault(5, "always", "72031100000000027f00"),
  ],
  [
    "descriptor-vendor-before-information",
    rawCompletionFault(
      5,
      "always",
      "720311000000000e8000000a80000000000000000005",
    ),
  ],
  [
    "descriptor-sdat-overflow",
    rawCompletionFault(
      5,
      "always",
      "720311008000000c000a80000000000000000005",
    ),
  ],
  [
    "descriptor-header-byte-5",
    rawCompletionFault(
      5,
      "always",
      "720311000001000c000a80000000000000000005",
    ),
  ],
  [
    "descriptor-header-byte-6",
    rawCompletionFault(
      5,
      "always",
      "720311000000010c000a80000000000000000005",
    ),
  ],
  [
    "descriptor-information-flags",
    rawCompletionFault(
      5,
      "always",
      "720311000000000c000a81000000000000000005",
    ),
  ],
  [
    "descriptor-invalid-information",
    rawCompletionFault(
      5,
      "always",
      "720311000000000c000a00000000000000000005",
    ),
  ],
  [
    "descriptor-medium-with-out-of-range-asc",
    rawCompletionFault(
      5,
      "always",
      "720321000000000c000a80000000000000000005",
    ),
  ],
  [
    "descriptor-unfamiliar-asc",
    rawCompletionFault(
      5,
      "always",
      "72037f7f0000000c000a80000000000000000005",
    ),
  ],
  [
    "descriptor-information-byte-3",
    rawCompletionFault(
      5,
      "always",
      "720311000000000c000a80010000000000000005",
    ),
  ],
  [
    "descriptor-truncated-descriptor",
    rawCompletionFault(5, "always", "7203110000000004000a"),
  ],
  [
    "descriptor-duplicate-information",
    rawCompletionFault(
      5,
      "always",
      "7203110000000018000a80000000000000000005000a80000000000000000005",
    ),
  ],
  [
    "descriptor-information-among-standard-descriptors",
    rawCompletionFault(
      5,
      "always",
      descriptorMediumSenseWithPeripheralDescriptors(5, 1),
    ),
  ],
  [
    "descriptor-information-after-standard-descriptors",
    rawCompletionFault(
      5,
      "always",
      descriptorMediumSenseWithPeripheralDescriptors(5, 3),
    ),
  ],
];
for (const [name, fault] of optionalMediumSenseFixtures) {
  const recovered = runTestCopy(`recover-${name}`, fault);
  const result = recoveryResult(recovered.stderr);
  if (
    recovered.status !== 0 ||
    result.badSectorCount !== 1 ||
    JSON.stringify(badSectorRanges(result, 40)) !==
      JSON.stringify([{ startLba: 5, sectorCount: 1 }])
  ) {
    throw new Error(
      `libdvdcss ${name} optional medium sense check failed: ${recovered.stderr}`,
    );
  }
}

const malformedUnknownFixtures = [
  ["missing", "generic@5@always"],
  ["empty", "raw@5@always@2@0@8@0@-"],
  ["descriptor-core-too-short", "raw@5@always@2@0@8@2@7203"],
  ["truncated", "raw@5@always@2@0@8@7@70000300000000"],
  ["oversized", "raw@5@always@2@0@8@253@-"],
  ["inconsistent", "raw@5@always@2@0@8@8@700003000000000a"],
  [
    "fixed-declared-length-excludes-asc",
    "raw@5@always@2@0@8@14@f000030000000504000000001100",
  ],
  ["unsupported", "raw@5@always@2@0@8@1@7f"],
  [
    "fixed-deferred-medium",
    "raw@5@always@2@0@8@18@710003000000050a00000000110000000000",
  ],
  [
    "descriptor-deferred-medium",
    "raw@5@always@2@0@8@20@730311000000000c000a80000000000000000005",
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
    result.classifierVersion !== "scsi-read-classifier-v2" ||
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
  const unlocatedMedium = runTestCopy(
    `recover-${name}-out-of-request-information-lba`,
    `raw@35@always@2@0@8@${sense.length / 2}@${sense}`,
  );
  const result = recoveryResult(unlocatedMedium.stderr);
  if (
    unlocatedMedium.status !== 0 ||
    result.badSectorCount !== 1 ||
    JSON.stringify(badSectorRanges(result, 40)) !==
      JSON.stringify([{ startLba: 35, sectorCount: 1 }])
  ) {
    throw new Error(
      `libdvdcss out-of-request ${name} information check failed: ${unlocatedMedium.stderr}`,
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

const driveACompletionSet = [
  rawCompletionFault(5, "always", fixedMediumSense(5)),
  rawCompletionFault(9, "always", descriptorMediumSense(9)),
].join(",");
const driveA = runTestCopy("cross-drive-rescue-drive-a", driveACompletionSet);
const driveAResult = recoveryResult(driveA.stderr);
const sharedRescueIdentity = statSync(driveA.outputPath);
if (
  driveA.status !== 0 ||
  JSON.stringify(badSectorRanges(driveAResult, 40)) !==
    JSON.stringify([
      { startLba: 5, sectorCount: 1 },
      { startLba: 9, sectorCount: 1 },
    ])
) {
  throw new Error(
    `libdvdcss cross-drive initial rescue check failed: ${driveA.stderr}`,
  );
}

const driveBCompletionSet = rawCompletionFault(
  9,
  "always",
  fixedMediumSense(9),
);
const driveB = runTestResume(
  driveA.outputPath,
  driveBCompletionSet,
  driveAResult.badSectorBitmapHex,
);
const driveBResult = recoveryResult(driveB.stderr);
const driveBImage = readFileSync(driveA.outputPath);
if (
  driveB.status !== 0 ||
  JSON.stringify(badSectorRanges(driveBResult, 40)) !==
    JSON.stringify([{ startLba: 9, sectorCount: 1 }]) ||
  JSON.stringify(testReads(driveB.stderr)) !==
    JSON.stringify([
      { lba: 5, blocks: 1 },
      { lba: 9, blocks: 1 },
      { lba: 9, blocks: 1 },
    ]) ||
  !driveBImage.subarray(5 * 2_048, 6 * 2_048)
    .equals(content.subarray(5 * 2_048, 6 * 2_048)) ||
  !driveBImage.subarray(9 * 2_048, 10 * 2_048).equals(Buffer.alloc(2_048)) ||
  statSync(driveA.outputPath).dev !== sharedRescueIdentity.dev ||
  statSync(driveA.outputPath).ino !== sharedRescueIdentity.ino
) {
  throw new Error(
    `libdvdcss cross-drive partial rescue check failed: ${driveB.stderr}`,
  );
}

const finalMatchingDrive = runTestResume(
  driveA.outputPath,
  "none",
  driveBResult.badSectorBitmapHex,
);
if (
  finalMatchingDrive.status !== 0 ||
  !readFileSync(driveA.outputPath).equals(content) ||
  recoveryResult(finalMatchingDrive.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(finalMatchingDrive.stderr)) !==
    JSON.stringify([{ lba: 9, blocks: 1 }]) ||
  statSync(driveA.outputPath).dev !== sharedRescueIdentity.dev ||
  statSync(driveA.outputPath).ino !== sharedRescueIdentity.ino
) {
  throw new Error(
    `libdvdcss cross-drive complete rescue check failed: ${finalMatchingDrive.stderr}`,
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
    JSON.stringify([
      { lba: 5, blocks: 1 },
      { lba: 4, blocks: 1 },
      { lba: 5, blocks: 1 },
      { lba: 5, blocks: 1 },
      { lba: 6, blocks: 1 },
    ]) ||
  outOfRangeResumeResult.category !== "out_of_range" ||
  outOfRangeResumeResult.firstFailingLba !== 5 ||
  outOfRangeResumeResult.declaredByteCount !== content.byteLength ||
  outOfRangeResumeResult.retainedImageByteCount !== content.byteLength
) {
  throw new Error(
    `libdvdcss out-of-range resume check failed: ${outOfRangeResume.stderr}`,
  );
}

const conflictingOutOfRangeResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-conflicting-out-of-range-resume.img",
);
writeFileSync(conflictingOutOfRangeResumePath, unknownResumeContent);
const conflictingOutOfRangeResume = runTestResume(
  conflictingOutOfRangeResumePath,
  [
    rawCompletionFault(5, 1, fixedMediumAtFive),
    rawCompletionFault(5, "always", fixedOutOfRangeSense(5)),
  ].join(","),
  isolatedResult.badSectorBitmapHex,
);
const conflictingOutOfRangeResumeResult = readFailureResult(
  conflictingOutOfRangeResume.stderr,
);
if (
  conflictingOutOfRangeResume.status !== 3 ||
  !readFileSync(conflictingOutOfRangeResumePath).equals(unknownResumeContent) ||
  conflictingOutOfRangeResume.stderr.includes(recoveryResultPrefix) ||
  JSON.stringify(testReads(conflictingOutOfRangeResume.stderr)) !==
    JSON.stringify([
      { lba: 5, blocks: 1 },
      { lba: 5, blocks: 1 },
    ]) ||
  conflictingOutOfRangeResumeResult.protocolVersion !== 1 ||
  conflictingOutOfRangeResumeResult.category !== "out_of_range" ||
  conflictingOutOfRangeResumeResult.boundaryProofVersion !== undefined ||
  conflictingOutOfRangeResumeResult.firstFailingLba !== 5 ||
  conflictingOutOfRangeResumeResult.retainedImageByteCount !==
    content.byteLength
) {
  throw new Error(
    `libdvdcss conflicting out-of-range resume check failed: ${conflictingOutOfRangeResume.stderr}`,
  );
}

const legacyBoundaryResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-legacy-boundary-resume.img",
);
const legacyBoundaryResumeContent = Buffer.from(content);
legacyBoundaryResumeContent.fill(0, 5 * 2_048, 6 * 2_048);
legacyBoundaryResumeContent.fill(0, 35 * 2_048, 36 * 2_048);
writeFileSync(legacyBoundaryResumePath, legacyBoundaryResumeContent);
const legacyBoundaryBitmap = Buffer.alloc(content.byteLength / 2_048 / 8);
legacyBoundaryBitmap[0] = 1 << 5;
legacyBoundaryBitmap[4] = 1 << 3;
const legacyBoundaryResume = runTestResume(
  legacyBoundaryResumePath,
  [
    rawCompletionFault(5, "always", fixedMediumAtFive),
    rawTailCompletionFault(35, "always", fixedOutOfRangeSense(35)),
  ].join(","),
  legacyBoundaryBitmap.toString("hex"),
);
const legacyBoundaryResult = readFailureResult(legacyBoundaryResume.stderr);
if (
  legacyBoundaryResume.status !== 3 ||
  !readFileSync(legacyBoundaryResumePath).equals(legacyBoundaryResumeContent) ||
  legacyBoundaryResult.protocolVersion !== 2 ||
  legacyBoundaryResult.category !== "out_of_range" ||
  legacyBoundaryResult.boundaryProofVersion !==
    "dvd-sector-boundary-proof-v1" ||
  legacyBoundaryResult.firstFailingLba !== 35 ||
  legacyBoundaryResult.retainedImageByteCount !== 35 * 2_048 ||
  legacyBoundaryResult.recoveryProtocol?.badSectorCount !== 1 ||
  legacyBoundaryResult.recoveryProtocol?.badAreaCount !== 1 ||
  legacyBoundaryResult.recoveryProtocol?.badSectorBitmapHex !==
    "2000000000" ||
  legacyBoundaryResume.stderr.includes(recoveryResultPrefix) ||
  JSON.stringify(testReads(legacyBoundaryResume.stderr)) !==
    JSON.stringify([
      { lba: 5, blocks: 1 },
      { lba: 5, blocks: 1 },
      { lba: 35, blocks: 1 },
      { lba: 34, blocks: 1 },
      { lba: 35, blocks: 1 },
      { lba: 35, blocks: 1 },
      { lba: 36, blocks: 1 },
      { lba: 39, blocks: 1 },
    ])
) {
  throw new Error(
    `libdvdcss legacy damaged boundary resume check failed: ${legacyBoundaryResume.stderr}`,
  );
}

const recoveredLegacyBoundaryResumePath = prepareOutput(
  "/tmp/rip-dvd-reader-recovered-legacy-boundary-resume.img",
);
writeFileSync(recoveredLegacyBoundaryResumePath, legacyBoundaryResumeContent);
const recoveredLegacyBoundaryResume = runTestResume(
  recoveredLegacyBoundaryResumePath,
  rawTailCompletionFault(35, "always", fixedOutOfRangeSense(35)),
  legacyBoundaryBitmap.toString("hex"),
);
const recoveredLegacyBoundaryResult = readFailureResult(
  recoveredLegacyBoundaryResume.stderr,
);
if (
  recoveredLegacyBoundaryResume.status !== 3 ||
  recoveredLegacyBoundaryResult.protocolVersion !== 2 ||
  recoveredLegacyBoundaryResult.category !== "out_of_range" ||
  recoveredLegacyBoundaryResult.firstFailingLba !== 35 ||
  recoveredLegacyBoundaryResult.recoveryProtocol?.badSectorCount !== 0 ||
  recoveredLegacyBoundaryResult.recoveryProtocol?.badAreaCount !== 0 ||
  recoveredLegacyBoundaryResult.recoveryProtocol?.recoveredByteCount !==
    content.byteLength ||
  recoveredLegacyBoundaryResult.recoveryProtocol?.badSectorBitmapHex !==
    "" ||
  !readFileSync(recoveredLegacyBoundaryResumePath)
    .subarray(5 * 2_048, 6 * 2_048)
    .equals(content.subarray(5 * 2_048, 6 * 2_048)) ||
  recoveredLegacyBoundaryResume.stderr.includes(recoveryResultPrefix)
) {
  throw new Error(
    `libdvdcss recovered legacy boundary resume check failed: ${recoveredLegacyBoundaryResume.stderr}`,
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
