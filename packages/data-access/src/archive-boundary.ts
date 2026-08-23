import { DomainInvariantError } from "./errors.js";

export const DVD_ARCHIVE_BOUNDARY_POLICY_VERSION =
  "dvd-archive-boundary-v1" as const;

const MAX_DVD_CONTENT_BYTES = 9_000_000_000;

export interface ArchiveBoundaryEvidence {
  policyVersion: string;
  reportedSizeBytes: number;
  publishedSizeBytes: number;
  excludedSectorCount: number;
}

export interface NormalDvdArchiveBoundaryEvidence
  extends ArchiveBoundaryEvidence {
  policyVersion: typeof DVD_ARCHIVE_BOUNDARY_POLICY_VERSION;
  excludedSectorCount: 0;
}

type ArchiveBoundaryEvidenceRecord = {
  boundaryPolicyVersion: string | null;
  boundaryReportedSizeBytes: number | null;
  boundaryPublishedSizeBytes: number | null;
  boundaryExcludedSectorCount: number | null;
};

export function createNormalDvdArchiveBoundaryEvidence(
  reportedSizeBytes: number,
): NormalDvdArchiveBoundaryEvidence {
  if (
    !Number.isSafeInteger(reportedSizeBytes) ||
    reportedSizeBytes <= 0 ||
    reportedSizeBytes > MAX_DVD_CONTENT_BYTES
  ) {
    throw new DomainInvariantError(
      "DVD archive-boundary reported size is invalid",
    );
  }
  return {
    policyVersion: DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
    reportedSizeBytes,
    publishedSizeBytes: reportedSizeBytes,
    excludedSectorCount: 0,
  };
}

export function validateNormalDvdArchiveBoundaryEvidence(
  value: unknown,
  publishedArchiveSizeBytes: number,
): NormalDvdArchiveBoundaryEvidence {
  if (typeof value !== "object" || value === null) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  const evidence = value as Partial<NormalDvdArchiveBoundaryEvidence>;
  if (typeof evidence.reportedSizeBytes !== "number") {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  const normalized = createNormalDvdArchiveBoundaryEvidence(
    evidence.reportedSizeBytes,
  );
  if (
    evidence.policyVersion !== normalized.policyVersion ||
    evidence.publishedSizeBytes !== normalized.publishedSizeBytes ||
    evidence.excludedSectorCount !== normalized.excludedSectorCount ||
    publishedArchiveSizeBytes !== normalized.publishedSizeBytes
  ) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  return normalized;
}

export function archiveBoundaryEvidenceFromRecord(
  record: ArchiveBoundaryEvidenceRecord,
): ArchiveBoundaryEvidence | null {
  const {
    boundaryPolicyVersion,
    boundaryReportedSizeBytes,
    boundaryPublishedSizeBytes,
    boundaryExcludedSectorCount,
  } = record;
  if (
    boundaryPolicyVersion === null &&
    boundaryReportedSizeBytes === null &&
    boundaryPublishedSizeBytes === null &&
    boundaryExcludedSectorCount === null
  ) {
    return null;
  }
  if (
    boundaryPolicyVersion === null ||
    boundaryReportedSizeBytes === null ||
    boundaryPublishedSizeBytes === null ||
    boundaryExcludedSectorCount === null
  ) {
    throw new DomainInvariantError(
      "Persisted archive-boundary evidence is incomplete",
    );
  }
  return {
    policyVersion: boundaryPolicyVersion,
    reportedSizeBytes: boundaryReportedSizeBytes,
    publishedSizeBytes: boundaryPublishedSizeBytes,
    excludedSectorCount: boundaryExcludedSectorCount,
  };
}
