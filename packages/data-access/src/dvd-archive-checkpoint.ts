import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertDvdArchiveBoundaryEvidenceDigest,
  assertDvdArchiveEvidenceManifestDigests,
  assertDvdArchiveRecoveryReadEvidenceDigest,
} from "./dvd-archive-evidence-digests.js";
import { archiveBoundaryEvidenceFromRecord, type ArchiveBoundaryEvidence } from "./archive-boundary.js";
import { canonicalJson } from "./canonical-json.js";
import { assertDvdEvidenceRangeTransition } from "./dvd-evidence-transition.js";
import { validateDvdSourceSampleManifest } from "./dvd-disc-verification.js";
import { DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES } from "./dvd-recovery-storage-preflight.js";
import type { ArchiveJob, DvdArchiveEvidenceHeader, DvdInitialArchiveSave, OriginalDiscArchive } from "./types.js";

export type CommittedDvdInitialEvidence = DvdInitialArchiveSave["manifest"] & {
  publicationDigest: string;
  boundaryEvidence: ArchiveBoundaryEvidence;
  image: { filesystemIdentity: string; mtimeNs: string };
};

export interface CommittedDvdCurrentCheckpoint {
  initialEvidence: CommittedDvdInitialEvidence;
  currentManifestId: string;
  currentManifestRevision: number;
  currentManifestDigest: string;
}

export interface DvdRecoveryProtectedRange {
  startByte: number;
  byteCount: number;
  unitBytes: number;
  beforeDigest: string;
  afterDigest: string;
}

export type CommittedDvdRecoveryEvidence = DvdInitialArchiveSave["manifest"] & {
  checkpointFormat: "dvd-recovery-batch-v1";
  sourceArchiveJobId: string;
  publicationDigest: string;
  rootPublicationDigest: string;
  previousPublicationDigest: string;
  image: { filesystemIdentity: string; mtimeNs: string };
  previousImage: { filesystemIdentity: string; mtimeNs: string };
  boundaryEvidence: ArchiveBoundaryEvidence;
  recoveryRead: import("./dvd-archive-evidence-digests.js")
    .DvdArchiveRecoveryReadEvidenceDigestInput & {
      id: string;
      evidenceDigest: string;
    };
  journalDigest: string | null;
  protectedRanges: readonly DvdRecoveryProtectedRange[];
};

export type CommittedDvdCheckpointEvidence =
  | CommittedDvdInitialEvidence
  | CommittedDvdRecoveryEvidence;

export const DVD_RECOVERY_MAX_CHECKPOINT_REVISION = 10_000;

export class DvdCheckpointReadFault extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "DvdCheckpointReadFault";
  }
}

interface DvdCheckpointPointer {
  originalDiscArchiveId: string;
  currentManifestId: string;
  currentManifestRevision: number;
  currentManifestDigest: string;
  publicationDigest: string;
}

export { canonicalJson as canonicalPublicationJson };

export function createDvdInitialPublicationDigest(value: unknown): string {
  return createHash("sha256").update("rip-dvd:dvd-initial-publication:v1\0")
    .update(canonicalJson(value)).digest("hex");
}

export function createDvdRecoveryCheckpointPublicationDigest(
  value: unknown,
): string {
  return createHash("sha256").update("rip-dvd:dvd-recovery-checkpoint:v1\0")
    .update(canonicalJson(value)).digest("hex");
}

