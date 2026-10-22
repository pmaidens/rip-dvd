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
import { assertDvdEvidenceRangeTransition } from "./dvd-recovery-transition.js";
import { DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES } from "./dvd-recovery-storage-preflight.js";
import type {
  ArchiveJob,
  DvdArchiveEvidenceHeader,
  DvdInitialArchiveSave,
  OriginalDiscArchive,
} from "./types.js";

export type CommittedDvdInitialEvidence = DvdInitialArchiveSave["manifest"] & {
  publicationDigest: string;
  boundaryEvidence: ArchiveBoundaryEvidence;
  image: { filesystemIdentity: string; mtimeNs: string };
};

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
  recoveryRead: import("./dvd-archive-evidence-digests.js").DvdArchiveRecoveryReadEvidenceDigestInput & {
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
  constructor(readonly code: string) { super(code); }
}

export function canonicalPublicationJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
}

function publicationDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(canonicalPublicationJson(value)).digest("hex");
}

export function createDvdInitialPublicationDigest(value: unknown): string {
  return publicationDigest("rip-dvd:dvd-initial-publication:v1\0", value);
}

export function createDvdRecoveryCheckpointPublicationDigest(value: unknown): string {
  return publicationDigest("rip-dvd:dvd-recovery-checkpoint:v1\0", value);
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
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertInitialManifest(
  raw: unknown,
  archive: OriginalDiscArchive,
  jobs: readonly ArchiveJob[],
): CommittedDvdInitialEvidence {
  try {
    const manifest = raw as CommittedDvdInitialEvidence;
    const { publicationDigest: recordedDigest, ...payload } = manifest;
    if (recordedDigest !== createDvdInitialPublicationDigest(payload)) throw new Error("Publication digest differs");
    assertDvdArchiveEvidenceManifestDigests(manifest);
    assertDvdArchiveBoundaryEvidenceDigest(manifest.boundaryEvidence, manifest.boundaryEvidenceDigest);
    const record = raw as CommittedDvdInitialEvidence & {
      policies: { publication: string; copy: string; metadata: string | null };
      integrity: unknown;
      initialCopy: { unrecoveredSourceRanges: unknown; declaredByteCount: number; recoveredByteCount: number; copyPolicyVersion: string };
      metadataDecision: { policyVersion: string; decision: string; blockers: unknown[]; observations: unknown[] } | null;
    };
    const unresolved = manifest.unrecoveredSourceRanges.reduce((count, range) => count + range.sectorCount, 0);
    const integrity = {
      integrity: unresolved === 0 ? "clean_read" : "incomplete_read", policyVersion: "dvd-recovery-evidence-v1",
      badSectorCount: unresolved, badAreaCount: manifest.unrecoveredSourceRanges.length,
      badSectorRanges: manifest.unrecoveredSourceRanges.map(({ startLba, sectorCount }) => ({ startLba, sectorCount })),
    };
    if (canonicalPublicationJson(record.integrity) !== canonicalPublicationJson(integrity) ||
      canonicalPublicationJson(record.initialCopy.unrecoveredSourceRanges) !== canonicalPublicationJson(manifest.unrecoveredSourceRanges) ||
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
    const source = jobs.find(job => job.id === manifest.sourceArchiveJobId && job.evidenceFormat === "dvd-recovery-evidence-v1");
    if (manifest.originalDiscArchiveId !== archive.id || manifest.imageFingerprint !== archive.fingerprint ||
      archive.discKind !== "dvd" || manifest.revision !== 1 || manifest.id !== `${archive.id}:initial` ||
      !source || source.originalDiscArchiveId !== archive.id || source.detectedDiscId !== archive.detectedDiscId ||
      source.status !== "completed" || manifest.boundaryPolicyVersion !== manifest.boundaryEvidence.policyVersion ||
      manifest.boundaryReportedSizeBytes !== manifest.boundaryEvidence.reportedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== manifest.boundaryEvidence.publishedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== archive.sizeBytes ||
      canonicalPublicationJson(manifest.boundaryEvidence) !== canonicalPublicationJson(archiveBoundaryEvidenceFromRecord(archive)))
      throw new Error("Manifest provenance differs");
    return manifest;
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_MANIFEST_CONFLICT"); }
}

function assertRecoveryManifest(
  raw: unknown,
  previous: CommittedDvdCheckpointEvidence,
  initial: CommittedDvdInitialEvidence,
): CommittedDvdRecoveryEvidence {
  try {
    const manifest = raw as CommittedDvdRecoveryEvidence;
    const { publicationDigest: recordedDigest, ...payload } = manifest;
    if (recordedDigest !== createDvdRecoveryCheckpointPublicationDigest(payload)) throw new Error("Recovery publication digest differs");
    assertDvdArchiveEvidenceManifestDigests(manifest);
    assertDvdArchiveBoundaryEvidenceDigest(manifest.boundaryEvidence, manifest.boundaryEvidenceDigest);
    assertDvdArchiveRecoveryReadEvidenceDigest(manifest.recoveryRead, manifest.recoveryRead.evidenceDigest);
    assertDvdEvidenceRangeTransition(previous.unrecoveredSourceRanges, manifest.unrecoveredSourceRanges, manifest.recoveryRead);
    const recovered = manifest.recoveryRead.outcome === "recovered";
    const protectedByteCount = manifest.protectedRanges.reduce((count, range) => count + range.byteCount, 0);
    const protectedUnitBytes = manifest.protectedRanges[0]?.unitBytes;
    const recoveredStartByte = manifest.recoveryRead.startLba * manifest.sectorSizeBytes;
    const expectedProtectedStart = protectedUnitBytes === undefined
      ? null
      : Math.floor(recoveredStartByte / protectedUnitBytes) * protectedUnitBytes;
    const expectedProtectedEnd = protectedUnitBytes === undefined
      ? null
      : Math.ceil(
        (recoveredStartByte + manifest.sectorSizeBytes) / protectedUnitBytes,
      ) * protectedUnitBytes;
    if (manifest.checkpointFormat !== "dvd-recovery-batch-v1" ||
      manifest.originalDiscArchiveId !== initial.originalDiscArchiveId ||
      manifest.id !== `${initial.originalDiscArchiveId}:recovery:${manifest.revision}` ||
      manifest.revision !== previous.revision + 1 || manifest.previousManifestId !== previous.id ||
      manifest.previousManifestDigest !== previous.manifestDigest ||
      manifest.recoveryReadId !== manifest.recoveryRead.id ||
      manifest.recoveryReadEvidenceDigest !== manifest.recoveryRead.evidenceDigest ||
      manifest.recoveryRead.originalDiscArchiveId !== initial.originalDiscArchiveId ||
      manifest.recoveryRead.fromManifestId !== previous.id ||
      manifest.recoveryRead.fromManifestRevision !== previous.revision ||
      manifest.sourceArchiveJobId !== initial.sourceArchiveJobId ||
      manifest.rootPublicationDigest !== initial.publicationDigest ||
      manifest.previousPublicationDigest !== previous.publicationDigest ||
      manifest.evidenceFormat !== initial.evidenceFormat || manifest.imageFingerprint !== initial.imageFingerprint ||
      manifest.sectorSizeBytes !== initial.sectorSizeBytes ||
      manifest.acceptedEndLbaExclusive !== initial.acceptedEndLbaExclusive ||
      manifest.boundaryPolicyVersion !== initial.boundaryPolicyVersion ||
      manifest.boundaryReportedSizeBytes !== initial.boundaryReportedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== initial.boundaryPublishedSizeBytes ||
      manifest.boundaryEvidenceDigest !== initial.boundaryEvidenceDigest ||
      canonicalPublicationJson(manifest.boundaryEvidence) !== canonicalPublicationJson(initial.boundaryEvidence) ||
      manifest.previousImage.filesystemIdentity !== previous.image.filesystemIdentity ||
      manifest.previousImage.mtimeNs !== previous.image.mtimeNs ||
      (recovered ? !/^[0-9a-f]{64}$/.test(manifest.journalDigest ?? "") || manifest.protectedRanges.length < 1 :
        manifest.journalDigest !== null || manifest.protectedRanges.length !== 0) ||
      protectedByteCount > DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES ||
      (recovered && manifest.protectedRanges.some((range, index) =>
        range.unitBytes !== protectedUnitBytes ||
        range.byteCount !== protectedUnitBytes ||
        range.startByte !== expectedProtectedStart! + index * protectedUnitBytes
      )) ||
      (recovered && expectedProtectedEnd !==
        expectedProtectedStart! + protectedByteCount) ||
      manifest.protectedRanges.some((range) =>
        !Number.isSafeInteger(range.startByte) || range.startByte < 0 ||
        !Number.isSafeInteger(range.byteCount) || range.byteCount < 1 ||
        !Number.isSafeInteger(range.unitBytes) || range.unitBytes < 1 ||
        range.startByte % range.unitBytes !== 0 || range.byteCount % range.unitBytes !== 0 ||
        range.startByte + range.byteCount > manifest.boundaryPublishedSizeBytes ||
        !/^[0-9a-f]{64}$/.test(range.beforeDigest) || !/^[0-9a-f]{64}$/.test(range.afterDigest)
      )) throw new Error("Recovery manifest contents differ");
    return manifest;
  } catch { throw new DvdCheckpointReadFault("CONSISTENCY_FAULT"); }
}

async function verifyImage(
  archive: OriginalDiscArchive,
  manifest: CommittedDvdCheckpointEvidence,
): Promise<void> {
  let image;
  try {
    image = await open(archive.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await image.stat({ bigint: true });
    const named = await lstat(archive.archivePath, { bigint: true });
    if (!stat.isFile() || named.isSymbolicLink() || stat.ino !== named.ino || stat.dev !== named.dev ||
      `${stat.dev}:${stat.ino}` !== manifest.image.filesystemIdentity ||
      stat.size !== BigInt(manifest.boundaryPublishedSizeBytes) || stat.mtimeNs.toString() !== manifest.image.mtimeNs ||
      named.size !== stat.size || named.mtimeNs !== stat.mtimeNs)
      throw new Error("Image differs from checkpoint");
    if ("protectedRanges" in manifest) {
      for (const range of manifest.protectedRanges) {
        const bytes = Buffer.alloc(range.byteCount);
        const read = await image.read(bytes, 0, bytes.length, range.startByte);
        if (read.bytesRead !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== range.afterDigest)
          throw new Error("Committed protected bytes differ");
      }
    }
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_IMAGE_CONFLICT"); }
  finally { await image?.close(); }
}

/** Read only. Never reconcile, install a pointer, or synchronize an operator read. */
export async function readCommittedDvdCheckpoint(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
  assertImageOwnership(): void;
}): Promise<CommittedDvdCheckpointEvidence | null> {
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
  if (await pathExists(join(directory, "recovery-journal.bin"))) {
    throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  }
  const pointerPath = join(directory, "checkpoint.json");
  const pointer = await readRecord(pointerPath, "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE") as {
    originalDiscArchiveId: string;
    currentManifestId: string;
    currentManifestRevision: number;
    currentManifestDigest: string;
    publicationDigest: string;
  };
  if (!Number.isSafeInteger(pointer.currentManifestRevision) || pointer.currentManifestRevision < 1 ||
    pointer.currentManifestRevision > DVD_RECOVERY_MAX_CHECKPOINT_REVISION) {
    throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  }
  const initial = assertInitialManifest(
    await readRecord(join(directory, "initial-manifest.json"), "DVD_PUBLICATION_MANIFEST_CONFLICT"),
    archive,
    jobs,
  );
  let manifest: CommittedDvdCheckpointEvidence = initial;
  for (let revision = 2; revision <= pointer.currentManifestRevision; revision += 1) {
    const raw = await readRecord(
      join(directory, `recovery-manifest-${revision}.json`),
      "DVD_PUBLICATION_CHECKPOINT_CONFLICT",
    );
    manifest = assertRecoveryManifest(raw, manifest, initial);
    input.assertImageOwnership();
  }
  const expectedPointer = {
    originalDiscArchiveId: archive.id, currentManifestId: manifest.id,
    currentManifestRevision: manifest.revision, currentManifestDigest: manifest.manifestDigest,
    publicationDigest: manifest.publicationDigest,
  };
  if (canonicalPublicationJson(pointer) !== canonicalPublicationJson(expectedPointer))
    throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  if (header !== null) {
    if (header.currentManifestRevision > manifest.revision)
      throw new DvdCheckpointReadFault("DVD_PUBLICATION_PROJECTION_AHEAD");
    if (header.sourceArchiveJobId !== initial.sourceArchiveJobId ||
      header.acceptedEndLbaExclusive !== manifest.acceptedEndLbaExclusive ||
      header.boundaryEvidenceDigest !== manifest.boundaryEvidenceDigest ||
      header.currentManifestRevision !== manifest.revision ||
      header.currentManifestId !== manifest.id || header.currentManifestDigest !== manifest.manifestDigest)
      throw new DvdCheckpointReadFault(manifest.revision === 1 ? "DVD_PUBLICATION_CHECKPOINT_CONFLICT" : "CONSISTENCY_FAULT");
  } else if (manifest.revision > 1) {
    throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
  }
  await verifyImage(archive, manifest);
  input.assertImageOwnership();
  if (await pathExists(join(directory, "recovery-journal.bin")) ||
    canonicalPublicationJson(await readRecord(pointerPath, "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE")) !== canonicalPublicationJson(pointer))
    throw new DvdCheckpointReadFault("DVD_EVIDENCE_CHANGED_DURING_READ");
  input.assertImageOwnership();
  return manifest;
}
