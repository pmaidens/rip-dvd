import { DomainInvariantError } from "./errors.js";

export const DVD_ARCHIVE_BOUNDARY_POLICY_VERSION =
  "dvd-archive-boundary-v2" as const;
export const DVD_NORMAL_ENDPOINT_PROOF_VERSION =
  "dvd-normal-endpoint-proof-v1" as const;

const LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION =
  "dvd-archive-boundary-v1" as const;

const DVD_SECTOR_SIZE_BYTES = 2_048;
const MAX_DVD_CONTENT_BYTES = 9_000_000_000;

interface DvdArchiveBoundaryEvidenceBase {
  policyVersion:
    | typeof DVD_ARCHIVE_BOUNDARY_POLICY_VERSION
    | typeof LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION;
  reportedSizeBytes: number;
  publishedSizeBytes: number;
  excludedSectorCount: number;
}

export interface DvdArchiveBoundaryOutOfRangeEvidence {
  classifierVersion: string;
  scsiStatus: number;
  hostStatus: 0;
  driverStatus: number;
  senseResponseCode: 0x70 | 0x72;
  senseKey: 0x05;
  asc: 0x21;
  ascq: 0;
}

export interface NormalDvdArchiveBoundaryEvidence
  extends DvdArchiveBoundaryEvidenceBase {
  policyVersion: typeof DVD_ARCHIVE_BOUNDARY_POLICY_VERSION;
  excludedSectorCount: 0;
  endpointProof: {
    proofVersion: typeof DVD_NORMAL_ENDPOINT_PROOF_VERSION;
    confirmationCount: 2;
    firstExcludedLba: number;
    outOfRangeEvidence: DvdArchiveBoundaryOutOfRangeEvidence;
  };
}

interface LegacyNormalDvdArchiveBoundaryEvidence
  extends DvdArchiveBoundaryEvidenceBase {
  policyVersion: typeof LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION;
  excludedSectorCount: 0;
}

export interface CorrectedDvdArchiveBoundaryEvidence
  extends DvdArchiveBoundaryEvidenceBase {
  policyVersion: typeof LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION;
  firstExcludedLba: number;
  maximumReferencedLba: number;
  outOfRangeEvidence: DvdArchiveBoundaryOutOfRangeEvidence;
}

export type ArchiveBoundaryEvidence =
  | LegacyNormalDvdArchiveBoundaryEvidence
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

function normalizeOutOfRangeEvidence(
  outOfRangeEvidence: DvdArchiveBoundaryOutOfRangeEvidence,
  invalidEvidence: () => DomainInvariantError,
): DvdArchiveBoundaryOutOfRangeEvidence {
  if (
    typeof outOfRangeEvidence !== "object" ||
    outOfRangeEvidence === null ||
    typeof outOfRangeEvidence.classifierVersion !== "string" ||
    outOfRangeEvidence.classifierVersion.length === 0 ||
    outOfRangeEvidence.classifierVersion.length > 128 ||
    !Number.isSafeInteger(outOfRangeEvidence.scsiStatus) ||
    outOfRangeEvidence.scsiStatus < 0 ||
    outOfRangeEvidence.scsiStatus > 0xff ||
    (outOfRangeEvidence.scsiStatus & 0xfe) !== 2 ||
    outOfRangeEvidence.hostStatus !== 0 ||
    !Number.isSafeInteger(outOfRangeEvidence.driverStatus) ||
    outOfRangeEvidence.driverStatus < 0 ||
    outOfRangeEvidence.driverStatus > 0xffff ||
    ((outOfRangeEvidence.driverStatus & 0x0f) !== 0 &&
      (outOfRangeEvidence.driverStatus & 0x0f) !== 8) ||
    (outOfRangeEvidence.senseResponseCode !== 0x70 &&
      outOfRangeEvidence.senseResponseCode !== 0x72) ||
    outOfRangeEvidence.senseKey !== 0x05 ||
    outOfRangeEvidence.asc !== 0x21 ||
    outOfRangeEvidence.ascq !== 0
  ) {
    throw invalidEvidence();
  }
  return {
    classifierVersion: outOfRangeEvidence.classifierVersion,
    scsiStatus: outOfRangeEvidence.scsiStatus,
    hostStatus: outOfRangeEvidence.hostStatus,
    driverStatus: outOfRangeEvidence.driverStatus,
    senseResponseCode: outOfRangeEvidence.senseResponseCode,
    senseKey: outOfRangeEvidence.senseKey,
    asc: outOfRangeEvidence.asc,
    ascq: outOfRangeEvidence.ascq,
  };
}

