import type {
  DetectedDiscId,
  DiscInspectionId,
  OpticalDriveId,
  OriginalDiscArchiveId,
} from "./types.js";

export const ARCHIVE_AUDIT_SCHEMA_VERSION = 1;
export const ARCHIVE_AUDIT_COMMAND_VERSION = "archive-audit-v1";

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
  archiveId: OriginalDiscArchiveId;
  detectedDiscId: DetectedDiscId;
  opticalDriveId: OpticalDriveId;
  discInspectionId: DiscInspectionId | null;
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

export type ArchiveAuditCounts = Record<ArchiveAuditClassification, number> & {
  suspiciousCapacityReuseSignals: number;
};

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
  counts: ArchiveAuditCounts;
  findings: readonly ArchiveAuditFinding[];
}

export function countArchiveAuditFindings(
  findings: readonly ArchiveAuditFinding[],
): ArchiveAuditCounts {
  const counts: ArchiveAuditCounts = {
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
  for (const finding of findings) {
    counts[finding.classification] += 1;
    if (finding.capacityReuse !== null) counts.suspiciousCapacityReuseSignals += 1;
  }
  return counts;
}
