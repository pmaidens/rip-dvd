import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isDvdFingerprint } from "@rip-dvd/data-access/dvd-scan";

import {
  DVD_RECOVERY_POLICY_VERSION,
  DVD_SECTOR_SIZE_BYTES,
  createDvdRecoveryProtocolPayload,
  type OutOfRangeDvdReadFailureResult,
  type DvdRecoveryResult,
  type DvdRecoveryProtocolPayload,
  parseDvdReadFailureResultProtocol,
  parseDvdRecoveryResultProtocol,
} from "./dvd-recovery-contracts.js";

const MAX_RESCUE_MAP_BYTES = 1_200_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DvdRescueIdentity {
  archiveRequestId: string;
  fingerprint: string;
  sizeBytes: number;
}

export interface DvdRescueWorkspace {
  boundaryFailure: OutOfRangeDvdReadFailureResult | null;
  imageByteCount: number;
  imageFilesystemIdentity: string;
  imagePath: string;
  mapPath: string;
  recoveryResult: DvdRecoveryResult | null;
}

type DvdRescueState = Pick<
  DvdRescueWorkspace,
  "boundaryFailure" | "imageByteCount" | "recoveryResult"
>;

interface DvdRescueMap {
  schemaVersion: 1 | 2;
  archiveRequestId: string;
  fingerprint: string;
  declaredByteCount: number;
  sectorSizeBytes: typeof DVD_SECTOR_SIZE_BYTES;
  totalSectorCount: number;
  recoveryPolicyVersion: typeof DVD_RECOVERY_POLICY_VERSION;
  imageByteCount?: number;
  imageFilesystemIdentity: string;
  preparedImageBasename?: string;
  recoveryProtocol: DvdRecoveryProtocolPayload | null;
  boundaryFailureProtocol?: OutOfRangeDvdReadFailureResult;
}

type AuthorizeMutation = () => void | Promise<void>;

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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Archive Request identity is invalid for DVD rescue");
  }
  return value;
}

function archiveRequestPathKey(archiveRequestId: string): string {
  return createHash("sha256")
    .update(requireArchiveRequestId(archiveRequestId), "utf8")
    .digest("hex");
}

export function dvdBoundaryRetentionMapPath(
  root: string,
  archiveRequestId: string,
): string {
  const requestPathKey = archiveRequestPathKey(archiveRequestId);
  return join(root, `.${requestPathKey}.rip-dvd-rescue.json.retaining`);
}

