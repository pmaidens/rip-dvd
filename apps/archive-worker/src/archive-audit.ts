import type { ArchiveAuditRecord } from "@rip-dvd/data-access/archive-audit-records";

import type { DvdImageGeometry } from "./dvd-geometry-validator.js";

export const ARCHIVE_AUDIT_SCHEMA_VERSION = 1;
export const ARCHIVE_AUDIT_COMMAND_VERSION = "archive-audit-v1";
export const ARCHIVE_AUDIT_MAX_CONCURRENCY = 8;

export type ArchiveAuditFileOutcome =
  | "ok"
  | "definite_truncation"
  | "malformed_metadata"
  | "unsupported_layout"
  | "missing_file"
  | "containment_rejection"
  | "not_regular_file"
  | "read_error"
  | "read_timeout";

export interface ArchiveAuditFileInspection {
  actualSizeBytes: number | null;
  geometry: DvdImageGeometry | null;
  outcome: ArchiveAuditFileOutcome;
}

export interface ArchiveAuditFileInspector {
  inspect(
    archivePath: string,
    originalsLibraryPath: string,
    signal: AbortSignal,
  ): Promise<ArchiveAuditFileInspection>;
}

export type ArchiveAuditClassification =
  | "consistent"
  | "definite_truncation"
  | "suspicious_capacity_reuse"
  | "size_mismatch"
  | "missing_file"
  | "malformed_metadata"
  | "unsupported_layout"
  | "containment_rejection"
  | "not_regular_file"
  | "read_error"
  | "read_timeout";

export type ArchiveAuditReason =
  | "supported_geometry_fits_archive"
  | "declared_geometry_extends_beyond_eof"
  | "distinct_media_generations_reused_exact_capacity"
  | "catalog_or_boundary_size_differs_from_file"
  | "archive_file_is_missing"
  | "filesystem_metadata_is_malformed"
  | "filesystem_layout_is_unsupported"
  | "archive_path_is_outside_configured_containment"
  | "archive_path_is_not_a_regular_file"
  | "archive_file_could_not_be_read"
  | "archive_file_read_timed_out";

export interface ArchiveAuditDeclaredGeometry {
  isoVolumeSizeBytes: number | null;
  udfMaximumDeclaredSizeBytes: number | null;
  maximumDeclaredSizeBytes: number | null;
}

export interface ArchiveAuditCapacityReuseSignal {
  classification: "suspicious_capacity_reuse";
  capacityBytes: number;
  archiveCount: number;
  mediaGenerationCount: number;
  reason: "distinct_media_generations_reused_exact_capacity";
}

export interface ArchiveAuditFinding {
  archiveId: string;
  detectedDiscId: string;
  opticalDriveId: string;
  discInspectionId: string | null;
  mediaGeneration: string | null;
  archivedAt: string;
  recordedSizeBytes: number | null;
  actualSizeBytes: number | null;
  discInspectionCapacityBytes: number | null;
  reportedBoundarySizeBytes: number | null;
  publishedBoundarySizeBytes: number | null;
  declaredGeometry: ArchiveAuditDeclaredGeometry | null;
  classification: ArchiveAuditClassification;
  reason: ArchiveAuditReason;
  capacityReuse: ArchiveAuditCapacityReuseSignal | null;
}

export interface ArchiveAuditReport {
  schemaVersion: typeof ARCHIVE_AUDIT_SCHEMA_VERSION;
  commandVersion: typeof ARCHIVE_AUDIT_COMMAND_VERSION;
  startedAt: string;
  completedAt: string;
  scope: {
    recordLimit: number;
    concurrency: number;
    fileTimeoutMs: number;
    runtimeTimeoutMs: number;
    truncated: boolean;
  };
  counts: Record<ArchiveAuditClassification, number> & {
    suspiciousCapacityReuseSignals: number;
  };
  findings: readonly ArchiveAuditFinding[];
}

export interface RunArchiveAuditRequest {
  records: readonly ArchiveAuditRecord[];
  recordsTruncated: boolean;
  recordLimit: number;
  concurrency: number;
  fileTimeoutMs: number;
  runtimeTimeoutMs: number;
  originalsLibraryPath: string;
  fileInspector: ArchiveAuditFileInspector;
  signal: AbortSignal;
  now?: () => Date;
}

