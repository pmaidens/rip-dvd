import {
  canonicalPublicationJson, createDvdInitialPublicationDigest,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  type DvdArchiveEvidenceManifestDigestInput,
  type DvdArchiveEvidenceManifestDigests,
  type CleanReadArchiveIntegrityEvidence,
  type IncompleteReadArchiveIntegrityEvidence,
  type DvdSourceSampleManifest,
  validateDvdSourceSampleManifest,
} from "@rip-dvd/data-access";
import type { ProvenDvdInitialArchiveBoundary } from "./dvd-initial-boundary.js";
import { validateDvdInitialCopyResult, type DvdInitialCopyResult } from "./dvd-initial-copy.js";

export const DVD_INITIAL_PUBLICATION_POLICY_VERSION = "dvd-initial-publication-v1";

export interface DvdInitialManifest extends DvdArchiveEvidenceManifestDigestInput, DvdArchiveEvidenceManifestDigests {
  id: string;
  sourceArchiveJobId: string;
  image: { filesystemIdentity: string; mtimeNs: string };
  boundaryEvidence: ProvenDvdInitialArchiveBoundary["boundaryEvidence"];
  initialCopy: DvdInitialCopyResult;
  metadataDecision: ProvenDvdInitialArchiveBoundary["metadataDecision"];
  integrity: CleanReadArchiveIntegrityEvidence | IncompleteReadArchiveIntegrityEvidence;
  policies: {
    publication: typeof DVD_INITIAL_PUBLICATION_POLICY_VERSION;
    copy: "dvd-initial-copy-v1";
    metadata: "dvd-full-extent-metadata-v1" | null;
  };
  publicationDigest: string;
  sourceSampleManifest?: DvdSourceSampleManifest;
}

export { canonicalPublicationJson } from "@rip-dvd/data-access";

