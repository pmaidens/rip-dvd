import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(
  new URL("../src/native/atomic-exchange.c", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("../dist/rip-dvd-atomic-exchange.node", import.meta.url),
);
const temporaryOutputPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
mkdirSync(dirname(outputPath), { recursive: true });

const platformLinkerArguments =
  process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup"]
    : ["-shared", "-fPIC"];

const compilation = spawnSync(
  process.env.CC || "cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${resolve(dirname(process.execPath), "../include/node")}`,
    ...platformLinkerArguments,
    sourcePath,
    "-o",
    temporaryOutputPath,
  ],
  {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

try {
  if (compilation.error) {
    throw compilation.error;
  }
  if (compilation.status !== 0) {
    throw new Error(
      `Atomic exchange binding compilation failed: ${compilation.stderr.trim()}`,
    );
  }
  chmodSync(temporaryOutputPath, 0o755);
  renameSync(temporaryOutputPath, outputPath);
} finally {
  rmSync(temporaryOutputPath, { force: true });
}
