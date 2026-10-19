import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProvenDvdInitialArchiveBoundary } from "./dvd-initial-boundary.js";
import {
  canonicalPublicationJson, createDvdInitialManifest, validateDvdInitialManifest,
  type DvdInitialManifest,
} from "./dvd-initial-manifest.js";

export type DvdInitialPublicationFaultCode =
  | "DVD_PUBLICATION_INTENT_CONFLICT" | "DVD_PUBLICATION_INTENT_MISSING"
  | "DVD_PUBLICATION_IMAGE_CONFLICT" | "DVD_PUBLICATION_MANIFEST_CONFLICT"
  | "DVD_PUBLICATION_CHECKPOINT_CONFLICT" | "DVD_PUBLICATION_PROJECTION_AHEAD"
  | "DVD_PUBLICATION_PATH_CONFLICT";

export class DvdInitialPublicationFault extends Error {
  constructor(readonly code: DvdInitialPublicationFaultCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DvdInitialPublicationFault";
  }
}

export interface DvdInitialCheckpoint {
  originalDiscArchiveId: string;
  currentManifestId: string;
  currentManifestRevision: 1;
  currentManifestDigest: string;
  publicationDigest: string;
}

export type DvdInitialPublicationStep = "intent" | "image" | "manifest" | "link" | "pointer";
interface PublicationIdentity {
  originalsLibraryPath: string;
  originalDiscArchiveId: string;
  sourceArchiveJobId: string;
  imageFingerprint: string;
}
interface PublicationControls {
  signal?: AbortSignal;
  authorizeMutation?(): void | Promise<void>;
  /** Storage fault seam. A thrown interruption leaves durable state for replay. */
  fault?(point: `before:${DvdInitialPublicationStep}` | `after:${DvdInitialPublicationStep}`): void | Promise<void>;
  databaseProjection?: {
    currentManifestId: string;
    currentManifestRevision: number;
    currentManifestDigest: string;
  } | null;
}
interface PublicationIntent {
  version: "dvd-initial-publication-v1";
  stagingPath: string;
  manifest: DvdInitialManifest;
}
interface PublicationPaths {
  root: string;
  directory: string;
  archive: string;
  intent: string;
  manifest: string;
  pointer: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
async function authorize(controls: PublicationControls) {
  controls.signal?.throwIfAborted();
  await controls.authorizeMutation?.();
  controls.signal?.throwIfAborted();
}
async function step(controls: PublicationControls, name: DvdInitialPublicationStep, work: () => Promise<void>) {
  await authorize(controls);
  await controls.fault?.(`before:${name}`);
  await authorize(controls);
  await work();
  await controls.fault?.(`after:${name}`);
  await authorize(controls);
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function ensureDirectory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DvdInitialPublicationFault("DVD_PUBLICATION_PATH_CONFLICT");
  // Also sync an existing directory: an interrupted mkdir may not have been durable.
  await syncDirectory(dirname(path));
  await syncDirectory(path);
}
async function pathsFor(identity: PublicationIdentity): Promise<PublicationPaths> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identity.originalDiscArchiveId))
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_PATH_CONFLICT");
  const root = await realpath(identity.originalsLibraryPath);
  const evidenceRoot = join(root, ".dvd-evidence");
  await ensureDirectory(evidenceRoot);
  const directory = join(evidenceRoot, identity.originalDiscArchiveId);
  await ensureDirectory(directory);
  return {
    root, directory, archive: join(root, `${identity.originalDiscArchiveId}.iso`),
    intent: join(directory, "publication-intent.json"),
    manifest: join(directory, "initial-manifest.json"),
    pointer: join(directory, "checkpoint.json"),
  };
}
async function readRecord(path: string, code: DvdInitialPublicationFaultCode): Promise<unknown | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new DvdInitialPublicationFault(code, { cause: error });
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Evidence is not a regular file");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (before.ino !== named.ino || before.dev !== named.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("Evidence changed while reading");
    return value;
  } catch (error) { throw new DvdInitialPublicationFault(code, { cause: error }); }
  finally { await file.close(); }
}
async function installRecord(path: string, value: unknown, code: DvdInitialPublicationFaultCode) {
  const bytes = canonicalPublicationJson(value);
  const existing = await readRecord(path, code);
  if (existing !== undefined) {
    if (canonicalPublicationJson(existing) !== bytes) throw new DvdInitialPublicationFault(code);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await file.sync(); } finally { await file.close(); }
    await syncDirectory(dirname(path));
    return;
  }
  const temporary = join(dirname(path), `.publication-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    try { await link(temporary, path); } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (canonicalPublicationJson(await readRecord(path, code)) !== bytes) throw new DvdInitialPublicationFault(code);
    }
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary);
    await syncDirectory(dirname(path));
  }
}
function checkpointFor(manifest: DvdInitialManifest): DvdInitialCheckpoint {
  return {
    originalDiscArchiveId: manifest.originalDiscArchiveId, currentManifestId: manifest.id,
    currentManifestRevision: 1, currentManifestDigest: manifest.manifestDigest,
    publicationDigest: manifest.publicationDigest,
  };
}
function checkProjection(pointer: unknown, projection: PublicationControls["databaseProjection"]) {
  if (!projection) return;
  if (pointer !== undefined && (pointer === null || typeof pointer !== "object" || Array.isArray(pointer)))
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  const checkpoint = pointer as DvdInitialCheckpoint | undefined;
  if (!Number.isSafeInteger(projection.currentManifestRevision) || projection.currentManifestRevision < 1 ||
    checkpoint === undefined || projection.currentManifestRevision > checkpoint.currentManifestRevision)
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_PROJECTION_AHEAD");
  if (projection.currentManifestRevision === checkpoint.currentManifestRevision &&
    (projection.currentManifestId !== checkpoint.currentManifestId || projection.currentManifestDigest !== checkpoint.currentManifestDigest))
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
}
async function verifyImage(path: string, manifest: DvdInitialManifest, synchronize = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const verify = async () => {
      const stat = await file!.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!stat.isFile() || named.isSymbolicLink() || stat.ino !== named.ino || stat.dev !== named.dev ||
        `${stat.dev}:${stat.ino}` !== manifest.image.filesystemIdentity ||
        stat.size !== BigInt(manifest.boundaryPublishedSizeBytes) || stat.mtimeNs.toString() !== manifest.image.mtimeNs ||
        named.size !== stat.size || named.mtimeNs !== stat.mtimeNs)
        throw new Error("Image identity, extent or version differs from the proven copy");
    };
    await verify();
    if (synchronize) { await file.sync(); await verify(); }
  } catch (error) { throw new DvdInitialPublicationFault("DVD_PUBLICATION_IMAGE_CONFLICT", { cause: error }); }
  finally { await file?.close(); }
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}
function checkStagingPath(path: string, paths: PublicationPaths) {
  const evidenceRelative = relative(join(paths.root, ".dvd-evidence"), path);
  const insideEvidence = evidenceRelative !== ".." &&
    !evidenceRelative.startsWith(`..${sep}`) && !isAbsolute(evidenceRelative);
  if (!isAbsolute(path) || resolve(path) !== path || path === paths.archive ||
    insideEvidence)
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_PATH_CONFLICT");
}
function verifyIntent(value: unknown, identity: PublicationIdentity, paths: PublicationPaths): PublicationIntent {
  try {
    const intent = value as PublicationIntent;
    if (intent.version !== "dvd-initial-publication-v1") throw new Error("Unsupported publication intent");
    const manifest = validateDvdInitialManifest(intent.manifest);
    if (manifest.originalDiscArchiveId !== identity.originalDiscArchiveId || manifest.sourceArchiveJobId !== identity.sourceArchiveJobId || manifest.imageFingerprint !== identity.imageFingerprint)
      throw new Error("Publication intent belongs to another archive or job");
    checkStagingPath(intent.stagingPath, paths);
    if (canonicalPublicationJson(intent) !== canonicalPublicationJson({ version: "dvd-initial-publication-v1", stagingPath: intent.stagingPath, manifest }))
      throw new Error("Invalid publication intent");
    return { ...intent, manifest };
  } catch (error) { throw new DvdInitialPublicationFault("DVD_PUBLICATION_INTENT_CONFLICT", { cause: error }); }
}

async function completePublication(controls: PublicationControls, paths: PublicationPaths, intent: PublicationIntent) {
  const { manifest } = intent;
  const checkpoint = checkpointFor(manifest);
  const verifyEvidence = async () => {
    const currentIntent = await readRecord(paths.intent, "DVD_PUBLICATION_INTENT_CONFLICT");
    if (canonicalPublicationJson(currentIntent) !== canonicalPublicationJson(intent))
      throw new DvdInitialPublicationFault("DVD_PUBLICATION_INTENT_CONFLICT");
    const currentManifest = await readRecord(paths.manifest, "DVD_PUBLICATION_MANIFEST_CONFLICT");
    if (canonicalPublicationJson(currentManifest) !== canonicalPublicationJson(manifest))
      throw new DvdInitialPublicationFault("DVD_PUBLICATION_MANIFEST_CONFLICT");
  };
  const verifyCheckpoint = async () => {
    const current = await readRecord(paths.pointer, "DVD_PUBLICATION_CHECKPOINT_CONFLICT");
    if (canonicalPublicationJson(current) !== canonicalPublicationJson(checkpoint))
      throw new DvdInitialPublicationFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  };
  const pointer = await readRecord(paths.pointer, "DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  checkProjection(pointer, controls.databaseProjection);
  const savedManifest = await readRecord(paths.manifest, "DVD_PUBLICATION_MANIFEST_CONFLICT");
  if (savedManifest !== undefined && canonicalPublicationJson(savedManifest) !== canonicalPublicationJson(manifest))
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_MANIFEST_CONFLICT");
  if (pointer !== undefined && (canonicalPublicationJson(pointer) !== canonicalPublicationJson(checkpoint) || savedManifest === undefined))
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  const published = await exists(paths.archive);
  if (pointer !== undefined && !published) throw new DvdInitialPublicationFault("DVD_PUBLICATION_IMAGE_CONFLICT");
  // A published link is usable after request cleanup, but must be the exact intended inode.
  const imagePath = published ? paths.archive : intent.stagingPath;
  await step(controls, "image", () => verifyImage(imagePath, manifest, true));
  await step(controls, "manifest", () => installRecord(paths.manifest, manifest, "DVD_PUBLICATION_MANIFEST_CONFLICT"));
  await step(controls, "link", async () => {
    if (!published) {
      await verifyImage(intent.stagingPath, manifest);
      await authorize(controls);
      try { await link(intent.stagingPath, paths.archive); } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    await verifyImage(paths.archive, manifest, true);
    await syncDirectory(paths.root);
    await verifyImage(paths.archive, manifest);
  });
  await step(controls, "pointer", async () => {
    await verifyImage(paths.archive, manifest);
    await verifyEvidence();
    await authorize(controls);
    await installRecord(paths.pointer, checkpoint, "DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  });
  await verifyEvidence();
  await verifyCheckpoint();
  await verifyImage(paths.archive, manifest);
  return {
    archivePath: paths.archive, manifest, checkpoint,
    async verifyPublication() {
      await verifyEvidence();
      await verifyCheckpoint();
      await verifyImage(paths.archive, manifest);
    },
    async finalizePublication() {
      // The caller still holds archive exclusion, but its Archive Job claim may
      // already be completed by the database save. Do not renew that old claim.
      controls.signal?.throwIfAborted();
      // Revalidate the committed save before removing only its request-owned link.
      await verifyCheckpoint();
      await verifyEvidence();
      await verifyImage(paths.archive, manifest);
      if (await exists(intent.stagingPath)) {
        if (await realpath(dirname(intent.stagingPath)) !== dirname(intent.stagingPath))
          throw new DvdInitialPublicationFault("DVD_PUBLICATION_PATH_CONFLICT");
        await verifyImage(intent.stagingPath, manifest);
        controls.signal?.throwIfAborted();
        await unlink(intent.stagingPath);
        await syncDirectory(dirname(intent.stagingPath));
      }
    },
  };
}

/** Dormant marked-job publication seam. Caller holds archive exclusion and has
 * closed every copy helper before supplying the proven immutable image. #408
 * consumes the returned checkpoint in its atomic database save. */
export async function publishDvdInitialArchive(options: PublicationIdentity & PublicationControls & { proven: ProvenDvdInitialArchiveBoundary }) {
  await authorize(options);
  const manifest = createDvdInitialManifest(options);
  const paths = await pathsFor(options);
  const sourcePath = resolve(options.proven.initialCopy.imagePath);
  const stagingPath = join(await realpath(dirname(sourcePath)), basename(sourcePath));
  checkStagingPath(stagingPath, paths);
  const intent: PublicationIntent = { version: "dvd-initial-publication-v1", stagingPath, manifest };
  // Never create intent around a foreign existing artifact or checkpoint.
  if (await readRecord(paths.intent, "DVD_PUBLICATION_INTENT_CONFLICT") === undefined &&
    (await exists(paths.archive) || await exists(paths.manifest) || await exists(paths.pointer)))
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_INTENT_MISSING");
  checkProjection(await readRecord(paths.pointer, "DVD_PUBLICATION_CHECKPOINT_CONFLICT"), options.databaseProjection);
  await verifyImage(stagingPath, manifest);
  await step(options, "intent", () => installRecord(paths.intent, intent, "DVD_PUBLICATION_INTENT_CONFLICT"));
  return completePublication(options, paths, intent);
}

/** Resolve and validate the durable staging intent before ownership is
 * acquired. Reconciliation validates the same intent again under ownership. */
export async function readDvdInitialArchivePublicationImagePath(
  options: PublicationIdentity,
): Promise<string> {
  const paths = await pathsFor(options);
  const value = await readRecord(
    paths.intent,
    "DVD_PUBLICATION_INTENT_CONFLICT",
  );
  if (value === undefined) {
    throw new DvdInitialPublicationFault("DVD_PUBLICATION_INTENT_MISSING");
  }
  return verifyIntent(value, options, paths).stagingPath;
}

/** Replay durable intent without another optical read, metadata pass or image hash. */
export async function reconcileDvdInitialArchivePublication(options: PublicationIdentity & PublicationControls) {
  await authorize(options);
  const paths = await pathsFor(options);
  const value = await readRecord(paths.intent, "DVD_PUBLICATION_INTENT_CONFLICT");
  if (value === undefined) throw new DvdInitialPublicationFault("DVD_PUBLICATION_INTENT_MISSING");
  const intent = verifyIntent(value, options, paths);
  await step(options, "intent", () => installRecord(paths.intent, intent, "DVD_PUBLICATION_INTENT_CONFLICT"));
  return completePublication(options, paths, intent);
}
