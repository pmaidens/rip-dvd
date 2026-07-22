import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
  DETECTED_DISC_STATUSES,
  DISC_KINDS,
  DISC_SELECTION_KINDS,
  JOB_STATUSES,
  MEDIA_DOMAINS,
  MEDIA_ITEM_KINDS,
} from "../domain-values.js";
import type {
  ArchiveJobId,
  ArchiveJobClaimToken,
  DetectedDiscId,
  DiscSelectionId,
  EncodeJobId,
  EncodeJobClaimToken,
  EncodingProfileId,
  MediaItemId,
  OpticalDriveId,
  OriginalDiscArchiveId,
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
    isPresent: integer("is_present", { mode: "boolean" })
      .notNull()
      .default(true),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("optical_drives_device_path_unique").on(table.devicePath),
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

export const originalDiscArchives = sqliteTable(
  "original_disc_archives",
  {
    id: text("id").$type<OriginalDiscArchiveId>().notNull().primaryKey(),
    detectedDiscId: text("detected_disc_id")
      .$type<DetectedDiscId>()
      .notNull()
      .references(() => detectedDiscs.id, { onDelete: "restrict" }),
    discKind: text("disc_kind", { enum: DISC_KINDS }).notNull(),
    archiveFormat: text("archive_format", { enum: ["iso"] }).notNull(),
    archivePath: text("archive_path").notNull(),
    fingerprint: text("fingerprint").notNull(),
    sizeBytes: integer("size_bytes"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }).notNull(),
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
      sql`${table.archiveFormat} in ('iso')`,
    ),
    check(
      "original_disc_archives_size_check",
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("disc_selections_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("disc_selections_archive_source_unique").on(
      table.originalDiscArchiveId,
      table.sourceKey,
    ),
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

export const encodingProfiles = sqliteTable(
  "encoding_profiles",
  {
    id: text("id").$type<EncodingProfileId>().notNull().primaryKey(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    mediaDomain: text("media_domain", { enum: MEDIA_DOMAINS }).notNull(),
    version: integer("version").notNull(),
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
    check(
      "encoding_profiles_domain_check",
      sql`${table.mediaDomain} in (${sqliteStringLiterals(MEDIA_DOMAINS)})`,
    ),
    check("encoding_profiles_version_check", sql`${table.version} > 0`),
  ],
);

export const archiveJobs = sqliteTable(
  "archive_jobs",
  {
    id: text("id").$type<ArchiveJobId>().notNull().primaryKey(),
    detectedDiscId: text("detected_disc_id")
      .$type<DetectedDiscId>()
      .notNull()
      .references(() => detectedDiscs.id, { onDelete: "restrict" }),
    originalDiscArchiveId: text("original_disc_archive_id")
      .$type<OriginalDiscArchiveId>()
      .references(() => originalDiscArchives.id, { onDelete: "restrict" }),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    progressPercent: integer("progress_percent").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimToken: text("claim_token").$type<ArchiveJobClaimToken>(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("archive_jobs_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("archive_jobs_detected_disc_unique").on(table.detectedDiscId),
    index("archive_jobs_queue_idx").on(table.status, table.priority, table.createdAt),
    check(
      "archive_jobs_status_check",
      sql`${table.status} in (${sqliteStringLiterals(JOB_STATUSES)})`,
    ),
    check(
      "archive_jobs_progress_check",
      sql`${table.progressPercent} between 0 and 100`,
    ),
  ],
);

export const encodeJobs = sqliteTable(
  "encode_jobs",
  {
    id: text("id").$type<EncodeJobId>().notNull().primaryKey(),
    discSelectionId: text("disc_selection_id")
      .$type<DiscSelectionId>()
      .notNull()
      .references(() => discSelections.id, { onDelete: "restrict" }),
    encodingProfileId: text("encoding_profile_id")
      .$type<EncodingProfileId>()
      .notNull()
      .references(() => encodingProfiles.id, { onDelete: "restrict" }),
    outputPath: text("output_path").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    progressPercent: integer("progress_percent").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimToken: text("claim_token").$type<EncodeJobClaimToken>(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("encode_jobs_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("encode_jobs_selection_profile_unique").on(
      table.discSelectionId,
      table.encodingProfileId,
    ),
    uniqueIndex("encode_jobs_output_path_unique").on(table.outputPath),
    index("encode_jobs_queue_idx").on(table.status, table.priority, table.createdAt),
    check(
      "encode_jobs_status_check",
      sql`${table.status} in (${sqliteStringLiterals(JOB_STATUSES)})`,
    ),
    check(
      "encode_jobs_progress_check",
      sql`${table.progressPercent} between 0 and 100`,
    ),
  ],
);
