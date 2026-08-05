import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(
  new URL("../src/native/atomic-exchange.c", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("../dist/rip-dvd-atomic-exchange", import.meta.url),
);
mkdirSync(dirname(outputPath), { recursive: true });

const compilation = spawnSync(
  process.env.CC || "cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    sourcePath,
    "-o",
    outputPath,
  ],
  {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (compilation.error) {
  throw compilation.error;
}
if (compilation.status !== 0) {
  throw new Error(
    `Atomic exchange helper compilation failed: ${compilation.stderr.trim()}`,
  );
}
chmodSync(outputPath, 0o755);
