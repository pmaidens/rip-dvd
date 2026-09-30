import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import {
  createDataAccess,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  createDvdArchiveRecoveryReadEvidenceDigest,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  DvdRecoveryEvidenceAdmissionClosedError,
  type ArchiveJobId,
  type ArchiveRequestId,
  type DetectedDiscId,
  type EncodeJobId,
  type OriginalDiscArchiveId,
} from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";
import {
  boundedSettlingMigration,
  createPreBoundedDiscSettlingProductionFixture,
} from "../test/production-migration-fixture.mjs";

const migrationsRoot = new URL("../drizzle/", import.meta.url);
const publishedBoundedSettlingHash =
  "82bfd1781e0a8b50c348cbd59e7042704bf32473a971c8ce3fdb72e8a48d5c98";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createDatabasePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "rip-dvd.sqlite");
}

function createMigrationsThrough(lastMigration: string): string {
  const migrationsFolder = mkdtempSync(
    join(tmpdir(), "rip-dvd-migration-subset-"),
  );
  temporaryDirectories.push(migrationsFolder);
  const migrationNames = readdirSync(migrationsRoot)
    .filter((name) => /^\d/.test(name) && name <= lastMigration)
    .sort();
  for (const migrationName of migrationNames) {
    const destination = join(migrationsFolder, migrationName);
    mkdirSync(destination);
    copyFileSync(
      new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
      join(destination, "migration.sql"),
    );
  }
  return migrationsFolder;
}

function seedEncodeJob(
  databasePath: string,
  key: string,
) {
  const sqlite = new DatabaseSync(databasePath);
  const ids = {
    archive: `${key}-archive`,
    disc: `${key}-disc`,
    drive: `${key}-drive`,
    item: `${key}-item`,
    job: `${key}-job`,
    profile: `${key}-profile`,
    selection: `${key}-selection`,
  };
  sqlite.prepare(`
    INSERT INTO optical_drives (
      id, device_path, is_present, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, 1, 1, 1, 1)
  `).run(ids.drive, `/dev/${key}`);
  sqlite.prepare(`
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
      created_at, updated_at
    ) VALUES (?, ?, 'dvd', ?, 'archived', 1, 1, 1)
  `).run(ids.disc, ids.drive, `${key}-fingerprint`);
  sqlite.prepare(`
    INSERT INTO original_disc_archives (
      id, detected_disc_id, disc_kind, archive_format, archive_path,
      fingerprint, size_bytes, boundary_policy_version,
      boundary_reported_size_bytes, boundary_published_size_bytes,
      boundary_excluded_sector_count, archived_at, catalog_reviewed_at,
      catalog_review_outcome, created_at, updated_at
    ) VALUES (
      ?, ?, 'dvd', 'iso', ?, ?, 2048, 'dvd-archive-boundary-v1',
      2048, 2048, 0, 1, 1, 'reviewed_with_selections', 1, 1
    )
  `).run(
    ids.archive,
    ids.disc,
    `/originals/${key}.iso`,
    `${key}-fingerprint`,
  );
  sqlite.prepare(`
    INSERT INTO media_items (id, kind, title, created_at, updated_at)
    VALUES (?, 'movie', ?, 1, 1)
  `).run(ids.item, key);
  sqlite.prepare(`
    INSERT INTO disc_selections (
      id, original_disc_archive_id, media_item_id, source_key, kind,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'dvd:main-feature', 'main_feature', 1, 1)
  `).run(ids.selection, ids.archive, ids.item);
  sqlite.prepare(`
    INSERT INTO encoding_profiles (
      id, key, display_name, media_domain, version, is_active, settings,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'dvd_video', 1, 1, ?, 1, 1)
  `).run(
    ids.profile,
    key,
    key,
    JSON.stringify({ preset: "Fast 480p30" }),
  );
  sqlite.prepare(`
    INSERT INTO encode_jobs (
      id, disc_selection_id, encoding_profile_id, output_path, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 1, 1)
  `).run(
    ids.job,
    ids.selection,
    ids.profile,
    `/media/${key}.mkv`,
  );
  sqlite.close();
  return { id: ids.job as EncodeJobId };
}

function readApplicationSchema(sqlite: DatabaseSync): unknown[] {
  return sqlite
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'
      ORDER BY type, name
    `)
    .all();
}

function createProductionShapedDatabase(): string {
  const databasePath = createDatabasePath("rip-dvd-production-migration-");
  createPreBoundedDiscSettlingProductionFixture({
    databasePath,
    migrationsRoot,
  });
  const sqlite = new DatabaseSync(databasePath);
  expect(
    sqlite.prepare("SELECT name FROM pragma_table_info('disc_inspections')").all(),
  ).not.toEqual(expect.arrayContaining([
    { name: "media_capacity_bytes" },
    { name: "stable_observation_count" },
    { name: "settling_quiet_window_started_at" },
    { name: "settling_started_at" },
    { name: "settling_reset_count" },
  ]));
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  sqlite.close();
  return databasePath;
}

it("migrates the production pre-bounded Disc Inspection schema", () => {
  const databasePath = createProductionShapedDatabase();

  const access = createDataAccess({ databasePath });

  expect(access.discInspections.list()).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "fixture-running-inspection",
      status: "running",
      phase: "reading_metadata",
      attemptCount: 2,
      consecutiveFailureCount: 1,
      volumeLabel: "FIXTURE_RUNNING",
      mediaCapacityBytes: null,
      stableObservationCount: null,
      settlingQuietWindowStartedAt: null,
      settlingStartedAt: null,
      settlingResetCount: null,
      settlingBaselineCapacityBytes: null,
    }),
    expect.objectContaining({
      id: "fixture-completed-inspection",
      detectedDiscId: "fixture-completed-disc",
      status: "completed",
      phase: "confirming_media",
      volumeLabel: "FIXTURE_COMPLETED",
      totalBytes: 204_800,
      bytesHashed: 204_800,
    }),
  ]));
  access.close();

  const sqlite = new DatabaseSync(databasePath);
  expect(
    sqlite.prepare("SELECT name FROM pragma_table_info('disc_inspections')").all(),
  ).toEqual(expect.arrayContaining([
    { name: "media_capacity_bytes" },
    { name: "stable_observation_count" },
    { name: "settling_quiet_window_started_at" },
    { name: "settling_started_at" },
    { name: "settling_reset_count" },
    { name: "settling_baseline_capacity_bytes" },
  ]));
  expect(
    sqlite.prepare("SELECT count(*) AS count FROM disc_inspections").get(),
  ).toEqual({ count: 2 });
  expect(
    sqlite.prepare("SELECT count(*) AS count FROM disc_inspection_attempts").get(),
  ).toEqual({ count: 2 });
  const attemptTable = sqlite
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'disc_inspection_attempts'
    `)
    .get() as { sql: string };
  expect(attemptTable.sql).toContain(
    "phase\" in ('settling', 'reading_metadata', 'hashing_content', 'confirming_media', 'retry_wait')",
  );
  expect(
    sqlite.prepare("SELECT name FROM pragma_index_list('disc_inspections')").all(),
  ).toEqual(expect.arrayContaining([
    { name: "disc_inspections_current_drive_unique" },
    { name: "disc_inspections_status_idx" },
  ]));
  expect(
    sqlite
      .prepare("SELECT name FROM pragma_index_list('disc_inspection_attempts')")
      .all(),
  ).toEqual(expect.arrayContaining([
    { name: "disc_inspection_attempts_number_unique" },
  ]));
  expect(
    sqlite
      .prepare(`
        SELECT "table", "from", "to", on_delete
        FROM pragma_foreign_key_list('disc_inspection_attempts')
      `)
      .all(),
  ).toEqual([
    {
      table: "disc_inspections",
      from: "disc_inspection_id",
      to: "id",
      on_delete: "RESTRICT",
    },
  ]);
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(sqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  expect(
    sqlite.prepare(
      "SELECT count(*) AS count FROM __drizzle_migrations WHERE name = ?",
    ).get(boundedSettlingMigration),
  ).toEqual({ count: 1 });
  const migratedSchema = readApplicationSchema(sqlite);
  sqlite.close();

  const freshDatabasePath = createDatabasePath("rip-dvd-fresh-migration-");
  const freshAccess = createDataAccess({ databasePath: freshDatabasePath });
  freshAccess.close();
  const freshSqlite = new DatabaseSync(freshDatabasePath);
  expect(migratedSchema).toEqual(readApplicationSchema(freshSqlite));
  freshSqlite.close();
});

