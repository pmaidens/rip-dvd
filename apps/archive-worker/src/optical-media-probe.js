// @ts-check

import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{
 *   closeSync(descriptor: number): void;
 *   openSync(path: string, flags: number): number;
 *   readFileSync(path: string, encoding: "utf8"): string;
 * }} ActiveMediaProbeFileSystem
 */

/**
 * Open an Optical Drive to force Linux to check media state, then read the
 * resulting monotonic disk sequence while the device handle is still open.
 *
 * @param {string} devicePath
 * @param {number} flags
 * @param {string} generationPath
 * @param {ActiveMediaProbeFileSystem} [fileSystem]
 */
export function readActiveMediaGeneration(
  devicePath,
  flags,
  generationPath,
  fileSystem = fs,
) {
  const descriptor = fileSystem.openSync(devicePath, flags);
  try {
    return fileSystem.readFileSync(generationPath, "utf8");
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function runFromCommandLine() {
  const [devicePath, flagsText, generationPath] = process.argv.slice(2);
  const flags = Number(flagsText);
  if (
    devicePath === undefined ||
    generationPath === undefined ||
    !Number.isSafeInteger(flags)
  ) {
    process.stderr.write("Optical Drive media probe arguments are invalid\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(
      readActiveMediaGeneration(devicePath, flags, generationPath),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runFromCommandLine();
}