function geometryInBytes(
  geometry: DvdImageGeometry | null,
): ArchiveAuditDeclaredGeometry | null {
  if (geometry === null) {
    return null;
  }
  const isoVolumeSizeBytes = geometry.isoVolumeSectorCount === null
    ? null
    : geometry.isoVolumeSectorCount * 2_048;
  const udfMaximumDeclaredSizeBytes =
    geometry.udfMaximumDeclaredSectorCount === null
      ? null
      : geometry.udfMaximumDeclaredSectorCount * 2_048;
  const declaredSizes = [isoVolumeSizeBytes, udfMaximumDeclaredSizeBytes]
    .filter((value): value is number => value !== null);
  return {
    isoVolumeSizeBytes,
    udfMaximumDeclaredSizeBytes,
    maximumDeclaredSizeBytes:
      declaredSizes.length === 0 ? null : Math.max(...declaredSizes),
  };
}

function primaryResult(
  record: ArchiveAuditRecord,
  inspection: ArchiveAuditFileInspection,
): Pick<
  ArchiveAuditFinding,
  "actualSizeBytes" | "classification" | "declaredGeometry" | "reason"
> {
  const declaredGeometry = geometryInBytes(inspection.geometry);
  if (inspection.outcome === "ok") {
    const expectedSizes = [
      record.recordedSizeBytes,
      record.publishedBoundarySizeBytes,
    ].filter((value): value is number => value !== null);
    const hasSizeMismatch =
      inspection.actualSizeBytes === null ||
      expectedSizes.some((size) => size !== inspection.actualSizeBytes);
    return hasSizeMismatch
      ? {
          actualSizeBytes: inspection.actualSizeBytes,
          classification: "size_mismatch",
          declaredGeometry,
          reason: "catalog_or_boundary_size_differs_from_file",
        }
      : {
          actualSizeBytes: inspection.actualSizeBytes,
          classification: "consistent",
          declaredGeometry,
          reason: "supported_geometry_fits_archive",
        };
  }
  const resultByOutcome: Record<
    Exclude<ArchiveAuditFileOutcome, "ok">,
    { classification: ArchiveAuditClassification; reason: ArchiveAuditReason }
  > = {
    definite_truncation: {
      classification: "definite_truncation",
      reason: "declared_geometry_extends_beyond_eof",
    },
    malformed_metadata: {
      classification: "malformed_metadata",
      reason: "filesystem_metadata_is_malformed",
    },
    unsupported_layout: {
      classification: "unsupported_layout",
      reason: "filesystem_layout_is_unsupported",
    },
    missing_file: {
      classification: "missing_file",
      reason: "archive_file_is_missing",
    },
    containment_rejection: {
      classification: "containment_rejection",
      reason: "archive_path_is_outside_configured_containment",
    },
    not_regular_file: {
      classification: "not_regular_file",
      reason: "archive_path_is_not_a_regular_file",
    },
    read_error: {
      classification: "read_error",
      reason: "archive_file_could_not_be_read",
    },
    read_timeout: {
      classification: "read_timeout",
      reason: "archive_file_read_timed_out",
    },
  };
  return {
    actualSizeBytes: inspection.actualSizeBytes,
    declaredGeometry,
    ...resultByOutcome[inspection.outcome],
  };
}

