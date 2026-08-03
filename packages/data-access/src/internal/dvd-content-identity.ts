import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";

import { DomainInvariantError } from "../errors.js";

const DVD_CONTENT_HASH_DOMAIN = "rip-dvd-content-v2\0";
const MAX_DVD_CONTENT_BYTES = 9_000_000_000;
const MAX_ARCHIVE_PATH_BYTES = 4_096;
const HASH_BUFFER_BYTES = 1_048_576;

export interface DvdArchiveFileIdentity {
  changedAtNanoseconds: bigint;
  deviceId: bigint;
  inode: bigint;
  modifiedAtNanoseconds: bigint;
  sizeBytes: bigint;
}

export function isCurrentDvdContentSize(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_DVD_CONTENT_BYTES
  );
}

function requireDvdContentSize(value: number): number {
  if (!isCurrentDvdContentSize(value)) {
    throw new DomainInvariantError("DVD content size is invalid");
  }
  return value;
}

function requireCanonicalArchivePath(path: string): string {
  if (
    !isAbsolute(path) ||
    Buffer.byteLength(path) > MAX_ARCHIVE_PATH_BYTES ||
    realpathSync(path) !== normalize(path)
  ) {
    throw new DomainInvariantError("DVD archive path is unsafe");
  }
  return path;
}

export function readDvdArchiveFileSize(path: string): number {
  const safePath = requireCanonicalArchivePath(path);
  let descriptor: number | undefined;
  let primaryError: unknown;

  try {
    descriptor = openSync(
      safePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(safePath, { bigint: true });
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.size !== named.size
    ) {
      throw new DomainInvariantError(
        "DVD archive changed before its content size was read",
      );
    }
    return requireDvdContentSize(Number(opened.size));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (primaryError === undefined) {
          throw error;
        }
      }
    }
  }
}

function fileIdentity(
  metadata: BigIntStats,
): DvdArchiveFileIdentity {
  return {
    changedAtNanoseconds: metadata.ctimeNs,
    deviceId: metadata.dev,
    inode: metadata.ino,
    modifiedAtNanoseconds: metadata.mtimeNs,
    sizeBytes: metadata.size,
  };
}

function identitiesMatch(
  left: DvdArchiveFileIdentity,
  right: DvdArchiveFileIdentity,
): boolean {
  return (
    left.changedAtNanoseconds === right.changedAtNanoseconds &&
    left.deviceId === right.deviceId &&
    left.inode === right.inode &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.sizeBytes === right.sizeBytes
  );
}

export function hashDvdArchiveFile(
  path: string,
  expectedSizeBytes: number,
): { contentId: string; identity: DvdArchiveFileIdentity } {
  const safePath = requireCanonicalArchivePath(path);
  const safeSizeBytes = requireDvdContentSize(expectedSizeBytes);
  let descriptor: number | undefined;
  let primaryError: unknown;

  try {
    descriptor = openSync(
      safePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedBefore = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(safePath, { bigint: true });
    if (
      !openedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      openedBefore.dev !== namedBefore.dev ||
      openedBefore.ino !== namedBefore.ino ||
      openedBefore.size !== BigInt(safeSizeBytes)
    ) {
      throw new DomainInvariantError(
        "DVD archive changed before its content identity was read",
      );
    }

    const identity = fileIdentity(openedBefore);
    const hash = createHash("sha256");
    hash.update(DVD_CONTENT_HASH_DOMAIN);
    hash.update(String(safeSizeBytes));
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let remaining = safeSizeBytes;
    while (remaining > 0) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, remaining),
        null,
      );
      if (count === 0) {
        throw new DomainInvariantError(
          "DVD archive ended before its declared content size",
        );
      }
      hash.update(buffer.subarray(0, count));
      remaining -= count;
    }

    const openedAfter = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(safePath, { bigint: true });
    if (
      namedAfter.isSymbolicLink() ||
      openedAfter.dev !== namedAfter.dev ||
      openedAfter.ino !== namedAfter.ino ||
      !identitiesMatch(identity, fileIdentity(openedAfter))
    ) {
      throw new DomainInvariantError(
        "DVD archive changed while its content identity was read",
      );
    }

    return {
      contentId: `sha256:${hash.digest("hex")}`,
      identity,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (primaryError === undefined) {
          throw error;
        }
      }
    }
  }
}

export function dvdArchiveFileMatchesIdentity(
  path: string,
  expected: DvdArchiveFileIdentity,
): boolean {
  try {
    const safePath = requireCanonicalArchivePath(path);
    const metadata = lstatSync(safePath, { bigint: true });
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      identitiesMatch(expected, fileIdentity(metadata))
    );
  } catch {
    return false;
  }
}
