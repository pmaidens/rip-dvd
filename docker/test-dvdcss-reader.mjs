import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

const executable = "/usr/local/bin/rip-dvd-dvdcss-reader";
const testExecutable = "/tmp/rip-dvd-dvdcss-reader-test";
const sourcePath = "/tmp/rip-dvd-reader-source.img";
const recoveryResultPrefix = "rip-dvd-recovery-result ";
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

const invalid = spawnSync(executable, ["hash", sourcePath, "4095"], {
  encoding: "utf8",
});
if (invalid.status !== 2 || !invalid.stderr.includes("size is invalid")) {
  throw new Error("libdvdcss reader accepted a partial DVD block");
}
