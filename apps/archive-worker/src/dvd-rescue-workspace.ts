import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { isDvdFingerprint } from "@rip-dvd/data-access/dvd-scan";

import {
  DVD_RECOVERY_POLICY_VERSION,
  DVD_SECTOR_SIZE_BYTES,
  createDvdRecoveryProtocolPayload,
  isProvenDvdBoundaryCandidate,
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

export interface ImageProofIdentity {
  ctimeNs: bigint;
  mtimeNs: bigint;
}

export interface DvdRescueWorkspace {
  boundaryFailure: OutOfRangeDvdReadFailureResult | null;
  imageByteCount: number;
  imageFilesystemIdentity: string;
  imageProofIdentity: ImageProofIdentity | null;
  imagePath: string;
  mapPath: string;
  recoveryResult: DvdRecoveryResult | null;
}

type DvdRescueState = Pick<
  DvdRescueWorkspace,
  "boundaryFailure" | "imageByteCount" | "recoveryResult"
>;

interface DvdRescueMap {
  schemaVersion: 1 | 2 | 3;
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
  boundaryAcceptanceImageProof?: {
    source: SerializedImageProofIdentity;
    accepted?: SerializedImageProofIdentity;
  };
}

type AuthorizeMutation = () => void | Promise<void>;

interface SerializedImageProofIdentity {
  ctimeNs: string;
  mtimeNs: string;
}

const INTEGER_PATTERN = /^-?[0-9]+$/;

function serializeImageProofIdentity(
  identity: ImageProofIdentity,
): SerializedImageProofIdentity {
  return {
    ctimeNs: identity.ctimeNs.toString(),
    mtimeNs: identity.mtimeNs.toString(),
  };
}

function parseImageProofIdentity(
  value: unknown,
): ImageProofIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ctimeNs" in value) ||
    typeof value.ctimeNs !== "string" ||
    !INTEGER_PATTERN.test(value.ctimeNs) ||
    !("mtimeNs" in value) ||
    typeof value.mtimeNs !== "string" ||
    !INTEGER_PATTERN.test(value.mtimeNs)
  ) {
    throw new Error("DVD rescue boundary image proof is invalid");
  }
  return {
    ctimeNs: BigInt(value.ctimeNs),
    mtimeNs: BigInt(value.mtimeNs),
  };
}

function parseBoundaryAcceptanceImageProof(
  map: DvdRescueMap,
): { source: ImageProofIdentity; accepted?: ImageProofIdentity } | null {
  if (map.boundaryAcceptanceImageProof === undefined) {
    return null;
  }
  if (map.schemaVersion !== 3) {
    throw new Error("DVD rescue boundary image proof is invalid");
  }
  return {
    source: parseImageProofIdentity(
      map.boundaryAcceptanceImageProof.source,
    ),
    ...(map.boundaryAcceptanceImageProof.accepted === undefined
      ? {}
      : {
          accepted: parseImageProofIdentity(
            map.boundaryAcceptanceImageProof.accepted,
          ),
        }),
  };
}