async function readRecord(path: string, code: string): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Not regular evidence");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (before.ino !== named.ino || before.dev !== named.dev ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("Evidence changed during read");
    return value;
  } catch { throw new DvdCheckpointReadFault(code); }
  finally { await file?.close(); }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertRecoveryManifestStaticProvenance(
  manifest: CommittedDvdRecoveryEvidence,
  initial: CommittedDvdInitialEvidence,
): void {
  if (
    manifest.originalDiscArchiveId !== initial.originalDiscArchiveId ||
    manifest.evidenceFormat !== initial.evidenceFormat ||
    manifest.imageFingerprint !== initial.imageFingerprint ||
    manifest.sectorSizeBytes !== initial.sectorSizeBytes ||
    manifest.acceptedEndLbaExclusive !== initial.acceptedEndLbaExclusive ||
    manifest.boundaryPolicyVersion !== initial.boundaryPolicyVersion ||
    manifest.boundaryReportedSizeBytes !== initial.boundaryReportedSizeBytes ||
    manifest.boundaryPublishedSizeBytes !== initial.boundaryPublishedSizeBytes ||
    manifest.boundaryEvidenceDigest !== initial.boundaryEvidenceDigest ||
    canonicalJson(manifest.boundaryEvidence) !==
      canonicalJson(initial.boundaryEvidence) ||
    manifest.sourceArchiveJobId !== initial.sourceArchiveJobId ||
    manifest.rootPublicationDigest !== initial.publicationDigest
  ) {
    throw new Error("Recovery manifest provenance differs");
  }
}

function assertRecoveryManifestRecord(
  raw: unknown,
  initial: CommittedDvdInitialEvidence,
): asserts raw is CommittedDvdRecoveryEvidence {
  const manifest = raw as CommittedDvdRecoveryEvidence;
  const { publicationDigest, ...payload } = manifest;
  const recovered = manifest.recoveryRead?.outcome === "recovered";
  const protectedByteCount = manifest.protectedRanges?.reduce(
    (count, range) => count + range.byteCount,
    0,
  );
  const protectedUnitBytes = manifest.protectedRanges?.[0]?.unitBytes;
  const recoveredStartByte = manifest.recoveryRead?.startLba *
    manifest.sectorSizeBytes;
  const expectedProtectedStart = protectedUnitBytes === undefined
    ? null
    : Math.floor(recoveredStartByte / protectedUnitBytes) * protectedUnitBytes;
  const expectedProtectedEnd = protectedUnitBytes === undefined
    ? null
    : Math.ceil(
      (recoveredStartByte + manifest.sectorSizeBytes) / protectedUnitBytes,
    ) * protectedUnitBytes;
  if (
    publicationDigest !==
      createDvdRecoveryCheckpointPublicationDigest(payload) ||
    manifest.checkpointFormat !== "dvd-recovery-batch-v1" ||
    typeof manifest.id !== "string" ||
    manifest.id.length === 0 ||
    manifest.id.length > 256 ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 2 ||
    manifest.revision > DVD_RECOVERY_MAX_CHECKPOINT_REVISION ||
    manifest.id !==
      `${initial.originalDiscArchiveId}:recovery:${manifest.revision}` ||
    manifest.previousManifestId === null ||
    manifest.previousManifestDigest === null ||
    manifest.recoveryReadId === null ||
    manifest.recoveryReadEvidenceDigest === null ||
    manifest.recoveryRead === null ||
    typeof manifest.recoveryRead !== "object" ||
    manifest.recoveryRead.id !== manifest.recoveryReadId ||
    manifest.recoveryRead.evidenceDigest !==
      manifest.recoveryReadEvidenceDigest ||
    manifest.recoveryRead.originalDiscArchiveId !==
      initial.originalDiscArchiveId ||
    (recovered
      ? !/^[0-9a-f]{64}$/.test(manifest.journalDigest ?? "") ||
        manifest.protectedRanges.length < 1
      : manifest.journalDigest !== null ||
        manifest.protectedRanges.length !== 0) ||
    protectedByteCount > DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES ||
    (recovered && manifest.protectedRanges.some((range, index) =>
      range.unitBytes !== protectedUnitBytes ||
      range.byteCount !== protectedUnitBytes ||
      range.startByte !== expectedProtectedStart! + index * protectedUnitBytes
    )) ||
    (recovered &&
      expectedProtectedEnd !== expectedProtectedStart! + protectedByteCount) ||
    manifest.protectedRanges.some((range) =>
      !Number.isSafeInteger(range.startByte) || range.startByte < 0 ||
      !Number.isSafeInteger(range.byteCount) || range.byteCount < 1 ||
      !Number.isSafeInteger(range.unitBytes) || range.unitBytes < 1 ||
      range.startByte % range.unitBytes !== 0 ||
      range.byteCount % range.unitBytes !== 0 ||
      range.startByte + range.byteCount > manifest.boundaryPublishedSizeBytes ||
      !/^[0-9a-f]{64}$/.test(range.beforeDigest) ||
      !/^[0-9a-f]{64}$/.test(range.afterDigest)
    )
  ) {
    throw new Error("Recovery manifest shape differs");
  }
  assertDvdArchiveEvidenceManifestDigests(manifest);
  assertDvdArchiveRecoveryReadEvidenceDigest(
    manifest.recoveryRead,
    manifest.recoveryRead.evidenceDigest,
  );
  assertRecoveryManifestStaticProvenance(manifest, initial);
}