function addCapacityReuseSignals(findings: ArchiveAuditFinding[]): void {
  const groups = new Map<string, ArchiveAuditFinding[]>();
  for (const finding of findings) {
    const capacityBytes = finding.discInspectionCapacityBytes ??
      finding.reportedBoundarySizeBytes;
    if (
      capacityBytes === null ||
      finding.mediaGeneration === null ||
      capacityBytes <= 0
    ) {
      continue;
    }
    const key = `${finding.opticalDriveId}\u0000${capacityBytes}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const generations = new Set(group.map(({ mediaGeneration }) => mediaGeneration));
    const discs = new Set(group.map(({ detectedDiscId }) => detectedDiscId));
    if (generations.size < 2 || discs.size < 2) {
      continue;
    }
    const firstFinding = group[0]!;
    const capacityBytes = firstFinding.discInspectionCapacityBytes ??
      firstFinding.reportedBoundarySizeBytes!;
    for (const finding of group) {
      finding.capacityReuse = {
        classification: "suspicious_capacity_reuse",
        capacityBytes,
        archiveCount: group.length,
        mediaGenerationCount: generations.size,
        reason: "distinct_media_generations_reused_exact_capacity",
      };
      if (finding.classification === "consistent") {
        finding.classification = "suspicious_capacity_reuse";
        finding.reason = "distinct_media_generations_reused_exact_capacity";
      }
    }
  }
}

function emptyCounts(): ArchiveAuditReport["counts"] {
  return {
    consistent: 0,
    definite_truncation: 0,
    suspicious_capacity_reuse: 0,
    size_mismatch: 0,
    missing_file: 0,
    malformed_metadata: 0,
    unsupported_layout: 0,
    containment_rejection: 0,
    not_regular_file: 0,
    read_error: 0,
    read_timeout: 0,
    suspiciousCapacityReuseSignals: 0,
  };
}

export async function runArchiveAudit({
  records,
  recordsTruncated,
  recordLimit,
  concurrency,
  fileTimeoutMs,
  runtimeTimeoutMs,
  originalsLibraryPath,
  fileInspector,
  signal,
  now = () => new Date(),
}: RunArchiveAuditRequest): Promise<ArchiveAuditReport> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > ARCHIVE_AUDIT_MAX_CONCURRENCY
  ) {
    throw new TypeError(
      `Archive audit concurrency must be between 1 and ${ARCHIVE_AUDIT_MAX_CONCURRENCY}`,
    );
  }
  if (records.length > recordLimit) {
    throw new TypeError("Archive audit records exceed the declared record limit");
  }
  if (
    !Number.isSafeInteger(fileTimeoutMs) ||
    fileTimeoutMs < 1 ||
    !Number.isSafeInteger(runtimeTimeoutMs) ||
    runtimeTimeoutMs < 1
  ) {
    throw new TypeError("Archive audit time limits must be positive integers");
  }
  signal.throwIfAborted();
  const startedAt = now();
  const findings = new Array<ArchiveAuditFinding>(records.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      signal.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      const record = records[index];
      if (record === undefined) {
        return;
      }
      const inspection = record.archivePathRejected || record.archivePath === null
        ? {
            actualSizeBytes: null,
            geometry: null,
            outcome: "containment_rejection" as const,
          }
        : await fileInspector.inspect(
            record.archivePath,
            originalsLibraryPath,
            signal,
          );
      const result = primaryResult(record, inspection);
      findings[index] = {
        archiveId: record.archiveId,
        detectedDiscId: record.detectedDiscId,
        opticalDriveId: record.opticalDriveId,
        discInspectionId: record.discInspectionId,
        mediaGeneration: record.mediaGeneration,
        archivedAt: record.archivedAt.toISOString(),
        recordedSizeBytes: record.recordedSizeBytes,
        discInspectionCapacityBytes: record.discInspectionCapacityBytes,
        reportedBoundarySizeBytes: record.reportedBoundarySizeBytes,
        publishedBoundarySizeBytes: record.publishedBoundarySizeBytes,
        capacityReuse: null,
        ...result,
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, records.length) }, worker),
  );
  addCapacityReuseSignals(findings);

  const counts = emptyCounts();
  for (const finding of findings) {
    counts[finding.classification] += 1;
    if (finding.capacityReuse !== null) {
      counts.suspiciousCapacityReuseSignals += 1;
    }
  }
  return {
    schemaVersion: ARCHIVE_AUDIT_SCHEMA_VERSION,
    commandVersion: ARCHIVE_AUDIT_COMMAND_VERSION,
    startedAt: startedAt.toISOString(),
    completedAt: now().toISOString(),
    scope: {
      recordLimit,
      concurrency,
      fileTimeoutMs,
      runtimeTimeoutMs,
      truncated: recordsTruncated,
    },
    counts,
    findings,
  };
}
