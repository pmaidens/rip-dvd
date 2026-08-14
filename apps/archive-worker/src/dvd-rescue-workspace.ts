import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isDvdFingerprint } from "@rip-dvd/data-access/dvd-scan";

import {
  DVD_RECOVERY_POLICY_VERSION,
  DVD_SECTOR_SIZE_BYTES,
  createDvdRecoveryProtocolPayload,
  type DvdRecoveryResult,
  type DvdRecoveryProtocolPayload,
  parseDvdRecoveryResultProtocol,
} from "./dvd-recovery-contracts.js";

const MAX_RESCUE_MAP_BYTES = 1_200_000;
const ARCHIVE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DvdRescueIdentity {
  archiveRequestId: string;
  fingerprint: string;
  sizeBytes: number;
}

export interface DvdRescueWorkspace {
  imageFilesystemIdentity: string;
  imagePath: string;
  mapPath: string;
  recoveryResult: DvdRecoveryResult;
}

interface DvdRescueMap {
  schemaVersion: 1;
  archiveRequestId: string;
  fingerprint: string;
  declaredByteCount: number;
  sectorSizeBytes: typeof DVD_SECTOR_SIZE_BYTES;
  totalSectorCount: number;
  recoveryPolicyVersion: typeof DVD_RECOVERY_POLICY_VERSION;
  imageFilesystemIdentity: string;
  recoveryProtocol: DvdRecoveryProtocolPayload;
}

function filesystemIdentity(metadata: Awaited<ReturnType<typeof lstat>>): string {
  if (
    !Number.isSafeInteger(metadata.dev) ||
    !Number.isSafeInteger(metadata.ino) ||
    metadata.dev < 0 ||
    metadata.ino <= 0
  ) {
    throw new Error("DVD rescue image identity is invalid");
  }
  return `${metadata.dev}:${metadata.ino}`;
}

function requireArchiveRequestId(value: string): string {
  if (!ARCHIVE_REQUEST_ID_PATTERN.test(value)) {
    throw new Error("Archive Request identity is invalid for DVD rescue");
  }
  return value;
}

export function dvdRescueWorkspacePaths(
  root: string,
  archiveRequestId: string,
): Pick<DvdRescueWorkspace, "imagePath" | "mapPath"> {
  const safeRequestId = requireArchiveRequestId(archiveRequestId);
  return {
    imagePath: join(root, `.${safeRequestId}.rip-dvd-rescue.iso`),
    mapPath: join(root, `.${safeRequestId}.rip-dvd-rescue.json`),
  };
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function optionalMetadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function quarantinePath(path: string): Promise<boolean> {
  if ((await optionalMetadata(path)) === null) {
    return false;
  }
  await rename(path, `${path}.invalid-${randomUUID()}`);
  return true;
}

async function quarantineWorkspaceFiles(
  root: string,
  paths: Pick<DvdRescueWorkspace, "imagePath" | "mapPath">,
): Promise<void> {
  const mapChanged = await quarantinePath(paths.mapPath);
  const imageChanged = await quarantinePath(paths.imagePath);
  if (mapChanged || imageChanged) {
    await syncPath(root);
  }
}

function recoveryResultFromRescueMap(
  value: unknown,
  identity: DvdRescueIdentity,
): DvdRecoveryResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("archiveRequestId" in value) ||
    value.archiveRequestId !== identity.archiveRequestId ||
    !("fingerprint" in value) ||
    value.fingerprint !== identity.fingerprint ||
    !("declaredByteCount" in value) ||
    value.declaredByteCount !== identity.sizeBytes ||
    !("sectorSizeBytes" in value) ||
    value.sectorSizeBytes !== DVD_SECTOR_SIZE_BYTES ||
    !("totalSectorCount" in value) ||
    value.totalSectorCount !== identity.sizeBytes / DVD_SECTOR_SIZE_BYTES ||
    !("recoveryPolicyVersion" in value) ||
    value.recoveryPolicyVersion !== DVD_RECOVERY_POLICY_VERSION ||
    !("imageFilesystemIdentity" in value) ||
    typeof value.imageFilesystemIdentity !== "string" ||
    !("recoveryProtocol" in value)
  ) {
    throw new Error("DVD rescue state does not match the Archive Request");
  }
  return parseDvdRecoveryResultProtocol(
    JSON.stringify(value.recoveryProtocol),
    identity.sizeBytes,
  );
}

function createRescueMap(
  identity: DvdRescueIdentity,
  imageFilesystemIdentity: string,
  recoveryResult: DvdRecoveryResult,
): DvdRescueMap {
  const recoveryProtocol = createDvdRecoveryProtocolPayload(recoveryResult);
  parseDvdRecoveryResultProtocol(
    JSON.stringify(recoveryProtocol),
    identity.sizeBytes,
  );
  return {
    schemaVersion: 1,
    archiveRequestId: identity.archiveRequestId,
    fingerprint: identity.fingerprint,
    declaredByteCount: identity.sizeBytes,
    sectorSizeBytes: DVD_SECTOR_SIZE_BYTES,
    totalSectorCount: identity.sizeBytes / DVD_SECTOR_SIZE_BYTES,
    recoveryPolicyVersion: DVD_RECOVERY_POLICY_VERSION,
    imageFilesystemIdentity,
    recoveryProtocol,
  };
}

