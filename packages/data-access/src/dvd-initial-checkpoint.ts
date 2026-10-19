import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertDvdArchiveBoundaryEvidenceDigest, assertDvdArchiveEvidenceManifestDigests } from "./dvd-archive-evidence-digests.js";
import { archiveBoundaryEvidenceFromRecord, type ArchiveBoundaryEvidence } from "./archive-boundary.js";
import type { ArchiveJob, DvdArchiveEvidenceHeader, DvdInitialArchiveSave, OriginalDiscArchive } from "./types.js";

export type CommittedDvdInitialEvidence = DvdInitialArchiveSave["manifest"] & {
  publicationDigest: string;
  boundaryEvidence: ArchiveBoundaryEvidence;
  image: { filesystemIdentity: string; mtimeNs: string };
};

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

export function createDvdInitialPublicationDigest(value: unknown): string {
  return createHash("sha256").update("rip-dvd:dvd-initial-publication:v1\0")
    .update(canonicalPublicationJson(value)).digest("hex");
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

/** Read only. Never reconcile, install a pointer, or synchronize an operator read. */
export async function readCommittedDvdInitialCheckpoint(input: {
  originalsLibraryPath?: string;
  archive: OriginalDiscArchive;
  header: DvdArchiveEvidenceHeader | null;
  jobs: readonly ArchiveJob[];
}): Promise<CommittedDvdInitialEvidence | null> {
  const { archive, header, jobs } = input;
  const markedJobs = jobs.filter(job => job.evidenceFormat === "dvd-recovery-evidence-v1");
  if (header === null && markedJobs.length === 0) return null;
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
  const raw = await readRecord(join(directory, "initial-manifest.json"), "DVD_PUBLICATION_MANIFEST_CONFLICT");
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
    const source = markedJobs.find(job => job.id === manifest.sourceArchiveJobId);
    if (manifest.originalDiscArchiveId !== archive.id || manifest.imageFingerprint !== archive.fingerprint ||
      archive.discKind !== "dvd" || manifest.revision !== 1 || manifest.id !== `${archive.id}:initial` ||
      !source || source.originalDiscArchiveId !== archive.id || source.detectedDiscId !== archive.detectedDiscId ||
      source.status !== "completed" ||
      manifest.boundaryPolicyVersion !== manifest.boundaryEvidence.policyVersion ||
      manifest.boundaryReportedSizeBytes !== manifest.boundaryEvidence.reportedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== manifest.boundaryEvidence.publishedSizeBytes ||
      manifest.boundaryPublishedSizeBytes !== archive.sizeBytes ||
      canonicalPublicationJson(manifest.boundaryEvidence) !== canonicalPublicationJson(archiveBoundaryEvidenceFromRecord(archive)))
      throw new Error("Manifest provenance differs");
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_MANIFEST_CONFLICT"); }
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
    if (header.sourceArchiveJobId !== manifest.sourceArchiveJobId ||
      header.acceptedEndLbaExclusive !== manifest.acceptedEndLbaExclusive ||
      header.boundaryEvidenceDigest !== manifest.boundaryEvidenceDigest ||
      (header.currentManifestRevision === manifest.revision &&
        (header.currentManifestId !== manifest.id || header.currentManifestDigest !== manifest.manifestDigest)))
      throw new DvdCheckpointReadFault("DVD_PUBLICATION_CHECKPOINT_CONFLICT");
  }
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
  } catch { throw new DvdCheckpointReadFault("DVD_PUBLICATION_IMAGE_CONFLICT"); }
  finally { await image?.close(); }
  if (canonicalPublicationJson(await readRecord(pointerPath, "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE")) !== canonicalPublicationJson(pointer))
    throw new DvdCheckpointReadFault("DVD_EVIDENCE_CHANGED_DURING_READ");
  return manifest;
}