function imageMetadataMatchesProof(
  metadata: BigIntStats,
  imageFilesystemIdentity: string,
  imageByteCount: number,
  proofIdentity: ImageProofIdentity,
): boolean {
  return metadata.isFile() &&
    metadata.nlink > 0n &&
    `${metadata.dev}:${metadata.ino}` === imageFilesystemIdentity &&
    metadata.size === BigInt(imageByteCount) &&
    metadata.ctimeNs === proofIdentity.ctimeNs &&
    metadata.mtimeNs === proofIdentity.mtimeNs;
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

async function readRescueMap(
  path: string,
  metadata: Awaited<ReturnType<typeof lstat>>,
): Promise<unknown> {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_RESCUE_MAP_BYTES
  ) {
    throw new Error("DVD rescue state is invalid");
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== metadata.size ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      throw new Error("DVD rescue map changed during validation");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
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
  authorizeMutation?: AuthorizeMutation,
): Promise<void> {
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

async function reconcileBoundaryAcceptanceTransaction(
  root: string,
  paths: Pick<DvdRescueWorkspace, "imagePath" | "mapPath">,
  retentionMapPath: string,
  transaction: {
    action: "discard" | "promote";
    imageByteCount: number;
    imageFilesystemIdentity: string;
    proofIdentity: ImageProofIdentity;
  },
  {
    authorizeMutation,
    invalidStatePolicy,
  }: {
    authorizeMutation?: AuthorizeMutation;
    invalidStatePolicy: "preserve" | "quarantine";
  },
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let imageChanged = false;
  let mapChanged = false;
  const imageStillMatches = async (): Promise<boolean> => {
    const metadata = handle === undefined
      ? await lstat(paths.imagePath, { bigint: true })
      : await handle.stat({ bigint: true });
    return imageMetadataMatchesProof(
      metadata,
      transaction.imageFilesystemIdentity,
      transaction.imageByteCount,
      transaction.proofIdentity,
    );
  };
  const rejectChangedImage = (): never => {
    imageChanged = true;
    throw new Error("DVD rescue image changed during transaction recovery");
  };
  try {
    handle = await open(
      paths.imagePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    if (!(await imageStillMatches())) {
      rejectChangedImage();
    }
    await authorizeMutation?.();
    if (!(await imageStillMatches())) {
      rejectChangedImage();
    }
    if (transaction.action === "promote") {
      await rename(retentionMapPath, paths.mapPath);
    } else {
      await unlink(retentionMapPath);
    }
    mapChanged = true;
    await authorizeMutation?.();
    await syncPath(root);
    if (!(await imageStillMatches())) {
      rejectChangedImage();
    }
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (!imageChanged) {
      try {
        imageChanged = !(await imageStillMatches());
      } catch {
        imageChanged = true;
      }
    }
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (
      invalidStatePolicy === "quarantine" &&
      (imageChanged ||
        (mapChanged && transaction.action === "promote"))
    ) {
      try {
        await quarantineWorkspaceFiles(
          root,
          paths,
          retentionMapPath,
          authorizeMutation,
        );
      } catch (quarantineError) {
        throw new Error("DVD rescue state could not be quarantined", {
          cause: new AggregateError([error, quarantineError]),
        });
      }
    }
    throw error;
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
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3) ||
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
  parseBoundaryAcceptanceImageProof(map);
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
  if (boundaryFailure.category !== "out_of_range") {
    throw new Error("DVD rescue state does not match the Archive Request");
  }
  if (map.schemaVersion === 3) {
    const acceptedByteCount = boundaryFailure.firstFailingLba *
      DVD_SECTOR_SIZE_BYTES;
    if (
      !isProvenDvdBoundaryCandidate(boundaryFailure) ||
      map.imageByteCount !== acceptedByteCount ||
      map.recoveryProtocol === null
    ) {
      throw new Error("DVD rescue state does not match the Archive Request");
    }
    return {
      boundaryFailure,
      imageByteCount: acceptedByteCount,
      recoveryResult: parseDvdRecoveryResultProtocol(
        JSON.stringify(map.recoveryProtocol),
        acceptedByteCount,
      ),
    };
  }
  if (
    map.recoveryProtocol === null
      ? map.imageByteCount !== boundaryFailure.retainedImageByteCount ||
        map.imageByteCount! >
          boundaryFailure.firstFailingLba * DVD_SECTOR_SIZE_BYTES
      : map.imageByteCount !== identity.sizeBytes &&
        map.imageByteCount !== boundaryFailure.retainedImageByteCount
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
  {
    preparedImageBasename,
    boundaryAcceptanceImageProof,
  }: {
    preparedImageBasename?: string;
    boundaryAcceptanceImageProof?: {
      source: ImageProofIdentity;
      accepted?: ImageProofIdentity;
    };
  } = {},
): DvdRescueMap {
  const recoveryProtocol = state.recoveryResult === null
    ? null
    : createDvdRecoveryProtocolPayload(state.recoveryResult);
  if (recoveryProtocol !== null) {
    parseDvdRecoveryResultProtocol(
      JSON.stringify(recoveryProtocol),
      state.recoveryResult!.declaredByteCount,
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
  const schemaVersion = state.boundaryFailure === null
    ? 1
    : state.recoveryResult !== null &&
        isProvenDvdBoundaryCandidate(state.boundaryFailure) &&
        state.imageByteCount ===
          state.boundaryFailure.firstFailingLba * DVD_SECTOR_SIZE_BYTES &&
        state.recoveryResult.declaredByteCount === state.imageByteCount
      ? 3
      : 2;
  if (
    boundaryAcceptanceImageProof !== undefined &&
    schemaVersion !== 3
  ) {
    throw new Error("DVD rescue boundary image proof is invalid");
  }
  return {
    schemaVersion,
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
    ...(boundaryAcceptanceImageProof === undefined
      ? {}
      : {
          boundaryAcceptanceImageProof: {
            source: serializeImageProofIdentity(
              boundaryAcceptanceImageProof.source,
            ),
            ...(boundaryAcceptanceImageProof.accepted === undefined
              ? {}
              : {
                  accepted: serializeImageProofIdentity(
                    boundaryAcceptanceImageProof.accepted,
                  ),
                }),
          },
        }),
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
      { preparedImageBasename: basename(sourceImagePath) },
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
  return {
    ...paths,
    ...state,
    imageFilesystemIdentity,
    imageProofIdentity: null,
  };
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
  const initialMap = createRescueMap(
    identity,
    imageFilesystemIdentity,
    state,
  );
  let imageProofIdentity: ImageProofIdentity | null = null;
  let imageHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeMapAtomically(
      root,
      retentionMapPath,
      initialMap,
      authorizeMutation,
    );
    await authorizeMutation?.();
    await rename(sourceImagePath, paths.imagePath);
    await syncPath(root);
    if (initialMap.schemaVersion === 3) {
      imageHandle = await open(
        paths.imagePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const accepted = await imageHandle.stat({ bigint: true });
      imageProofIdentity = {
        ctimeNs: accepted.ctimeNs,
        mtimeNs: accepted.mtimeNs,
      };
      if (!imageMetadataMatchesProof(
        accepted,
        imageFilesystemIdentity,
        state.imageByteCount,
        imageProofIdentity,
      )) {
        throw new Error("DVD rescue boundary image changed during commit");
      }
      await writeMapAtomically(
        root,
        retentionMapPath,
        createRescueMap(
          identity,
          imageFilesystemIdentity,
          state,
          {
            boundaryAcceptanceImageProof: {
              source: imageProofIdentity,
              accepted: imageProofIdentity,
            },
          },
        ),
        authorizeMutation,
      );
      if (!imageMetadataMatchesProof(
        await imageHandle.stat({ bigint: true }),
        imageFilesystemIdentity,
        state.imageByteCount,
        imageProofIdentity,
      )) {
        throw new Error("DVD rescue boundary image changed during commit");
      }
    }
    await finalizeRetention?.();
    await authorizeMutation?.();
    await rename(retentionMapPath, paths.mapPath);
    await syncPath(root);
    if (
      imageProofIdentity !== null &&
      imageHandle !== undefined &&
      !imageMetadataMatchesProof(
        await imageHandle.stat({ bigint: true }),
        imageFilesystemIdentity,
        state.imageByteCount,
        imageProofIdentity,
      )
    ) {
      throw new Error("DVD rescue boundary image changed during commit");
    }
    await imageHandle?.close();
    imageHandle = undefined;
    return {
      ...paths,
      ...state,
      imageFilesystemIdentity,
      imageProofIdentity,
    };
  } catch (error) {
    await imageHandle?.close().catch(() => undefined);
    imageHandle = undefined;
    try {
      await quarantineWorkspaceFiles(
        root,
        paths,
        retentionMapPath,
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
  {
    authorizeMutation,
    invalidStatePolicy = "quarantine",
  }: {
    authorizeMutation?: AuthorizeMutation;
    invalidStatePolicy?: "preserve" | "quarantine";
  } = {},
): Promise<DvdRescueWorkspace | null> {
  const paths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
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
    let acceptedTransaction: {
      imageByteCount: number;
      imageFilesystemIdentity: string;
      proofIdentity: ImageProofIdentity;
    } | null = null;
    let unappliedTransaction: {
      imageByteCount: number;
      imageFilesystemIdentity: string;
      proofIdentity: ImageProofIdentity;
    } | null = null;
    try {
      const retainedMapValue = await readRescueMap(
        retentionMapPath,
        retentionMapMetadata,
      );
      const retainedMap = retainedMapValue as DvdRescueMap;
      const retainedState = rescueStateFromMap(retainedMapValue, identity);
      const retentionProof = parseBoundaryAcceptanceImageProof(retainedMap);
      if (
        retainedMap.schemaVersion === 3 &&
        retentionProof !== null &&
        imageMetadata !== null &&
        imageMetadata.isFile() &&
        !imageMetadata.isSymbolicLink() &&
        filesystemIdentity(imageMetadata) ===
          retainedMap.imageFilesystemIdentity
      ) {
        if (
          retentionProof.accepted !== undefined &&
          imageMetadata.size === retainedState.imageByteCount
        ) {
          acceptedTransaction = {
            imageByteCount: retainedState.imageByteCount,
            imageFilesystemIdentity: retainedMap.imageFilesystemIdentity,
            proofIdentity: retentionProof.accepted,
          };
        } else if (retentionProof.accepted === undefined) {
          const mapValue = await readRescueMap(paths.mapPath, mapMetadata);
          const map = mapValue as DvdRescueMap;
          const state = rescueStateFromMap(mapValue, identity);
          if (
            imageMetadata.size === state.imageByteCount &&
            filesystemIdentity(imageMetadata) ===
              map.imageFilesystemIdentity
          ) {
            unappliedTransaction = {
              imageByteCount: state.imageByteCount,
              imageFilesystemIdentity: map.imageFilesystemIdentity,
              proofIdentity: retentionProof.source,
            };
          }
        }
      }
    } catch {
      acceptedTransaction = null;
      unappliedTransaction = null;
    }
    if (acceptedTransaction !== null) {
      await reconcileBoundaryAcceptanceTransaction(
        root,
        paths,
        retentionMapPath,
        { action: "promote", ...acceptedTransaction },
        { authorizeMutation, invalidStatePolicy },
      );
      mapMetadata = await lstat(paths.mapPath);
      retentionMapMetadata = null;
    } else if (unappliedTransaction !== null) {
      await reconcileBoundaryAcceptanceTransaction(
        root,
        paths,
        retentionMapPath,
        { action: "discard", ...unappliedTransaction },
        { authorizeMutation, invalidStatePolicy },
      );
      retentionMapMetadata = null;
    } else if (invalidStatePolicy === "preserve") {
      throw new Error("DVD rescue state is invalid", {
        cause: new Error("DVD rescue transaction contains conflicting maps"),
      });
    } else {
      await quarantinePath(retentionMapPath, authorizeMutation);
      await syncPath(root);
      retentionMapMetadata = null;
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
      mapMetadata === null
    ) {
      throw new Error("DVD rescue state is invalid");
    }
    const parsed = await readRescueMap(paths.mapPath, mapMetadata);
    const state = rescueStateFromMap(parsed, identity);
    const map = parsed as DvdRescueMap;
    const boundaryAcceptanceProof = parseBoundaryAcceptanceImageProof(map);
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
    if (boundaryAcceptanceProof !== null) {
      if (boundaryAcceptanceProof.accepted === undefined) {
        throw new Error("DVD rescue boundary image proof is incomplete");
      }
      const handle = await open(
        paths.imagePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        if (!imageMetadataMatchesProof(
          await handle.stat({ bigint: true }),
          map.imageFilesystemIdentity,
          state.imageByteCount,
          boundaryAcceptanceProof.accepted,
        )) {
          throw new Error("DVD rescue boundary image proof does not match");
        }
      } finally {
        await handle.close();
      }
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
      imageProofIdentity: boundaryAcceptanceProof?.accepted ?? null,
    };
  } catch (error) {
    if (invalidStatePolicy === "quarantine") {
      try {
        await quarantineWorkspaceFiles(
          root,
          paths,
          retentionMapPath,
          authorizeMutation,
        );
      } catch (quarantineError) {
        throw new Error("DVD rescue state could not be quarantined", {
          cause: quarantineError,
        });
      }
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
  const expectedPaths = dvdRescueWorkspacePaths(
    root,
    identity.archiveRequestId,
  );
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
    imageProofIdentity: null,
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
  recoveryResult: DvdRecoveryResult | null = null,
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
      recoveryResult,
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
  recoveryResult: DvdRecoveryResult | null = null,
): Promise<DvdRescueWorkspace> {
  const expectedPaths = dvdRescueWorkspacePaths(
    root,
    identity.archiveRequestId,
  );
  const imageMetadata = await lstat(workspace.imagePath);
  const continuesBoundaryPrefix =
    workspace.boundaryFailure !== null && workspace.recoveryResult === null;
  const retainedRecoveryResult = recoveryResult ?? workspace.recoveryResult;
  if (
    workspace.imagePath !== expectedPaths.imagePath ||
    workspace.mapPath !== expectedPaths.mapPath ||
    !imageMetadata.isFile() ||
    imageMetadata.isSymbolicLink() ||
    (retainedRecoveryResult === null &&
      imageMetadata.size !== boundaryFailure.retainedImageByteCount) ||
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
    imageByteCount: imageMetadata.size,
    recoveryResult: retainedRecoveryResult,
  };
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  const initialMap = createRescueMap(
    identity,
    workspace.imageFilesystemIdentity,
    state,
  );
  let imageProofIdentity: ImageProofIdentity | null = null;
  let imageHandle: Awaited<ReturnType<typeof open>> | undefined;
  if (initialMap.schemaVersion === 3) {
    imageHandle = await open(
      workspace.imagePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const proofMetadata = await imageHandle.stat({ bigint: true });
    imageProofIdentity = {
      ctimeNs: proofMetadata.ctimeNs,
      mtimeNs: proofMetadata.mtimeNs,
    };
    if (!imageMetadataMatchesProof(
      proofMetadata,
      workspace.imageFilesystemIdentity,
      state.imageByteCount,
      imageProofIdentity,
    )) {
      await imageHandle.close();
      throw new Error("DVD rescue image changed during boundary retention");
    }
  }
  const stagedMap = imageProofIdentity === null
    ? initialMap
    : createRescueMap(
        identity,
        workspace.imageFilesystemIdentity,
        state,
        {
          boundaryAcceptanceImageProof: {
            source: imageProofIdentity,
            accepted: imageProofIdentity,
          },
        },
      );
  let mapCommitted = false;
  let imageChanged = false;
  try {
    await writeMapAtomically(
      root,
      retentionMapPath,
      stagedMap,
      authorizeMutation,
    );
    await finalizeRetention?.();
    await authorizeMutation?.();
    await rename(retentionMapPath, workspace.mapPath);
    mapCommitted = true;
    await syncPath(root);
    if (
      imageProofIdentity !== null &&
      imageHandle !== undefined &&
      !imageMetadataMatchesProof(
        await imageHandle.stat({ bigint: true }),
        workspace.imageFilesystemIdentity,
        state.imageByteCount,
        imageProofIdentity,
      )
    ) {
      imageChanged = true;
      throw new Error("DVD rescue image changed during boundary retention");
    }
    await imageHandle?.close();
    imageHandle = undefined;
  } catch (error) {
    if (
      imageProofIdentity !== null &&
      imageHandle !== undefined &&
      !imageChanged
    ) {
      try {
        imageChanged = !imageMetadataMatchesProof(
          await imageHandle.stat({ bigint: true }),
          workspace.imageFilesystemIdentity,
          state.imageByteCount,
          imageProofIdentity,
        );
      } catch {
        imageChanged = true;
      }
    }
    await imageHandle?.close().catch(() => undefined);
    imageHandle = undefined;
    try {
      if (mapCommitted || imageChanged) {
        await quarantineWorkspaceFiles(
          root,
          expectedPaths,
          retentionMapPath,
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
  return {
    ...workspace,
    ...state,
    imageProofIdentity,
  };
}

export async function acceptDvdBoundaryRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  workspace: DvdRescueWorkspace,
  recoveryResult: DvdRecoveryResult,
  expectedImageProofIdentity: {
    ctimeNs: bigint;
    mtimeNs: bigint;
  },
  authorizeMutation?: AuthorizeMutation,
): Promise<{
  imageProofIdentity: ImageProofIdentity;
  workspace: DvdRescueWorkspace;
}> {
  const expectedPaths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  const boundaryFailure = workspace.boundaryFailure;
  if (
    workspace.imagePath !== expectedPaths.imagePath ||
    workspace.mapPath !== expectedPaths.mapPath ||
    boundaryFailure === null ||
    !isProvenDvdBoundaryCandidate(boundaryFailure)
  ) {
    throw new Error("DVD rescue boundary acceptance is invalid");
  }
  const acceptedByteCount = boundaryFailure.firstFailingLba *
    DVD_SECTOR_SIZE_BYTES;
  if (recoveryResult.declaredByteCount !== acceptedByteCount) {
    throw new Error("DVD rescue boundary acceptance is invalid");
  }
  const metadata = await lstat(workspace.imagePath, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < BigInt(acceptedByteCount) ||
    metadata.size > BigInt(identity.sizeBytes) ||
    `${metadata.dev}:${metadata.ino}` !== workspace.imageFilesystemIdentity ||
    metadata.ctimeNs !== expectedImageProofIdentity.ctimeNs ||
    metadata.mtimeNs !== expectedImageProofIdentity.mtimeNs
  ) {
    const error = new Error(
      "DVD rescue image changed during boundary acceptance",
    );
    try {
      await quarantineWorkspaceFiles(
        root,
        expectedPaths,
        dvdBoundaryRetentionMapPath(root, identity.archiveRequestId),
        authorizeMutation,
      );
    } catch (quarantineError) {
      throw new Error("DVD rescue boundary state could not be quarantined", {
        cause: new AggregateError([error, quarantineError]),
      });
    }
    throw error;
  }
  const acceptedState = {
    boundaryFailure,
    imageByteCount: acceptedByteCount,
    recoveryResult,
  };
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  let imageChangedDuringAcceptance = false;
  let mapPromoted = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let lastValidatedImageByteCount = Number(metadata.size);
  let lastValidatedImageProof: ImageProofIdentity = expectedImageProofIdentity;
  const rejectChangedImage = (): never => {
    imageChangedDuringAcceptance = true;
    throw new Error("DVD rescue image changed during boundary acceptance");
  };
  try {
    await writeMapAtomically(
      root,
      retentionMapPath,
      createRescueMap(
        identity,
        workspace.imageFilesystemIdentity,
        acceptedState,
        {
          boundaryAcceptanceImageProof: {
            source: expectedImageProofIdentity,
          },
        },
      ),
      authorizeMutation,
    );
    handle = await open(
      workspace.imagePath,
      fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (!imageMetadataMatchesProof(
      opened,
      workspace.imageFilesystemIdentity,
      lastValidatedImageByteCount,
      lastValidatedImageProof,
    )) {
      rejectChangedImage();
    }
    await authorizeMutation?.();
    const beforeTruncate = await handle.stat({ bigint: true });
    if (!imageMetadataMatchesProof(
      beforeTruncate,
      workspace.imageFilesystemIdentity,
      lastValidatedImageByteCount,
      lastValidatedImageProof,
    )) {
      rejectChangedImage();
    }
    if (beforeTruncate.size !== BigInt(acceptedByteCount)) {
      await handle.truncate(acceptedByteCount);
    }
    await handle.sync();
    const accepted = await handle.stat({ bigint: true });
    if (
      !accepted.isFile() ||
      accepted.nlink <= 0n ||
      `${accepted.dev}:${accepted.ino}` !==
        workspace.imageFilesystemIdentity ||
      accepted.size !== BigInt(acceptedByteCount)
    ) {
      rejectChangedImage();
    }
    lastValidatedImageByteCount = acceptedByteCount;
    lastValidatedImageProof = {
      ctimeNs: accepted.ctimeNs,
      mtimeNs: accepted.mtimeNs,
    };
    await writeMapAtomically(
      root,
      retentionMapPath,
      createRescueMap(
        identity,
        workspace.imageFilesystemIdentity,
        acceptedState,
        {
          boundaryAcceptanceImageProof: {
            source: expectedImageProofIdentity,
            accepted: lastValidatedImageProof,
          },
        },
      ),
      authorizeMutation,
    );
    const beforePromotion = await handle.stat({ bigint: true });
    if (!imageMetadataMatchesProof(
      beforePromotion,
      workspace.imageFilesystemIdentity,
      lastValidatedImageByteCount,
      lastValidatedImageProof,
    )) {
      rejectChangedImage();
    }
    await authorizeMutation?.();
    const authorizedForPromotion = await handle.stat({ bigint: true });
    if (!imageMetadataMatchesProof(
      authorizedForPromotion,
      workspace.imageFilesystemIdentity,
      lastValidatedImageByteCount,
      lastValidatedImageProof,
    )) {
      rejectChangedImage();
    }
    await rename(retentionMapPath, workspace.mapPath);
    mapPromoted = true;
    await authorizeMutation?.();
    await syncPath(root);
    const promoted = await handle.stat({ bigint: true });
    if (!imageMetadataMatchesProof(
      promoted,
      workspace.imageFilesystemIdentity,
      lastValidatedImageByteCount,
      lastValidatedImageProof,
    )) {
      rejectChangedImage();
    }
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (!imageChangedDuringAcceptance) {
      try {
        const observed = handle === undefined
          ? await lstat(workspace.imagePath, { bigint: true })
          : await handle.stat({ bigint: true });
        imageChangedDuringAcceptance = !imageMetadataMatchesProof(
          observed,
          workspace.imageFilesystemIdentity,
          lastValidatedImageByteCount,
          lastValidatedImageProof,
        );
      } catch {
        imageChangedDuringAcceptance = true;
      }
    }
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (imageChangedDuringAcceptance || mapPromoted) {
      try {
        await quarantineWorkspaceFiles(
          root,
          expectedPaths,
          retentionMapPath,
          authorizeMutation,
        );
      } catch (quarantineError) {
        throw new Error("DVD rescue boundary state could not be quarantined", {
          cause: new AggregateError([error, quarantineError]),
        });
      }
    }
    throw error;
  }
  return {
    imageProofIdentity: lastValidatedImageProof,
    workspace: {
      ...workspace,
      ...acceptedState,
      imageProofIdentity: lastValidatedImageProof,
    },
  };
}

export async function updateDvdBoundaryRescueWorkspaceImageProof(
  root: string,
  identity: DvdRescueIdentity,
  workspace: DvdRescueWorkspace,
  expectedImageProofIdentity: ImageProofIdentity,
  authorizeMutation?: AuthorizeMutation,
): Promise<void> {
  const expectedPaths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  const retentionMapPath = dvdBoundaryRetentionMapPath(
    root,
    identity.archiveRequestId,
  );
  if (
    workspace.imagePath !== expectedPaths.imagePath ||
    workspace.mapPath !== expectedPaths.mapPath
  ) {
    throw new Error("DVD rescue boundary image proof update is invalid");
  }
  const mapMetadata = await lstat(workspace.mapPath);
  const mapValue = await readRescueMap(workspace.mapPath, mapMetadata);
  const map = mapValue as DvdRescueMap;
  const state = rescueStateFromMap(mapValue, identity);
  const priorProof = parseBoundaryAcceptanceImageProof(map);
  if (
    map.schemaVersion !== 3 ||
    priorProof?.accepted === undefined ||
    state.boundaryFailure === null ||
    state.recoveryResult === null ||
    state.imageByteCount !== workspace.imageByteCount ||
    map.imageFilesystemIdentity !== workspace.imageFilesystemIdentity
  ) {
    throw new Error("DVD rescue boundary image proof update is invalid");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      workspace.imagePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    if (!imageMetadataMatchesProof(
      await handle.stat({ bigint: true }),
      workspace.imageFilesystemIdentity,
      workspace.imageByteCount,
      expectedImageProofIdentity,
    )) {
      throw new Error("DVD rescue boundary image changed after publication");
    }
    await writeMapAtomically(
      root,
      workspace.mapPath,
      createRescueMap(
        identity,
        workspace.imageFilesystemIdentity,
        state,
        {
          boundaryAcceptanceImageProof: {
            source: priorProof.source,
            accepted: expectedImageProofIdentity,
          },
        },
      ),
      authorizeMutation,
    );
    if (!imageMetadataMatchesProof(
      await handle.stat({ bigint: true }),
      workspace.imageFilesystemIdentity,
      workspace.imageByteCount,
      expectedImageProofIdentity,
    )) {
      throw new Error("DVD rescue boundary image changed after publication");
    }
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    try {
      await quarantineWorkspaceFiles(
        root,
        expectedPaths,
        retentionMapPath,
        authorizeMutation,
      );
    } catch (quarantineError) {
      throw new Error("DVD rescue state could not be quarantined", {
        cause: new AggregateError([error, quarantineError]),
      });
    }
    throw error;
  }
}

export async function quarantineDvdRescueWorkspace(
  root: string,
  identity: DvdRescueIdentity,
  workspace: DvdRescueWorkspace,
  authorizeMutation?: AuthorizeMutation,
): Promise<void> {
  const expectedPaths = dvdRescueWorkspacePaths(root, identity.archiveRequestId);
  if (
    workspace.imagePath !== expectedPaths.imagePath ||
    workspace.mapPath !== expectedPaths.mapPath
  ) {
    throw new Error("DVD rescue workspace identity changed before quarantine");
  }
  await quarantineWorkspaceFiles(
    root,
    expectedPaths,
    dvdBoundaryRetentionMapPath(root, identity.archiveRequestId),
    authorizeMutation,
  );
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