async function writeMapAtomically(
  root: string,
  mapPath: string,
  map: DvdRescueMap,
): Promise<void> {
  const serialized = `${JSON.stringify(map)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RESCUE_MAP_BYTES) {
    throw new Error("DVD rescue map exceeds its safety limit");
  }
  const temporaryPath = `${mapPath}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o640,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, mapPath);
    await syncPath(root);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function loadDvdRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
): Promise<DvdRescueWorkspace | null> {
  const paths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  let imageMetadata: Awaited<ReturnType<typeof optionalMetadata>>;
  let mapMetadata: Awaited<ReturnType<typeof optionalMetadata>>;
  try {
    [imageMetadata, mapMetadata] = await Promise.all([
      optionalMetadata(paths.imagePath),
      optionalMetadata(paths.mapPath),
    ]);
  } catch (error) {
    throw new Error("DVD rescue state could not be inspected", {
      cause: error,
    });
  }
  if (imageMetadata === null && mapMetadata === null) {
    return null;
  }
  try {
    if (
      !isDvdFingerprint(identity.fingerprint) ||
      !Number.isSafeInteger(identity.sizeBytes) ||
      identity.sizeBytes <= 0 ||
      identity.sizeBytes % DVD_SECTOR_SIZE_BYTES !== 0 ||
      imageMetadata === null ||
      mapMetadata === null ||
      !imageMetadata.isFile() ||
      imageMetadata.isSymbolicLink() ||
      imageMetadata.size !== identity.sizeBytes ||
      !mapMetadata.isFile() ||
      mapMetadata.isSymbolicLink() ||
      mapMetadata.size <= 0 ||
      mapMetadata.size > MAX_RESCUE_MAP_BYTES
    ) {
      throw new Error("DVD rescue state is invalid");
    }
    const handle = await open(
      paths.mapPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    let text: string;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size !== mapMetadata.size ||
        opened.dev !== mapMetadata.dev ||
        opened.ino !== mapMetadata.ino
      ) {
        throw new Error("DVD rescue map changed during validation");
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(text) as unknown;
    const recoveryResult = recoveryResultFromRescueMap(parsed, identity);
    const map = parsed as DvdRescueMap;
    if (map.imageFilesystemIdentity !== filesystemIdentity(imageMetadata)) {
      throw new Error("DVD rescue image does not match its recovery map");
    }
    const canonicalImagePath = await realpath(paths.imagePath);
    if (
      dirname(canonicalImagePath) !== root ||
      basename(canonicalImagePath) !== basename(paths.imagePath)
    ) {
      throw new Error("DVD rescue image escaped the Originals library");
    }
    return {
      ...paths,
      imageFilesystemIdentity: map.imageFilesystemIdentity,
      recoveryResult,
    };
  } catch (error) {
    try {
      await quarantineWorkspaceFiles(root, paths);
    } catch (quarantineError) {
      throw new Error("DVD rescue state could not be quarantined", {
        cause: quarantineError,
      });
    }
    if (
      error instanceof Error &&
      error.message === "DVD rescue state does not match the Archive Request"
    ) {
      throw error;
    }
    throw new Error("DVD rescue state is invalid", { cause: error });
  }
}

export async function commitDvdRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  sourceImagePath: string,
  recoveryResult: DvdRecoveryResult,
): Promise<DvdRescueWorkspace> {
  const paths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  if (
    dirname(sourceImagePath) !== root ||
    (await optionalMetadata(paths.imagePath)) !== null ||
    (await optionalMetadata(paths.mapPath)) !== null
  ) {
    throw new Error("DVD rescue workspace cannot be committed safely");
  }
  await rename(sourceImagePath, paths.imagePath);
  try {
    const imageMetadata = await lstat(paths.imagePath);
    if (
      !imageMetadata.isFile() ||
      imageMetadata.isSymbolicLink() ||
      imageMetadata.size !== identity.sizeBytes
    ) {
      throw new Error("DVD rescue image is invalid");
    }
    const imageFilesystemIdentity = filesystemIdentity(imageMetadata);
    await syncPath(root);
    await writeMapAtomically(
      root,
      paths.mapPath,
      createRescueMap(
        identity,
        imageFilesystemIdentity,
        recoveryResult,
      ),
    );
    return { ...paths, imageFilesystemIdentity, recoveryResult };
  } catch (error) {
    try {
      await quarantineWorkspaceFiles(root, paths);
    } catch (quarantineError) {
      throw new Error("DVD rescue state could not be quarantined", {
        cause: quarantineError,
      });
    }
    throw new Error("DVD rescue state could not be committed", {
      cause: error,
    });
  }
}

export async function updateDvdRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  workspace: DvdRescueWorkspace,
  recoveryResult: DvdRecoveryResult,
): Promise<DvdRescueWorkspace> {
  const expectedPaths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  if (
    workspace.imagePath !== expectedPaths.imagePath ||
    workspace.mapPath !== expectedPaths.mapPath
  ) {
    throw new Error("DVD rescue workspace identity changed");
  }
  let imageMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    imageMetadata = await lstat(workspace.imagePath);
  } catch (error) {
    throw new Error("DVD rescue image changed during recovery", {
      cause: error,
    });
  }
  if (
    !imageMetadata.isFile() ||
    imageMetadata.isSymbolicLink() ||
    imageMetadata.size !== identity.sizeBytes ||
    filesystemIdentity(imageMetadata) !== workspace.imageFilesystemIdentity
  ) {
    throw new Error("DVD rescue image changed during recovery");
  }
  try {
    await writeMapAtomically(
      root,
      workspace.mapPath,
      createRescueMap(
        identity,
        workspace.imageFilesystemIdentity,
        recoveryResult,
      ),
    );
  } catch (error) {
    throw new Error("DVD rescue state could not be updated", { cause: error });
  }
  return { ...workspace, recoveryResult };
}

export async function removeDvdRescueWorkspace(
  root: string,
  workspace: DvdRescueWorkspace,
): Promise<void> {
  await unlink(workspace.mapPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await unlink(workspace.imagePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await syncPath(root);
}
