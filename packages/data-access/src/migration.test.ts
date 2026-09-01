import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import { createDataAccess } from "./index.js";
import { completeCatalogReview } from "./catalog.test-support.js";
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
  access: ReturnType<typeof createLegacySidecarDataAccess>,
  key: string,
) {
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/${key}`,
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: `${key}-disc`,
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: `/originals/${key}.iso`,
    fingerprint: disc.fingerprint,
  });
  const item = access.catalog.createMediaItem({
    kind: "movie",
    title: key,
  });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  completeCatalogReview(access, archive.id);
  const profile = access.encodingProfiles.create({
    key,
    displayName: key,
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30" },
  });
  return access.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: `/media/${key}.mkv`,
  });
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

it("preserves historical Encode Jobs without inventing Failure Reports", () => {
  const databasePath = createDatabasePath("rip-dvd-encode-report-migration-");
  const previousMigrations = createMigrationsThrough(
    "20260828164042_married_lady_ursula",
  );
  const previousAccess = createLegacySidecarDataAccess({
    databasePath,
    migrationsFolder: previousMigrations,
  });
  const job = seedEncodeJob(previousAccess, "historical-encode");
  const claim = previousAccess.encodeJobs.claimNext("historical-worker");
  if (claim === null) {
    throw new Error("Expected historical Encode Job claim");
  }
  previousAccess.encodeJobs.fail(
    claim,
    "HandBrake failed with status 9 and /private/legacy-path",
  );
  previousAccess.close();

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
  const drive = previousAccess.catalog.upsertOpticalDrive({
    devicePath: "/dev/expanded-encode",
    isPresent: true,
  });
  const disc = previousAccess.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: "expanded-encode-disc",
  });
  previousAccess.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  previousAccess.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = previousAccess.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: "/originals/expanded-encode.iso",
    fingerprint: disc.fingerprint,
  });
  const item = previousAccess.catalog.createMediaItem({
    kind: "movie",
    title: "Expanded Encode Reports",
  });
  const selection = previousAccess.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  completeCatalogReview(previousAccess, archive.id);
  const profile = previousAccess.encodingProfiles.create({
    key: "expanded-encode",
    displayName: "Expanded encode",
    mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30" },
  });
  const job = previousAccess.encodeJobs.enqueue({
    discSelectionId: selection.id,
    encodingProfileId: profile.id,
    outputPath: "/media/expanded-encode.mkv",
  });
  const commandClaim = previousAccess.encodeJobs.claimNext("command-worker");
  if (!commandClaim) throw new Error("Expected command report claim");
  previousAccess.encodeJobs.fail(commandClaim, "HandBrake command failed");
  previousAccess.close();
  const historicalSqlite = new DatabaseSync(databasePath);
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
  const job = seedEncodeJob(previousAccess, "previous-command-report");
  const claim = previousAccess.encodeJobs.claimNext("previous-report-worker");
  if (claim === null) {
    throw new Error("Expected previous Encode Job claim");
  }
  previousAccess.encodeJobs.fail(claim, "HandBrake command failed");
  previousAccess.close();

  const previousSqlite = new DatabaseSync(databasePath);
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
