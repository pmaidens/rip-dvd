import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

import type { EncodeOutputFilesystemIdentity } from "@rip-dvd/data-access";

export interface EncodeOutputFilesystemAuthoritySnapshot {
  birthtimeMs: number;
  deviceId: number;
  inode: number;
  modifiedAtMs: number;
  sizeBytes: number;
}

export async function requireNonEmptyRegularEncodeOutput(
  path: string,
  errorMessage: string,
): Promise<Stats> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0
  ) {
    throw new Error(errorMessage);
  }
  return metadata;
}

function snapshotFromMetadata(
  metadata: Stats,
): EncodeOutputFilesystemAuthoritySnapshot {
  return {
    birthtimeMs: metadata.birthtimeMs,
    deviceId: metadata.dev,
    inode: metadata.ino,
    modifiedAtMs: metadata.mtimeMs,
    sizeBytes: metadata.size,
  };
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

export function encodeOutputFilesystemIdentity(
  metadata: Stats,
): EncodeOutputFilesystemIdentity {
  const snapshot = snapshotFromMetadata(metadata);
  return JSON.stringify([
    snapshot.deviceId,
    snapshot.inode,
    snapshot.sizeBytes,
    snapshot.birthtimeMs,
    snapshot.modifiedAtMs,
  ]) as EncodeOutputFilesystemIdentity;
}

export function decodeOutputFilesystemIdentity(
  value: unknown,
): EncodeOutputFilesystemAuthoritySnapshot | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(value);
    if (!Array.isArray(decoded) || decoded.length !== 5) {
      return null;
    }
    const [deviceId, inode, sizeBytes, birthtimeMs, modifiedAtMs] = decoded;
    if (
      !isNonnegativeSafeInteger(deviceId) ||
      !isNonnegativeSafeInteger(inode) ||
      !isNonnegativeSafeInteger(sizeBytes) ||
      !isNonnegativeFiniteNumber(birthtimeMs) ||
      !isNonnegativeFiniteNumber(modifiedAtMs)
    ) {
      return null;
    }
    return { birthtimeMs, deviceId, inode, modifiedAtMs, sizeBytes };
  } catch {
    return null;
  }
}

export function sameEncodeOutputInode(
  first: Stats,
  second: Stats,
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export function sameEncodeOutputMutationSnapshot(
  first: Stats,
  second: Stats,
): boolean {
  return (
    sameEncodeOutputInode(first, second) &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

export function sameEncodeOutputAuthoritySnapshot(
  first: Stats,
  second: Stats,
): boolean {
  return authoritySnapshotMatchesMetadata(
    snapshotFromMetadata(first),
    second,
  );
}

function authoritySnapshotMatchesMetadata(
  snapshot: EncodeOutputFilesystemAuthoritySnapshot,
  metadata: Stats,
): boolean {
  return (
    snapshot.deviceId === metadata.dev &&
    snapshot.inode === metadata.ino &&
    snapshot.sizeBytes === metadata.size &&
    snapshot.birthtimeMs === metadata.birthtimeMs &&
    snapshot.modifiedAtMs === metadata.mtimeMs
  );
}

export function matchesEncodeOutputFilesystemIdentity(
  identity: unknown,
  metadata: Stats,
): boolean {
  const snapshot = decodeOutputFilesystemIdentity(identity);
  return (
    snapshot !== null &&
    authoritySnapshotMatchesMetadata(snapshot, metadata)
  );
}