export function createNormalDvdArchiveBoundaryEvidence(
  {
    reportedSizeBytes,
    endpointProof,
  }: {
    reportedSizeBytes: number;
    endpointProof: NormalDvdArchiveBoundaryEvidence["endpointProof"];
  },
): NormalDvdArchiveBoundaryEvidence {
  const invalidEvidence = () => new DomainInvariantError(
    "Normal DVD archive-boundary evidence is invalid",
  );
  if (
    !isValidDvdSize(reportedSizeBytes) ||
    reportedSizeBytes % DVD_SECTOR_SIZE_BYTES !== 0 ||
    typeof endpointProof !== "object" ||
    endpointProof === null ||
    endpointProof.proofVersion !== DVD_NORMAL_ENDPOINT_PROOF_VERSION ||
    endpointProof.confirmationCount !== 2 ||
    !Number.isSafeInteger(endpointProof.firstExcludedLba) ||
    endpointProof.firstExcludedLba !==
      reportedSizeBytes / DVD_SECTOR_SIZE_BYTES
  ) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  const outOfRangeEvidence = normalizeOutOfRangeEvidence(
    endpointProof.outOfRangeEvidence,
    invalidEvidence,
  );
  return {
    policyVersion: DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
    reportedSizeBytes,
    publishedSizeBytes: reportedSizeBytes,
    excludedSectorCount: 0,
    endpointProof: {
      proofVersion: DVD_NORMAL_ENDPOINT_PROOF_VERSION,
      confirmationCount: 2,
      firstExcludedLba: endpointProof.firstExcludedLba,
      outOfRangeEvidence,
    },
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
    outOfRangeEvidence === null
  ) {
    throw correctedEvidenceError();
  }
  const normalizedOutOfRangeEvidence = normalizeOutOfRangeEvidence(
    outOfRangeEvidence,
    correctedEvidenceError,
  );
  return {
    policyVersion: LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
    reportedSizeBytes,
    publishedSizeBytes,
    excludedSectorCount: excludedByteCount / DVD_SECTOR_SIZE_BYTES,
    firstExcludedLba,
    maximumReferencedLba,
    outOfRangeEvidence: normalizedOutOfRangeEvidence,
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
  if (
    typeof evidence.reportedSizeBytes !== "number" ||
    evidence.endpointProof === undefined
  ) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  const normalized = createNormalDvdArchiveBoundaryEvidence({
    reportedSizeBytes: evidence.reportedSizeBytes,
    endpointProof: evidence.endpointProof,
  });
  if (
    evidence.policyVersion !== normalized.policyVersion ||
    evidence.publishedSizeBytes !== normalized.publishedSizeBytes ||
    evidence.excludedSectorCount !== normalized.excludedSectorCount ||
    publishedArchiveSizeBytes !== normalized.publishedSizeBytes ||
    evidence.endpointProof.proofVersion !==
      normalized.endpointProof.proofVersion ||
    evidence.endpointProof.confirmationCount !==
      normalized.endpointProof.confirmationCount ||
    evidence.endpointProof.firstExcludedLba !==
      normalized.endpointProof.firstExcludedLba ||
    evidence.endpointProof.outOfRangeEvidence.classifierVersion !==
      normalized.endpointProof.outOfRangeEvidence.classifierVersion ||
    evidence.endpointProof.outOfRangeEvidence.scsiStatus !==
      normalized.endpointProof.outOfRangeEvidence.scsiStatus ||
    evidence.endpointProof.outOfRangeEvidence.hostStatus !==
      normalized.endpointProof.outOfRangeEvidence.hostStatus ||
    evidence.endpointProof.outOfRangeEvidence.driverStatus !==
      normalized.endpointProof.outOfRangeEvidence.driverStatus ||
    evidence.endpointProof.outOfRangeEvidence.senseResponseCode !==
      normalized.endpointProof.outOfRangeEvidence.senseResponseCode ||
    evidence.endpointProof.outOfRangeEvidence.senseKey !==
      normalized.endpointProof.outOfRangeEvidence.senseKey ||
    evidence.endpointProof.outOfRangeEvidence.asc !==
      normalized.endpointProof.outOfRangeEvidence.asc ||
    evidence.endpointProof.outOfRangeEvidence.ascq !==
      normalized.endpointProof.outOfRangeEvidence.ascq
  ) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  return normalized;
}

function validateLegacyNormalDvdArchiveBoundaryEvidence(
  value: unknown,
  publishedArchiveSizeBytes: number,
): LegacyNormalDvdArchiveBoundaryEvidence {
  if (typeof value !== "object" || value === null) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  const evidence = value as Partial<LegacyNormalDvdArchiveBoundaryEvidence>;
  if (
    evidence.policyVersion !== LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION ||
    typeof evidence.reportedSizeBytes !== "number" ||
    !isValidDvdSize(evidence.reportedSizeBytes) ||
    evidence.publishedSizeBytes !== evidence.reportedSizeBytes ||
    evidence.excludedSectorCount !== 0 ||
    publishedArchiveSizeBytes !== evidence.publishedSizeBytes
  ) {
    throw new DomainInvariantError(
      "Normal DVD archive-boundary evidence is invalid",
    );
  }
  return {
    policyVersion: LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
    reportedSizeBytes: evidence.reportedSizeBytes,
    publishedSizeBytes: evidence.publishedSizeBytes,
    excludedSectorCount: 0,
  };
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
    if (
      boundaryPolicyVersion ===
        LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION &&
      values.slice(4).every((value) => value === null)
    ) {
      return validateLegacyNormalDvdArchiveBoundaryEvidence({
        policyVersion: LEGACY_DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
        reportedSizeBytes: boundaryReportedSizeBytes,
        publishedSizeBytes: boundaryPublishedSizeBytes,
        excludedSectorCount: 0,
      }, boundaryPublishedSizeBytes);
    }
    if (
      boundaryPolicyVersion !== DVD_ARCHIVE_BOUNDARY_POLICY_VERSION ||
      boundaryFirstExcludedLba === null ||
      boundaryMaximumReferencedLba !== null ||
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
        "Persisted archive-boundary evidence is contradictory",
      );
    }
    return validateNormalDvdArchiveBoundaryEvidence({
      policyVersion: DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
      reportedSizeBytes: boundaryReportedSizeBytes,
      publishedSizeBytes: boundaryPublishedSizeBytes,
      excludedSectorCount: boundaryExcludedSectorCount,
      endpointProof: {
        proofVersion: DVD_NORMAL_ENDPOINT_PROOF_VERSION,
        confirmationCount: 2,
        firstExcludedLba: boundaryFirstExcludedLba,
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
      },
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
