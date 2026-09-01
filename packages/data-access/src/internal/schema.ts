import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
  ARCHIVE_FAILURE_DETAIL_VERSIONS,
  ARCHIVE_JOB_STATUSES,
  ARCHIVE_READ_FAILURE_CATEGORIES,
  ARCHIVE_READ_FAILURE_STAGES,
  ARCHIVE_REQUEST_STATUSES,
  ARCHIVE_RUNNING_PROGRESS_PHASES,
  ARCHIVE_FORMATS,
  ARCHIVE_INTEGRITIES,
  CATALOG_REVIEW_OUTCOMES,
  DETECTED_DISC_STATUSES,
  DISC_INSPECTION_ATTEMPT_OUTCOMES,
  DISC_INSPECTION_PHASES,
  DISC_INSPECTION_REASON_CODES,
  DISC_INSPECTION_STATUSES,
  DISC_KINDS,
  DISC_SELECTION_KINDS,
  ENCODE_JOB_STATUSES,
  ENCODE_PROGRESS_PHASES,
  FILESYSTEM_VERIFICATION_STATUSES,
  MEDIA_DOMAINS,
  MEDIA_ITEM_KINDS,
  RETAINED_ENCODE_OUTPUT_STATES,
  TMDB_MEDIA_TYPES,
  WORKER_INCIDENT_PHASES,
  WORKER_INCIDENT_REASON_CODES,
  WORKER_INCIDENT_RETRYABILITIES,
  WORKER_KINDS,
} from "../domain-values.js";
import {
  ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
  ENCODE_JOB_FAILURE_PHASES,
  ENCODE_JOB_FAILURE_REASON_CODES,
  ENCODE_JOB_FAILURE_REPORT_SCHEMA_VERSIONS,
  ENCODE_JOB_FAILURE_RETRYABILITIES,
  ENCODE_JOB_FAILURE_SIGNALS,
} from "../encode-job-failure-report.js";
import type {
  ArchiveRequestId,
  ArchiveJobId,
  ArchiveJobClaimToken,
  ArchiveReadFailureCategory,
  ArchiveReadFailureStage,
  DetectedDiscId,
  DiscInspectionAttemptId,
  DiscInspectionClaimToken,
  DiscInspectionId,
  DiscSelectionId,
  DvdTitleBadSectorCount,
  EncodeJobCleanupClaimToken,
  EncodeJobId,
  EncodeJobFailureReportId,
  EncodeJobClaimToken,
  EncodeOutputFilesystemIdentity,
  EncodingProfileId,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RetainedEncodeOutputId,
  UnreadableSectorRange,
  WorkerIncidentEvidence,
  WorkerIncidentId,
  WorkerIncidentSchemaVersion,
} from "../types.js";

const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull();
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).notNull();

function sqliteStringLiterals(values: readonly string[]) {
  return sql.raw(
    values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "),
  );
}

