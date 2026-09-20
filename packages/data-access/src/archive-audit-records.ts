import { DatabaseSync } from "node:sqlite";

export const ARCHIVE_AUDIT_DEFAULT_RECORD_LIMIT = 100;
export const ARCHIVE_AUDIT_MAX_RECORD_LIMIT = 1_000;
export const ARCHIVE_AUDIT_MAX_PATH_BYTES = 4_096;

const MAX_DOMAIN_ID_BYTES = 128;
const MAX_MEDIA_GENERATION_BYTES = 64;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface ArchiveAuditRecord {
  archiveId: string;
  detectedDiscId: string;
  opticalDriveId: string;
  discInspectionId: string | null;
  mediaGeneration: string | null;
  discInspectionCapacityBytes: number | null;
  archivePath: string | null;
  archivePathRejected: boolean;
  recordedSizeBytes: number | null;
  reportedBoundarySizeBytes: number | null;
  publishedBoundarySizeBytes: number | null;
  archivedAt: Date;
}

export interface ArchiveAuditRecordPage {
  records: readonly ArchiveAuditRecord[];
  truncated: boolean;
}

interface ArchiveAuditRow {
  archive_id: unknown;
  archive_id_too_long: unknown;
  detected_disc_id: unknown;
  detected_disc_id_too_long: unknown;
  optical_drive_id: unknown;
  optical_drive_id_too_long: unknown;
  record_relationship_invalid: unknown;
  disc_inspection_id: unknown;
  disc_inspection_id_too_long: unknown;
  media_generation: unknown;
  media_generation_too_long: unknown;
  disc_inspection_capacity_bytes: unknown;
  archive_path: unknown;
  archive_path_rejected: unknown;
  recorded_size_bytes: unknown;
  reported_boundary_size_bytes: unknown;
  published_boundary_size_bytes: unknown;
  archived_at: unknown;
}

function requireLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ARCHIVE_AUDIT_MAX_RECORD_LIMIT
  ) {
    throw new TypeError(
      `Archive audit limit must be between 1 and ${ARCHIVE_AUDIT_MAX_RECORD_LIMIT}`,
    );
  }
  return limit;
}

function requireBoundedText(
  value: unknown,
  tooLong: unknown,
  field: string,
): string {
  if (tooLong !== 0 || typeof value !== "string" || value.length === 0) {
    throw new Error(`Archive audit ${field} is invalid`);
  }
  return value;
}

function nullableBoundedText(
  value: unknown,
  tooLong: unknown,
  field: string,
): string | null {
  if (value === null && tooLong === 0) {
    return null;
  }
  return requireBoundedText(value, tooLong, field);
}