export function createDvdInitialManifest({
  originalDiscArchiveId, sourceArchiveJobId, imageFingerprint, proven,
  sourceSampleManifest,
}: {
  originalDiscArchiveId: string;
  sourceArchiveJobId: string;
  imageFingerprint: string;
  proven: ProvenDvdInitialArchiveBoundary;
  sourceSampleManifest?: DvdSourceSampleManifest;
}): DvdInitialManifest {
  const { boundaryEvidence, initialCopy, metadataDecision } = proven;
  if (!sourceArchiveJobId || !/^\d+:\d+$/.test(initialCopy.imageFilesystemIdentity) || !/^\d+$/.test(proven.imageMtimeNs))
    throw new Error("Invalid initial publication identity");
  validateDvdInitialCopyResult(initialCopy, boundaryEvidence.reportedSizeBytes,
    "Invalid initial publication source map", boundaryEvidence.publishedSizeBytes);
  if (boundaryEvidence.excludedSectorCount === 0) {
    if (metadataDecision?.policyVersion !== "dvd-full-extent-metadata-v1" ||
      metadataDecision.decision !== "publishable" || metadataDecision.blockers.length !== 0 ||
      !Array.isArray(metadataDecision.observations))
      throw new Error("Initial publication requires the accepted full-extent metadata decision");
  } else if (metadataDecision !== null) {
    throw new Error("Corrected initial publication requires strict boundary evidence");
  }
  const input: DvdArchiveEvidenceManifestDigestInput = {
    originalDiscArchiveId, revision: 1, previousManifestId: null, previousManifestDigest: null,
    recoveryReadId: null, recoveryReadEvidenceDigest: null,
    evidenceFormat: "dvd-recovery-evidence-v1", imageFingerprint, sectorSizeBytes: 2048,
    acceptedEndLbaExclusive: boundaryEvidence.publishedSizeBytes / 2048,
    boundaryPolicyVersion: boundaryEvidence.policyVersion,
    boundaryReportedSizeBytes: boundaryEvidence.reportedSizeBytes,
    boundaryPublishedSizeBytes: boundaryEvidence.publishedSizeBytes,
    boundaryEvidenceDigest: createDvdArchiveBoundaryEvidenceDigest(boundaryEvidence),
    unrecoveredSourceRanges: initialCopy.unrecoveredSourceRanges,
  };
  const badSectorRanges = input.unrecoveredSourceRanges.map(({ startLba, sectorCount }) => ({ startLba, sectorCount }));
  const integrity: DvdInitialManifest["integrity"] = badSectorRanges.length === 0
    ? { integrity: "clean_read", policyVersion: "dvd-recovery-evidence-v1", badSectorCount: 0, badAreaCount: 0, badSectorRanges: [] }
    : { integrity: "incomplete_read", policyVersion: "dvd-recovery-evidence-v1", badSectorCount: badSectorRanges.reduce((n, r) => n + r.sectorCount, 0), badAreaCount: badSectorRanges.length, badSectorRanges };
  const manifest = {
    ...input, ...createDvdArchiveEvidenceManifestDigests(input),
    id: `${originalDiscArchiveId}:initial`, sourceArchiveJobId,
    image: { filesystemIdentity: initialCopy.imageFilesystemIdentity, mtimeNs: proven.imageMtimeNs },
    boundaryEvidence,
    initialCopy: {
      copyPolicyVersion: initialCopy.copyPolicyVersion, declaredByteCount: initialCopy.declaredByteCount,
      recoveredByteCount: initialCopy.recoveredByteCount, skippedRequestCount: initialCopy.skippedRequestCount,
      diagnosticsTruncated: initialCopy.diagnosticsTruncated, diagnostics: initialCopy.diagnostics,
      unrecoveredSourceRanges: initialCopy.unrecoveredSourceRanges,
    },
    metadataDecision, integrity,
    policies: { publication: DVD_INITIAL_PUBLICATION_POLICY_VERSION, copy: initialCopy.copyPolicyVersion, metadata: metadataDecision?.policyVersion ?? null },
    ...(sourceSampleManifest === undefined ? {} : {
      sourceSampleManifest: validateDvdSourceSampleManifest(
        sourceSampleManifest,
      ),
    }),
  };
  if (sourceSampleManifest !== undefined && (
    sourceSampleManifest.sourceMetadataFingerprint !== imageFingerprint ||
    sourceSampleManifest.acceptedEndLbaExclusive !==
      input.acceptedEndLbaExclusive ||
    sourceSampleManifest.checkpointRevision !== input.revision ||
    sourceSampleManifest.checkpointDigest !==
      createDvdArchiveEvidenceManifestDigests(input).manifestDigest
  )) {
    throw new Error("DVD source sample manifest provenance is invalid");
  }
  // Clone at the ownership boundary. Caller mutations cannot change this save.
  return JSON.parse(canonicalPublicationJson({ ...manifest,
    publicationDigest: createDvdInitialPublicationDigest(manifest),
  })) as DvdInitialManifest;
}

export function validateDvdInitialManifest(value: unknown): DvdInitialManifest {
  const candidate = value as DvdInitialManifest;
  const expected = createDvdInitialManifest({
    originalDiscArchiveId: candidate.originalDiscArchiveId,
    sourceArchiveJobId: candidate.sourceArchiveJobId,
    imageFingerprint: candidate.imageFingerprint,
    ...(Object.hasOwn(candidate, "sourceSampleManifest")
      ? { sourceSampleManifest: candidate.sourceSampleManifest }
      : {}),
    proven: {
      boundaryEvidence: candidate.boundaryEvidence, metadataDecision: candidate.metadataDecision,
      imageMtimeNs: candidate.image.mtimeNs,
      initialCopy: { ...candidate.initialCopy, imageFilesystemIdentity: candidate.image.filesystemIdentity, imagePath: "" },
    },
  });
  if (canonicalPublicationJson(candidate) !== canonicalPublicationJson(expected))
    throw new Error("Initial publication manifest contents or digest conflict");
  return expected;
}
