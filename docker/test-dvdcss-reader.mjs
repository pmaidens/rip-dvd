import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const executable = "/usr/local/bin/rip-dvd-dvdcss-reader";
const sourcePath = "/tmp/rip-dvd-reader-source.img";
const copyPath = "/tmp/rip-dvd-reader-copy.img";
const content = Buffer.alloc(40 * 2_048);
for (let index = 0; index < content.length; index += 1) {
  content[index] = index % 251;
}
writeFileSync(sourcePath, content);

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

const copy = spawnSync(
  executable,
  ["copy", sourcePath, copyPath, String(content.byteLength)],
  { encoding: "utf8" },
);
const progress = copy.stderr.trim().split("\n");
if (
  copy.status !== 0 ||
  !readFileSync(copyPath).equals(content) ||
  progress.length !== 2 ||
  progress.at(-1) !== `${content.byteLength} bytes copied`
) {
  throw new Error(`libdvdcss reader copy check failed: ${copy.stderr}`);
}

const authorizedCopyPath = "/tmp/rip-dvd-reader-authorized-copy.img";
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

const invalid = spawnSync(executable, ["hash", sourcePath, "4095"], {
  encoding: "utf8",
});
if (invalid.status !== 2 || !invalid.stderr.includes("size is invalid")) {
  throw new Error("libdvdcss reader accepted a partial DVD block");
}