it("keeps the fresh and published bounded migration paths intact", () => {
  const databasePath = createDatabasePath("rip-dvd-bounded-migration-");
  const boundedMigrationsFolder = createMigrationsThrough(
    boundedSettlingMigration,
  );
  const boundedAccess = createDataAccess({
    databasePath,
    migrationsFolder: boundedMigrationsFolder,
  });
  const drive = boundedAccess.catalog.upsertOpticalDrive({
    devicePath: "/dev/fixture-bounded",
    isEnabled: true,
    isPresent: true,
  });
  const started = boundedAccess.discInspections.beginOrResume({
    opticalDriveId: drive.id,
    mediaGeneration: "fixture-bounded-generation",
    mediaCapacityBytes: null,
  });
  expect(started.inspection).toMatchObject({
    phase: "settling",
    stableObservationCount: 0,
    settlingBaselineCapacityBytes: null,
  });
  boundedAccess.close();

  const publishedSqlite = new DatabaseSync(databasePath);
  publishedSqlite
    .prepare("UPDATE __drizzle_migrations SET hash = ? WHERE name = ?")
    .run(publishedBoundedSettlingHash, boundedSettlingMigration);
  publishedSqlite.close();

  const currentAccess = createDataAccess({ databasePath });
  expect(
    currentAccess.discInspections.list({ ids: [started.inspection.id] }),
  ).toEqual([
    expect.objectContaining({
      id: started.inspection.id,
      phase: "settling",
      mediaGeneration: "fixture-bounded-generation",
      stableObservationCount: 0,
      settlingBaselineCapacityBytes: null,
    }),
  ]);
  currentAccess.close();

  const sqlite = new DatabaseSync(databasePath);
  expect(
    sqlite.prepare(
      "SELECT hash FROM __drizzle_migrations WHERE name = ?",
    ).get(boundedSettlingMigration),
  ).toEqual({ hash: publishedBoundedSettlingHash });
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(sqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  sqlite.close();
});

it("migrates historical Original Disc Archives with null boundary evidence", () => {
  const databasePath = createDatabasePath("rip-dvd-boundary-migration-");
  const previousMigrations = createMigrationsThrough(
    "20260822201215_thick_madame_web",
  );
  const previousAccess = createDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();

  const historicalSqlite = new DatabaseSync(databasePath);
  historicalSqlite.exec(`
    INSERT INTO optical_drives (
      id, device_path, is_enabled, configuration_default_resolved,
      is_configured_target, is_present, last_seen_at, created_at, updated_at
    ) VALUES (
      'historical-drive', '/dev/historical', 0, 1, 0, 0, 1, 1, 1
    );
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status,
      detected_at, created_at, updated_at
    ) VALUES (
      'historical-disc', 'historical-drive', 'dvd',
      'historical-boundary-fingerprint', 'archived', 1, 1, 1
    );
    INSERT INTO original_disc_archives (
      id, detected_disc_id, disc_kind, archive_format, archive_path,
      fingerprint, size_bytes, archived_at, created_at, updated_at
    ) VALUES (
      'historical-archive', 'historical-disc', 'dvd', 'iso',
      '/media/originals/historical.iso', 'historical-boundary-fingerprint',
      2048, 1, 1, 1
    );
  `);
  historicalSqlite.close();

  const migratedAccess = createDataAccess({ databasePath });
  expect(migratedAccess.catalog.listOriginalDiscArchives()).toEqual([
    expect.objectContaining({
      id: "historical-archive",
      sizeBytes: 2_048,
      boundaryPolicyVersion: null,
      boundaryReportedSizeBytes: null,
      boundaryPublishedSizeBytes: null,
      boundaryExcludedSectorCount: null,
      boundaryFirstExcludedLba: null,
      boundaryMaximumReferencedLba: null,
      boundaryReadFailureClassifierVersion: null,
      boundaryReadFailureScsiStatus: null,
      boundaryReadFailureHostStatus: null,
      boundaryReadFailureDriverStatus: null,
      boundaryReadFailureSenseResponseCode: null,
      boundaryReadFailureSenseKey: null,
      boundaryReadFailureAsc: null,
      boundaryReadFailureAscq: null,
    }),
  ]);
  migratedAccess.close();

  const migratedSqlite = new DatabaseSync(databasePath);
  expect(migratedSqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(migratedSqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  migratedSqlite.close();
});

it("preserves archive history while adding nullable Re-archive lineage", () => {
  const databasePath = createDatabasePath("rip-dvd-rearchive-migration-");
  const previousMigrations = createMigrationsThrough(
    "20260922161825_operation-detail-lookups",
  );
  const previousAccess = createDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();
  const historical = new DatabaseSync(databasePath);
  historical.exec(`
    INSERT INTO optical_drives (
      id, device_path, is_enabled, configuration_default_resolved,
      is_configured_target, is_present, last_seen_at, created_at, updated_at
    ) VALUES (
      'rearchive-migration-drive', '/dev/rearchive-migration', 0, 1,
      0, 0, 1, 1, 1
    );
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status,
      detected_at, created_at, updated_at
    ) VALUES (
      'rearchive-migration-disc', 'rearchive-migration-drive', 'dvd',
      'synthetic-rearchive-migration', 'archived', 1, 1, 1
    );
    INSERT INTO archive_requests (
      id, detected_disc_id, status, priority, fulfilled_at,
      created_at, updated_at
    ) VALUES (
      'rearchive-migration-request', 'rearchive-migration-disc',
      'fulfilled', 0, 1, 1, 1
    );
    INSERT INTO original_disc_archives (
      id, detected_disc_id, disc_kind, archive_format, archive_path,
      fingerprint, size_bytes, archived_at, created_at, updated_at
    ) VALUES (
      'rearchive-migration-archive', 'rearchive-migration-disc', 'dvd', 'iso',
      '/originals/synthetic-rearchive-migration.iso',
      'synthetic-rearchive-migration', NULL, 1, 1, 1
    );
  `);
  historical.close();

  const migratedAccess = createDataAccess({ databasePath });
  expect(migratedAccess.archiveRequests.find(
    "rearchive-migration-request" as never,
  )).toMatchObject({
    id: "rearchive-migration-request",
    rearchiveSourceArchiveId: null,
    status: "fulfilled",
  });
  expect(migratedAccess.catalog.listOriginalDiscArchives({
    ids: ["rearchive-migration-archive" as never],
  })).toEqual([
    expect.objectContaining({
      id: "rearchive-migration-archive",
      rearchiveSourceArchiveId: null,
      archivePath: "/originals/synthetic-rearchive-migration.iso",
      sizeBytes: null,
    }),
  ]);
  migratedAccess.close();

  const sqlite = new DatabaseSync(databasePath);
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(sqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  expect(
    sqlite.prepare(
      "SELECT name, \"unique\" FROM pragma_index_list('original_disc_archives') ORDER BY name",
    ).all(),
  ).toEqual(expect.arrayContaining([
    { name: "original_disc_archives_detected_disc_idx", unique: 0 },
    { name: "original_disc_archives_detected_disc_unique", unique: 1 },
    { name: "original_disc_archives_fingerprint_idx", unique: 0 },
    { name: "original_disc_archives_fingerprint_unique", unique: 1 },
    { name: "original_disc_archives_path_unique", unique: 1 },
    { name: "original_disc_archives_rearchive_source_idx", unique: 0 },
  ]));
  expect(
    sqlite.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE name IN (
        'original_disc_archives_detected_disc_unique',
        'original_disc_archives_fingerprint_unique'
      )
      ORDER BY name
    `).all(),
  ).toEqual([
    { sql: expect.stringMatching(/WHERE .*rearchive_source_archive_id.*is null/i) },
    { sql: expect.stringMatching(/WHERE .*rearchive_source_archive_id.*is null/i) },
  ]);
  sqlite.close();
});

it("backfills retained Encode Output ownership from durable insertion order", () => {
  const databasePath = createDatabasePath("rip-dvd-retained-owner-migration-");
  const previousMigrations = createMigrationsThrough(
    "20260922212838_modern_khan",
  );
  const previousAccess = createDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();
  const predecessor = seedEncodeJob(databasePath, "retained-owner-predecessor");
  const replacement = seedEncodeJob(databasePath, "retained-owner-replacement");
  const changedPathPredecessor = seedEncodeJob(
    databasePath,
    "changed-path-owner-predecessor",
  );
  const changedPathReplacement = seedEncodeJob(
    databasePath,
    "changed-path-owner-replacement",
  );
  const historical = new DatabaseSync(databasePath);
  historical.prepare(`
    UPDATE encode_jobs
    SET predecessor_encode_job_id = ?, output_path = ?
    WHERE id = ?
  `).run(predecessor.id, "/media/shared-retained-owner.mkv", replacement.id);
  historical.prepare(`
    UPDATE encode_jobs
    SET output_path = ?, status = 'completed', completed_at = 2,
      reserves_output_path = 0
    WHERE id = ?
  `).run("/media/shared-retained-owner.mkv", predecessor.id);
  historical.prepare(`
    UPDATE encode_jobs SET predecessor_encode_job_id = ? WHERE id = ?
  `).run(changedPathPredecessor.id, changedPathReplacement.id);
  historical.prepare(`
    UPDATE encode_jobs SET status = 'completed', completed_at = 2 WHERE id = ?
  `).run(changedPathPredecessor.id);
  const insert = historical.prepare(`
    INSERT INTO retained_encode_outputs (
      id, predecessor_encode_job_id, replacement_encode_job_id,
      retained_output_path, filesystem_identity, state, cleanup_eligible,
      retained_at
    ) VALUES (?, ?, ?, ?, ?, 'retained', 1, ?)
  `);
  insert.run(
    "z-first-retained-output",
    predecessor.id,
    replacement.id,
    "/media/z-first-retained-output.mkv",
    "z-first-retained-identity",
    2000,
  );
  insert.run(
    "a-second-retained-output",
    predecessor.id,
    replacement.id,
    "/media/a-second-retained-output.mkv",
    "a-second-retained-identity",
    1000,
  );
  insert.run(
    "changed-path-first-retained-output",
    changedPathPredecessor.id,
    changedPathReplacement.id,
    "/media/changed-path-first-retained-output.mkv",
    "changed-path-first-retained-identity",
    500,
  );
  historical.close();

  const migrated = createDataAccess({ databasePath });
  expect(migrated.encodeJobs.listRetainedOutputs([replacement.id]).map(
    ({ id, sourceEncodeJobId }) => ({ id, sourceEncodeJobId }),
  )).toEqual(expect.arrayContaining([
    {
      id: "z-first-retained-output",
      sourceEncodeJobId: predecessor.id,
    },
    {
      id: "a-second-retained-output",
      sourceEncodeJobId: replacement.id,
    },
  ]));
  expect(migrated.encodeJobs.listRetainedOutputs([
    changedPathReplacement.id,
  ])).toEqual([
    expect.objectContaining({
      id: "changed-path-first-retained-output",
      sourceEncodeJobId: changedPathReplacement.id,
    }),
  ]);
  migrated.close();

  const verified = new DatabaseSync(databasePath);
  expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(verified.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  verified.close();
});

it("migrates legacy archives and rehearses restoring the pre-write DVD evidence backup", () => {
  const databasePath = createDatabasePath("rip-dvd-evidence-migration-");
  const continuationFingerprint = `dvdmeta-sha256:${"4".repeat(64)}`;
  const continuationScanData = JSON.stringify({
    schemaVersion: 2,
    contentId: continuationFingerprint,
    titles: [{
      number: 1,
      durationSeconds: 3_600,
      chapters: 10,
      audioStreams: [],
      subtitles: [],
    }],
  });
  const evidenceMigrations = [
    "20260930002706_dvd-evidence-compatibility",
    "20260930003106_dvd-evidence-authority",
    "20260930003626_dvd-evidence-checkpoints",
  ] as const;
  const previousMigrations = createMigrationsThrough(
    "20260930002622_wandering_micromax",
  );
  const previousAccess = createDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();

  const legacyKeys = [
    "evidence-legacy-unknown",
    "evidence-legacy-clean",
    "evidence-legacy-watchable",
  ] as const;
  for (const key of [...legacyKeys, "evidence-new-format"] as const) {
    seedEncodeJob(databasePath, key);
  }
  const historical = new DatabaseSync(databasePath);
  historical.prepare(`
    UPDATE detected_discs
    SET fingerprint = ?, scan_data = ?
    WHERE id = 'evidence-new-format-disc'
  `).run(continuationFingerprint, continuationScanData);
  historical.prepare(`
    UPDATE original_disc_archives
    SET fingerprint = ?
    WHERE id = 'evidence-new-format-archive'
  `).run(continuationFingerprint);
  historical.exec(`
    UPDATE original_disc_archives
    SET size_bytes = 4096,
        boundary_reported_size_bytes = 4096,
        boundary_published_size_bytes = 4096
    WHERE id = 'evidence-new-format-archive';

    UPDATE encode_jobs
    SET output_validation_result = 'passed',
        output_validation_filesystem_identity = 'synthetic-main-output',
        output_validated_at = 2,
        output_completeness = 'complete'
    WHERE id = 'evidence-legacy-clean-job';

    UPDATE original_disc_archives
    SET integrity = 'clean_read',
        integrity_policy_version = 'legacy-clean-v1',
        bad_sector_count = 0,
        bad_area_count = 0,
        bad_sector_ranges = '[]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-legacy-clean-archive';

    UPDATE original_disc_archives
    SET integrity = 'watchable_salvage',
        integrity_policy_version = 'dvd-watchable-salvage-v1',
        bad_sector_count = 1,
        bad_area_count = 1,
        bad_sector_ranges = '[{"startLba":17,"sectorCount":1}]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-legacy-watchable-archive';

    INSERT INTO archive_requests (
      id, detected_disc_id, status, priority, fulfilled_at,
      created_at, updated_at
    ) VALUES (
      'evidence-legacy-clean-request', 'evidence-legacy-clean-disc',
      'fulfilled', 0, 1, 1, 1
    );

    INSERT INTO archive_jobs (
      id, archive_request_id, detected_disc_id, original_disc_archive_id,
      attempt_ordinal, status, priority, progress_phase, progress_percent,
      progress_bytes, last_progress_at, started_at, completed_at,
      created_at, updated_at
    ) VALUES (
      'evidence-legacy-clean-archive-job',
      'evidence-legacy-clean-request',
      'evidence-legacy-clean-disc',
      'evidence-legacy-clean-archive',
      1, 'completed', 0, 'finalizing', 100, 2048, 1, 1, 1, 1, 1
    );
  `);
  expect(historical.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  historical.close();

  const backupPath = join(dirname(databasePath), "pre-write-backup.sqlite");
  const restoredPath = join(dirname(databasePath), "restored.sqlite");
  copyFileSync(databasePath, backupPath);
  copyFileSync(backupPath, restoredPath);

  const readLegacySnapshot = (path: string) => {
    const access = createDataAccess({ databasePath: path });
    const snapshot = {
      archives: access.catalog.listOriginalDiscArchives().map((archive) => ({
        id: archive.id,
        integrity: archive.integrity,
        policyVersion: archive.integrityPolicyVersion,
        badSectorCount: archive.badSectorCount,
        badAreaCount: archive.badAreaCount,
        badSectorRanges: archive.badSectorRanges,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      archiveJob: access.archiveJobs.find(
        "evidence-legacy-clean-archive-job" as ArchiveJobId,
      ),
      archiveRequest: access.archiveRequests.find(
        "evidence-legacy-clean-request" as ArchiveRequestId,
      ),
      encodeJobs: access.encodeJobs.list().map((job) => ({
        id: job.id,
        status: job.status,
        validationResult: job.outputValidationResult,
        validationFilesystemIdentity: job.outputValidationFilesystemIdentity,
        validatedAt: job.outputValidatedAt,
        completeness: job.outputCompleteness,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      evidenceReads: [...legacyKeys, "evidence-new-format"].map((key) => ({
        header: access.catalog.findDvdArchiveEvidenceHeader(
          `${key}-archive` as OriginalDiscArchiveId,
        ),
        recovery: access.catalog.findArchiveRecovery(
          `${key}-archive` as OriginalDiscArchiveId,
        ),
      })),
    };
    access.close();
    const sqlite = new DatabaseSync(path);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("PRAGMA quick_check").get()).toEqual({
      quick_check: "ok",
    });
    const appliedEvidenceMigrations = sqlite.prepare(`
      SELECT name
      FROM __drizzle_migrations
      WHERE name IN (?, ?, ?)
      ORDER BY created_at, name
    `).all(...evidenceMigrations);
    const retainedOutputColumns = sqlite.prepare(`
      SELECT name
      FROM pragma_table_info('retained_encode_outputs')
      WHERE name IN (
        'source_encode_job_id',
        'validation_result',
        'validation_filesystem_identity',
        'validated_at',
        'completeness'
      )
      ORDER BY name
    `).all();
    sqlite.close();
    return {
      ...snapshot,
      appliedEvidenceMigrations,
      retainedOutputColumns,
    };
  };

  const migratedSnapshot = readLegacySnapshot(databasePath);
  const restoredSnapshot = readLegacySnapshot(restoredPath);
  expect(migratedSnapshot).toEqual(restoredSnapshot);
  expect(migratedSnapshot.archives).toEqual([
    expect.objectContaining({
      id: "evidence-legacy-clean-archive",
      integrity: "clean_read",
      policyVersion: "legacy-clean-v1",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
    }),
    expect.objectContaining({
      id: "evidence-legacy-unknown-archive",
      integrity: "unknown",
      policyVersion: null,
    }),
    expect.objectContaining({
      id: "evidence-legacy-watchable-archive",
      integrity: "watchable_salvage",
      policyVersion: "dvd-watchable-salvage-v1",
      badSectorCount: 1,
      badAreaCount: 1,
      badSectorRanges: [{ startLba: 17, sectorCount: 1 }],
    }),
    expect.objectContaining({
      id: "evidence-new-format-archive",
      integrity: "unknown",
      policyVersion: null,
    }),
  ]);
  expect(migratedSnapshot.archiveRequest).toMatchObject({
    status: "fulfilled",
    evidenceFormat: null,
  });
  expect(migratedSnapshot.archiveJob).toMatchObject({
    status: "completed",
    evidenceFormat: null,
  });
  expect(migratedSnapshot.encodeJobs).toHaveLength(4);
  expect(migratedSnapshot.encodeJobs.every(({ status }) => status === "queued"))
    .toBe(true);
  expect(migratedSnapshot.encodeJobs).toContainEqual(expect.objectContaining({
    id: "evidence-legacy-clean-job",
    validationResult: "passed",
    validationFilesystemIdentity: "synthetic-main-output",
    validatedAt: new Date(2),
    completeness: "complete",
  }));
  expect(migratedSnapshot.appliedEvidenceMigrations).toEqual(
    evidenceMigrations.map((name) => ({ name })),
  );
  expect(migratedSnapshot.retainedOutputColumns).toEqual([
    { name: "completeness" },
    { name: "source_encode_job_id" },
    { name: "validated_at" },
    { name: "validation_filesystem_identity" },
    { name: "validation_result" },
  ]);
  expect(migratedSnapshot.evidenceReads).toEqual([
    { header: null, recovery: null },
    { header: null, recovery: null },
    { header: null, recovery: null },
    { header: null, recovery: null },
  ]);

  const closedAccess = createDataAccess({ databasePath });
  expect(() => closedAccess.archiveRequests.submit({
    mutationKey: "00000000-0000-4000-8000-000000000402",
    detectedDiscId: "evidence-new-format-disc" as DetectedDiscId,
    evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
  })).toThrow(DvdRecoveryEvidenceAdmissionClosedError);
  closedAccess.close();
  const admissionCheck = new DatabaseSync(databasePath);
  expect(admissionCheck.prepare(`
    SELECT count(*) AS count
    FROM mutation_invocations
    WHERE key = '00000000-0000-4000-8000-000000000402'
  `).get()).toEqual({ count: 0 });
  admissionCheck.exec(`
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
      created_at, updated_at
    ) VALUES
      (
        'evidence-cancel-pending-disc', 'evidence-new-format-drive', 'dvd',
        'evidence-cancel-pending-fingerprint', 'approved', 1, 1, 1
      ),
      (
        'evidence-cancel-running-disc', 'evidence-new-format-drive', 'dvd',
        'evidence-cancel-running-fingerprint', 'approved', 1, 1, 1
      );

    INSERT INTO archive_requests (
      id, detected_disc_id, evidence_format, status, priority,
      created_at, updated_at
    ) VALUES
      (
        'evidence-cancel-pending-request', 'evidence-cancel-pending-disc',
        'dvd-recovery-evidence-v1', 'pending', 0, 1, 1
      ),
      (
        'evidence-cancel-running-request', 'evidence-cancel-running-disc',
        'dvd-recovery-evidence-v1', 'running', 0, 1, 1
      );

    UPDATE archive_requests
    SET status = 'cancelled', cancellation_requested_at = 2,
        cancelled_at = 2, updated_at = 2
    WHERE id = 'evidence-cancel-pending-request';

    UPDATE archive_requests
    SET status = 'cancellation_requested', cancellation_requested_at = 2,
        updated_at = 2
    WHERE id = 'evidence-cancel-running-request';
  `);
  expect(admissionCheck.prepare(`
    SELECT id, status, cancellation_requested_at, cancelled_at
    FROM archive_requests
    WHERE id IN (
      'evidence-cancel-pending-request',
      'evidence-cancel-running-request'
    )
    ORDER BY id
  `).all()).toEqual([
    {
      id: "evidence-cancel-pending-request",
      status: "cancelled",
      cancellation_requested_at: 2,
      cancelled_at: 2,
    },
    {
      id: "evidence-cancel-running-request",
      status: "cancellation_requested",
      cancellation_requested_at: 2,
      cancelled_at: null,
    },
  ]);
  admissionCheck.exec(`
    INSERT INTO archive_jobs (
      id, archive_request_id, detected_disc_id, evidence_format,
      attempt_ordinal, status, priority, progress_phase, progress_percent,
      progress_bytes, last_progress_at, claimed_by, claim_token, claimed_at,
      started_at, created_at, updated_at
    ) VALUES (
      'evidence-cancel-running-job', 'evidence-cancel-running-request',
      'evidence-cancel-running-disc', 'dvd-recovery-evidence-v1',
      1, 'running', 0, 'preparing', 0, 0, 1,
      'synthetic-cancellation-worker', 'synthetic-cancellation-token',
      1, 1, 1, 1
    )
  `);
  expect(() => admissionCheck.exec(`
    UPDATE archive_jobs
    SET progress_percent = 1, updated_at = 3
    WHERE id = 'evidence-cancel-running-job'
  `)).toThrow(/admission is closed/i);
  expect(() => admissionCheck.exec(`
    UPDATE archive_jobs
    SET original_disc_archive_id = 'evidence-new-format-archive',
        updated_at = 3
    WHERE id = 'evidence-cancel-running-job'
  `)).toThrow(/admission is closed/i);
  admissionCheck.exec(`
    UPDATE archive_jobs
    SET status = 'aborted', completed_at = 3,
        error_message = 'Archive cancellation completed', updated_at = 3
    WHERE id = 'evidence-cancel-running-job';

    UPDATE archive_requests
    SET status = 'cancelled', cancelled_at = 3, updated_at = 3
    WHERE id = 'evidence-cancel-running-request';
  `);
  expect(admissionCheck.prepare(`
    SELECT job.status AS jobStatus,
           job.progress_percent AS progressPercent,
           job.original_disc_archive_id AS originalDiscArchiveId,
           request.status AS requestStatus
    FROM archive_jobs AS job
    INNER JOIN archive_requests AS request
      ON request.id = job.archive_request_id
    WHERE job.id = 'evidence-cancel-running-job'
  `).get()).toEqual({
    jobStatus: "aborted",
    progressPercent: 0,
    originalDiscArchiveId: null,
    requestStatus: "cancelled",
  });
  expect(() => admissionCheck.exec(`
    UPDATE archive_requests
    SET priority = 1, updated_at = 3
    WHERE id = 'evidence-cancel-pending-request'
  `)).toThrow(/admission is closed/i);
  expect(() => admissionCheck.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 1
    WHERE id = 'evidence-legacy-clean-archive'
  `)).toThrow(/integrity_evidence_revision/i);
  expect(() => admissionCheck.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 1,
        integrity = 'incomplete_read',
        integrity_policy_version = 'dvd-recovery-evidence-v1',
        bad_sector_count = 1,
        bad_area_count = 1,
        bad_sector_ranges = '[{"startLba":11,"sectorCount":1}]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-legacy-unknown-archive'
  `)).toThrow(/requires authoritative DVD evidence/i);
  admissionCheck.exec(`
    INSERT INTO optical_drives (
      id, device_path, is_present, last_seen_at, created_at, updated_at
    ) VALUES (
      'evidence-request-drive', '/dev/evidence-request', 0, 1, 1, 1
    );
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status, scan_data,
      detected_at, created_at, updated_at
    ) VALUES (
      'evidence-request-disc', 'evidence-request-drive', 'dvd',
      '${continuationFingerprint}', 'approved', '${continuationScanData}',
      1, 1, 1
    );
    INSERT INTO disc_inspections (
      id, optical_drive_id, detected_disc_id, media_generation, is_current,
      status, phase, total_bytes, phase_started_at, attempt_started_at, started_at,
      completed_at, created_at, updated_at
    ) VALUES (
      'evidence-new-format-inspection', 'evidence-new-format-drive',
      'evidence-new-format-disc', 'evidence-new-format-generation', 1,
      'completed', 'confirming_media', 4096, 1, 1, 1, 1, 1, 1
    );

    INSERT INTO archive_requests (
      id, detected_disc_id, evidence_format, status, priority, fulfilled_at,
      created_at, updated_at
    ) VALUES (
      'evidence-new-format-request', 'evidence-request-disc',
      'dvd-recovery-evidence-v1', 'fulfilled', 0, 1, 1, 1
    );

    INSERT INTO archive_jobs (
      id, archive_request_id, disc_inspection_id, detected_disc_id,
      original_disc_archive_id, evidence_format, attempt_ordinal, status,
      priority, progress_phase, progress_percent, progress_bytes,
      last_progress_at, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'evidence-new-format-archive-job',
      'evidence-new-format-request',
      'evidence-new-format-inspection',
      'evidence-new-format-disc',
      'evidence-new-format-archive',
      'dvd-recovery-evidence-v1',
      1, 'completed', 0, 'finalizing', 100, 4096, 1, 1, 1, 1, 1
    );

    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
      created_at, updated_at
    ) VALUES (
      'evidence-nondvd-disc', 'evidence-legacy-unknown-drive', 'blu_ray',
      'evidence-nondvd-fingerprint', 'archived', 1, 1, 1
    );

    INSERT INTO original_disc_archives (
      id, detected_disc_id, disc_kind, archive_format, archive_path,
      fingerprint, size_bytes, archived_at, created_at, updated_at
    ) VALUES (
      'evidence-nondvd-archive', 'evidence-nondvd-disc', 'blu_ray', 'iso',
      '/originals/evidence-nondvd.iso', 'evidence-nondvd-fingerprint',
      2048, 1, 1, 1
    );

    INSERT INTO disc_inspections (
      id, optical_drive_id, detected_disc_id, media_generation, is_current,
      status, phase, total_bytes, phase_started_at, attempt_started_at, started_at,
      completed_at, created_at, updated_at
    ) VALUES (
      'evidence-nondvd-inspection', 'evidence-legacy-unknown-drive',
      'evidence-nondvd-disc', 'evidence-nondvd-generation', 1,
      'completed', 'confirming_media', 2048, 1, 1, 1, 1, 1, 1
    );

    INSERT INTO archive_requests (
      id, detected_disc_id, evidence_format, status, priority, fulfilled_at,
      created_at, updated_at
    ) VALUES (
      'evidence-nondvd-request', 'evidence-nondvd-disc',
      'dvd-recovery-evidence-v1', 'fulfilled', 0, 1, 1, 1
    );

    INSERT INTO archive_jobs (
      id, archive_request_id, disc_inspection_id, detected_disc_id,
      original_disc_archive_id, evidence_format, attempt_ordinal, status,
      priority, progress_phase, progress_percent, progress_bytes,
      last_progress_at, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'evidence-nondvd-archive-job', 'evidence-nondvd-request',
      'evidence-nondvd-inspection', 'evidence-nondvd-disc',
      'evidence-nondvd-archive',
      'dvd-recovery-evidence-v1', 1, 'completed', 0, 'finalizing', 100,
      2048, 1, 1, 1, 1, 1
    );

    INSERT INTO archive_jobs (
      id, archive_request_id, disc_inspection_id, detected_disc_id,
      original_disc_archive_id, evidence_format, attempt_ordinal, status,
      priority, progress_phase, progress_percent, progress_bytes,
      last_progress_at, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'evidence-mismatched-archive-job', 'evidence-nondvd-request',
      'evidence-nondvd-inspection', 'evidence-nondvd-disc',
      'evidence-new-format-archive',
      'dvd-recovery-evidence-v1', 2, 'completed', 0, 'finalizing', 100,
      4096, 1, 1, 1, 1, 1
    );
  `);
  admissionCheck.close();

  const projectionOnlyAccess = createDataAccess({ databasePath });
  expect(projectionOnlyAccess.catalog.listOriginalDiscArchives({
    ids: ["evidence-new-format-archive" as OriginalDiscArchiveId],
  })).toEqual([
    expect.objectContaining({
      integrity: "unknown",
      integrityEvidenceRevision: null,
      integrityPolicyVersion: null,
      badSectorCount: null,
      badAreaCount: null,
      badSectorRanges: null,
    }),
  ]);
  expect(projectionOnlyAccess.archiveJobs.find(
    "evidence-new-format-archive-job" as ArchiveJobId,
  )).toMatchObject({ evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT });
  expect(projectionOnlyAccess.catalog.findDvdArchiveEvidenceHeader(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toBeNull();
  expect(projectionOnlyAccess.catalog.findArchiveRecovery(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toBeNull();
  projectionOnlyAccess.close();

  const evidenceFixture = new DatabaseSync(databasePath);
  const initialRanges = [{
    startLba: 0,
    sectorCount: 2,
    classification: "skipped_untested",
  }] as const;
  const authoritativeRanges = [
    { startLba: 0, sectorCount: 1, classification: "skipped_untested" },
    { startLba: 1, sectorCount: 1, classification: "individually_failed" },
  ] as const;
  const boundaryDigest = createDvdArchiveBoundaryEvidenceDigest({
    policyVersion: "dvd-archive-boundary-v1",
    reportedSizeBytes: 4_096,
    publishedSizeBytes: 4_096,
    excludedSectorCount: 0,
  });
  const initialManifest = createDvdArchiveEvidenceManifestDigests({
    originalDiscArchiveId: "evidence-new-format-archive",
    revision: 1,
    previousManifestId: null,
    previousManifestDigest: null,
    recoveryReadId: null,
    recoveryReadEvidenceDigest: null,
    evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
    imageFingerprint: continuationFingerprint,
    sectorSizeBytes: 2_048,
    acceptedEndLbaExclusive: 2,
    boundaryPolicyVersion: "dvd-archive-boundary-v1",
    boundaryReportedSizeBytes: 4_096,
    boundaryPublishedSizeBytes: 4_096,
    boundaryEvidenceDigest: boundaryDigest,
    unrecoveredSourceRanges: initialRanges,
  });
  const initialRangesDigest = initialManifest.unrecoveredSourceRangesDigest;
  const initialManifestDigest = initialManifest.manifestDigest;
  const recoveryReadDigest = createDvdArchiveRecoveryReadEvidenceDigest({
    originalDiscArchiveId: "evidence-new-format-archive",
    fromManifestId: "evidence-new-format-manifest-1",
    fromManifestRevision: 1,
    startLba: 1,
    sectorCount: 1,
    outcome: "failed",
  });
  const failedManifest = createDvdArchiveEvidenceManifestDigests({
    originalDiscArchiveId: "evidence-new-format-archive",
    revision: 2,
    previousManifestId: "evidence-new-format-manifest-1",
    previousManifestDigest: initialManifestDigest,
    recoveryReadId: "evidence-new-format-read-1",
    recoveryReadEvidenceDigest: recoveryReadDigest,
    evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
    imageFingerprint: continuationFingerprint,
    sectorSizeBytes: 2_048,
    acceptedEndLbaExclusive: 2,
    boundaryPolicyVersion: "dvd-archive-boundary-v1",
    boundaryReportedSizeBytes: 4_096,
    boundaryPublishedSizeBytes: 4_096,
    boundaryEvidenceDigest: boundaryDigest,
    unrecoveredSourceRanges: authoritativeRanges,
  });
  const failedRangesDigest = failedManifest.unrecoveredSourceRangesDigest;
  const failedManifestDigest = failedManifest.manifestDigest;
  const cleanBoundaryDigest = createDvdArchiveBoundaryEvidenceDigest({
    policyVersion: "dvd-archive-boundary-v1",
    reportedSizeBytes: 6_144,
    publishedSizeBytes: 4_096,
    excludedSectorCount: 1,
    firstExcludedLba: 2,
    maximumReferencedLba: 0,
    outOfRangeEvidence: {
      classifierVersion: "scsi-read-classifier-v2",
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 0,
      senseResponseCode: 112,
      senseKey: 5,
      asc: 33,
      ascq: 0,
    },
  });
  const cleanManifest = createDvdArchiveEvidenceManifestDigests({
    originalDiscArchiveId: "evidence-clean-archive",
    revision: 1,
    previousManifestId: null,
    previousManifestDigest: null,
    recoveryReadId: null,
    recoveryReadEvidenceDigest: null,
    evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
    imageFingerprint: "evidence-clean-fingerprint",
    sectorSizeBytes: 2_048,
    acceptedEndLbaExclusive: 2,
    boundaryPolicyVersion: "dvd-archive-boundary-v1",
    boundaryReportedSizeBytes: 6_144,
    boundaryPublishedSizeBytes: 4_096,
    boundaryEvidenceDigest: cleanBoundaryDigest,
    unrecoveredSourceRanges: [],
  });
  const cleanRangesDigest = cleanManifest.unrecoveredSourceRangesDigest;
  const cleanManifestDigest = cleanManifest.manifestDigest;
  evidenceFixture.exec(`
    INSERT INTO optical_drives (
      id, device_path, is_present, last_seen_at, created_at, updated_at
    ) VALUES
      ('evidence-clean-drive', '/dev/evidence-clean', 1, 1, 1, 1),
      ('evidence-clean-source-drive', '/dev/evidence-clean-source', 0, 1, 1, 1);
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
      created_at, updated_at
    ) VALUES
      (
        'evidence-clean-disc', 'evidence-clean-drive', 'dvd',
        'evidence-clean-fingerprint', 'archived', 1, 1, 1
      ),
      (
        'evidence-clean-source-disc', 'evidence-clean-source-drive', 'dvd',
        'evidence-clean-fingerprint', 'archived', 1, 1, 1
      );
    INSERT INTO disc_inspections (
      id, optical_drive_id, detected_disc_id, media_generation, is_current,
      status, phase, total_bytes, phase_started_at, attempt_started_at,
      started_at, completed_at, created_at, updated_at
    ) VALUES (
      'evidence-clean-inspection', 'evidence-clean-drive',
      'evidence-clean-disc', 'evidence-clean-generation', 1,
      'completed', 'confirming_media', 6144, 1, 1, 1, 1, 1, 1
    );
    INSERT INTO original_disc_archives (
      id, detected_disc_id, disc_kind, archive_format, archive_path,
      fingerprint, size_bytes, integrity, archived_at, created_at, updated_at
    ) VALUES (
      'evidence-clean-source-archive', 'evidence-clean-source-disc', 'dvd',
      'iso', '/originals/evidence-clean-source.iso',
      'evidence-clean-fingerprint', 6144, 'unknown', 0, 0, 0
    );
    INSERT INTO original_disc_archives (
      id, detected_disc_id, rearchive_source_archive_id, disc_kind,
      archive_format, archive_path,
      fingerprint, size_bytes, boundary_policy_version,
      boundary_reported_size_bytes, boundary_published_size_bytes,
      boundary_excluded_sector_count, boundary_first_excluded_lba,
      boundary_maximum_referenced_lba,
      boundary_read_failure_classifier_version,
      boundary_read_failure_scsi_status, boundary_read_failure_host_status,
      boundary_read_failure_driver_status,
      boundary_read_failure_sense_response_code,
      boundary_read_failure_sense_key, boundary_read_failure_asc,
      boundary_read_failure_ascq, integrity, integrity_policy_version,
      bad_sector_count, bad_area_count, bad_sector_ranges,
      archived_at, created_at, updated_at
    ) VALUES (
      'evidence-clean-archive', 'evidence-clean-disc',
      'evidence-clean-source-archive', 'dvd', 'iso',
      '/originals/evidence-clean.iso', 'evidence-clean-fingerprint', 4096,
      'dvd-archive-boundary-v1', 6144, 4096, 1, 2, 0,
      'scsi-read-classifier-v2', 2, 0, 0, 112, 5, 33, 0, 'clean_read',
      'dvd-recovery-evidence-v1', 0, 0, '[]', 1, 1, 1
    );
    INSERT INTO archive_requests (
      id, detected_disc_id, rearchive_source_archive_id, evidence_format,
      status, priority, fulfilled_at, created_at, updated_at
    ) VALUES (
      'evidence-clean-request', 'evidence-clean-source-disc',
      'evidence-clean-source-archive',
      'dvd-recovery-evidence-v1', 'fulfilled', 0, 1, 1, 1
    );
    INSERT INTO archive_jobs (
      id, archive_request_id, disc_inspection_id, detected_disc_id,
      original_disc_archive_id, evidence_format, attempt_ordinal, status,
      priority, progress_phase, progress_percent, progress_bytes,
      last_progress_at, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'evidence-clean-job', 'evidence-clean-request',
      'evidence-clean-inspection', 'evidence-clean-disc',
      'evidence-clean-archive', 'dvd-recovery-evidence-v1', 1, 'completed', 0,
      'finalizing', 100, 4096, 1, 1, 1, 1, 1
    );
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, evidence_format,
      image_fingerprint, sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (
      'evidence-clean-manifest-1', 'evidence-clean-archive', 1,
      'dvd-recovery-evidence-v1', 'evidence-clean-fingerprint', 2048, 2,
      'dvd-archive-boundary-v1', 6144, 4096, '${cleanBoundaryDigest}', '[]',
      '${cleanRangesDigest}', '${cleanManifestDigest}', 1
    )
  `);
  const insertCleanHeader = () => evidenceFixture.exec(`
    INSERT INTO dvd_archive_evidence_headers (
      original_disc_archive_id, source_archive_job_id, evidence_format,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      sector_size_bytes, accepted_end_lba_exclusive, current_manifest_id,
      current_manifest_revision, current_manifest_digest, created_at, updated_at
    ) VALUES (
      'evidence-clean-archive', 'evidence-clean-job',
      'dvd-recovery-evidence-v1', 'dvd-archive-boundary-v1', 6144, 4096,
      '${cleanBoundaryDigest}', 2048, 2, 'evidence-clean-manifest-1', 1,
      '${cleanManifestDigest}', 1, 1
    )
  `);
  expect(insertCleanHeader).toThrow(/proven initial manifest/i);
  evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 1
    WHERE id = 'evidence-clean-archive'
  `);
  insertCleanHeader();
  evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET bad_sector_ranges = '[ ]'
    WHERE id = 'evidence-clean-archive'
  `);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET boundary_maximum_referenced_lba = 1
    WHERE id = 'evidence-clean-archive'
  `)).toThrow(/Archive Boundary Evidence is immutable/i);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET boundary_read_failure_classifier_version = 'scsi-read-classifier-v3',
        boundary_read_failure_scsi_status = 3,
        boundary_read_failure_driver_status = 8,
        boundary_read_failure_sense_response_code = 114
    WHERE id = 'evidence-clean-archive'
  `)).toThrow(/Archive Boundary Evidence is immutable/i);
  const insertInitialManifest = evidenceFixture.prepare(`
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, evidence_format,
      image_fingerprint, sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (
      'evidence-new-format-manifest-1',
      'evidence-new-format-archive',
      1,
      'dvd-recovery-evidence-v1',
      '${continuationFingerprint}',
      2048,
      2,
      'dvd-archive-boundary-v1',
      4096,
      4096,
      '${boundaryDigest}',
      ?,
      '${initialRangesDigest}',
      '${initialManifestDigest}',
      1
    )
  `);
  for (const invalidRanges of [
    [{ startLba: 0, sectorCount: 1 }],
    [
      { startLba: 0, sectorCount: 1, classification: "skipped_untested" },
      { startLba: 1, sectorCount: 1, classification: "skipped_untested" },
    ],
    [{ startLba: 0, sectorCount: 1, classification: "individually_failed" }],
    [{
      startLba: Number.MAX_SAFE_INTEGER + 1,
      sectorCount: 1,
      classification: "skipped_untested",
    }],
  ]) {
    expect(() => insertInitialManifest.run(JSON.stringify(invalidRanges)))
      .toThrow(/DVD evidence manifest/i);
  }
  insertInitialManifest.run(JSON.stringify(initialRanges));
  expect(() => evidenceFixture.exec(`
    UPDATE disc_inspections
    SET total_bytes = 2048
    WHERE id = 'evidence-new-format-inspection';
    INSERT INTO dvd_archive_evidence_headers (
      original_disc_archive_id, source_archive_job_id, evidence_format,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      sector_size_bytes, accepted_end_lba_exclusive, current_manifest_id,
      current_manifest_revision, current_manifest_digest, created_at, updated_at
    ) VALUES (
      'evidence-new-format-archive', 'evidence-new-format-archive-job',
      'dvd-recovery-evidence-v1', 'dvd-archive-boundary-v1', 4096, 4096,
      '${boundaryDigest}', 2048, 2, 'evidence-new-format-manifest-1', 1,
      '${initialManifestDigest}', 1, 1
    )
  `)).toThrow(/DVD boundary/i);
  evidenceFixture.exec(`
    UPDATE disc_inspections
    SET total_bytes = 4096
    WHERE id = 'evidence-new-format-inspection'
  `);
  expect(() => evidenceFixture.exec(`
    INSERT INTO dvd_archive_evidence_headers (
      original_disc_archive_id, source_archive_job_id, evidence_format,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      sector_size_bytes, accepted_end_lba_exclusive, current_manifest_id,
      current_manifest_revision, current_manifest_digest, created_at, updated_at
    ) VALUES (
      'evidence-new-format-archive', 'evidence-mismatched-archive-job',
      'dvd-recovery-evidence-v1', 'dvd-archive-boundary-v1', 4096, 4096,
      '${boundaryDigest}', 2048, 2, 'evidence-new-format-manifest-1', 1,
      '${initialManifestDigest}', 1, 1
    )
  `)).toThrow(/proven initial manifest/i);
  evidenceFixture.exec(`
    INSERT INTO dvd_archive_evidence_headers (
      original_disc_archive_id, source_archive_job_id, evidence_format,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      sector_size_bytes, accepted_end_lba_exclusive, current_manifest_id,
      current_manifest_revision, current_manifest_digest, created_at, updated_at
    ) VALUES (
      'evidence-new-format-archive', 'evidence-new-format-archive-job',
      'dvd-recovery-evidence-v1', 'dvd-archive-boundary-v1', 4096, 4096,
      '${boundaryDigest}', 2048, 2, 'evidence-new-format-manifest-1', 1,
      '${initialManifestDigest}', 1, 1
    );
    UPDATE original_disc_archives
    SET verification_status = 'accessible',
        verification_message = 'Synthetic verification',
        verified_at = 2
    WHERE id = 'evidence-new-format-archive';
  `);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET size_bytes = 2048,
        boundary_reported_size_bytes = 2048,
        boundary_published_size_bytes = 2048
    WHERE id = 'evidence-new-format-archive'
  `)).toThrow(/projection must match a committed DVD evidence manifest/i);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity = 'incomplete_read',
        integrity_policy_version = 'dvd-recovery-evidence-v1',
        bad_sector_count = 2,
        bad_area_count = 1,
        bad_sector_ranges = '[{"startLba":0,"sectorCount":1}]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-new-format-archive'
  `)).toThrow(/projection must match a committed DVD evidence manifest/i);
  const repeatedRecoveryReadDigest =
    createDvdArchiveRecoveryReadEvidenceDigest({
      originalDiscArchiveId: "evidence-new-format-archive",
      fromManifestId: "evidence-new-format-manifest-2",
      fromManifestRevision: 2,
      startLba: 1,
      sectorCount: 1,
      outcome: "failed",
    });
  const rejectedRepeatedManifest =
    createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: "evidence-new-format-archive",
      revision: 3,
      previousManifestId: "evidence-new-format-manifest-2",
      previousManifestDigest: failedManifestDigest,
      recoveryReadId: "evidence-new-format-read-repeat",
      recoveryReadEvidenceDigest: repeatedRecoveryReadDigest,
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      imageFingerprint: continuationFingerprint,
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 2,
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 4_096,
      boundaryPublishedSizeBytes: 4_096,
      boundaryEvidenceDigest: boundaryDigest,
      unrecoveredSourceRanges: authoritativeRanges,
    });
  evidenceFixture.exec(`
    UPDATE disc_inspections
    SET total_bytes = 2048
    WHERE id = 'evidence-new-format-inspection'
  `);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity = 'incomplete_read',
        integrity_policy_version = 'dvd-recovery-evidence-v1',
        bad_sector_count = 2,
        bad_area_count = 1,
        bad_sector_ranges = '[{"startLba":0,"sectorCount":2}]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-new-format-archive'
  `)).toThrow(/projection must match a committed DVD evidence manifest/i);
  evidenceFixture.exec(`
    UPDATE disc_inspections
    SET total_bytes = 4096
    WHERE id = 'evidence-new-format-inspection';
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 1,
        integrity = 'incomplete_read',
        integrity_policy_version = 'dvd-recovery-evidence-v1',
        bad_sector_count = 2,
        bad_area_count = 1,
        bad_sector_ranges = '[{"startLba":0,"sectorCount":2}]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-new-format-archive';
  `);
  expect(() => evidenceFixture.exec(`
    INSERT INTO archive_recoveries (
      id, original_disc_archive_id, status, created_at, updated_at
    ) VALUES (
      'evidence-new-format-recovery',
      'evidence-new-format-archive',
      'completed',
      1,
      1
    )
  `)).toThrow(/status must match authoritative DVD evidence/i);
  evidenceFixture.exec(`
    INSERT INTO archive_recoveries (
      id, original_disc_archive_id, status, created_at, updated_at
    ) VALUES (
      'evidence-new-format-recovery',
      'evidence-new-format-archive',
      'eligible',
      1,
      1
    )
  `);
  evidenceFixture.exec(`
    INSERT INTO dvd_archive_recovery_reads (
      id, original_disc_archive_id, from_manifest_id,
      from_manifest_revision, start_lba, sector_count, outcome,
      evidence_digest, created_at
    ) VALUES (
      'evidence-new-format-read-1', 'evidence-new-format-archive',
      'evidence-new-format-manifest-1', 1, 1, 1, 'failed',
      '${recoveryReadDigest}', 2
    )
  `);
  evidenceFixture.prepare(`
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, previous_manifest_id,
      recovery_read_id, evidence_format, image_fingerprint,
      sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (
      'evidence-new-format-manifest-2', 'evidence-new-format-archive', 2,
      'evidence-new-format-manifest-1', 'evidence-new-format-read-1',
      'dvd-recovery-evidence-v1', '${continuationFingerprint}', 2048, 2,
      'dvd-archive-boundary-v1', 4096, 4096, '${boundaryDigest}', ?,
      '${failedRangesDigest}', '${failedManifestDigest}', 2
    )
  `).run(JSON.stringify(authoritativeRanges));
  evidenceFixture.exec(`
    UPDATE dvd_archive_evidence_headers
    SET current_manifest_id = 'evidence-new-format-manifest-2',
        current_manifest_revision = 2,
        current_manifest_digest = '${failedManifestDigest}',
        updated_at = 2
    WHERE original_disc_archive_id = 'evidence-new-format-archive';
    UPDATE original_disc_archives
    SET verification_message = 'Synthetic verification after checkpoint'
    WHERE id = 'evidence-new-format-archive';
  `);
  expect(evidenceFixture.prepare(`
    SELECT integrity_evidence_revision AS integrityEvidenceRevision,
           bad_area_count AS badAreaCount
    FROM original_disc_archives
    WHERE id = 'evidence-new-format-archive'
  `).get()).toEqual({ integrityEvidenceRevision: 1, badAreaCount: 1 });
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 0
    WHERE id = 'evidence-new-format-archive'
  `)).toThrow(/projection must match a committed DVD evidence manifest/i);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 3
    WHERE id = 'evidence-new-format-archive'
  `)).toThrow(/projection must match a committed DVD evidence manifest/i);
  evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 2,
        integrity = 'incomplete_read',
        integrity_policy_version = 'dvd-recovery-evidence-v1',
        bad_sector_count = 2,
        bad_area_count = 2,
        bad_sector_ranges = '[{"startLba":0,"sectorCount":1},{"startLba":1,"sectorCount":1}]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-new-format-archive';
  `);
  expect(() => evidenceFixture.exec(`
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 1,
        bad_area_count = 1,
        bad_sector_ranges = '[{"startLba":0,"sectorCount":2}]'
    WHERE id = 'evidence-new-format-archive'
  `)).toThrow(/projection must match a committed DVD evidence manifest/i);
  evidenceFixture.exec(`
    INSERT INTO dvd_archive_recovery_reads (
      id, original_disc_archive_id, from_manifest_id,
      from_manifest_revision, start_lba, sector_count, outcome,
      evidence_digest, created_at
    ) VALUES (
      'evidence-new-format-read-repeat', 'evidence-new-format-archive',
      'evidence-new-format-manifest-2', 2, 1, 1, 'failed',
      '${repeatedRecoveryReadDigest}', 3
    )
  `);
  expect(evidenceFixture.prepare(`
    SELECT current_manifest_revision AS revision
    FROM dvd_archive_evidence_headers
    WHERE original_disc_archive_id = 'evidence-new-format-archive'
  `).get()).toEqual({ revision: 2 });
  expect(() => evidenceFixture.prepare(`
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, previous_manifest_id,
      recovery_read_id, evidence_format, image_fingerprint,
      sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (
      'evidence-new-format-manifest-repeat',
      'evidence-new-format-archive', 3,
      'evidence-new-format-manifest-2', 'evidence-new-format-read-repeat',
      'dvd-recovery-evidence-v1', '${continuationFingerprint}', 2048, 2,
      'dvd-archive-boundary-v1', 4096, 4096, '${boundaryDigest}', ?,
      '${rejectedRepeatedManifest.unrecoveredSourceRangesDigest}',
      '${rejectedRepeatedManifest.manifestDigest}', 3
    )
  `).run(JSON.stringify(authoritativeRanges))).toThrow(
    /manifest transition requires its one-sector recovery read/i,
  );
  expect(evidenceFixture.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  evidenceFixture.close();

  const tamperedRecoveryPath = join(
    dirname(databasePath),
    "tampered-recovery-evidence.sqlite",
  );
  copyFileSync(databasePath, tamperedRecoveryPath);
  const tamperedRecovery = new DatabaseSync(tamperedRecoveryPath);
  tamperedRecovery.exec(`
    DROP TRIGGER dvd_evidence_recovery_read_update_guard;
    UPDATE dvd_archive_recovery_reads
    SET evidence_digest = '${"0".repeat(64)}'
    WHERE id = 'evidence-new-format-read-1'
  `);
  tamperedRecovery.close();
  const tamperedRecoveryAccess = createDataAccess({
    databasePath: tamperedRecoveryPath,
  });
  expect(() => tamperedRecoveryAccess.catalog.findDvdArchiveEvidenceHeader(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toThrow(
    "Persisted DVD Archive Recovery evidence digest does not match its contents",
  );
  tamperedRecoveryAccess.close();

  const currentAccess = createDataAccess({ databasePath });
  expect(currentAccess.archiveRequests.find(
    "evidence-new-format-request" as ArchiveRequestId,
  )).toMatchObject({ detectedDiscId: "evidence-request-disc" });
  expect(currentAccess.archiveJobs.find(
    "evidence-new-format-archive-job" as ArchiveJobId,
  )).toMatchObject({ detectedDiscId: "evidence-new-format-disc" });
  expect(currentAccess.archiveRequests.find(
    "evidence-clean-request" as ArchiveRequestId,
  )).toMatchObject({ detectedDiscId: "evidence-clean-source-disc" });
  expect(currentAccess.archiveJobs.find(
    "evidence-clean-job" as ArchiveJobId,
  )).toMatchObject({ detectedDiscId: "evidence-clean-disc" });
  expect(currentAccess.catalog.findDvdArchiveEvidenceHeader(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toEqual({
    originalDiscArchiveId: "evidence-new-format-archive",
    sourceArchiveJobId: "evidence-new-format-archive-job",
    evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
    boundaryEvidenceDigest: boundaryDigest,
    sectorSizeBytes: 2048,
    acceptedEndLbaExclusive: 2,
    currentManifestId: "evidence-new-format-manifest-2",
    currentManifestRevision: 2,
    currentManifestDigest: failedManifestDigest,
    unrecoveredSourceRanges: [
      {
        startLba: 0,
        sectorCount: 1,
        classification: "skipped_untested",
      },
      {
        startLba: 1,
        sectorCount: 1,
        classification: "individually_failed",
      },
    ],
    createdAt: new Date(1),
    updatedAt: new Date(2),
  });
  expect(currentAccess.catalog.findDvdArchiveEvidenceHeader(
    "evidence-clean-archive" as OriginalDiscArchiveId,
  )).toMatchObject({
    originalDiscArchiveId: "evidence-clean-archive",
    sourceArchiveJobId: "evidence-clean-job",
    currentManifestRevision: 1,
  });
  expect(currentAccess.catalog.findArchiveRecovery(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toEqual({
    id: "evidence-new-format-recovery",
    originalDiscArchiveId: "evidence-new-format-archive",
    status: "eligible",
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  expect(currentAccess.catalog.listOriginalDiscArchives({
    ids: ["evidence-new-format-archive" as OriginalDiscArchiveId],
  })).toEqual([
    expect.objectContaining({
      integrity: "incomplete_read",
      integrityEvidenceRevision: 2,
      integrityPolicyVersion: DVD_RECOVERY_EVIDENCE_FORMAT,
      badSectorCount: 2,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 0, sectorCount: 1 },
        { startLba: 1, sectorCount: 1 },
      ],
    }),
  ]);
  expect(
    new Set(
      currentAccess.catalog.listDiscSelections({ encodeEligibleOnly: true })
        .map(({ id }) => id),
    ),
  ).toEqual(new Set(legacyKeys.map((key) => `${key}-selection`)));

  const claimedEncodeJobs = new Set<string>();
  for (;;) {
    const claim = currentAccess.encodeJobs.claimNext("compatibility-worker");
    if (claim === null) break;
    claimedEncodeJobs.add(claim.id);
    currentAccess.encodeJobs.fail(claim, "Synthetic compatibility failure");
  }
  expect(claimedEncodeJobs).toEqual(
    new Set(legacyKeys.map((key) => `${key}-job`)),
  );
  expect(currentAccess.encodeJobs.list()).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "evidence-new-format-job",
      status: "queued",
    }),
  ]));
  currentAccess.close();

  const recoveredFirstSectorRanges = [{
    startLba: 1,
    sectorCount: 1,
    classification: "individually_failed",
  }] as const;
  const recoveredFirstSectorReadDigest =
    createDvdArchiveRecoveryReadEvidenceDigest({
      originalDiscArchiveId: "evidence-new-format-archive",
      fromManifestId: "evidence-new-format-manifest-2",
      fromManifestRevision: 2,
      startLba: 0,
      sectorCount: 1,
      outcome: "recovered",
    });
  const recoveredFirstSectorManifest =
    createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: "evidence-new-format-archive",
      revision: 3,
      previousManifestId: "evidence-new-format-manifest-2",
      previousManifestDigest: failedManifestDigest,
      recoveryReadId: "evidence-new-format-read-2",
      recoveryReadEvidenceDigest: recoveredFirstSectorReadDigest,
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      imageFingerprint: continuationFingerprint,
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 2,
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 4_096,
      boundaryPublishedSizeBytes: 4_096,
      boundaryEvidenceDigest: boundaryDigest,
      unrecoveredSourceRanges: recoveredFirstSectorRanges,
    });
  const recoveredLastSectorReadDigest =
    createDvdArchiveRecoveryReadEvidenceDigest({
      originalDiscArchiveId: "evidence-new-format-archive",
      fromManifestId: "evidence-new-format-manifest-3",
      fromManifestRevision: 3,
      startLba: 1,
      sectorCount: 1,
      outcome: "recovered",
    });
  const recoveredLastSectorManifest =
    createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: "evidence-new-format-archive",
      revision: 4,
      previousManifestId: "evidence-new-format-manifest-3",
      previousManifestDigest: recoveredFirstSectorManifest.manifestDigest,
      recoveryReadId: "evidence-new-format-read-3",
      recoveryReadEvidenceDigest: recoveredLastSectorReadDigest,
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      imageFingerprint: continuationFingerprint,
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 2,
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 4_096,
      boundaryPublishedSizeBytes: 4_096,
      boundaryEvidenceDigest: boundaryDigest,
      unrecoveredSourceRanges: [],
    });
  const finalDatabase = new DatabaseSync(databasePath);
  for (const mutation of [
    "UPDATE archive_recoveries SET id = 'renamed-recovery' WHERE id = 'evidence-new-format-recovery'",
    "UPDATE archive_recoveries SET original_disc_archive_id = 'evidence-legacy-clean-archive' WHERE id = 'evidence-new-format-recovery'",
    "UPDATE archive_recoveries SET created_at = 2 WHERE id = 'evidence-new-format-recovery'",
    "DELETE FROM archive_recoveries WHERE id = 'evidence-new-format-recovery'",
  ]) {
    expect(() => finalDatabase.exec(mutation)).toThrow(
      /Archive Recovery identity is immutable/i,
    );
  }
  finalDatabase.exec(`
    INSERT INTO dvd_archive_recovery_reads (
      id, original_disc_archive_id, from_manifest_id,
      from_manifest_revision, start_lba, sector_count, outcome,
      evidence_digest, created_at
    ) VALUES (
      'evidence-new-format-read-2', 'evidence-new-format-archive',
      'evidence-new-format-manifest-2', 2, 0, 1, 'recovered',
      '${recoveredFirstSectorReadDigest}', 3
    );
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, previous_manifest_id,
      recovery_read_id, evidence_format, image_fingerprint,
      sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (
      'evidence-new-format-manifest-3', 'evidence-new-format-archive', 3,
      'evidence-new-format-manifest-2', 'evidence-new-format-read-2',
      'dvd-recovery-evidence-v1', '${continuationFingerprint}', 2048, 2,
      'dvd-archive-boundary-v1', 4096, 4096, '${boundaryDigest}',
      '[{"startLba":1,"sectorCount":1,"classification":"individually_failed"}]',
      '${recoveredFirstSectorManifest.unrecoveredSourceRangesDigest}',
      '${recoveredFirstSectorManifest.manifestDigest}', 3
    );
    UPDATE dvd_archive_evidence_headers
    SET current_manifest_id = 'evidence-new-format-manifest-3',
        current_manifest_revision = 3,
        current_manifest_digest = '${recoveredFirstSectorManifest.manifestDigest}',
        updated_at = 3
    WHERE original_disc_archive_id = 'evidence-new-format-archive';

    INSERT INTO dvd_archive_recovery_reads (
      id, original_disc_archive_id, from_manifest_id,
      from_manifest_revision, start_lba, sector_count, outcome,
      evidence_digest, created_at
    ) VALUES (
      'evidence-new-format-read-3', 'evidence-new-format-archive',
      'evidence-new-format-manifest-3', 3, 1, 1, 'recovered',
      '${recoveredLastSectorReadDigest}', 4
    );
    INSERT INTO dvd_archive_evidence_manifests (
      id, original_disc_archive_id, revision, previous_manifest_id,
      recovery_read_id, evidence_format, image_fingerprint,
      sector_size_bytes, accepted_end_lba_exclusive,
      boundary_policy_version, boundary_reported_size_bytes,
      boundary_published_size_bytes, boundary_evidence_digest,
      unrecovered_source_ranges, unrecovered_source_ranges_digest,
      manifest_digest, created_at
    ) VALUES (
      'evidence-new-format-manifest-4', 'evidence-new-format-archive', 4,
      'evidence-new-format-manifest-3', 'evidence-new-format-read-3',
      'dvd-recovery-evidence-v1', '${continuationFingerprint}', 2048, 2,
      'dvd-archive-boundary-v1', 4096, 4096, '${boundaryDigest}', '[]',
      '${recoveredLastSectorManifest.unrecoveredSourceRangesDigest}',
      '${recoveredLastSectorManifest.manifestDigest}', 4
    );
    UPDATE dvd_archive_evidence_headers
    SET current_manifest_id = 'evidence-new-format-manifest-4',
        current_manifest_revision = 4,
        current_manifest_digest = '${recoveredLastSectorManifest.manifestDigest}',
        updated_at = 4
    WHERE original_disc_archive_id = 'evidence-new-format-archive';
    UPDATE original_disc_archives
    SET integrity_evidence_revision = 4,
        integrity = 'clean_read',
        integrity_policy_version = 'dvd-recovery-evidence-v1',
        bad_sector_count = 0,
        bad_area_count = 0,
        bad_sector_ranges = '[]',
        bad_sector_counts_by_title = NULL
    WHERE id = 'evidence-new-format-archive';
    UPDATE archive_recoveries
    SET status = 'completed', updated_at = 4
    WHERE original_disc_archive_id = 'evidence-new-format-archive';
  `);
  expect(finalDatabase.prepare(`
    SELECT current_manifest_revision AS revision
    FROM dvd_archive_evidence_headers
    WHERE original_disc_archive_id = 'evidence-new-format-archive'
  `).get()).toEqual({ revision: 4 });
  expect(finalDatabase.prepare(`
    SELECT integrity,
           integrity_evidence_revision AS integrityEvidenceRevision,
           bad_sector_count AS badSectorCount
    FROM original_disc_archives
    WHERE id = 'evidence-new-format-archive'
  `).get()).toEqual({
    integrity: "clean_read",
    integrityEvidenceRevision: 4,
    badSectorCount: 0,
  });
  expect(finalDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(finalDatabase.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  expect(finalDatabase.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'trigger' AND name LIKE 'dvd_evidence_%'
    ORDER BY name
  `).all()).toEqual([
    { name: "dvd_evidence_archive_boundary_update_guard" },
    { name: "dvd_evidence_archive_job_insert_match" },
    { name: "dvd_evidence_archive_job_update_guard" },
    { name: "dvd_evidence_archive_projection_update_guard" },
    { name: "dvd_evidence_archive_recovery_delete_guard" },
    { name: "dvd_evidence_archive_recovery_insert_guard" },
    { name: "dvd_evidence_archive_recovery_update_guard" },
    { name: "dvd_evidence_archive_request_update_guard" },
    { name: "dvd_evidence_header_delete_guard" },
    { name: "dvd_evidence_header_insert_guard" },
    { name: "dvd_evidence_header_update_guard" },
    { name: "dvd_evidence_incomplete_archive_insert_guard" },
    { name: "dvd_evidence_incomplete_archive_update_guard" },
    { name: "dvd_evidence_manifest_delete_guard" },
    { name: "dvd_evidence_manifest_insert_guard" },
    { name: "dvd_evidence_manifest_update_guard" },
    { name: "dvd_evidence_recovery_read_delete_guard" },
    { name: "dvd_evidence_recovery_read_insert_guard" },
    { name: "dvd_evidence_recovery_read_update_guard" },
  ]);
  finalDatabase.close();

  for (const tamper of [
    {
      suffix: "initial-manifest",
      mutation: `
        DROP TRIGGER dvd_evidence_manifest_update_guard;
        UPDATE dvd_archive_evidence_manifests
        SET unrecovered_source_ranges =
          '[{"startLba":0,"sectorCount":1,"classification":"skipped_untested"}]'
        WHERE id = 'evidence-new-format-manifest-1';
      `,
      expected:
        "Persisted Unrecovered Source ranges digest does not match its contents",
    },
    {
      suffix: "older-recovery-read",
      mutation: `
        DROP TRIGGER dvd_evidence_recovery_read_update_guard;
        UPDATE dvd_archive_recovery_reads
        SET outcome = 'recovered'
        WHERE id = 'evidence-new-format-read-1';
      `,
      expected:
        "Persisted DVD Archive Recovery evidence digest does not match its contents",
    },
  ]) {
    const tamperedPath = join(
      dirname(databasePath),
      `tampered-${tamper.suffix}.sqlite`,
    );
    copyFileSync(databasePath, tamperedPath);
    const tamperedDatabase = new DatabaseSync(tamperedPath);
    tamperedDatabase.exec(tamper.mutation);
    tamperedDatabase.close();

    const tamperedAccess = createDataAccess({ databasePath: tamperedPath });
    expect(tamperedAccess.catalog.findDvdArchiveEvidenceHeader(
      "evidence-new-format-archive" as OriginalDiscArchiveId,
    )).toMatchObject({ currentManifestRevision: 4 });
    expect(() => tamperedAccess.catalog.auditDvdArchiveEvidenceChains([
      "evidence-new-format-archive" as OriginalDiscArchiveId,
    ])).toThrow(tamper.expected);
    tamperedAccess.close();
  }

  const provenanceTamperedPath = join(
    dirname(databasePath),
    "tampered-source-job-provenance.sqlite",
  );
  copyFileSync(databasePath, provenanceTamperedPath);
  const provenanceTamperedDatabase = new DatabaseSync(provenanceTamperedPath);
  provenanceTamperedDatabase.exec(`
    DROP TRIGGER dvd_evidence_header_update_guard;
    UPDATE dvd_archive_evidence_headers
    SET source_archive_job_id = 'evidence-mismatched-archive-job'
    WHERE original_disc_archive_id = 'evidence-new-format-archive';
  `);
  provenanceTamperedDatabase.close();

  const provenanceTamperedAccess = createDataAccess({
    databasePath: provenanceTamperedPath,
  });
  expect(() => provenanceTamperedAccess.catalog.findDvdArchiveEvidenceHeader(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toThrow(
    "Persisted DVD Archive Evidence source job provenance is invalid",
  );
  provenanceTamperedAccess.close();

  const missingManifestPath = join(
    dirname(databasePath),
    "tampered-missing-current-manifest.sqlite",
  );
  copyFileSync(databasePath, missingManifestPath);
  const missingManifestAccess = createDataAccess({
    databasePath: missingManifestPath,
  });
  const missingManifestDatabase = new DatabaseSync(missingManifestPath);
  missingManifestDatabase.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER dvd_evidence_header_update_guard;
    UPDATE dvd_archive_evidence_headers
    SET current_manifest_id = 'missing-current-manifest'
    WHERE original_disc_archive_id = 'evidence-new-format-archive';
  `);
  missingManifestDatabase.close();

  expect(() => missingManifestAccess.catalog.findDvdArchiveEvidenceHeader(
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  )).toThrow(/authoritative links are incomplete/i);
  expect(() => missingManifestAccess.catalog.auditDvdArchiveEvidenceChains([
    "evidence-new-format-archive" as OriginalDiscArchiveId,
  ])).toThrow(/authoritative links are incomplete/i);
  missingManifestAccess.close();

  for (const brokenLink of [
    {
      suffix: "source-job",
      mutation: `
        DROP TRIGGER dvd_evidence_header_update_guard;
        UPDATE dvd_archive_evidence_headers
        SET source_archive_job_id = 'missing-source-job'
        WHERE original_disc_archive_id = 'evidence-new-format-archive';
      `,
    },
    {
      suffix: "source-request",
      mutation: `
        DROP TRIGGER dvd_evidence_archive_job_update_guard;
        UPDATE archive_jobs
        SET archive_request_id = 'missing-source-request'
        WHERE id = 'evidence-new-format-archive-job';
      `,
    },
    {
      suffix: "source-inspection",
      mutation: `
        DROP TRIGGER dvd_evidence_archive_job_update_guard;
        UPDATE archive_jobs
        SET disc_inspection_id = NULL
        WHERE id = 'evidence-new-format-archive-job';
      `,
    },
  ]) {
    const brokenLinkPath = join(
      dirname(databasePath),
      `tampered-missing-${brokenLink.suffix}.sqlite`,
    );
    copyFileSync(databasePath, brokenLinkPath);
    const brokenLinkAccess = createDataAccess({ databasePath: brokenLinkPath });
    const brokenLinkDatabase = new DatabaseSync(brokenLinkPath);
    brokenLinkDatabase.exec(`
      PRAGMA foreign_keys = OFF;
      ${brokenLink.mutation}
    `);
    brokenLinkDatabase.close();

    expect(() => brokenLinkAccess.catalog.findDvdArchiveEvidenceHeader(
      "evidence-new-format-archive" as OriginalDiscArchiveId,
    )).toThrow(/authoritative links are incomplete/i);
    expect(() => brokenLinkAccess.catalog.auditDvdArchiveEvidenceChains([
      "evidence-new-format-archive" as OriginalDiscArchiveId,
    ])).toThrow(/authoritative links are incomplete/i);
    brokenLinkAccess.close();
  }
});

it("fails closed instead of inventing checkpoint identities for interstitial evidence", () => {
  const databasePath = createDatabasePath("rip-dvd-evidence-checkpoint-guard-");
  const previousMigrations = createMigrationsThrough(
    "20260930003106_dvd-evidence-authority",
  );
  const previousAccess = createLegacySidecarDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();

  const interstitial = new DatabaseSync(databasePath);
  interstitial.exec(`
    INSERT INTO optical_drives (
      id, device_path, is_present, last_seen_at, created_at, updated_at
    ) VALUES ('synthetic-interstitial-drive', '/dev/synthetic', 1, 1, 1, 1);
    INSERT INTO detected_discs (
      id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
      created_at, updated_at
    ) VALUES (
      'synthetic-interstitial-disc', 'synthetic-interstitial-drive', 'dvd',
      'synthetic-interstitial-fingerprint', 'archived', 1, 1, 1
    );
    INSERT INTO disc_inspections (
      id, optical_drive_id, detected_disc_id, media_generation, is_current,
      status, phase, total_bytes, phase_started_at, attempt_started_at,
      started_at, completed_at, created_at, updated_at
    ) VALUES (
      'synthetic-interstitial-inspection', 'synthetic-interstitial-drive',
      'synthetic-interstitial-disc', 'synthetic-interstitial-generation', 1,
      'completed', 'confirming_media', 2048, 1, 1, 1, 1, 1, 1
    );
    INSERT INTO original_disc_archives (
      id, detected_disc_id, disc_kind, archive_format, archive_path,
      fingerprint, size_bytes, boundary_policy_version,
      boundary_reported_size_bytes, boundary_published_size_bytes,
      boundary_excluded_sector_count, integrity, archived_at, created_at,
      updated_at
    ) VALUES (
      'synthetic-interstitial-archive', 'synthetic-interstitial-disc', 'dvd',
      'iso', '/synthetic/interstitial.iso',
      'synthetic-interstitial-fingerprint', 2048, 'dvd-archive-boundary-v1',
      2048, 2048, 0, 'unknown', 1, 1, 1
    );
    INSERT INTO archive_requests (
      id, detected_disc_id, evidence_format, status, priority, fulfilled_at,
      created_at, updated_at
    ) VALUES (
      'synthetic-interstitial-request', 'synthetic-interstitial-disc',
      'dvd-recovery-evidence-v1', 'fulfilled', 0, 1, 1, 1
    );
    INSERT INTO archive_jobs (
      id, archive_request_id, disc_inspection_id, detected_disc_id,
      original_disc_archive_id, evidence_format, attempt_ordinal, status,
      priority, progress_phase, progress_percent, progress_bytes,
      last_progress_at, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'synthetic-interstitial-job', 'synthetic-interstitial-request',
      'synthetic-interstitial-inspection', 'synthetic-interstitial-disc',
      'synthetic-interstitial-archive', 'dvd-recovery-evidence-v1', 1,
      'completed', 0, 'finalizing', 100, 2048, 1, 1, 1, 1, 1
    );
    DROP TRIGGER dvd_evidence_header_insert_guard;
    INSERT INTO dvd_archive_evidence_headers (
      original_disc_archive_id, source_archive_job_id, evidence_format,
      accepted_end_lba_exclusive, unrecovered_source_ranges, created_at
    ) VALUES (
      'synthetic-interstitial-archive', 'synthetic-interstitial-job',
      'dvd-recovery-evidence-v1', 1,
      '[{"startLba":0,"sectorCount":1,"classification":"skipped_untested"}]',
      1
    );
  `);
  interstitial.close();

  expect(() => createDataAccess({ databasePath })).toThrow(
    /__dvd_evidence_checkpoint_migration_guard/i,
  );
});

it("preserves historical Encode Jobs without inventing Failure Reports", () => {
  const databasePath = createDatabasePath("rip-dvd-encode-report-migration-");
  const previousMigrations = createMigrationsThrough(
    "20260828164042_married_lady_ursula",
  );
  const previousAccess = createLegacySidecarDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();
  const job = seedEncodeJob(databasePath, "historical-encode");
  const historical = new DatabaseSync(databasePath);
  historical.prepare(`
    UPDATE encode_jobs SET status = 'failed', reserves_output_path = 0,
      error_message = ? WHERE id = ?
  `).run("HandBrake failed with status 9 and /private/legacy-path", job.id);
  historical.close();

  const migratedAccess = createDataAccess({ databasePath });
  expect(migratedAccess.encodeJobs.list()).toEqual([
    expect.objectContaining({
      id: job.id,
      status: "failed",
      errorMessage: "HandBrake failed with status 9 and /private/legacy-path",
    }),
  ]);
  expect(migratedAccess.encodeJobs.listFailureReports([job.id])).toEqual([]);
  migratedAccess.close();

  const sqlite = new DatabaseSync(databasePath);
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(sqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  sqlite.close();
});

it("migrates command reports and accepts every new Encode failure category", () => {
  const databasePath = createDatabasePath("rip-dvd-expanded-encode-report-");
  const commandReportMigrations = createMigrationsThrough(
    "20260901172324_glorious_cargill",
  );
  const previousAccess = createLegacySidecarDataAccess({
    databasePath,
    migrationsFolder: commandReportMigrations,
  });
  previousAccess.close();
  const job = seedEncodeJob(databasePath, "expanded-encode");
  const historicalSqlite = new DatabaseSync(databasePath);
  historicalSqlite.prepare(`
    UPDATE encode_jobs SET status = 'failed', reserves_output_path = 0,
      error_message = 'HandBrake command failed' WHERE id = ?
  `).run(job.id);
  historicalSqlite.prepare(`
    INSERT INTO encode_job_failure_reports (
      id, encode_job_id, schema_version, worker_kind, reason_code, phase,
      retryability, diagnostic, exit_status, signal, timeout_seconds,
      occurred_at, created_at
    ) VALUES (?, ?, 1, 'encode_worker', 'command_failed', 'encoding',
      'appropriate', 'historical command failure', 17, NULL, NULL, 1, 1)
  `).run("historical-command-report", job.id);
  historicalSqlite.close();

  const access = createDataAccess({ databasePath });
  expect(access.encodeJobs.listFailureReports([job.id])).toEqual([
    expect.objectContaining({
      reasonCode: "command_failed",
      evidence: { kind: "exit_status", exitStatus: 17 },
    }),
  ]);
  const reports = [
    {
      reasonCode: "input_unavailable",
      phase: "preparation",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "invalid_configuration",
      phase: "preparation",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "output_conflict",
      phase: "preparation",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "unsafe_output_state",
      phase: "preparation",
      evidence: { kind: "none" },
    },
    {
      reasonCode: "output_validation_failed",
      phase: "validation",
      evidence: {
        kind: "duration",
        expectedSeconds: 8_078,
        observedSeconds: 97.205,
      },
    },
    {
      reasonCode: "unknown_failure",
      phase: "publication",
      evidence: { kind: "none" },
    },
  ] as const;
  for (const [index, report] of reports.entries()) {
    access.encodeJobs.requeue(job.id);
    const claim = access.encodeJobs.claimNext(`expanded-worker-${index}`);
    if (!claim) throw new Error("Expected expanded report claim");
    access.encodeJobs.failWithReport(claim, {
      schemaVersion: 1,
      retryability: "after_action",
      diagnostic: `expanded failure ${index}`,
      ...report,
    });
  }
  expect(
    new Set(
      access.encodeJobs.listFailureReports([job.id]).map(({ reasonCode }) =>
        reasonCode
      ),
    ),
  ).toEqual(new Set([
    "command_failed",
    "input_unavailable",
    "invalid_configuration",
    "output_conflict",
    "unsafe_output_state",
    "output_validation_failed",
    "unknown_failure",
  ]));
  access.close();

  const sqlite = new DatabaseSync(databasePath);
  expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(sqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  sqlite.close();
});

it("preserves every previously accepted command Failure Report", () => {
  const databasePath = createDatabasePath(
    "rip-dvd-post-command-report-migration-",
  );
  const previousMigrations = createMigrationsThrough(
    "20260901183135_encode_preparation_validation_failures",
  );
  const previousAccess = createLegacySidecarDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  previousAccess.close();
  const job = seedEncodeJob(databasePath, "previous-command-report");

  const previousSqlite = new DatabaseSync(databasePath);
  previousSqlite.prepare(`
    UPDATE encode_jobs SET status = 'failed', reserves_output_path = 0,
      error_message = 'HandBrake command failed' WHERE id = ?
  `).run(job.id);
  const occurredAt = Date.parse("2026-09-01T17:30:00.000Z");
  previousSqlite.prepare(`
    INSERT INTO encode_job_failure_reports(
      id,
      encode_job_id,
      schema_version,
      worker_kind,
      reason_code,
      phase,
      retryability,
      diagnostic,
      exit_status,
      signal,
      timeout_seconds,
      occurred_at,
      created_at
    ) VALUES (?, ?, 1, 'encode_worker', 'command_failed', 'validation',
      'after_action', ?, 19, NULL, NULL, ?, ?)
  `).run(
    "previous-command-failure-report",
    job.id,
    "previous private diagnostic",
    occurredAt,
    occurredAt,
  );
  previousSqlite.close();

  const migratedAccess = createDataAccess({ databasePath });
  expect(migratedAccess.encodeJobs.listFailureReports([job.id])).toEqual([
    expect.objectContaining({
      id: "previous-command-failure-report",
      reasonCode: "command_failed",
      phase: "validation",
      retryability: "after_action",
      diagnostic: "previous private diagnostic",
      evidence: { kind: "exit_status", exitStatus: 19 },
    }),
  ]);
  migratedAccess.close();

  const migratedSqlite = new DatabaseSync(databasePath);
  expect(migratedSqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(migratedSqlite.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  migratedSqlite.close();
});