export function dvdRescueWorkspacePaths(
  root: string,
  archiveRequestId: string,
): Pick<DvdRescueWorkspace, "imagePath" | "mapPath"> {
  const requestPathKey = archiveRequestPathKey(archiveRequestId);
  return {
    imagePath: join(root, `.${requestPathKey}.rip-dvd-rescue.iso`),
    mapPath: join(root, `.${requestPathKey}.rip-dvd-rescue.json`),
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

async function quarantinePath(
  path: string,
  authorizeMutation?: AuthorizeMutation,
): Promise<boolean> {
  if ((await optionalMetadata(path)) === null) {
    return false;
  }
  await authorizeMutation?.();
  await rename(path, `${path}.invalid-${randomUUID()}`);
  return true;
}

async function quarantineWorkspaceFiles(
  root: string,
  paths: Pick<DvdRescueWorkspace, "imagePath" | "mapPath">,
  retentionMapPath: string,
  correlatedArchivePath?: string,
  authorizeMutation?: AuthorizeMutation,
): Promise<void> {
  const archiveChanged =
    correlatedArchivePath === undefined
      ? false
      : await quarantinePath(correlatedArchivePath, authorizeMutation);
  if (archiveChanged) {
    await syncPath(root);
  }
  const retentionMapChanged = await quarantinePath(
    retentionMapPath,
    authorizeMutation,
  );
  const mapChanged = await quarantinePath(paths.mapPath, authorizeMutation);
  const imageChanged = await quarantinePath(paths.imagePath, authorizeMutation);
  if (retentionMapChanged || mapChanged || imageChanged) {
    await syncPath(root);
  }
}

function rescueStateFromMap(
  value: unknown,
  identity: DvdRescueIdentity,
): DvdRescueState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
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
  const map = value as DvdRescueMap;
  if (map.schemaVersion === 1) {
    if (map.recoveryProtocol === null || map.boundaryFailureProtocol !== undefined) {
      throw new Error("DVD rescue state does not match the Archive Request");
    }
    return {
      boundaryFailure: null,
      imageByteCount: identity.sizeBytes,
      recoveryResult: parseDvdRecoveryResultProtocol(
        JSON.stringify(map.recoveryProtocol),
        identity.sizeBytes,
      ),
    };
  }
  if (
    !Number.isSafeInteger(map.imageByteCount) ||
    map.imageByteCount! < 0 ||
    map.imageByteCount! > identity.sizeBytes ||
    map.imageByteCount! % DVD_SECTOR_SIZE_BYTES !== 0 ||
    map.boundaryFailureProtocol === undefined
  ) {
    throw new Error("DVD rescue state does not match the Archive Request");
  }
  const boundaryFailure = parseDvdReadFailureResultProtocol(
    JSON.stringify(map.boundaryFailureProtocol),
    identity.sizeBytes,
  );
  if (
    boundaryFailure.category !== "out_of_range" ||
    map.imageByteCount !== boundaryFailure.retainedImageByteCount ||
    (map.recoveryProtocol === null &&
      map.imageByteCount! >
        boundaryFailure.firstFailingLba * DVD_SECTOR_SIZE_BYTES) ||
    (map.recoveryProtocol !== null && map.imageByteCount !== identity.sizeBytes)
  ) {
    throw new Error("DVD rescue state does not match the Archive Request");
  }
  return {
    boundaryFailure,
    imageByteCount: map.imageByteCount!,
    recoveryResult: map.recoveryProtocol === null
      ? null
      : parseDvdRecoveryResultProtocol(
          JSON.stringify(map.recoveryProtocol),
          identity.sizeBytes,
        ),
  };
}

function createRescueMap(
  identity: DvdRescueIdentity,
  imageFilesystemIdentity: string,
  state: DvdRescueState,
  preparedImageBasename?: string,
): DvdRescueMap {
  const recoveryProtocol = state.recoveryResult === null
    ? null
    : createDvdRecoveryProtocolPayload(state.recoveryResult);
  if (recoveryProtocol !== null) {
    parseDvdRecoveryResultProtocol(
      JSON.stringify(recoveryProtocol),
      identity.sizeBytes,
    );
  }
  if (state.boundaryFailure !== null) {
    const parsed = parseDvdReadFailureResultProtocol(
      JSON.stringify(state.boundaryFailure),
      identity.sizeBytes,
    );
    if (parsed.category !== "out_of_range") {
      throw new Error("DVD rescue boundary evidence is invalid");
    }
  }
  return {
    schemaVersion: state.boundaryFailure === null ? 1 : 2,
    archiveRequestId: identity.archiveRequestId,
    fingerprint: identity.fingerprint,
    declaredByteCount: identity.sizeBytes,
    sectorSizeBytes: DVD_SECTOR_SIZE_BYTES,
    totalSectorCount: identity.sizeBytes / DVD_SECTOR_SIZE_BYTES,
    recoveryPolicyVersion: DVD_RECOVERY_POLICY_VERSION,
    ...(state.boundaryFailure === null
      ? {}
      : {
          imageByteCount: state.imageByteCount,
          boundaryFailureProtocol: state.boundaryFailure,
        }),
    imageFilesystemIdentity,
    ...(preparedImageBasename === undefined ? {} : { preparedImageBasename }),
    recoveryProtocol,
  };
}

function requirePreparedImagePath(
  root: string,
  identity: DvdRescueIdentity,
  value: unknown,
): string {
  const digest = identity.fingerprint.slice(
    identity.fingerprint.lastIndexOf(":") + 1,
  );
  const stem = identity.fingerprint.startsWith("dvdmeta-sha256:")
    ? `dvdmeta-${digest}`
    : digest;
  const expectedPrefix = `.${stem}.`;
  const expectedSuffix = ".iso.rip-dvd-partial";
  const uuid =
    typeof value === "string" &&
    value.startsWith(expectedPrefix) &&
    value.endsWith(expectedSuffix)
      ? value.slice(expectedPrefix.length, -expectedSuffix.length)
      : "";
  if (
    typeof value !== "string" ||
    basename(value) !== value ||
    !UUID_V4_PATTERN.test(uuid)
  ) {
    throw new Error("Prepared DVD rescue image identity is invalid");
  }
  const path = join(root, value);
  if (dirname(path) !== root) {
    throw new Error("Prepared DVD rescue image escaped the Originals library");
  }
  return path;
}

async function writeMapAtomically(
  root: string,
  mapPath: string,
  map: DvdRescueMap,
  authorizeMutation?: AuthorizeMutation,
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
    await authorizeMutation?.();
    await rename(temporaryPath, mapPath);
    await syncPath(root);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function commitPreparedDvdRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  paths: Pick<DvdRescueWorkspace, "imagePath" | "mapPath">,
  sourceImagePath: string,
  imageFilesystemIdentity: string,
  state: DvdRescueState,
  authorizeMutation?: AuthorizeMutation,
): Promise<DvdRescueWorkspace> {
  await writeMapAtomically(
    root,
    paths.mapPath,
    createRescueMap(
      identity,
      imageFilesystemIdentity,
      state,
      basename(sourceImagePath),
    ),
    authorizeMutation,
  );
  await authorizeMutation?.();
  await rename(sourceImagePath, paths.imagePath);
  await syncPath(root);
  await writeMapAtomically(
    root,
    paths.mapPath,
    createRescueMap(identity, imageFilesystemIdentity, state),
    authorizeMutation,
  );
  return { ...paths, ...state, imageFilesystemIdentity };
}

async function commitPreparedDvdBoundaryRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  paths: Pick<DvdRescueWorkspace, "imagePath" | "mapPath">,
  sourceImagePath: string,
  imageFilesystemIdentity: string,
  state: DvdRescueState,
  authorizeMutation?: AuthorizeMutation,
  finalizeRetention?: AuthorizeMutation,
): Promise<DvdRescueWorkspace> {
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  try {
    await writeMapAtomically(
      root,
      retentionMapPath,
      createRescueMap(identity, imageFilesystemIdentity, state),
      authorizeMutation,
    );
    await authorizeMutation?.();
    await rename(sourceImagePath, paths.imagePath);
    await syncPath(root);
    await finalizeRetention?.();
    await authorizeMutation?.();
    await rename(retentionMapPath, paths.mapPath);
    await syncPath(root);
    return { ...paths, ...state, imageFilesystemIdentity };
  } catch (error) {
    try {
      await quarantineWorkspaceFiles(
        root,
        paths,
        retentionMapPath,
        undefined,
        authorizeMutation,
      );
    } catch (quarantineError) {
      throw new Error("DVD rescue boundary state could not be quarantined", {
        cause: new AggregateError([error, quarantineError]),
      });
    }
    throw error;
  }
}