function nullableSize(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Archive audit ${field} is invalid`);
  }
  return value as number;
}

function archiveAuditRecordFromRow(row: ArchiveAuditRow): ArchiveAuditRecord {
  if (row.record_relationship_invalid !== 0) {
    throw new Error("Archive audit catalog relationship is invalid");
  }
  if (!Number.isSafeInteger(row.archived_at)) {
    throw new Error("Archive audit archived time is invalid");
  }
  const archivedAt = new Date(row.archived_at as number);
  if (!Number.isFinite(archivedAt.getTime())) {
    throw new Error("Archive audit archived time is invalid");
  }
  const archivePathRejected = row.archive_path_rejected === 1;
  if (
    (!archivePathRejected && typeof row.archive_path !== "string") ||
    (archivePathRejected && row.archive_path !== null)
  ) {
    throw new Error("Archive audit path is invalid");
  }
  return {
    archiveId: requireBoundedText(
      row.archive_id,
      row.archive_id_too_long,
      "archive identity",
    ),
    detectedDiscId: requireBoundedText(
      row.detected_disc_id,
      row.detected_disc_id_too_long,
      "Detected Disc identity",
    ),
    opticalDriveId: requireBoundedText(
      row.optical_drive_id,
      row.optical_drive_id_too_long,
      "Optical Drive identity",
    ),
    discInspectionId: nullableBoundedText(
      row.disc_inspection_id,
      row.disc_inspection_id_too_long,
      "Disc Inspection identity",
    ),
    mediaGeneration: nullableBoundedText(
      row.media_generation,
      row.media_generation_too_long,
      "media generation",
    ),
    discInspectionCapacityBytes: nullableSize(
      row.disc_inspection_capacity_bytes,
      "Disc Inspection capacity",
    ),
    archivePath: archivePathRejected ? null : row.archive_path as string,
    archivePathRejected,
    recordedSizeBytes: nullableSize(row.recorded_size_bytes, "recorded size"),
    reportedBoundarySizeBytes: nullableSize(
      row.reported_boundary_size_bytes,
      "reported boundary size",
    ),
    publishedBoundarySizeBytes: nullableSize(
      row.published_boundary_size_bytes,
      "published boundary size",
    ),
    archivedAt,
  };
}

export function readArchiveAuditRecords(
  databasePath: string,
  limit = ARCHIVE_AUDIT_DEFAULT_RECORD_LIMIT,
): ArchiveAuditRecordPage {
  const boundedLimit = requireLimit(limit);
  if (databasePath.trim() === "" || databasePath === ":memory:") {
    throw new TypeError("Archive audit database path must name an existing file");
  }

  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    sqlite.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    sqlite.exec("PRAGMA query_only = ON");
    sqlite.exec("PRAGMA trusted_schema = OFF");
    const rows = sqlite.prepare(`
      with bounded_archives as materialized (
        select
          substr(archive.id, 1, ${MAX_DOMAIN_ID_BYTES + 1}) as archive_id,
          length(cast(archive.id as blob)) > ${MAX_DOMAIN_ID_BYTES}
            as archive_id_too_long,
          substr(archive.detected_disc_id, 1, ${MAX_DOMAIN_ID_BYTES + 1})
            as detected_disc_id,
          length(cast(archive.detected_disc_id as blob)) > ${MAX_DOMAIN_ID_BYTES}
            as detected_disc_id_too_long,
          substr(disc.optical_drive_id, 1, ${MAX_DOMAIN_ID_BYTES + 1})
            as optical_drive_id,
          length(cast(disc.optical_drive_id as blob)) > ${MAX_DOMAIN_ID_BYTES}
            as optical_drive_id_too_long,
          (disc.id is null or drive.id is null) as record_relationship_invalid,
          substr(inspection.id, 1, ${MAX_DOMAIN_ID_BYTES + 1})
            as disc_inspection_id,
          coalesce(
            length(cast(inspection.id as blob)) > ${MAX_DOMAIN_ID_BYTES},
            0
          ) as disc_inspection_id_too_long,
          substr(inspection.media_generation, 1, ${MAX_MEDIA_GENERATION_BYTES + 1})
            as media_generation,
          coalesce(
            length(cast(inspection.media_generation as blob)) > ${MAX_MEDIA_GENERATION_BYTES},
            0
          ) as media_generation_too_long,
          inspection.media_capacity_bytes as disc_inspection_capacity_bytes,
          case
            when length(cast(archive.archive_path as blob)) between 1 and ${ARCHIVE_AUDIT_MAX_PATH_BYTES}
              then archive.archive_path
            else null
          end as archive_path,
          length(cast(archive.archive_path as blob)) not between 1 and ${ARCHIVE_AUDIT_MAX_PATH_BYTES}
            as archive_path_rejected,
          archive.size_bytes as recorded_size_bytes,
          archive.boundary_reported_size_bytes as reported_boundary_size_bytes,
          archive.boundary_published_size_bytes as published_boundary_size_bytes,
          archive.archived_at
        from original_disc_archives as archive
        left join detected_discs as disc on disc.id = archive.detected_disc_id
        left join optical_drives as drive on drive.id = disc.optical_drive_id
        left join archive_jobs as publication_job on publication_job.id = (
          select candidate.id
          from archive_jobs as candidate
          where
            candidate.original_disc_archive_id = archive.id
            and candidate.status = 'completed'
          order by candidate.completed_at desc, candidate.id desc
          limit 1
        )
        left join disc_inspections as inspection
          on inspection.id = publication_job.disc_inspection_id
        where archive.disc_kind = 'dvd' and archive.archive_format = 'iso'
        order by archive.archived_at asc, archive.id asc
        limit ?
      )
      select archive.*
      from bounded_archives as archive
      order by archive.archived_at asc, archive.archive_id asc
    `).all(boundedLimit + 1) as unknown as ArchiveAuditRow[];
    return {
      records: rows.slice(0, boundedLimit).map(archiveAuditRecordFromRow),
      truncated: rows.length > boundedLimit,
    };
  } finally {
    sqlite.close();
  }
}
