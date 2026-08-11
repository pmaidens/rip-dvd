// @ts-check

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { createRawDvdContentIdHasher } from "@rip-dvd/data-access/dvd-content-id";

import { requireDvdContentSize } from "./dvd-content-policy.js";

const DVD_CONTENT_READ_BUFFER_BYTES = 1_048_576;

/**
 * Hash every declared raw-disc byte. Running this in a helper process keeps a
 * kernel-blocked device open or read outside the archive worker's event loop.
 *
 * @param {string} devicePath
 * @param {number} sizeBytes
 * @param {typeof fs} [fileSystem]
 */
export function hashDiscContent(devicePath, sizeBytes, fileSystem = fs) {
  const safeSizeBytes = requireDvdContentSize(sizeBytes);
  const descriptor = fileSystem.openSync(devicePath, fileSystem.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(
    Math.min(DVD_CONTENT_READ_BUFFER_BYTES, safeSizeBytes),
  );
  const hasher = createRawDvdContentIdHasher(safeSizeBytes);
  let bytesRead = 0;
  try {
    while (bytesRead < safeSizeBytes) {
      const count = fileSystem.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, safeSizeBytes - bytesRead),
        null,
      );
      if (count === 0) {
        throw new Error("DVD content read ended before the declared media size");
      }
      hasher.update(buffer.subarray(0, count));
      bytesRead += count;
    }
  } finally {
    fileSystem.closeSync(descriptor);
  }
  return hasher.digest();
}

function runFromCommandLine() {
  const [devicePath, sizeText] = process.argv.slice(2);
  const sizeBytes = Number(sizeText);
  if (devicePath === undefined || !Number.isSafeInteger(sizeBytes)) {
    process.stderr.write("DVD content probe arguments are invalid\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(hashDiscContent(devicePath, sizeBytes));
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