export const opticalDrives = sqliteTable(
  "optical_drives",
  {
    id: text("id").$type<OpticalDriveId>().notNull().primaryKey(),
    devicePath: text("device_path").notNull(),
    displayName: text("display_name"),
    vendor: text("vendor"),
    product: text("product"),
    serialNumber: text("serial_number"),
    isEnabled: integer("is_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    configurationDefaultResolved: integer("configuration_default_resolved", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    isConfiguredTarget: integer("is_configured_target", { mode: "boolean" })
      .notNull()
      .default(false),
    isPresent: integer("is_present", { mode: "boolean" })
      .notNull()
      .default(true),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("optical_drives_present_device_path_unique")
      .on(table.devicePath)
      .where(sql`${table.isPresent} = true`),
    check("optical_drives_id_not_null", sql`${table.id} is not null`),
  ],
);

export const detectedDiscs = sqliteTable(
  "detected_discs",
  {
    id: text("id").$type<DetectedDiscId>().notNull().primaryKey(),
    opticalDriveId: text("optical_drive_id")
      .$type<OpticalDriveId>()
      .notNull()
      .references(() => opticalDrives.id, { onDelete: "restrict" }),
    discKind: text("disc_kind", { enum: DISC_KINDS }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    volumeLabel: text("volume_label"),
    status: text("status", { enum: DETECTED_DISC_STATUSES })
      .notNull()
      .default("detected"),
    scanData: text("scan_data", { mode: "json" }).$type<unknown>(),
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("detected_discs_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("detected_discs_drive_fingerprint_unique").on(
      table.opticalDriveId,
      table.fingerprint,
    ),
    index("detected_discs_status_idx").on(table.status),
    check(
      "detected_discs_kind_check",
      sql`${table.discKind} in (${sqliteStringLiterals(DISC_KINDS)})`,
    ),
    check(
      "detected_discs_status_check",
      sql`${table.status} in (${sqliteStringLiterals(DETECTED_DISC_STATUSES)})`,
    ),
  ],
);

export const discInspections = sqliteTable(
  "disc_inspections",
  {
    id: text("id").$type<DiscInspectionId>().notNull().primaryKey(),
    opticalDriveId: text("optical_drive_id")
      .$type<OpticalDriveId>()
      .notNull()
      .references(() => opticalDrives.id, { onDelete: "restrict" }),
    detectedDiscId: text("detected_disc_id")
      .$type<DetectedDiscId>()
      .references(() => detectedDiscs.id, { onDelete: "restrict" }),
    mediaGeneration: text("media_generation").notNull(),
    mediaCapacityBytes: integer("media_capacity_bytes"),
    settlingBaselineCapacityBytes: integer(
      "settling_baseline_capacity_bytes",
    ),
    stableObservationCount: integer("stable_observation_count"),
    settlingQuietWindowStartedAt: integer("settling_quiet_window_started_at", {
      mode: "timestamp_ms",
    }),
    settlingStartedAt: integer("settling_started_at", {
      mode: "timestamp_ms",
    }),
    settlingResetCount: integer("settling_reset_count"),
    isCurrent: integer("is_current", { mode: "boolean" })
      .notNull()
      .default(true),
    status: text("status", { enum: DISC_INSPECTION_STATUSES })
      .notNull()
      .default("running"),
    phase: text("phase", { enum: DISC_INSPECTION_PHASES })
      .notNull()
      .default("settling"),
    attemptCount: integer("attempt_count").notNull().default(1),
    consecutiveFailureCount: integer("consecutive_failure_count")
      .notNull()
      .default(0),
    volumeLabel: text("volume_label"),
    titleCount: integer("title_count"),
    chapterCount: integer("chapter_count"),
    audioStreamCount: integer("audio_stream_count"),
    subtitleStreamCount: integer("subtitle_stream_count"),
    totalBytes: integer("total_bytes"),
    bytesHashed: integer("bytes_hashed"),
    bytesPerSecond: integer("bytes_per_second"),
    etaSeconds: integer("eta_seconds"),
    retryAt: integer("retry_at", { mode: "timestamp_ms" }),
    manualRetryRequestedAt: integer("manual_retry_requested_at", {
      mode: "timestamp_ms",
    }),
    reasonCode: text("reason_code", { enum: DISC_INSPECTION_REASON_CODES }),
    diagnostic: text("diagnostic"),
    claimToken: text("claim_token").$type<DiscInspectionClaimToken>(),
    claimUpdatedAt: integer("claim_updated_at", { mode: "timestamp_ms" }),
    phaseStartedAt: integer("phase_started_at", { mode: "timestamp_ms" })
      .notNull(),
    attemptStartedAt: integer("attempt_started_at", { mode: "timestamp_ms" })
      .notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("disc_inspections_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("disc_inspections_current_drive_unique")
      .on(table.opticalDriveId)
      .where(sql`${table.isCurrent} = 1`),
    index("disc_inspections_status_idx").on(table.status, table.updatedAt),
    check(
      "disc_inspections_status_check",
      sql`${table.status} in (${sqliteStringLiterals(DISC_INSPECTION_STATUSES)})`,
    ),
    check(
      "disc_inspections_phase_check",
      sql`${table.phase} in (${sqliteStringLiterals(DISC_INSPECTION_PHASES)})`,
    ),
    check(
      "disc_inspections_reason_check",
      sql`${table.reasonCode} is null or ${table.reasonCode} in (${sqliteStringLiterals(DISC_INSPECTION_REASON_CODES)})`,
    ),
    check(
      "disc_inspections_generation_check",
      sql`length(${table.mediaGeneration}) between 1 and 64`,
    ),
    check(
      "disc_inspections_settling_evidence_check",
      sql`((${table.mediaCapacityBytes} is null and ${table.settlingBaselineCapacityBytes} is null and ${table.stableObservationCount} is null and ${table.settlingQuietWindowStartedAt} is null and ${table.settlingStartedAt} is null and ${table.settlingResetCount} is null) or (${table.mediaCapacityBytes} is null and (${table.settlingBaselineCapacityBytes} is null or (typeof(${table.settlingBaselineCapacityBytes}) = 'integer' and ${table.settlingBaselineCapacityBytes} > 0 and ${table.settlingBaselineCapacityBytes} <= 9000000000 and ${table.settlingBaselineCapacityBytes} % 2048 = 0)) and ${table.stableObservationCount} = 0 and ${table.settlingQuietWindowStartedAt} is null and ${table.settlingStartedAt} is not null and typeof(${table.settlingResetCount}) = 'integer' and ${table.settlingResetCount} between 0 and 10000) or (typeof(${table.mediaCapacityBytes}) = 'integer' and ${table.mediaCapacityBytes} > 0 and ${table.mediaCapacityBytes} <= 9000000000 and ${table.mediaCapacityBytes} % 2048 = 0 and ${table.settlingBaselineCapacityBytes} is null and typeof(${table.stableObservationCount}) = 'integer' and ${table.stableObservationCount} between 1 and 3 and ${table.settlingQuietWindowStartedAt} is not null and ${table.settlingStartedAt} is not null and ${table.settlingQuietWindowStartedAt} >= ${table.settlingStartedAt} and typeof(${table.settlingResetCount}) = 'integer' and ${table.settlingResetCount} between 0 and 10000)) and (${table.phase} <> 'settling' or ${table.settlingStartedAt} is not null)`,
    ),
    check(
      "disc_inspections_attempt_count_check",
      sql`typeof(${table.attemptCount}) = 'integer' and ${table.attemptCount} > 0 and typeof(${table.consecutiveFailureCount}) = 'integer' and ${table.consecutiveFailureCount} between 0 and 5 and ${table.consecutiveFailureCount} <= ${table.attemptCount}`,
    ),
    check(
      "disc_inspections_findings_check",
      sql`(${table.titleCount} is null or (typeof(${table.titleCount}) = 'integer' and ${table.titleCount} >= 0)) and (${table.chapterCount} is null or (typeof(${table.chapterCount}) = 'integer' and ${table.chapterCount} >= 0)) and (${table.audioStreamCount} is null or (typeof(${table.audioStreamCount}) = 'integer' and ${table.audioStreamCount} >= 0)) and (${table.subtitleStreamCount} is null or (typeof(${table.subtitleStreamCount}) = 'integer' and ${table.subtitleStreamCount} >= 0))`,
    ),
    check(
      "disc_inspections_progress_check",
      sql`(${table.totalBytes} is null or (typeof(${table.totalBytes}) = 'integer' and ${table.totalBytes} >= 0)) and (${table.bytesHashed} is null or (typeof(${table.bytesHashed}) = 'integer' and ${table.bytesHashed} >= 0 and (${table.totalBytes} is null or ${table.bytesHashed} <= ${table.totalBytes})))`,
    ),
    check(
      "disc_inspections_estimate_check",
      sql`(${table.bytesPerSecond} is null) = (${table.etaSeconds} is null) and (${table.bytesPerSecond} is null or (typeof(${table.bytesPerSecond}) = 'integer' and ${table.bytesPerSecond} > 0 and typeof(${table.etaSeconds}) = 'integer' and ${table.etaSeconds} >= 0))`,
    ),
    check(
      "disc_inspections_claim_check",
      sql`(${table.claimToken} is null) = (${table.claimUpdatedAt} is null) and (${table.claimToken} is null or ${table.status} = 'running')`,
    ),
    check(
      "disc_inspections_terminal_check",
      sql`(${table.status} = 'running') = (${table.completedAt} is null) and (${table.status} = 'completed') = (${table.detectedDiscId} is not null)`,
    ),
    check(
      "disc_inspections_retry_check",
      sql`(${table.retryAt} is null or (${table.status} = 'running' and ${table.phase} = 'retry_wait')) and (${table.manualRetryRequestedAt} is null or (${table.status} = 'failed' and ${table.isCurrent} = 1))`,
    ),
  ],
);

export const discInspectionAttempts = sqliteTable(
  "disc_inspection_attempts",
  {
    id: text("id").$type<DiscInspectionAttemptId>().notNull().primaryKey(),
    discInspectionId: text("disc_inspection_id")
      .$type<DiscInspectionId>()
      .notNull()
      .references(() => discInspections.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    outcome: text("outcome", { enum: DISC_INSPECTION_ATTEMPT_OUTCOMES })
      .notNull(),
    phase: text("phase", { enum: DISC_INSPECTION_PHASES }).notNull(),
    reasonCode: text("reason_code", { enum: DISC_INSPECTION_REASON_CODES }),
    diagnostic: text("diagnostic"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("disc_inspection_attempts_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("disc_inspection_attempts_number_unique").on(
      table.discInspectionId,
      table.attemptNumber,
    ),
    check(
      "disc_inspection_attempts_number_check",
      sql`typeof(${table.attemptNumber}) = 'integer' and ${table.attemptNumber} > 0`,
    ),
    check(
      "disc_inspection_attempts_outcome_check",
      sql`${table.outcome} in (${sqliteStringLiterals(DISC_INSPECTION_ATTEMPT_OUTCOMES)})`,
    ),
    check(
      "disc_inspection_attempts_phase_check",
      sql`${table.phase} in (${sqliteStringLiterals(DISC_INSPECTION_PHASES)})`,
    ),
    check(
      "disc_inspection_attempts_reason_check",
      sql`${table.reasonCode} is null or ${table.reasonCode} in (${sqliteStringLiterals(DISC_INSPECTION_REASON_CODES)})`,
    ),
  ],
);

export const archiveRequests = sqliteTable(
  "archive_requests",
  {
    id: text("id").$type<ArchiveRequestId>().notNull().primaryKey(),
    detectedDiscId: text("detected_disc_id")
      .$type<DetectedDiscId>()
      .notNull()
      .references(() => detectedDiscs.id, { onDelete: "restrict" }),
    status: text("status", { enum: ARCHIVE_REQUEST_STATUSES })
      .notNull()
      .default("pending"),
    priority: integer("priority").notNull().default(0),
    cancellationRequestedAt: integer("cancellation_requested_at", {
      mode: "timestamp_ms",
    }),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("archive_requests_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("archive_requests_nonterminal_disc_unique")
      .on(table.detectedDiscId)
      .where(sql`${table.status} in ('pending', 'running', 'needs_attention', 'cancellation_requested')`),
    index("archive_requests_status_idx").on(
      table.status,
      table.priority,
      table.createdAt,
    ),
    check(
      "archive_requests_status_check",
      sql`${table.status} in (${sqliteStringLiterals(ARCHIVE_REQUEST_STATUSES)})`,
    ),
    check(
      "archive_requests_terminal_fields_check",
      sql`(${table.fulfilledAt} is not null) = (${table.status} = 'fulfilled') and (${table.cancelledAt} is not null) = (${table.status} = 'cancelled') and (${table.cancellationRequestedAt} is not null) = (${table.status} in ('cancellation_requested', 'cancelled'))`,
    ),
  ],
);

export const originalDiscArchives = sqliteTable(
  "original_disc_archives",
  {
    id: text("id").$type<OriginalDiscArchiveId>().notNull().primaryKey(),
    detectedDiscId: text("detected_disc_id")
      .$type<DetectedDiscId>()
      .notNull()
      .references(() => detectedDiscs.id, { onDelete: "restrict" }),
    discKind: text("disc_kind", { enum: DISC_KINDS }).notNull(),
    archiveFormat: text("archive_format", { enum: ARCHIVE_FORMATS }).notNull(),
    archivePath: text("archive_path").notNull(),
    fingerprint: text("fingerprint").notNull(),
    sizeBytes: integer("size_bytes"),
    boundaryPolicyVersion: text("boundary_policy_version"),
    boundaryReportedSizeBytes: integer("boundary_reported_size_bytes"),
    boundaryPublishedSizeBytes: integer("boundary_published_size_bytes"),
    boundaryExcludedSectorCount: integer("boundary_excluded_sector_count"),
    boundaryFirstExcludedLba: integer("boundary_first_excluded_lba"),
    boundaryMaximumReferencedLba: integer("boundary_maximum_referenced_lba"),
    boundaryReadFailureClassifierVersion: text(
      "boundary_read_failure_classifier_version",
    ),
    boundaryReadFailureScsiStatus: integer(
      "boundary_read_failure_scsi_status",
    ),
    boundaryReadFailureHostStatus: integer(
      "boundary_read_failure_host_status",
    ),
    boundaryReadFailureDriverStatus: integer(
      "boundary_read_failure_driver_status",
    ),
    boundaryReadFailureSenseResponseCode: integer(
      "boundary_read_failure_sense_response_code",
    ),
    boundaryReadFailureSenseKey: integer(
      "boundary_read_failure_sense_key",
    ),
    boundaryReadFailureAsc: integer("boundary_read_failure_asc"),
    boundaryReadFailureAscq: integer("boundary_read_failure_ascq"),
    integrity: text("integrity", { enum: ARCHIVE_INTEGRITIES })
      .notNull()
      .default("unknown"),
    integrityPolicyVersion: text("integrity_policy_version"),
    badSectorCount: integer("bad_sector_count"),
    badAreaCount: integer("bad_area_count"),
    badSectorRanges: text("bad_sector_ranges", { mode: "json" })
      .$type<readonly UnreadableSectorRange[]>(),
    badSectorCountsByTitle: text("bad_sector_counts_by_title", { mode: "json" })
      .$type<readonly DvdTitleBadSectorCount[]>(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }).notNull(),
    catalogReviewedAt: integer("catalog_reviewed_at", {
      mode: "timestamp_ms",
    }),
    catalogReviewOutcome: text("catalog_review_outcome", {
      enum: CATALOG_REVIEW_OUTCOMES,
    })
      .notNull()
      .default("needs_review"),
    legacyCutoverPending: integer("legacy_cutover_pending", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    verificationStatus: text("verification_status", {
      enum: FILESYSTEM_VERIFICATION_STATUSES,
    }),
    verificationMessage: text("verification_message"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("original_disc_archives_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("original_disc_archives_detected_disc_unique").on(
      table.detectedDiscId,
    ),
    uniqueIndex("original_disc_archives_path_unique").on(table.archivePath),
    uniqueIndex("original_disc_archives_fingerprint_unique").on(table.fingerprint),
    check(
      "original_disc_archives_kind_check",
      sql`${table.discKind} in (${sqliteStringLiterals(DISC_KINDS)})`,
    ),
    check(
      "original_disc_archives_format_check",
      sql`${table.archiveFormat} in (${sqliteStringLiterals(ARCHIVE_FORMATS)})`,
    ),
    check(
      "original_disc_archives_size_check",
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    check(
      "original_disc_archives_boundary_evidence_check",
      sql`(${table.boundaryPolicyVersion} is null and ${table.boundaryReportedSizeBytes} is null and ${table.boundaryPublishedSizeBytes} is null and ${table.boundaryExcludedSectorCount} is null and ${table.boundaryFirstExcludedLba} is null and ${table.boundaryMaximumReferencedLba} is null and ${table.boundaryReadFailureClassifierVersion} is null and ${table.boundaryReadFailureScsiStatus} is null and ${table.boundaryReadFailureHostStatus} is null and ${table.boundaryReadFailureDriverStatus} is null and ${table.boundaryReadFailureSenseResponseCode} is null and ${table.boundaryReadFailureSenseKey} is null and ${table.boundaryReadFailureAsc} is null and ${table.boundaryReadFailureAscq} is null) or (${table.discKind} = 'dvd' and typeof(${table.boundaryPolicyVersion}) = 'text' and length(${table.boundaryPolicyVersion}) between 1 and 128 and typeof(${table.boundaryReportedSizeBytes}) = 'integer' and ${table.boundaryReportedSizeBytes} between 1 and 9000000000 and typeof(${table.sizeBytes}) = 'integer' and typeof(${table.boundaryPublishedSizeBytes}) = 'integer' and ${table.boundaryPublishedSizeBytes} = ${table.sizeBytes} and typeof(${table.boundaryExcludedSectorCount}) = 'integer' and ((${table.boundaryPublishedSizeBytes} = ${table.boundaryReportedSizeBytes} and ${table.boundaryExcludedSectorCount} = 0 and ${table.boundaryFirstExcludedLba} is null and ${table.boundaryMaximumReferencedLba} is null and ${table.boundaryReadFailureClassifierVersion} is null and ${table.boundaryReadFailureScsiStatus} is null and ${table.boundaryReadFailureHostStatus} is null and ${table.boundaryReadFailureDriverStatus} is null and ${table.boundaryReadFailureSenseResponseCode} is null and ${table.boundaryReadFailureSenseKey} is null and ${table.boundaryReadFailureAsc} is null and ${table.boundaryReadFailureAscq} is null) or (${table.boundaryReportedSizeBytes} % 2048 = 0 and ${table.boundaryPublishedSizeBytes} % 2048 = 0 and ${table.boundaryPublishedSizeBytes} between 2048 and ${table.boundaryReportedSizeBytes} - 2048 and ${table.boundaryExcludedSectorCount} = (${table.boundaryReportedSizeBytes} - ${table.boundaryPublishedSizeBytes}) / 2048 and typeof(${table.boundaryFirstExcludedLba}) = 'integer' and ${table.boundaryFirstExcludedLba} = ${table.boundaryPublishedSizeBytes} / 2048 and typeof(${table.boundaryMaximumReferencedLba}) = 'integer' and ${table.boundaryMaximumReferencedLba} between 0 and ${table.boundaryFirstExcludedLba} - 1 and typeof(${table.boundaryReadFailureClassifierVersion}) = 'text' and length(${table.boundaryReadFailureClassifierVersion}) between 1 and 128 and typeof(${table.boundaryReadFailureScsiStatus}) = 'integer' and ${table.boundaryReadFailureScsiStatus} between 0 and 255 and (${table.boundaryReadFailureScsiStatus} & 254) = 2 and typeof(${table.boundaryReadFailureHostStatus}) = 'integer' and ${table.boundaryReadFailureHostStatus} = 0 and typeof(${table.boundaryReadFailureDriverStatus}) = 'integer' and ${table.boundaryReadFailureDriverStatus} between 0 and 65535 and (${table.boundaryReadFailureDriverStatus} & 15) in (0, 8) and typeof(${table.boundaryReadFailureSenseResponseCode}) = 'integer' and ${table.boundaryReadFailureSenseResponseCode} in (112, 114) and typeof(${table.boundaryReadFailureSenseKey}) = 'integer' and ${table.boundaryReadFailureSenseKey} = 5 and typeof(${table.boundaryReadFailureAsc}) = 'integer' and ${table.boundaryReadFailureAsc} = 33 and typeof(${table.boundaryReadFailureAscq}) = 'integer' and ${table.boundaryReadFailureAscq} = 0)))`,
    ),
    check(
      "original_disc_archives_integrity_check",
      sql`${table.integrity} in (${sqliteStringLiterals(ARCHIVE_INTEGRITIES)})`,
    ),
    check(
      "original_disc_archives_integrity_evidence_check",
      sql`(${table.integrity} = 'unknown' and ${table.integrityPolicyVersion} is null and ${table.badSectorCount} is null and ${table.badAreaCount} is null and ${table.badSectorRanges} is null and ${table.badSectorCountsByTitle} is null) or (${table.integrity} = 'clean_read' and ${table.integrityPolicyVersion} is not null and ${table.badSectorCount} is not null and ${table.badAreaCount} is not null and ${table.badSectorRanges} is not null and ${table.badSectorCountsByTitle} is null and length(${table.integrityPolicyVersion}) between 1 and 128 and ${table.badSectorCount} = 0 and ${table.badAreaCount} = 0 and json(${table.badSectorRanges}) = json('[]')) or (${table.integrity} = 'watchable_salvage' and ${table.integrityPolicyVersion} is not null and ${table.badSectorCount} is not null and ${table.badAreaCount} is not null and ${table.badSectorRanges} is not null and length(${table.integrityPolicyVersion}) between 1 and 128 and ${table.badSectorCount} > 0 and ${table.badAreaCount} > 0 and json_valid(${table.badSectorRanges}) and json_type(${table.badSectorRanges}) = 'array' and (${table.integrityPolicyVersion} = 'dvd-watchable-salvage-v1' or (${table.badSectorCountsByTitle} is not null and json_valid(${table.badSectorCountsByTitle}) and json_type(${table.badSectorCountsByTitle}) = 'array')))`,
    ),
    check(
      "original_disc_archives_catalog_review_outcome_check",
      sql`${table.catalogReviewOutcome} in (${sqliteStringLiterals(CATALOG_REVIEW_OUTCOMES)}) and (${table.catalogReviewOutcome} = 'needs_review') = (${table.catalogReviewedAt} is null)`,
    ),
    check(
      "original_disc_archives_verification_check",
      sql`(${table.verificationStatus} is null) = (${table.verificationMessage} is null) and (${table.verificationStatus} is null) = (${table.verifiedAt} is null) and (${table.verificationStatus} is null or ${table.verificationStatus} in (${sqliteStringLiterals(FILESYSTEM_VERIFICATION_STATUSES)}))`,
    ),
  ],
);

export const legacyCutoverStagedSidecars = sqliteTable(
  "legacy_cutover_staged_sidecars",
  {
    originalsLibraryPath: text("originals_library_path").notNull(),
    sidecarPath: text("sidecar_path").notNull(),
    archivePath: text("archive_path").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.originalsLibraryPath, table.sidecarPath],
    }),
    index("legacy_cutover_staged_sidecars_library_idx").on(
      table.originalsLibraryPath,
    ),
  ],
);

export const originalDiscArchiveContentIds = sqliteTable(
  "original_disc_archive_content_ids",
  {
    originalDiscArchiveId: text("original_disc_archive_id")
      .$type<OriginalDiscArchiveId>()
      .notNull()
      .primaryKey()
      .references(() => originalDiscArchives.id, { onDelete: "cascade" }),
    contentId: text("content_id").notNull(),
  },
  (table) => [
    check(
      "original_disc_archive_content_ids_id_not_null",
      sql`${table.originalDiscArchiveId} is not null`,
    ),
    uniqueIndex("original_disc_archive_content_ids_content_id_unique").on(
      table.contentId,
    ),
  ],
);

export const mediaItems = sqliteTable(
  "media_items",
  {
    id: text("id").$type<MediaItemId>().notNull().primaryKey(),
    parentId: text("parent_id")
      .$type<MediaItemId>()
      .references((): AnySQLiteColumn => mediaItems.id, {
        onDelete: "restrict",
      }),
    kind: text("kind", { enum: MEDIA_ITEM_KINDS }).notNull(),
    title: text("title").notNull(),
    year: integer("year"),
    seasonNumber: integer("season_number"),
    episodeNumber: integer("episode_number"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("media_items_id_not_null", sql`${table.id} is not null`),
    index("media_items_parent_idx").on(table.parentId),
    check(
      "media_items_kind_check",
      sql`${table.kind} in (${sqliteStringLiterals(MEDIA_ITEM_KINDS)})`,
    ),
    check(
      "media_items_year_check",
      sql`${table.year} is null or ${table.year} between 1800 and 9999`,
    ),
    check(
      "media_items_season_number_check",
      sql`${table.seasonNumber} is null or ${table.seasonNumber} >= 0`,
    ),
    check(
      "media_items_episode_number_check",
      sql`${table.episodeNumber} is null or ${table.episodeNumber} > 0`,
    ),
  ],
);

export const mediaItemTmdbIdentities = sqliteTable(
  "media_item_tmdb_identities",
  {
    mediaItemId: text("media_item_id")
      .$type<MediaItemId>()
      .notNull()
      .primaryKey()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    mediaType: text("media_type", { enum: TMDB_MEDIA_TYPES }).notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "media_item_tmdb_identities_id_not_null",
      sql`${table.mediaItemId} is not null`,
    ),
    uniqueIndex("media_item_tmdb_identities_identity_unique").on(
      table.mediaType,
      table.tmdbId,
    ),
    check(
      "media_item_tmdb_identities_type_check",
      sql`${table.mediaType} in (${sqliteStringLiterals(TMDB_MEDIA_TYPES)})`,
    ),
    check(
      "media_item_tmdb_identities_id_check",
      sql`typeof(${table.tmdbId}) = 'integer' and ${table.tmdbId} > 0`,
    ),
  ],
);

export const discSelections = sqliteTable(
  "disc_selections",
  {
    id: text("id").$type<DiscSelectionId>().notNull().primaryKey(),
    originalDiscArchiveId: text("original_disc_archive_id")
      .$type<OriginalDiscArchiveId>()
      .notNull()
      .references(() => originalDiscArchives.id, { onDelete: "restrict" }),
    mediaItemId: text("media_item_id")
      .$type<MediaItemId>()
      .notNull()
      .references(() => mediaItems.id, { onDelete: "restrict" }),
    sourceKey: text("source_key").notNull(),
    kind: text("kind", { enum: DISC_SELECTION_KINDS }).notNull(),
    titleNumber: integer("title_number"),
    chapterStart: integer("chapter_start"),
    chapterEnd: integer("chapter_end"),
    label: text("label"),
    isCatalogActive: integer("is_catalog_active", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("disc_selections_id_not_null", sql`${table.id} is not null`),
    index("disc_selections_archive_active_source_idx")
      .on(table.originalDiscArchiveId, table.sourceKey)
      .where(sql`${table.isCatalogActive} = 1`),
    index("disc_selections_media_item_idx").on(table.mediaItemId),
    check(
      "disc_selections_kind_check",
      sql`${table.kind} in (${sqliteStringLiterals(DISC_SELECTION_KINDS)})`,
    ),
    check(
      "disc_selections_shape_check",
      sql`(${table.kind} = 'main_feature' and ${table.titleNumber} is null and ${table.chapterStart} is null and ${table.chapterEnd} is null) or (${table.kind} = 'dvd_title' and typeof(${table.titleNumber}) = 'integer' and ${table.titleNumber} > 0 and ${table.chapterStart} is null and ${table.chapterEnd} is null) or (${table.kind} = 'dvd_chapters' and typeof(${table.titleNumber}) = 'integer' and ${table.titleNumber} > 0 and typeof(${table.chapterStart}) = 'integer' and ${table.chapterStart} > 0 and typeof(${table.chapterEnd}) = 'integer' and ${table.chapterEnd} >= ${table.chapterStart})`,
    ),
  ],
);

export const discSelectionSupersessions = sqliteTable(
  "disc_selection_supersessions",
  {
    supersededDiscSelectionId: text("superseded_disc_selection_id")
      .$type<DiscSelectionId>()
      .notNull()
      .primaryKey()
      .references(() => discSelections.id, { onDelete: "restrict" }),
    replacementDiscSelectionId: text("replacement_disc_selection_id")
      .$type<DiscSelectionId>()
      .notNull()
      .references(() => discSelections.id, { onDelete: "restrict" }),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "disc_selection_supersessions_id_not_null",
      sql`${table.supersededDiscSelectionId} is not null`,
    ),
    uniqueIndex("disc_selection_supersessions_replacement_unique").on(
      table.replacementDiscSelectionId,
    ),
    check(
      "disc_selection_supersessions_distinct_selections_check",
      sql`${table.supersededDiscSelectionId} <> ${table.replacementDiscSelectionId}`,
    ),
  ],
);

export const encodingProfiles = sqliteTable(
  "encoding_profiles",
  {
    id: text("id").$type<EncodingProfileId>().notNull().primaryKey(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    mediaDomain: text("media_domain", { enum: MEDIA_DOMAINS }).notNull(),
    version: integer("version").notNull(),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(false),
    settings: text("settings", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("encoding_profiles_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("encoding_profiles_domain_key_version_unique").on(
      table.mediaDomain,
      table.key,
      table.version,
    ),
    uniqueIndex("encoding_profiles_one_active_version_unique")
      .on(table.mediaDomain, table.key)
      .where(sql`${table.isActive} = 1`),
    check(
      "encoding_profiles_domain_check",
      sql`${table.mediaDomain} in (${sqliteStringLiterals(MEDIA_DOMAINS)})`,
    ),
    check(
      "encoding_profiles_version_check",
      sql`typeof(${table.version}) = 'integer' and ${table.version} > 0`,
    ),
  ],
);

export const archiveJobs = sqliteTable(
  "archive_jobs",
  {
    id: text("id").$type<ArchiveJobId>().notNull().primaryKey(),
    archiveRequestId: text("archive_request_id")
      .$type<ArchiveRequestId>()
      .notNull()
      .references(() => archiveRequests.id, { onDelete: "restrict" }),
    discInspectionId: text("disc_inspection_id")
      .$type<DiscInspectionId>()
      .references(() => discInspections.id, { onDelete: "restrict" }),
    detectedDiscId: text("detected_disc_id")
      .$type<DetectedDiscId>()
      .notNull()
      .references(() => detectedDiscs.id, { onDelete: "restrict" }),
    originalDiscArchiveId: text("original_disc_archive_id")
      .$type<OriginalDiscArchiveId>()
      .references(() => originalDiscArchives.id, { onDelete: "restrict" }),
    attemptOrdinal: integer("attempt_ordinal").notNull(),
    status: text("status", { enum: ARCHIVE_JOB_STATUSES })
      .notNull()
      .default("running"),
    priority: integer("priority").notNull().default(0),
    progressPhase: text("progress_phase", {
      enum: ARCHIVE_RUNNING_PROGRESS_PHASES,
    })
      .notNull()
      .default("preparing"),
    progressPercent: integer("progress_percent").notNull().default(0),
    progressBytes: integer("progress_bytes").notNull().default(0),
    progressEtaSeconds: integer("progress_eta_seconds"),
    lastProgressAt: integer("last_progress_at", { mode: "timestamp_ms" })
      .notNull(),
    claimedBy: text("claimed_by"),
    claimToken: text("claim_token").$type<ArchiveJobClaimToken>(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    errorMessage: text("error_message"),
    failureDetailVersion: text("failure_detail_version", {
      enum: ARCHIVE_FAILURE_DETAIL_VERSIONS,
    }),
    readFailureStage: text("read_failure_stage", {
      enum: ARCHIVE_READ_FAILURE_STAGES,
    }).$type<ArchiveReadFailureStage>(),
    readFailureCategory: text("read_failure_category", {
      enum: ARCHIVE_READ_FAILURE_CATEGORIES,
    }).$type<ArchiveReadFailureCategory>(),
    readFailureClassifierVersion: text("read_failure_classifier_version"),
    readFailureLba: integer("read_failure_lba"),
    readFailureRequestedBlockCount: integer(
      "read_failure_requested_block_count",
    ),
    readFailureRetryCount: integer("read_failure_retry_count"),
    readFailureScsiStatus: integer("read_failure_scsi_status"),
    readFailureHostStatus: integer("read_failure_host_status"),
    readFailureDriverStatus: integer("read_failure_driver_status"),
    readFailureSenseKey: integer("read_failure_sense_key"),
    readFailureAsc: integer("read_failure_asc"),
    readFailureAscq: integer("read_failure_ascq"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("archive_jobs_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("archive_jobs_request_attempt_unique").on(
      table.archiveRequestId,
      table.attemptOrdinal,
    ),
    uniqueIndex("archive_jobs_running_request_unique")
      .on(table.archiveRequestId)
      .where(sql`${table.status} = 'running'`),
    index("archive_jobs_request_idx").on(
      table.archiveRequestId,
      table.attemptOrdinal,
    ),
    check(
      "archive_jobs_status_check",
      sql`${table.status} in (${sqliteStringLiterals(ARCHIVE_JOB_STATUSES)})`,
    ),
    check(
      "archive_jobs_progress_check",
      sql`${table.progressPercent} between 0 and 100`,
    ),
    check(
      "archive_jobs_progress_bytes_check",
      sql`typeof(${table.progressBytes}) = 'integer' and ${table.progressBytes} >= 0`,
    ),
    check(
      "archive_jobs_progress_eta_check",
      sql`${table.progressEtaSeconds} is null or (typeof(${table.progressEtaSeconds}) = 'integer' and ${table.progressEtaSeconds} >= 0)`,
    ),
    check(
      "archive_jobs_progress_phase_check",
      sql`${table.progressPhase} in (${sqliteStringLiterals(ARCHIVE_RUNNING_PROGRESS_PHASES)})`,
    ),
    check(
      "archive_jobs_attempt_ordinal_check",
      sql`typeof(${table.attemptOrdinal}) = 'integer' and ${table.attemptOrdinal} > 0`,
    ),
    check(
      "archive_jobs_attempt_shape_check",
      sql`(${table.status} = 'running' and ${table.claimedBy} is not null and ${table.claimToken} is not null and ${table.claimedAt} is not null and ${table.startedAt} is not null and ${table.completedAt} is null) or (${table.status} <> 'running' and ${table.startedAt} is not null and ${table.completedAt} is not null)`,
    ),
    check(
      "archive_jobs_failure_detail_version_check",
      sql`${table.failureDetailVersion} is null or (${table.status} = 'failed' and ${table.failureDetailVersion} in (${sqliteStringLiterals(ARCHIVE_FAILURE_DETAIL_VERSIONS)}))`,
    ),
    check(
      "archive_jobs_read_failure_shape_check",
      sql`(${table.readFailureCategory} is null and ${table.readFailureStage} is null and ${table.readFailureClassifierVersion} is null and ${table.readFailureLba} is null and ${table.readFailureRequestedBlockCount} is null and ${table.readFailureRetryCount} is null and ${table.readFailureScsiStatus} is null and ${table.readFailureHostStatus} is null and ${table.readFailureDriverStatus} is null and ${table.readFailureSenseKey} is null and ${table.readFailureAsc} is null and ${table.readFailureAscq} is null) or (${table.status} = 'failed' and ${table.readFailureStage} in (${sqliteStringLiterals(ARCHIVE_READ_FAILURE_STAGES)}) and ${table.readFailureCategory} in (${sqliteStringLiterals(ARCHIVE_READ_FAILURE_CATEGORIES)}) and typeof(${table.readFailureClassifierVersion}) = 'text' and length(${table.readFailureClassifierVersion}) between 1 and 128 and typeof(${table.readFailureLba}) = 'integer' and ${table.readFailureLba} >= 0 and typeof(${table.readFailureRequestedBlockCount}) = 'integer' and ${table.readFailureRequestedBlockCount} between 1 and 4294967295 and typeof(${table.readFailureRetryCount}) = 'integer' and ${table.readFailureRetryCount} between 0 and 4294967295 and (${table.readFailureScsiStatus} is null or (typeof(${table.readFailureScsiStatus}) = 'integer' and ${table.readFailureScsiStatus} between 0 and 255)) and (${table.readFailureHostStatus} is null or (typeof(${table.readFailureHostStatus}) = 'integer' and ${table.readFailureHostStatus} between 0 and 65535)) and (${table.readFailureDriverStatus} is null or (typeof(${table.readFailureDriverStatus}) = 'integer' and ${table.readFailureDriverStatus} between 0 and 65535)) and (${table.readFailureSenseKey} is null or (typeof(${table.readFailureSenseKey}) = 'integer' and ${table.readFailureSenseKey} between 0 and 15)) and (${table.readFailureAsc} is null or (typeof(${table.readFailureAsc}) = 'integer' and ${table.readFailureAsc} between 0 and 255)) and (${table.readFailureAscq} is null or (typeof(${table.readFailureAscq}) = 'integer' and ${table.readFailureAscq} between 0 and 255)) and ((${table.readFailureScsiStatus} is null and ${table.readFailureHostStatus} is null and ${table.readFailureDriverStatus} is null) or (${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null)) and ((${table.readFailureAsc} is null and ${table.readFailureAscq} is null) or (${table.readFailureAsc} is not null and ${table.readFailureAscq} is not null)))`,
    ),
    check(
      "archive_jobs_read_failure_category_evidence_check",
      sql`${table.readFailureCategory} is null or ${table.readFailureCategory} = 'unknown' or (${table.readFailureCategory} = 'not_ready' and ${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null and ${table.readFailureSenseKey} is not null and (${table.readFailureScsiStatus} & 254) = 2 and ${table.readFailureHostStatus} = 0 and (${table.readFailureDriverStatus} & 15) in (0, 8) and ${table.readFailureSenseKey} = 2 and ${table.readFailureAsc} is not null and ${table.readFailureAscq} is not null) or (${table.readFailureCategory} = 'unit_attention' and ${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null and ${table.readFailureSenseKey} is not null and (${table.readFailureScsiStatus} & 254) = 2 and ${table.readFailureHostStatus} = 0 and (${table.readFailureDriverStatus} & 15) in (0, 8) and ${table.readFailureSenseKey} = 6 and ${table.readFailureAsc} is not null and ${table.readFailureAscq} is not null) or (${table.readFailureCategory} = 'hardware_error' and ${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null and ${table.readFailureSenseKey} is not null and (${table.readFailureScsiStatus} & 254) = 2 and ${table.readFailureHostStatus} = 0 and (${table.readFailureDriverStatus} & 15) in (0, 8) and ${table.readFailureSenseKey} = 4 and ${table.readFailureAsc} is not null and ${table.readFailureAscq} is not null) or (${table.readFailureCategory} = 'transport_error' and ${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null and (${table.readFailureHostStatus} <> 0 or (${table.readFailureHostStatus} = 0 and (${table.readFailureDriverStatus} & 15) in (1, 2, 4, 6)))) or (${table.readFailureCategory} = 'protection_error' and ${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null and ${table.readFailureSenseKey} is not null and (${table.readFailureScsiStatus} & 254) = 2 and ${table.readFailureHostStatus} = 0 and (${table.readFailureDriverStatus} & 15) in (0, 8) and ${table.readFailureAsc} is not null and ${table.readFailureAscq} is not null and (${table.readFailureSenseKey} = 7 or (${table.readFailureSenseKey} = 5 and ${table.readFailureAsc} = 111))) or (${table.readFailureCategory} = 'out_of_range' and ${table.readFailureScsiStatus} is not null and ${table.readFailureHostStatus} is not null and ${table.readFailureDriverStatus} is not null and ${table.readFailureSenseKey} is not null and (${table.readFailureScsiStatus} & 254) = 2 and ${table.readFailureHostStatus} = 0 and (${table.readFailureDriverStatus} & 15) in (0, 8) and ${table.readFailureSenseKey} = 5 and ${table.readFailureAsc} = 33 and ${table.readFailureAscq} = 0)`,
    ),
  ],
);

export const encodeJobs = sqliteTable(
  "encode_jobs",
  {
    id: text("id").$type<EncodeJobId>().notNull().primaryKey(),
    predecessorEncodeJobId: text("predecessor_encode_job_id")
      .$type<EncodeJobId>()
      .references((): AnySQLiteColumn => encodeJobs.id, {
        onDelete: "restrict",
      }),
    discSelectionId: text("disc_selection_id")
      .$type<DiscSelectionId>()
      .notNull()
      .references(() => discSelections.id, { onDelete: "restrict" }),
    encodingProfileId: text("encoding_profile_id")
      .$type<EncodingProfileId>()
      .notNull()
      .references(() => encodingProfiles.id, { onDelete: "restrict" }),
    outputPath: text("output_path").notNull(),
    reservesOutputPath: integer("reserves_output_path", { mode: "boolean" })
      .notNull()
      .default(true),
    status: text("status", { enum: ENCODE_JOB_STATUSES })
      .notNull()
      .default("queued"),
    priority: integer("priority").notNull().default(0),
    replaceExistingOutput: integer("replace_existing_output", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    replacementOutputIdentity: text("replacement_output_identity")
      .$type<EncodeOutputFilesystemIdentity>(),
    partialCleanupOutputPath: text("partial_cleanup_output_path"),
    partialCleanupClaimToken: text("partial_cleanup_claim_token")
      .$type<EncodeJobClaimToken>(),
    partialCleanupLeaseToken: text("partial_cleanup_lease_token")
      .$type<EncodeJobCleanupClaimToken>(),
    publicationPending: integer("publication_pending", { mode: "boolean" })
      .notNull()
      .default(false),
    publicationCompletionPending: integer(
      "publication_completion_pending",
      { mode: "boolean" },
    )
      .notNull()
      .default(false),
    progressPhase: text("progress_phase", {
      enum: ENCODE_PROGRESS_PHASES,
    }),
    progressPercent: integer("progress_percent").notNull().default(0),
    progressEtaSeconds: integer("progress_eta_seconds"),
    claimedBy: text("claimed_by"),
    claimToken: text("claim_token").$type<EncodeJobClaimToken>(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    errorMessage: text("error_message"),
    verificationStatus: text("verification_status", {
      enum: FILESYSTEM_VERIFICATION_STATUSES,
    }),
    verificationMessage: text("verification_message"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("encode_jobs_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("encode_jobs_predecessor_unique")
      .on(table.predecessorEncodeJobId)
      .where(sql`${table.predecessorEncodeJobId} is not null`),
    uniqueIndex("encode_jobs_initial_selection_profile_unique")
      .on(table.discSelectionId, table.encodingProfileId)
      .where(sql`${table.predecessorEncodeJobId} is null`),
    uniqueIndex("encode_jobs_output_path_unique")
      .on(table.outputPath)
      .where(sql`${table.reservesOutputPath} = 1`),
    index("encode_jobs_queue_idx").on(table.status, table.priority, table.createdAt),
    check(
      "encode_jobs_status_check",
      sql`${table.status} in (${sqliteStringLiterals(ENCODE_JOB_STATUSES)})`,
    ),
    check(
      "encode_jobs_progress_check",
      sql`${table.progressPercent} between 0 and 100`,
    ),
    check(
      "encode_jobs_progress_phase_check",
      sql`${table.progressPhase} is null or ${table.progressPhase} in (${sqliteStringLiterals(ENCODE_PROGRESS_PHASES)})`,
    ),
    check(
      "encode_jobs_progress_eta_check",
      sql`${table.progressEtaSeconds} is null or (typeof(${table.progressEtaSeconds}) = 'integer' and ${table.progressEtaSeconds} >= 0)`,
    ),
    check(
      "encode_jobs_output_reservation_check",
      sql`${table.reservesOutputPath} = 1 or ${table.status} in ('cancellation_requested', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "encode_jobs_predecessor_distinct_check",
      sql`${table.predecessorEncodeJobId} is null or ${table.predecessorEncodeJobId} <> ${table.id}`,
    ),
    check(
      "encode_jobs_replacement_identity_check",
      sql`${table.replacementOutputIdentity} is null or ${table.replaceExistingOutput} = 1`,
    ),
    check(
      "encode_jobs_partial_cleanup_pair_check",
      sql`(${table.partialCleanupOutputPath} is null) = (${table.partialCleanupClaimToken} is null)`,
    ),
    check(
      "encode_jobs_publication_pending_cleanup_check",
      sql`${table.publicationPending} = 0 or ${table.partialCleanupClaimToken} is not null`,
    ),
    check(
      "encode_jobs_publication_completion_pending_check",
      sql`${table.publicationCompletionPending} = 0 or ${table.publicationPending} = 1`,
    ),
    check(
      "encode_jobs_partial_cleanup_lease_check",
      sql`${table.partialCleanupLeaseToken} is null or ${table.partialCleanupClaimToken} is not null`,
    ),
    check(
      "encode_jobs_verification_check",
      sql`(${table.verificationStatus} is null) = (${table.verificationMessage} is null) and (${table.verificationStatus} is null) = (${table.verifiedAt} is null) and (${table.verificationStatus} is null or ${table.verificationStatus} in (${sqliteStringLiterals(FILESYSTEM_VERIFICATION_STATUSES)}))`,
    ),
  ],
);

export const encodeJobFailureReports = sqliteTable(
  "encode_job_failure_reports",
  {
    id: text("id").$type<EncodeJobFailureReportId>().notNull().primaryKey(),
    encodeJobId: text("encode_job_id")
      .$type<EncodeJobId>()
      .notNull()
      .references(() => encodeJobs.id, { onDelete: "restrict" }),
    schemaVersion: integer("schema_version").notNull(),
    workerKind: text("worker_kind", { enum: ["encode_worker"] })
      .notNull()
      .default("encode_worker"),
    reasonCode: text("reason_code", {
      enum: ENCODE_JOB_FAILURE_REASON_CODES,
    }).notNull(),
    phase: text("phase", { enum: ENCODE_JOB_FAILURE_PHASES }).notNull(),
    retryability: text("retryability", {
      enum: ENCODE_JOB_FAILURE_RETRYABILITIES,
    }).notNull(),
    diagnostic: text("diagnostic"),
    exitStatus: integer("exit_status"),
    signal: text("signal", { enum: ENCODE_JOB_FAILURE_SIGNALS }),
    timeoutSeconds: integer("timeout_seconds"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("encode_job_failure_reports_id_not_null", sql`${table.id} is not null`),
    check(
      "encode_job_failure_reports_schema_version_check",
      sql`${table.schemaVersion} in (${sql.raw(ENCODE_JOB_FAILURE_REPORT_SCHEMA_VERSIONS.join(", "))})`,
    ),
    check(
      "encode_job_failure_reports_worker_kind_check",
      sql`${table.workerKind} = 'encode_worker'`,
    ),
    check(
      "encode_job_failure_reports_reason_code_check",
      sql`${table.reasonCode} in (${sqliteStringLiterals(ENCODE_JOB_FAILURE_REASON_CODES)})`,
    ),
    check(
      "encode_job_failure_reports_phase_check",
      sql`${table.phase} in (${sqliteStringLiterals(ENCODE_JOB_FAILURE_PHASES)})`,
    ),
    check(
      "encode_job_failure_reports_retryability_check",
      sql`${table.retryability} in (${sqliteStringLiterals(ENCODE_JOB_FAILURE_RETRYABILITIES)})`,
    ),
    check(
      "encode_job_failure_reports_diagnostic_check",
      sql`${table.diagnostic} is null or (typeof(${table.diagnostic}) = 'text' and length(${table.diagnostic}) between 1 and ${sql.raw(String(ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH))})`,
    ),
    check(
      "encode_job_failure_reports_evidence_check",
      sql`(${table.reasonCode} = 'command_failed' and ${table.timeoutSeconds} is null and ((typeof(${table.exitStatus}) = 'integer' and ${table.exitStatus} between 1 and 255 and ${table.signal} is null) or (${table.exitStatus} is null and ${table.signal} in (${sqliteStringLiterals(ENCODE_JOB_FAILURE_SIGNALS)})))) or (${table.reasonCode} = 'command_timeout' and ${table.exitStatus} is null and ${table.signal} is null and typeof(${table.timeoutSeconds}) = 'integer' and ${table.timeoutSeconds} between 1 and 604800)`,
    ),
    index("encode_job_failure_reports_job_occurred_idx").on(
      table.encodeJobId,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const retainedEncodeOutputs = sqliteTable(
  "retained_encode_outputs",
  {
    id: text("id").$type<RetainedEncodeOutputId>().notNull().primaryKey(),
    predecessorEncodeJobId: text("predecessor_encode_job_id")
      .$type<EncodeJobId>()
      .notNull()
      .references(() => encodeJobs.id, { onDelete: "restrict" }),
    replacementEncodeJobId: text("replacement_encode_job_id")
      .$type<EncodeJobId>()
      .notNull()
      .references(() => encodeJobs.id, { onDelete: "restrict" }),
    retainedOutputPath: text("retained_output_path").notNull(),
    filesystemIdentity: text("filesystem_identity")
      .$type<EncodeOutputFilesystemIdentity>()
      .notNull(),
    state: text("state", { enum: RETAINED_ENCODE_OUTPUT_STATES })
      .notNull()
      .default("retained"),
    cleanupEligible: integer("cleanup_eligible", { mode: "boolean" })
      .notNull()
      .default(true),
    retainedAt: integer("retained_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("retained_encode_outputs_id_not_null", sql`${table.id} is not null`),
    index("retained_encode_outputs_replacement_idx")
      .on(table.replacementEncodeJobId),
    uniqueIndex("retained_encode_outputs_path_unique")
      .on(table.retainedOutputPath),
    index("retained_encode_outputs_predecessor_idx")
      .on(table.predecessorEncodeJobId),
    check(
      "retained_encode_outputs_distinct_jobs_check",
      sql`${table.predecessorEncodeJobId} <> ${table.replacementEncodeJobId}`,
    ),
    check(
      "retained_encode_outputs_state_check",
      sql`${table.state} in (${sqliteStringLiterals(RETAINED_ENCODE_OUTPUT_STATES)})`,
    ),
    check(
      "retained_encode_outputs_cleanup_eligible_check",
      sql`${table.cleanupEligible} = 1`,
    ),
  ],
);

export const correctedEncodePublicationAuthorities = sqliteTable(
  "corrected_encode_publication_authorities",
  {
    replacementEncodeJobId: text("replacement_encode_job_id")
      .$type<EncodeJobId>()
      .notNull()
      .primaryKey()
      .references(() => encodeJobs.id, { onDelete: "restrict" }),
    claimToken: text("claim_token").$type<EncodeJobClaimToken>().notNull(),
    retainedOutputPath: text("retained_output_path").notNull(),
    filesystemIdentity: text("filesystem_identity")
      .$type<EncodeOutputFilesystemIdentity>()
      .notNull(),
  },
  (table) => [
    check(
      "corrected_encode_publication_authorities_id_not_null",
      sql`${table.replacementEncodeJobId} is not null`,
    ),
    uniqueIndex("corrected_encode_publication_authorities_path_unique")
      .on(table.retainedOutputPath),
  ],
);

export const workerIncidents = sqliteTable(
  "worker_incidents",
  {
    id: text("id").$type<WorkerIncidentId>().notNull().primaryKey(),
    schemaVersion: integer("schema_version")
      .$type<WorkerIncidentSchemaVersion>()
      .notNull(),
    workerKind: text("worker_kind", { enum: WORKER_KINDS }).notNull(),
    reasonCode: text("reason_code", {
      enum: WORKER_INCIDENT_REASON_CODES,
    }).notNull(),
    phase: text("phase", { enum: WORKER_INCIDENT_PHASES }).notNull(),
    retryability: text("retryability", {
      enum: WORKER_INCIDENT_RETRYABILITIES,
    }).notNull(),
    evidence: text("evidence", { mode: "json" })
      .$type<WorkerIncidentEvidence>()
      .notNull(),
    firstObservedAt: integer("first_observed_at", {
      mode: "timestamp_ms",
    }).notNull(),
    lastObservedAt: integer("last_observed_at", {
      mode: "timestamp_ms",
    }).notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check("worker_incidents_id_not_null", sql`${table.id} is not null`),
    check(
      "worker_incidents_schema_version_check",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "worker_incidents_worker_kind_check",
      sql`${table.workerKind} in (${sqliteStringLiterals(WORKER_KINDS)})`,
    ),
    check(
      "worker_incidents_reason_code_check",
      sql`${table.reasonCode} in (${sqliteStringLiterals(WORKER_INCIDENT_REASON_CODES)})`,
    ),
    check(
      "worker_incidents_phase_check",
      sql`${table.phase} in (${sqliteStringLiterals(WORKER_INCIDENT_PHASES)})`,
    ),
    check(
      "worker_incidents_retryability_check",
      sql`${table.retryability} in (${sqliteStringLiterals(WORKER_INCIDENT_RETRYABILITIES)})`,
    ),
    check(
      "worker_incidents_occurrence_count_check",
      sql`typeof(${table.occurrenceCount}) = 'integer' and ${table.occurrenceCount} > 0`,
    ),
    check(
      "worker_incidents_observation_order_check",
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`,
    ),
    check(
      "worker_incidents_resolution_order_check",
      sql`${table.resolvedAt} is null or ${table.resolvedAt} >= ${table.lastObservedAt}`,
    ),
    uniqueIndex("worker_incidents_active_identity_unique")
      .on(table.workerKind, table.reasonCode, table.phase, table.evidence)
      .where(sql`${table.resolvedAt} is null`),
    index("worker_incidents_worker_activity_idx").on(
      table.workerKind,
      table.resolvedAt,
      table.lastObservedAt,
    ),
  ],
);