function assertRecoveryManifestTransition(
  manifest: CommittedDvdRecoveryEvidence,
  previous: CommittedDvdCheckpointEvidence,
): void {
  if (
    manifest.revision !== previous.revision + 1 ||
    manifest.previousManifestId !== previous.id ||
    manifest.previousManifestDigest !== previous.manifestDigest ||
    manifest.previousPublicationDigest !== previous.publicationDigest ||
    manifest.previousImage.filesystemIdentity !==
      previous.image.filesystemIdentity ||
    manifest.previousImage.mtimeNs !== previous.image.mtimeNs ||
    manifest.recoveryRead.fromManifestId !== previous.id ||
    manifest.recoveryRead.fromManifestRevision !== previous.revision
  ) {
    throw new Error("Recovery manifest transition differs");
  }
  assertDvdEvidenceRangeTransition(
    previous.unrecoveredSourceRanges,
    manifest.unrecoveredSourceRanges,
    manifest.recoveryRead,
  );
}

async function verifyImage(
  archive: OriginalDiscArchive,
  manifest: CommittedDvdCheckpointEvidence,
): Promise<void> {
  let image;
  try {
    image = await open(
      archive.archivePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await image.stat({ bigint: true });
    const named = await lstat(archive.archivePath, { bigint: true });
    if (
      !stat.isFile() || named.isSymbolicLink() || stat.ino !== named.ino ||
      stat.dev !== named.dev ||
      `${stat.dev}:${stat.ino}` !== manifest.image.filesystemIdentity ||
      stat.size !== BigInt(manifest.boundaryPublishedSizeBytes) ||
      stat.mtimeNs.toString() !== manifest.image.mtimeNs ||
      named.size !== stat.size || named.mtimeNs !== stat.mtimeNs
    ) {
      throw new Error("Image differs from checkpoint");
    }
    if ("protectedRanges" in manifest) {
      for (const range of manifest.protectedRanges) {
        const bytes = Buffer.alloc(range.byteCount);
        const read = await image.read(
          bytes,
          0,
          bytes.length,
          range.startByte,
        );
        if (
          read.bytesRead !== bytes.length ||
          createHash("sha256").update(bytes).digest("hex") !== range.afterDigest
        ) {
          throw new Error("Committed protected bytes differ");
        }
      }
    }
  } catch {
    throw new DvdCheckpointReadFault("DVD_PUBLICATION_IMAGE_CONFLICT");
  } finally {
    await image?.close();
  }
}

async function readCommittedDvdCheckpointRecords(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
  assertImageOwnership(): void;
}, requireInitialPointer: boolean): Promise<{
  initialEvidence: CommittedDvdInitialEvidence;
  currentEvidence: CommittedDvdCheckpointEvidence;
  checkpoint: DvdCheckpointPointer;
} | null> {
  const { archive, header, jobs } = input;
  const markedJobs = jobs.filter(job => job.evidenceFormat === "dvd-recovery-evidence-v1");
  if (header === null && markedJobs.length === 0) return null;
  input.assertImageOwnership();
  if (!input.originalsLibraryPath) throw new DvdCheckpointReadFault("DVD_EVIDENCE_STORAGE_UNAVAILABLE");
  let root: string;
  let directory: string;
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(archive.id)) throw new Error("Invalid archive identity");
    root = await realpath(input.originalsLibraryPath);
    directory = join(root, ".dvd-evidence", archive.id);
    if (await realpath(directory) !== directory || resolve(archive.archivePath) !== join(root, `${archive.id}.iso`))
      throw new Error("Evidence path conflict");
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_PATH_CONFLICT"); }
  const journalPath = join(directory, "recovery-journal.bin");
  if (await pathExists(journalPath)) {
    throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  }
  const pointerPath = join(directory, "checkpoint.json");
  const pointer = await readRecord(pointerPath, "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE");
  input.assertImageOwnership();
  const raw = await readRecord(join(directory, "initial-manifest.json"), "DVD_PUBLICATION_MANIFEST_CONFLICT");
  input.assertImageOwnership();
  let manifest: CommittedDvdInitialEvidence;
  try {
    manifest = raw as CommittedDvdInitialEvidence;
    const { publicationDigest, ...payload } = manifest;
    if (publicationDigest !== createDvdInitialPublicationDigest(payload)) throw new Error("Publication digest differs");
    assertDvdArchiveEvidenceManifestDigests(manifest);
    assertDvdArchiveBoundaryEvidenceDigest(manifest.boundaryEvidence, manifest.boundaryEvidenceDigest);
    const record = raw as CommittedDvdInitialEvidence & {
      policies: { publication: string; copy: string; metadata: string | null };
      integrity: unknown;
      initialCopy: { unrecoveredSourceRanges: unknown; declaredByteCount: number; recoveredByteCount: number; copyPolicyVersion: string };
      metadataDecision: { policyVersion: string; decision: string; blockers: unknown[]; observations: unknown[] } | null;
    };
    const unresolved = manifest.unrecoveredSourceRanges.reduce((count, range) => count + range.sectorCount, 0);
    if (Object.hasOwn(manifest, "sourceSampleManifest")) {
      const sourceSampleManifest = validateDvdSourceSampleManifest(
        manifest.sourceSampleManifest!,
      );
      if (
        sourceSampleManifest.sourceMetadataFingerprint !==
          manifest.imageFingerprint ||
        sourceSampleManifest.acceptedEndLbaExclusive !==
          manifest.acceptedEndLbaExclusive ||
        sourceSampleManifest.checkpointRevision !== manifest.revision ||
        sourceSampleManifest.checkpointDigest !== manifest.manifestDigest
      ) throw new Error("Source sample manifest provenance differs");
    }
    const integrity = {
      integrity: unresolved === 0 ? "clean_read" : "incomplete_read", policyVersion: "dvd-recovery-evidence-v1",
      badSectorCount: unresolved, badAreaCount: manifest.unrecoveredSourceRanges.length,
      badSectorRanges: manifest.unrecoveredSourceRanges.map(({ startLba, sectorCount }) => ({ startLba, sectorCount })),
    };
    if (canonicalJson(record.integrity) !== canonicalJson(integrity) ||
      canonicalJson(record.initialCopy.unrecoveredSourceRanges) !== canonicalJson(manifest.unrecoveredSourceRanges) ||
      record.initialCopy.declaredByteCount !== manifest.boundaryReportedSizeBytes ||
      record.initialCopy.recoveredByteCount !== manifest.boundaryPublishedSizeBytes - unresolved * 2048 ||
      record.initialCopy.copyPolicyVersion !== "dvd-initial-copy-v1" ||
      record.policies.publication !== "dvd-initial-publication-v1" || record.policies.copy !== "dvd-initial-copy-v1")
      throw new Error("Initial evidence projections or policies differ");
    if (manifest.boundaryEvidence.excludedSectorCount === 0) {
      if (record.policies.metadata !== "dvd-full-extent-metadata-v1" ||
        record.metadataDecision?.policyVersion !== record.policies.metadata || record.metadataDecision.decision !== "publishable" ||
        record.metadataDecision.blockers.length !== 0 || !Array.isArray(record.metadataDecision.observations))
        throw new Error("Full-extent metadata decision differs");
    } else if (record.metadataDecision !== null || record.policies.metadata !== null) {
      throw new Error("Corrected boundary has a full-extent metadata decision");
    }
    const source = markedJobs.find(job => job.id === manifest.sourceArchiveJobId);
    if (manifest.originalDiscArchiveId !== archive.id || manifest.imageFingerprint !== archive.fingerprint ||
      archive.discKind !== "dvd" || manifest.revision !== 1 || manifest.id !== `${archive.id}:initial` ||
      !source || source.originalDiscArchiveId !== archive.id || source.detectedDiscId !== archive.detectedDiscId ||
      source.status !== "completed" ||
      manifest.boundaryPolicyVersion !== manifest.boundaryEvidence.policyVersion ||
      manifest.boundaryReportedSizeBytes !== manifest.boundaryEvidence.reportedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== manifest.boundaryEvidence.publishedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== archive.sizeBytes ||
      canonicalJson(manifest.boundaryEvidence) !== canonicalJson(archiveBoundaryEvidenceFromRecord(archive)))
      throw new Error("Manifest provenance differs");
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_MANIFEST_CONFLICT"); }
  let checkpoint: DvdCheckpointPointer;
  try {
    checkpoint = pointer as DvdCheckpointPointer;
    const keys = Object.keys(checkpoint).sort();
    const expectedKeys = [
      "currentManifestDigest",
      "currentManifestId",
      "currentManifestRevision",
      "originalDiscArchiveId",
      "publicationDigest",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      checkpoint.originalDiscArchiveId !== archive.id ||
      typeof checkpoint.currentManifestId !== "string" ||
      checkpoint.currentManifestId.length === 0 ||
      checkpoint.currentManifestId.length > 256 ||
      !Number.isSafeInteger(checkpoint.currentManifestRevision) ||
      checkpoint.currentManifestRevision < 1 ||
      !/^[0-9a-f]{64}$/.test(checkpoint.currentManifestDigest) ||
      (checkpoint.currentManifestRevision === 1 &&
        (checkpoint.currentManifestId !== manifest.id ||
          checkpoint.currentManifestDigest !== manifest.manifestDigest ||
          checkpoint.publicationDigest !== manifest.publicationDigest)) ||
      (requireInitialPointer && checkpoint.currentManifestRevision !== 1)
    ) throw new Error("Checkpoint differs");
  } catch {
    throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  }
  let currentEvidence: CommittedDvdCheckpointEvidence = manifest;
  if (checkpoint.currentManifestRevision > 1) {
    try {
      const currentRaw = await readRecord(
        join(
          directory,
          `recovery-manifest-${checkpoint.currentManifestRevision}.json`,
        ),
        "DVD_PUBLICATION_CHECKPOINT_CONFLICT",
      );
      input.assertImageOwnership();
      assertRecoveryManifestRecord(currentRaw, manifest);
      const current = currentRaw;
      const previous = checkpoint.currentManifestRevision === 2
        ? manifest
        : await readRecord(
          join(
            directory,
            `recovery-manifest-${checkpoint.currentManifestRevision - 1}.json`,
          ),
          "DVD_PUBLICATION_CHECKPOINT_CONFLICT",
        );
      input.assertImageOwnership();
      if (checkpoint.currentManifestRevision > 2) {
        assertRecoveryManifestRecord(previous, manifest);
      }
      const predecessor = previous as CommittedDvdCheckpointEvidence;
      assertRecoveryManifestTransition(current, predecessor);
      if (
        current.id !== checkpoint.currentManifestId ||
        current.revision !== checkpoint.currentManifestRevision ||
        current.manifestDigest !== checkpoint.currentManifestDigest ||
        current.publicationDigest !== checkpoint.publicationDigest
      ) {
        throw new Error("Recovery checkpoint pointer differs");
      }
      currentEvidence = current;
    } catch (error) {
      if (error instanceof DvdCheckpointReadFault) throw error;
      throw new DvdCheckpointReadFault(
        "DVD_PUBLICATION_CHECKPOINT_CONFLICT",
        { cause: error },
      );
    }
  }
  if (header !== null) {
    if (header.currentManifestRevision > checkpoint.currentManifestRevision)
      throw new DvdCheckpointReadFault("DVD_PUBLICATION_PROJECTION_AHEAD");
    if (header.sourceArchiveJobId !== manifest.sourceArchiveJobId ||
      header.acceptedEndLbaExclusive !== currentEvidence.acceptedEndLbaExclusive ||
      header.boundaryEvidenceDigest !== currentEvidence.boundaryEvidenceDigest ||
      (header.currentManifestRevision === checkpoint.currentManifestRevision &&
        (header.currentManifestId !== checkpoint.currentManifestId ||
          header.currentManifestDigest !== checkpoint.currentManifestDigest)))
      throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  }
  await verifyImage(archive, currentEvidence);
  input.assertImageOwnership();
  if (
    await pathExists(journalPath) ||
    canonicalJson(
      await readRecord(pointerPath, "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE"),
    ) !== canonicalJson(pointer)
  ) {
    throw new DvdCheckpointReadFault("DVD_EVIDENCE_CHANGED_DURING_READ");
  }
  input.assertImageOwnership();
  return { initialEvidence: manifest, currentEvidence, checkpoint };
}

