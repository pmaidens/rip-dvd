import type { ArchiveAuditRecord } from "@rip-dvd/data-access/archive-audit-records";
import {
  ARCHIVE_AUDIT_COMMAND_VERSION,
  ARCHIVE_AUDIT_SCHEMA_VERSION,
  countArchiveAuditFindings,
  type ArchiveAuditClassification,
  type ArchiveAuditDeclaredGeometry,
  type ArchiveAuditFinding,
  type ArchiveAuditReason,
  type ArchiveAuditReport,
} from "@rip-dvd/data-access";

import type { DvdImageGeometry } from "./dvd-geometry-validator.js";

export {
  ARCHIVE_AUDIT_COMMAND_VERSION,
  ARCHIVE_AUDIT_SCHEMA_VERSION,
};
export type {
  ArchiveAuditClassification,
  ArchiveAuditDeclaredGeometry,
  ArchiveAuditFinding,
  ArchiveAuditReason,
  ArchiveAuditReport,
} from "@rip-dvd/data-access";
export const ARCHIVE_AUDIT_MAX_CONCURRENCY = 8;

export type ArchiveAuditFileInspection =
  | {
      actualSizeBytes: number;
      geometry: DvdImageGeometry;
      outcome: "ok" | "definite_truncation";
    }
  | {
      actualSizeBytes: number | null;
      geometry: DvdImageGeometry | null;
      outcome: "malformed_metadata";
    }
  | {
      actualSizeBytes: number;
      geometry: DvdImageGeometry | null;
      outcome: "unsupported_layout";
    }
  | {
      actualSizeBytes: null;
      geometry: null;
      outcome:
        | "missing_file"
        | "containment_rejection"
        | "not_regular_file"
        | "read_timeout";
    }
  | {
      actualSizeBytes: number | null;
      geometry: null;
      outcome: "read_error";
    };

export type ArchiveAuditFileOutcome = ArchiveAuditFileInspection["outcome"];

export interface ArchiveAuditFileInspector {
  inspect(
    archivePath: string,
    originalsLibraryPath: string,
    signal: AbortSignal,
  ): Promise<ArchiveAuditFileInspection>;
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
  onFinding?: (finding: ArchiveAuditFinding, index: number) => void | Promise<void>;
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

function boundaryEvidenceMatchesActualSize(
  record: ArchiveAuditRecord,
  actualSizeBytes: number,
): boolean {
  const reported = record.reportedBoundarySizeBytes;
  const published = record.publishedBoundarySizeBytes;
  const excludedSectors = record.boundaryExcludedSectorCount;
  if (
    reported === null &&
    published === null &&
    excludedSectors === null
  ) {
    return true;
  }
  if (
    reported === null ||
    published !== actualSizeBytes ||
    excludedSectors === null
  ) {
    return false;
  }
  if (reported === actualSizeBytes) {
    return excludedSectors === 0;
  }
  return reported > actualSizeBytes &&
    reported - actualSizeBytes === excludedSectors * 2_048;
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
    const hasSizeMismatch =
      record.recordedSizeBytes !== null &&
        record.recordedSizeBytes !== inspection.actualSizeBytes ||
      !boundaryEvidenceMatchesActualSize(record, inspection.actualSizeBytes);
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
  onFinding,
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
      await onFinding?.(findings[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, records.length) }, worker),
  );
  addCapacityReuseSignals(findings);

  const counts = countArchiveAuditFindings(findings);
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
