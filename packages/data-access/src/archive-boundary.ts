import { DomainInvariantError } from "./errors.js";

export const DVD_ARCHIVE_BOUNDARY_POLICY_VERSION =
  "dvd-archive-boundary-v1" as const;

const DVD_SECTOR_SIZE_BYTES = 2_048;
const MAX_DVD_CONTENT_BYTES = 9_000_000_000;

interface DvdArchiveBoundaryEvidenceBase {
  policyVersion: typeof DVD_ARCHIVE_BOUNDARY_POLICY_VERSION;
  reportedSizeBytes: number;
  publishedSizeBytes: number;
  excludedSectorCount: number;
}

export interface DvdArchiveBoundaryOutOfRangeEvidence {
  classifierVersion: string;
  scsiStatus: 2;
  hostStatus: 0;
  driverStatus: 0 | 8;
  senseResponseCode: 0x70 | 0x72;
  senseKey: 0x05;
  asc: 0x21;
  ascq: 0;
}

export interface NormalDvdArchiveBoundaryEvidence
  extends DvdArchiveBoundaryEvidenceBase {
  excludedSectorCount: 0;
}

export interface CorrectedDvdArchiveBoundaryEvidence
  extends DvdArchiveBoundaryEvidenceBase {
  firstExcludedLba: number;
  maximumReferencedLba: number;
  outOfRangeEvidence: DvdArchiveBoundaryOutOfRangeEvidence;
}

export type ArchiveBoundaryEvidence =
  | NormalDvdArchiveBoundaryEvidence
  | CorrectedDvdArchiveBoundaryEvidence;

type ArchiveBoundaryEvidenceRecord = {
  boundaryPolicyVersion: string | null;
  boundaryReportedSizeBytes: number | null;
  boundaryPublishedSizeBytes: number | null;
  boundaryExcludedSectorCount: number | null;
  boundaryFirstExcludedLba?: number | null;
  boundaryMaximumReferencedLba?: number | null;
  boundaryReadFailureClassifierVersion?: string | null;
  boundaryReadFailureScsiStatus?: number | null;
  boundaryReadFailureHostStatus?: number | null;
  boundaryReadFailureDriverStatus?: number | null;
  boundaryReadFailureSenseResponseCode?: number | null;
  boundaryReadFailureSenseKey?: number | null;
  boundaryReadFailureAsc?: number | null;
  boundaryReadFailureAscq?: number | null;
};

function isValidDvdSize(value: number): boolean {
  return Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_DVD_CONTENT_BYTES;
}

function correctedEvidenceError(): DomainInvariantError {
  return new DomainInvariantError(
    "Corrected DVD archive-boundary evidence is invalid",
  );
}