/** Read only. Never reconcile, install a pointer, or synchronize an operator read. */
export async function readCommittedDvdInitialCheckpoint(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
  assertImageOwnership(): void;
}): Promise<CommittedDvdInitialEvidence | null> {
  return (await readCommittedDvdCheckpointRecords(input, true))
    ?.initialEvidence ?? null;
}

/** Read the current committed checkpoint evidence without traversing history. */
export async function readCommittedDvdCheckpoint(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
  assertImageOwnership(): void;
}): Promise<CommittedDvdCheckpointEvidence | null> {
  const records = await readCommittedDvdCheckpointRecords(input, false);
  if (records === null) return null;
  const header = input.header;
  if (header !== null) {
    if (
      header.currentManifestId !== records.checkpoint.currentManifestId ||
      header.currentManifestRevision !== records.checkpoint.currentManifestRevision ||
      header.currentManifestDigest !== records.checkpoint.currentManifestDigest
    ) {
      throw new DvdCheckpointReadFault(
        records.checkpoint.currentManifestRevision === 1
          ? "DVD_PUBLICATION_CHECKPOINT_CONFLICT"
          : "CONSISTENCY_FAULT",
      );
    }
  } else if (records.checkpoint.currentManifestRevision > 1) {
    throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  }
  return records.currentEvidence;
}

/** Read the immutable publication evidence and the current durable pointer. */
export async function readCommittedDvdCurrentCheckpoint(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
  assertImageOwnership(): void;
}): Promise<CommittedDvdCurrentCheckpoint | null> {
  const records = await readCommittedDvdCheckpointRecords(input, false);
  if (records === null) return null;
  const header = input.header;
  if (
    header === null ||
    header.currentManifestId !== records.checkpoint.currentManifestId ||
    header.currentManifestRevision !== records.checkpoint.currentManifestRevision ||
    header.currentManifestDigest !== records.checkpoint.currentManifestDigest
  ) {
    throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  }
  return {
    initialEvidence: records.initialEvidence,
    currentManifestId: records.checkpoint.currentManifestId,
    currentManifestRevision: records.checkpoint.currentManifestRevision,
    currentManifestDigest: records.checkpoint.currentManifestDigest,
  };
}
