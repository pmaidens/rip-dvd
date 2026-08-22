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