export async function loadDvdRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  correlatedArchivePath?: string,
  authorizeMutation?: AuthorizeMutation,
): Promise<DvdRescueWorkspace | null> {
  const paths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  if (
    correlatedArchivePath !== undefined &&
    dirname(correlatedArchivePath) !== root
  ) {
    throw new Error("Correlated DVD archive escaped the Originals library");
  }
  let imageMetadata: Awaited<ReturnType<typeof optionalMetadata>>;
  let mapMetadata: Awaited<ReturnType<typeof optionalMetadata>>;
  let retentionMapMetadata: Awaited<ReturnType<typeof optionalMetadata>>;
  try {
    [imageMetadata, mapMetadata, retentionMapMetadata] = await Promise.all([
      optionalMetadata(paths.imagePath),
      optionalMetadata(paths.mapPath),
      optionalMetadata(retentionMapPath),
    ]);
  } catch (error) {
    throw new Error("DVD rescue state could not be inspected", {
      cause: error,
    });
  }
  if (retentionMapMetadata !== null && mapMetadata !== null) {
    try {
      await quarantinePath(retentionMapPath, authorizeMutation);
      await syncPath(root);
      retentionMapMetadata = null;
    } catch (error) {
      throw new Error("DVD rescue state could not be quarantined", {
        cause: error,
      });
    }
  }
  if (
    imageMetadata === null &&
    mapMetadata === null &&
    retentionMapMetadata === null
  ) {
    return null;
  }
  try {
    if (
      !isDvdFingerprint(identity.fingerprint) ||
      !Number.isSafeInteger(identity.sizeBytes) ||
      identity.sizeBytes <= 0 ||
      identity.sizeBytes % DVD_SECTOR_SIZE_BYTES !== 0 ||
      mapMetadata === null ||
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
    const state = rescueStateFromMap(parsed, identity);
    const map = parsed as DvdRescueMap;
    const preparedImagePath =
      "preparedImageBasename" in map
        ? requirePreparedImagePath(
            root,
            identity,
            map.preparedImageBasename,
          )
        : null;
    if (imageMetadata === null && preparedImagePath !== null) {
      const preparedImageMetadata = await lstat(preparedImagePath);
      if (
        !preparedImageMetadata.isFile() ||
        preparedImageMetadata.isSymbolicLink() ||
        preparedImageMetadata.size !== state.imageByteCount ||
        filesystemIdentity(preparedImageMetadata) !==
          map.imageFilesystemIdentity
      ) {
        throw new Error("Prepared DVD rescue image is invalid");
      }
      await authorizeMutation?.();
      await rename(preparedImagePath, paths.imagePath);
      await syncPath(root);
      imageMetadata = await lstat(paths.imagePath);
    } else if (
      imageMetadata !== null &&
      preparedImagePath !== null &&
      (await optionalMetadata(preparedImagePath)) !== null
    ) {
      throw new Error("DVD rescue transaction contains conflicting images");
    }
    if (
      imageMetadata === null ||
      !imageMetadata.isFile() ||
      imageMetadata.isSymbolicLink() ||
      (state.recoveryResult === null
        ? imageMetadata.size < state.imageByteCount ||
          imageMetadata.size > identity.sizeBytes ||
          imageMetadata.size % DVD_SECTOR_SIZE_BYTES !== 0
        : imageMetadata.size !== state.imageByteCount)
    ) {
      throw new Error("DVD rescue image is invalid");
    }
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
    if (preparedImagePath !== null) {
      await writeMapAtomically(
        root,
        paths.mapPath,
        createRescueMap(
          identity,
          map.imageFilesystemIdentity,
          state,
        ),
        authorizeMutation,
      );
    }
    return {
      ...paths,
      ...state,
      imageFilesystemIdentity: map.imageFilesystemIdentity,
    };
  } catch (error) {
    try {
      await quarantineWorkspaceFiles(
        root,
        paths,
        retentionMapPath,
        correlatedArchivePath,
        authorizeMutation,
      );
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
  authorizeMutation?: AuthorizeMutation,
): Promise<DvdRescueWorkspace> {
  const paths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  if (
    dirname(sourceImagePath) !== root ||
    (await optionalMetadata(paths.imagePath)) !== null ||
    (await optionalMetadata(paths.mapPath)) !== null
  ) {
    throw new Error("DVD rescue workspace cannot be committed safely");
  }
  try {
    const imageMetadata = await lstat(sourceImagePath);
    if (
      !imageMetadata.isFile() ||
      imageMetadata.isSymbolicLink() ||
      imageMetadata.size !== identity.sizeBytes
    ) {
      throw new Error("DVD rescue image is invalid");
    }
    const imageFilesystemIdentity = filesystemIdentity(imageMetadata);
    const state = {
      boundaryFailure: null,
      imageByteCount: identity.sizeBytes,
      recoveryResult,
    };
    return await commitPreparedDvdRescueWorkspace(
      root,
      identity,
      paths,
      sourceImagePath,
      imageFilesystemIdentity,
      state,
      authorizeMutation,
    );
  } catch (error) {
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
  authorizeMutation?: AuthorizeMutation,
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
        {
          boundaryFailure: null,
          imageByteCount: identity.sizeBytes,
          recoveryResult,
        },
      ),
      authorizeMutation,
    );
  } catch (error) {
    throw new Error("DVD rescue state could not be updated", { cause: error });
  }
  return {
    ...workspace,
    boundaryFailure: null,
    imageByteCount: identity.sizeBytes,
    recoveryResult,
  };
}

export async function commitDvdBoundaryRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  sourceImagePath: string,
  boundaryFailure: OutOfRangeDvdReadFailureResult,
  authorizeMutation?: AuthorizeMutation,
  finalizeRetention?: AuthorizeMutation,
): Promise<DvdRescueWorkspace> {
  const paths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  if (
    dirname(sourceImagePath) !== root ||
    (await optionalMetadata(paths.imagePath)) !== null ||
    (await optionalMetadata(paths.mapPath)) !== null ||
    (await optionalMetadata(retentionMapPath)) !== null
  ) {
    throw new Error("DVD rescue workspace cannot be committed safely");
  }
  try {
    const imageMetadata = await lstat(sourceImagePath);
    if (
      !imageMetadata.isFile() ||
      imageMetadata.isSymbolicLink() ||
      imageMetadata.size < 0 ||
      imageMetadata.size % DVD_SECTOR_SIZE_BYTES !== 0 ||
      imageMetadata.size !== boundaryFailure.retainedImageByteCount ||
      imageMetadata.size >
        boundaryFailure.firstFailingLba * DVD_SECTOR_SIZE_BYTES
    ) {
      throw new Error("DVD rescue boundary image is invalid");
    }
    const imageFilesystemIdentity = filesystemIdentity(imageMetadata);
    const state = {
      boundaryFailure,
      imageByteCount: imageMetadata.size,
      recoveryResult: null,
    };
    return await commitPreparedDvdBoundaryRescueWorkspace(
      root,
      identity,
      paths,
      sourceImagePath,
      imageFilesystemIdentity,
      state,
      authorizeMutation,
      finalizeRetention,
    );
  } catch (error) {
    throw new Error("DVD rescue boundary state could not be committed", {
      cause: error,
    });
  }
}