export function createNormalDvdArchiveBoundaryEvidence(
  reportedSizeBytes: number,
): NormalDvdArchiveBoundaryEvidence {
  if (!isValidDvdSize(reportedSizeBytes)) {
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

export function createCorrectedDvdArchiveBoundaryEvidence({
  reportedSizeBytes,
  publishedSizeBytes,
  firstExcludedLba,
  maximumReferencedLba,
  outOfRangeEvidence,
}: {
  reportedSizeBytes: number;
  publishedSizeBytes: number;
  firstExcludedLba: number;
  maximumReferencedLba: number;
  outOfRangeEvidence: DvdArchiveBoundaryOutOfRangeEvidence;
}): CorrectedDvdArchiveBoundaryEvidence {
  const excludedByteCount = reportedSizeBytes - publishedSizeBytes;
  if (
    !isValidDvdSize(reportedSizeBytes) ||
    !isValidDvdSize(publishedSizeBytes) ||
    reportedSizeBytes % DVD_SECTOR_SIZE_BYTES !== 0 ||
    publishedSizeBytes % DVD_SECTOR_SIZE_BYTES !== 0 ||
    publishedSizeBytes >= reportedSizeBytes ||
    !Number.isSafeInteger(firstExcludedLba) ||
    firstExcludedLba !== publishedSizeBytes / DVD_SECTOR_SIZE_BYTES ||
    !Number.isSafeInteger(maximumReferencedLba) ||
    maximumReferencedLba < 0 ||
    maximumReferencedLba >= firstExcludedLba ||
    !Number.isSafeInteger(excludedByteCount) ||
    excludedByteCount <= 0 ||
    excludedByteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
    typeof outOfRangeEvidence !== "object" ||
    outOfRangeEvidence === null ||
    typeof outOfRangeEvidence.classifierVersion !== "string" ||
    outOfRangeEvidence.classifierVersion.length === 0 ||
    outOfRangeEvidence.classifierVersion.length > 128 ||
    outOfRangeEvidence.scsiStatus !== 2 ||
    outOfRangeEvidence.hostStatus !== 0 ||
    (outOfRangeEvidence.driverStatus !== 0 &&
      outOfRangeEvidence.driverStatus !== 8) ||
    (outOfRangeEvidence.senseResponseCode !== 0x70 &&
      outOfRangeEvidence.senseResponseCode !== 0x72) ||
    outOfRangeEvidence.senseKey !== 0x05 ||
    outOfRangeEvidence.asc !== 0x21 ||
    outOfRangeEvidence.ascq !== 0
  ) {
    throw correctedEvidenceError();
  }
  return {
    policyVersion: DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
    reportedSizeBytes,
    publishedSizeBytes,
    excludedSectorCount: excludedByteCount / DVD_SECTOR_SIZE_BYTES,
    firstExcludedLba,
    maximumReferencedLba,
    outOfRangeEvidence: {
      classifierVersion: outOfRangeEvidence.classifierVersion,
      scsiStatus: outOfRangeEvidence.scsiStatus,
      hostStatus: outOfRangeEvidence.hostStatus,
      driverStatus: outOfRangeEvidence.driverStatus,
      senseResponseCode: outOfRangeEvidence.senseResponseCode,
      senseKey: outOfRangeEvidence.senseKey,
      asc: outOfRangeEvidence.asc,
      ascq: outOfRangeEvidence.ascq,
    },
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

export function validateDvdArchiveBoundaryEvidence(
  value: unknown,
  publishedArchiveSizeBytes: number,
): ArchiveBoundaryEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    !("excludedSectorCount" in value)
  ) {
    throw correctedEvidenceError();
  }
  if (value.excludedSectorCount === 0) {
    return validateNormalDvdArchiveBoundaryEvidence(
      value,
      publishedArchiveSizeBytes,
    );
  }
  const evidence = value as Partial<CorrectedDvdArchiveBoundaryEvidence>;
  if (
    typeof evidence.reportedSizeBytes !== "number" ||
    typeof evidence.publishedSizeBytes !== "number" ||
    typeof evidence.firstExcludedLba !== "number" ||
    typeof evidence.maximumReferencedLba !== "number" ||
    evidence.outOfRangeEvidence === undefined
  ) {
    throw correctedEvidenceError();
  }
  const normalized = createCorrectedDvdArchiveBoundaryEvidence({
    reportedSizeBytes: evidence.reportedSizeBytes,
    publishedSizeBytes: evidence.publishedSizeBytes,
    firstExcludedLba: evidence.firstExcludedLba,
    maximumReferencedLba: evidence.maximumReferencedLba,
    outOfRangeEvidence: evidence.outOfRangeEvidence,
  });
  if (
    evidence.policyVersion !== normalized.policyVersion ||
    evidence.excludedSectorCount !== normalized.excludedSectorCount ||
    publishedArchiveSizeBytes !== normalized.publishedSizeBytes
  ) {
    throw correctedEvidenceError();
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
    boundaryFirstExcludedLba = null,
    boundaryMaximumReferencedLba = null,
    boundaryReadFailureClassifierVersion = null,
    boundaryReadFailureScsiStatus = null,
    boundaryReadFailureHostStatus = null,
    boundaryReadFailureDriverStatus = null,
    boundaryReadFailureSenseResponseCode = null,
    boundaryReadFailureSenseKey = null,
    boundaryReadFailureAsc = null,
    boundaryReadFailureAscq = null,
  } = record;
  const values = [
    boundaryPolicyVersion,
    boundaryReportedSizeBytes,
    boundaryPublishedSizeBytes,
    boundaryExcludedSectorCount,
    boundaryFirstExcludedLba,
    boundaryMaximumReferencedLba,
    boundaryReadFailureClassifierVersion,
    boundaryReadFailureScsiStatus,
    boundaryReadFailureHostStatus,
    boundaryReadFailureDriverStatus,
    boundaryReadFailureSenseResponseCode,
    boundaryReadFailureSenseKey,
    boundaryReadFailureAsc,
    boundaryReadFailureAscq,
  ];
  if (values.every((value) => value === null)) {
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
  if (boundaryExcludedSectorCount === 0) {
    if (values.slice(4).some((value) => value !== null)) {
      throw new DomainInvariantError(
        "Persisted archive-boundary evidence is contradictory",
      );
    }
    return validateNormalDvdArchiveBoundaryEvidence({
      policyVersion: boundaryPolicyVersion,
      reportedSizeBytes: boundaryReportedSizeBytes,
      publishedSizeBytes: boundaryPublishedSizeBytes,
      excludedSectorCount: boundaryExcludedSectorCount,
    }, boundaryPublishedSizeBytes);
  }
  if (
    boundaryFirstExcludedLba === null ||
    boundaryMaximumReferencedLba === null ||
    boundaryReadFailureClassifierVersion === null ||
    boundaryReadFailureScsiStatus === null ||
    boundaryReadFailureHostStatus === null ||
    boundaryReadFailureDriverStatus === null ||
    boundaryReadFailureSenseResponseCode === null ||
    boundaryReadFailureSenseKey === null ||
    boundaryReadFailureAsc === null ||
    boundaryReadFailureAscq === null
  ) {
    throw new DomainInvariantError(
      "Persisted archive-boundary evidence is incomplete",
    );
  }
  return validateDvdArchiveBoundaryEvidence({
    policyVersion: boundaryPolicyVersion,
    reportedSizeBytes: boundaryReportedSizeBytes,
    publishedSizeBytes: boundaryPublishedSizeBytes,
    excludedSectorCount: boundaryExcludedSectorCount,
    firstExcludedLba: boundaryFirstExcludedLba,
    maximumReferencedLba: boundaryMaximumReferencedLba,
    outOfRangeEvidence: {
      classifierVersion: boundaryReadFailureClassifierVersion,
      scsiStatus: boundaryReadFailureScsiStatus,
      hostStatus: boundaryReadFailureHostStatus,
      driverStatus: boundaryReadFailureDriverStatus,
      senseResponseCode: boundaryReadFailureSenseResponseCode,
      senseKey: boundaryReadFailureSenseKey,
      asc: boundaryReadFailureAsc,
      ascq: boundaryReadFailureAscq,
    },
  }, boundaryPublishedSizeBytes);
}
