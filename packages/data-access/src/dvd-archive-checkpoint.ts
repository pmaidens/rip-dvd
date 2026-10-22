import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertDvdArchiveBoundaryEvidenceDigest,
  assertDvdArchiveEvidenceManifestDigests,
  assertDvdArchiveRecoveryReadEvidenceDigest,
  type DvdArchiveEvidenceManifestDigestInput,
  type DvdArchiveEvidenceManifestDigests,
  type DvdArchiveRecoveryReadEvidenceDigestInput,
} from "./dvd-archive-evidence-digests.js";
import { archiveBoundaryEvidenceFromRecord, type ArchiveBoundaryEvidence } from "./archive-boundary.js";
import { canonicalJson } from "./canonical-json.js";
import { assertDvdEvidenceRangeTransition } from "./dvd-evidence-transition.js";
import { validateDvdSourceSampleManifest } from "./dvd-disc-verification.js";
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

interface DvdRecoveryManifestRecord extends
  DvdArchiveEvidenceManifestDigestInput,
  DvdArchiveEvidenceManifestDigests {
  id: string;
  recoveryRead: DvdArchiveRecoveryReadEvidenceDigestInput & {
    id: string;
    evidenceDigest: string;
  };
}

export { canonicalJson as canonicalPublicationJson };

export function createDvdInitialPublicationDigest(value: unknown): string {
  return createHash("sha256").update("rip-dvd:dvd-initial-publication:v1\0")
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

function assertRecoveryManifestStaticProvenance(
  manifest: DvdRecoveryManifestRecord,
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
    manifest.boundaryEvidenceDigest !== initial.boundaryEvidenceDigest
  ) {
    throw new Error("Recovery manifest provenance differs");
  }
}

function assertRecoveryManifestRecord(
  raw: unknown,
  initial: CommittedDvdInitialEvidence,
): asserts raw is DvdRecoveryManifestRecord {
  const manifest = raw as DvdRecoveryManifestRecord;
  const expectedKeys = [
    "acceptedEndLbaExclusive",
    "boundaryEvidenceDigest",
    "boundaryPolicyVersion",
    "boundaryPublishedSizeBytes",
    "boundaryReportedSizeBytes",
    "evidenceFormat",
    "id",
    "imageFingerprint",
    "manifestDigest",
    "originalDiscArchiveId",
    "previousManifestDigest",
    "previousManifestId",
    "recoveryRead",
    "recoveryReadEvidenceDigest",
    "recoveryReadId",
    "revision",
    "sectorSizeBytes",
    "unrecoveredSourceRanges",
    "unrecoveredSourceRangesDigest",
  ];
  const keys = Object.keys(manifest).sort();
  const recoveryReadKeys = Object.keys(manifest.recoveryRead ?? {}).sort();
  const expectedRecoveryReadKeys = [
    "evidenceDigest",
    "fromManifestId",
    "fromManifestRevision",
    "id",
    "originalDiscArchiveId",
    "outcome",
    "sectorCount",
    "startLba",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof manifest.id !== "string" ||
    manifest.id.length === 0 ||
    manifest.id.length > 256 ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 2 ||
    manifest.previousManifestId === null ||
    manifest.previousManifestDigest === null ||
    manifest.recoveryReadId === null ||
    manifest.recoveryReadEvidenceDigest === null ||
    manifest.recoveryRead === null ||
    typeof manifest.recoveryRead !== "object" ||
    recoveryReadKeys.length !== expectedRecoveryReadKeys.length ||
    recoveryReadKeys.some((key, index) =>
      key !== expectedRecoveryReadKeys[index]
    ) ||
    manifest.recoveryRead.id !== manifest.recoveryReadId ||
    manifest.recoveryRead.evidenceDigest !==
      manifest.recoveryReadEvidenceDigest
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

async function readCommittedDvdCheckpointRecords(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
  assertImageOwnership(): void;
}, requireInitialPointer: boolean): Promise<{
  initialEvidence: CommittedDvdInitialEvidence;
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
      checkpoint.publicationDigest !== manifest.publicationDigest ||
      (checkpoint.currentManifestRevision === 1 &&
        (checkpoint.currentManifestId !== manifest.id ||
          checkpoint.currentManifestDigest !== manifest.manifestDigest)) ||
      (requireInitialPointer && checkpoint.currentManifestRevision !== 1)
    ) throw new Error("Checkpoint differs");
  } catch {
    throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  }
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
      const predecessor = previous as {
        id: string;
        revision: number;
        manifestDigest: string;
        unrecoveredSourceRanges: CommittedDvdInitialEvidence["unrecoveredSourceRanges"];
      };
      if (
        current.id !== checkpoint.currentManifestId ||
        current.revision !== checkpoint.currentManifestRevision ||
        current.manifestDigest !== checkpoint.currentManifestDigest ||
        predecessor.revision !== current.revision - 1 ||
        current.previousManifestId !== predecessor.id ||
        current.previousManifestDigest !== predecessor.manifestDigest ||
        current.recoveryRead.originalDiscArchiveId !== archive.id ||
        current.recoveryRead.fromManifestId !== predecessor.id ||
        current.recoveryRead.fromManifestRevision !== predecessor.revision
      ) {
        throw new Error("Recovery manifest transition differs");
      }
      assertDvdEvidenceRangeTransition(
        predecessor.unrecoveredSourceRanges,
        current.unrecoveredSourceRanges,
        current.recoveryRead,
      );
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
      header.acceptedEndLbaExclusive !== manifest.acceptedEndLbaExclusive ||
      header.boundaryEvidenceDigest !== manifest.boundaryEvidenceDigest ||
      (header.currentManifestRevision === checkpoint.currentManifestRevision &&
        (header.currentManifestId !== checkpoint.currentManifestId ||
          header.currentManifestDigest !== checkpoint.currentManifestDigest)))
      throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  }
  let image;
  try {
    image = await open(archive.archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await image.stat({ bigint: true });
    const named = await lstat(archive.archivePath, { bigint: true });
    if (!stat.isFile() || named.isSymbolicLink() || stat.ino !== named.ino || stat.dev !== named.dev ||
      `${stat.dev}:${stat.ino}` !== manifest.image.filesystemIdentity ||
      stat.size !== BigInt(manifest.boundaryPublishedSizeBytes) ||
      (checkpoint.currentManifestRevision === 1 &&
        stat.mtimeNs.toString() !== manifest.image.mtimeNs) ||
      named.size !== stat.size || named.mtimeNs !== stat.mtimeNs)
      throw new Error("Image differs from checkpoint");
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_IMAGE_CONFLICT"); }
  finally { await image?.close(); }
  input.assertImageOwnership();
  if (canonicalJson(await readRecord(pointerPath, "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE")) !== canonicalJson(pointer))
    throw new DvdCheckpointReadFault("DVD_EVIDENCE_CHANGED_DURING_READ");
  input.assertImageOwnership();
  return { initialEvidence: manifest, checkpoint };
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
