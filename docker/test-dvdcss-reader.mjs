import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

const executable = "/usr/local/bin/rip-dvd-dvdcss-reader";
const testExecutable = "/tmp/rip-dvd-dvdcss-reader-test";
const sourcePath = "/tmp/rip-dvd-reader-source.img";
const recoveryResultPrefix = "rip-dvd-recovery-result ";
const readFailureResultPrefix = "rip-dvd-read-failure ";
const fixedMediumSense = "f00003000000050a00000000110000000000";
const descriptorMediumSense = "720311000000000c000a80000000000000000005";
const content = Buffer.alloc(40 * 2_048);
for (let index = 0; index < content.length; index += 1) {
  content[index] = index % 251;
}
writeFileSync(sourcePath, content);

function prepareOutput(path) {
  rmSync(path, { force: true });
  return path;
}

function recoveryResult(stderr) {
  const lines = stderr.trim().split("\n");
  const results = lines.filter((line) =>
    line.startsWith(recoveryResultPrefix)
  );
  if (results.length !== 1) {
    throw new Error(`expected one recovery result, received: ${stderr}`);
  }
  return JSON.parse(results[0].slice(recoveryResultPrefix.length));
}

function readFailureResult(stderr) {
  const lines = stderr.trim().split("\n");
  const results = lines.filter((line) =>
    line.startsWith(readFailureResultPrefix)
  );
  if (results.length !== 1) {
    throw new Error(`expected one read failure result, received: ${stderr}`);
  }
  return JSON.parse(results[0].slice(readFailureResultPrefix.length));
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

const retry = runTestCopy("retry", "5:1");
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
  ["fixed-medium", fixedMediumSense],
  ["descriptor-medium", descriptorMediumSense],
]) {
  const exactMedium = runTestCopy(
    name,
    `raw@5@always@2@0@8@${sense.length / 2}@${sense}`,
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

const transientExactMedium = runTestCopy(
  "transient-exact-medium",
  `raw@5@1@2@0@8@${fixedMediumSense.length / 2}@${fixedMediumSense}`,
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

const fixedUnknownSense = "f00005000000050a00000000210000000000";
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
      asc: 33,
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

const malformedUnknownFixtures = [
  ["missing", "generic@5@always"],
  ["empty", "raw@5@always@2@0@8@0@-"],
  ["truncated", "raw@5@always@2@0@8@7@70000300000000"],
  ["oversized", "raw@5@always@2@0@8@253@-"],
  ["inconsistent", "raw@5@always@2@0@8@8@700003000000000a"],
  [
    "fixed-declared-length-excludes-asc",
    "raw@5@always@2@0@8@14@f000030000000504000000001100",
  ],
  ["unsupported", "raw@5@always@2@0@8@1@7f"],
  [
    "descriptor-response-reserved-bit",
    "raw@5@always@2@0@8@8@f203110000000000",
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
    "descriptor-reserved-byte",
    "raw@5@always@2@0@8@20@720311000000000c000a80010000000000000005",
  ],
  [
    "contradictory",
    `raw@5@always@0@0@0@${fixedMediumSense.length / 2}@${fixedMediumSense}`,
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
  ["fixed", fixedMediumSense],
  ["descriptor", descriptorMediumSense],
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

const isolated = runTestCopy("isolated", "5:always");
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
  "5:always",
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
  "none",
  isolatedResult.badSectorBitmapHex,
);
if (
  resumed.status !== 0 ||
  !readFileSync(resumed.outputPath).equals(content) ||
  recoveryResult(resumed.stderr).badSectorCount !== 0 ||
  JSON.stringify(testReads(resumed.stderr)) !==
    JSON.stringify([{ lba: 5, blocks: 1 }])
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

const contiguous = runTestCopy("contiguous", "5:always,6:always");
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
    "100",
    "valid",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let cancellationStderr = "";
cancellation.stderr.on("data", (chunk) => {
  cancellationStderr += chunk.toString("utf8");
});
await once(cancellation.stderr, "data");
cancellation.kill("SIGTERM");
const [cancellationStatus, cancellationSignal] = await once(
  cancellation,
  "close",
);
if (
  cancellationStatus !== null ||
  cancellationSignal !== "SIGTERM" ||
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
await new Promise((resolve, reject) => {
  interruptedReadFailure.stderr.on("data", (chunk) => {
    interruptedReadFailureStderr += chunk.toString("utf8");
    if (interruptedReadFailureStderr.includes(readFailureResultPrefix)) {
      resolve();
    }
  });
  interruptedReadFailure.once("error", reject);
});
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