export async function recordDvdBoundaryFailure(
  root: string,
  identity: DvdRescueIdentity,
  workspace: DvdRescueWorkspace,
  boundaryFailure: OutOfRangeDvdReadFailureResult,
  authorizeMutation?: AuthorizeMutation,
  finalizeRetention?: AuthorizeMutation,
): Promise<DvdRescueWorkspace> {
  const expectedPaths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  const imageMetadata = await lstat(workspace.imagePath);
  const continuesBoundaryPrefix =
    workspace.boundaryFailure !== null && workspace.recoveryResult === null;
  if (
    workspace.imagePath !== expectedPaths.imagePath ||
    workspace.mapPath !== expectedPaths.mapPath ||
    !imageMetadata.isFile() ||
    imageMetadata.isSymbolicLink() ||
    imageMetadata.size !== boundaryFailure.retainedImageByteCount ||
    (continuesBoundaryPrefix
      ? imageMetadata.size < workspace.imageByteCount ||
        imageMetadata.size % DVD_SECTOR_SIZE_BYTES !== 0
      : imageMetadata.size !== workspace.imageByteCount) ||
    filesystemIdentity(imageMetadata) !== workspace.imageFilesystemIdentity
  ) {
    throw new Error("DVD rescue image changed during boundary retention");
  }
  const state = {
    boundaryFailure,
    imageByteCount: continuesBoundaryPrefix
      ? imageMetadata.size
      : workspace.imageByteCount,
    recoveryResult: workspace.recoveryResult,
  };
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  let mapCommitted = false;
  try {
    await writeMapAtomically(
      root,
      retentionMapPath,
      createRescueMap(
        identity,
        workspace.imageFilesystemIdentity,
        state,
      ),
      authorizeMutation,
    );
    await finalizeRetention?.();
    await authorizeMutation?.();
    await rename(retentionMapPath, workspace.mapPath);
    mapCommitted = true;
    await syncPath(root);
  } catch (error) {
    try {
      if (mapCommitted) {
        await quarantineWorkspaceFiles(
          root,
          expectedPaths,
          retentionMapPath,
          undefined,
          authorizeMutation,
        );
      } else if (await quarantinePath(retentionMapPath, authorizeMutation)) {
        await syncPath(root);
      }
    } catch (quarantineError) {
      throw new Error("DVD rescue boundary state could not be quarantined", {
        cause: new AggregateError([error, quarantineError]),
      });
    }
    throw new Error("DVD rescue boundary state could not be updated", {
      cause: error,
    });
  }
  return { ...workspace, ...state };
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
