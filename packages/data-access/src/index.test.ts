import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCatalogReview } from "./catalog.test-support.js";
import { createRawDvdContentIdHasher } from "./dvd-content-id.js";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  createDataAccess,
  createDiscSelectionSourceIdentity,
  DVD_TITLE_MAP_SCHEMA_VERSION,
  DomainInvariantError,
  ENCODE_JOB_LEASE_DURATION_MS,
  InvalidStatusTransitionError,
  MAX_DVD_TITLES,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  RecordNotFoundError,
  StaleJobAttemptError,
} from "./index.js";
import type {
  DetectedDiscId,
  DiscKind,
  DiscInspectionId,
  DiscSelectionId,
  EncodeJobId,
  MediaItemId,
  OriginalDiscArchiveId,
  RunningEncodeJob,
} from "./index.js";
import type { EncodingProfileId } from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";

const temporaryDirectories: string[] = [];

type ConcurrentWorkerResult =
  | "ok"
  | {
      outcome:
        | "activated"
        | "archived"
        | "cancelled"
        | "cancellation_requested"
        | "claimed"
        | "completed"
        | "created"
        | "enqueued"
        | "rejected"
        | "reviewed"
        | "skipped"
        | "started"
        | "versioned";
      id?: string;
      version?: number;
    }
  | null;

type ConcurrentOperation =
  | {
      operation: "start-archive";
      discInspectionId: DiscInspectionId;
    }
  | { operation: "reject"; detectedDiscId: DetectedDiscId }
  | {
      operation: "archive";
      detectedDiscId: DetectedDiscId;
      discKind: DiscKind;
      archivePath: string;
      fingerprint: string;
    }
  | {
      operation: "create-profile-version";
      sourceProfileId: EncodingProfileId;
      preset: string;
    }
  | {
      operation: "activate-profile-version";
      id: EncodingProfileId;
    }
  | {
      operation: "enqueue-encode";
      discSelectionId: DiscSelectionId;
      encodingProfileId: EncodingProfileId;
      outputPath: string;
    }
  | { operation: "cancel-encode"; encodeJobId: EncodeJobId }
  | { operation: "complete-encode"; claim: RunningEncodeJob }
  | { operation: "claim-encode" }
  | {
      operation: "complete-catalog-review";
      originalDiscArchiveId: OriginalDiscArchiveId;
      catalogRevision: Date;
      catalogReviewOutcome?: "reviewed_with_selections" | "archive_only";
    }
  | {
      operation: "create-disc-selection";
      originalDiscArchiveId: OriginalDiscArchiveId;
      mediaItemId: MediaItemId;
    }
  | {
      operation: "create-media-item";
      parentId: MediaItemId;
      title: string;
    };

type BarrierWorkerOptions = {
  databasePath: string;
} & (
  | { mode: "open"; count: number }
  | { mode: "operation"; operations: readonly ConcurrentOperation[] }
);

async function runBarrierWorkers(
  options: BarrierWorkerOptions,
  hooks: {
    beforeRelease?(): void;
    afterRelease?(): Promise<void> | void;
    afterOperationsStart?(): Promise<void> | void;
  } = {},
): Promise<ConcurrentWorkerResult[]> {
  const { databasePath, mode } = options;
  const count = mode === "operation" ? options.operations.length : options.count;
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = Array.from(
    { length: count },
    (_, index) => {
      const operation =
        mode === "operation" ? options.operations[index] : undefined;
      return new Worker(
        new URL("../test/concurrency-worker.mjs", import.meta.url),
        {
          execArgv: ["--no-warnings"],
          workerData: {
            barrier,
            databasePath,
            mode,
            workerId: `${mode}-worker-${index}`,
            ...operation,
          },
        },
      );
    },
  );

  const ready = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (message: { type: string; value?: string }) => {
          if (message.type === "ready") {
            worker.off("message", onMessage);
            resolve();
          } else if (message.type === "failure") {
            worker.off("message", onMessage);
            reject(new Error(message.value));
          }
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
      }),
  );
  const results = workers.map(
    (worker) =>
      new Promise<ConcurrentWorkerResult>((resolve, reject) => {
        worker.on(
          "message",
          (message: { type: string; value?: ConcurrentWorkerResult }) => {
            if (message.type === "result") {
              resolve(message.value ?? null);
            } else if (message.type === "failure") {
              reject(new Error(String(message.value)));
            }
          },
        );
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`Concurrency worker exited with code ${code}`));
          }
        });
      }),
  );
  const operationStarts = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (message: { type: string }) => {
          if (message.type === "operation-started") {
            worker.off("message", onMessage);
            resolve();
          }
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
      }),
  );

  await Promise.all(ready);
  hooks.beforeRelease?.();
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, count);
  const workerResults = Promise.all(results);
  await hooks.afterRelease?.();
  if (hooks.afterOperationsStart) {
    await Promise.all(operationStarts);
    await hooks.afterOperationsStart();
  }
  return workerResults;
}

function createTestDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-data-access-"));
  temporaryDirectories.push(directory);
  return join(directory, "rip-dvd.sqlite");
}

function createTestMigrationsFolder(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

function openTestDatabase(databasePath = createTestDatabasePath()) {
  return createLegacySidecarDataAccess({ databasePath });
}

function completeDiscInspection(
  access: ReturnType<typeof openTestDatabase>,
  input: {
    opticalDriveId: Parameters<
      ReturnType<typeof openTestDatabase>["discInspections"]["beginOrResume"]
    >[0]["opticalDriveId"];
    mediaGeneration: string;
    fingerprint: string;
  },
) {
  const started = access.discInspections.beginOrResume({
    opticalDriveId: input.opticalDriveId,
    mediaGeneration: input.mediaGeneration,
  });
  if (!started.claim) {
    throw new Error("Expected a new Disc Inspection claim");
  }
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: input.opticalDriveId,
    discKind: "dvd",
    fingerprint: input.fingerprint,
  });
  const scanned = disc.status === "detected"
    ? access.catalog.updateDetectedDiscStatus(disc.id, "scanned")
    : disc;
  const inspection = access.discInspections.record(started.claim, {
    type: "complete",
    detectedDiscId: scanned.id,
  });
  return { claim: started.claim, disc: scanned, inspection };
}

const invalidMediaItemFields = [
  ["blank title", "title", "   "],
  ["non-string title", "title", 42],
  ["year below the supported range", "year", 1799],
  ["year above the supported range", "year", 10_000],
  ["fractional year", "year", 2000.5],
  ["non-number year", "year", "2000"],
  ["negative season number", "seasonNumber", -1],
  ["fractional season number", "seasonNumber", 0.5],
  ["unsafe season number", "seasonNumber", Number.MAX_SAFE_INTEGER + 1],
  ["non-number season number", "seasonNumber", "1"],
  ["zero episode number", "episodeNumber", 0],
  ["fractional episode number", "episodeNumber", 1.5],
  ["unsafe episode number", "episodeNumber", Number.MAX_SAFE_INTEGER + 1],
  ["non-number episode number", "episodeNumber", "1"],
] as const;

const invalidMediaItemKinds = ["unsupported", null, 42] as const;

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("data-access facade", () => {
  it("keeps every attached drive lane while bounding all missing-drive history", () => {
    const access = openTestDatabase();
    for (let index = 0; index < 32; index += 1) {
      access.catalog.upsertOpticalDrive({
        devicePath: `/dev/sr${index}`,
        isEnabled: index % 2 === 0,
        isPresent: true,
      });
    }
    for (let index = 32; index < 92; index += 1) {
      access.catalog.upsertOpticalDrive({
        devicePath: `/dev/sr${index}`,
        isEnabled: false,
        isPresent: false,
      });
    }

    const activity = access.catalog.listOpticalDrives({ historicalLimit: 20 });

    expect(activity.filter((drive) => drive.isPresent)).toHaveLength(32);
    expect(activity.filter((drive) => !drive.isPresent)).toHaveLength(20);
    expect(activity).toHaveLength(52);
    access.close();
  });

  it("keeps every configured missing drive plus bounded disabled history", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const access = openTestDatabase();
    const configuredDrives = Array.from({ length: 25 }, (_, index) =>
      access.catalog.upsertOpticalDrive({
        devicePath: `/dev/configured-${index}`,
        isEnabled: true,
        isPresent: false,
      }),
    );
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    for (let index = 0; index < 25; index += 1) {
      access.catalog.upsertOpticalDrive({
        devicePath: `/dev/missing-${index}`,
        isEnabled: false,
        isPresent: false,
      });
    }

    const activity = access.catalog.listOpticalDrives({ historicalLimit: 20 });

    expect(
      activity.filter((drive) => drive.isEnabled && !drive.isPresent),
    ).toEqual(
      expect.arrayContaining(
        configuredDrives.map((drive) =>
          expect.objectContaining({ id: drive.id }),
        ),
      ),
    );
    expect(
      activity.filter((drive) => !drive.isEnabled && !drive.isPresent),
    ).toHaveLength(20);
    expect(activity).toHaveLength(45);
    access.close();
  });

  it("keeps live Detected Disc review work ahead of bounded terminal history", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const reviewDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "older-live-review",
      volumeLabel: "OLDER_LIVE_REVIEW",
    });
    access.catalog.updateDetectedDiscStatus(reviewDisc.id, "scanned");
    for (let index = 0; index < 30; index += 1) {
      const terminal = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `terminal-${index}`,
        volumeLabel: `TERMINAL_${index}`,
      });
      access.catalog.updateDetectedDiscStatus(terminal.id, "rejected");
    }

    const activity = access.catalog.listDetectedDiscs(undefined, {
      policy: {
        mode: "active-and-history",
        activeLimit: 100,
        historyLimit: 20,
      },
    });

    expect(activity).toHaveLength(21);
    expect(activity).toContainEqual(
      expect.objectContaining({ id: reviewDisc.id, status: "scanned" }),
    );
    expect(activity.filter((disc) => disc.status === "rejected")).toHaveLength(
      20,
    );
    access.close();
  });

  it("applies explicit independent bounds to live and terminal Detected Discs", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    for (let index = 0; index < 105; index += 1) {
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `live-${index}`,
      });
    }
    for (let index = 0; index < 30; index += 1) {
      const terminal = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `history-${index}`,
      });
      access.catalog.updateDetectedDiscStatus(terminal.id, "rejected");
    }

    const activity = access.catalog.listDetectedDiscs(undefined, {
      policy: {
        mode: "active-and-history",
        activeLimit: 100,
        historyLimit: 20,
      },
    });

    expect(
      activity.filter((disc) =>
        ["detected", "scanned", "approved"].includes(disc.status),
      ),
    ).toHaveLength(100);
    expect(
      activity.filter((disc) => ["archived", "rejected"].includes(disc.status)),
    ).toHaveLength(20);
    access.close();
  });

  it("rejects activity policy combined with explicit status filters", () => {
    const access = openTestDatabase();

    expect(() =>
      access.catalog.listDetectedDiscs(["detected"], {
        policy: {
          mode: "active-and-history",
          activeLimit: 100,
          historyLimit: 20,
        },
      }),
    ).toThrowError(
      new DomainInvariantError(
        "active-and-history list policy cannot be combined with explicit statuses",
      ),
    );

    access.close();
  });

  it("does not expose migration-only legacy sidecar state", () => {
    const access = createDataAccess({ databasePath: createTestDatabasePath() });

    expect(Object.keys(access)).not.toContain("legacySidecars");
    expect("legacySidecars" in access).toBe(false);

    access.close();
  });

  it("migrates a persistent database and reports its SQLite configuration", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);

    expect(access.checkHealth()).toMatchObject({
      status: "ok",
      journalMode: "wal",
      busyTimeoutMs: 5_000,
    });

    access.close();

    const sqlite = new DatabaseSync(databasePath);
    const identifierTables = sqlite
      .prepare(`
        select name, sql
        from sqlite_schema
        where type = 'table' and name not like '__drizzle_%'
        order by name
      `)
      .all() as Array<{ name: string; sql: string }>;
    expect(identifierTables.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "archive_requests",
        "disc_inspection_attempts",
        "disc_inspections",
      ]),
    );
    expect(identifierTables).toHaveLength(13);
    expect(
      identifierTables.every(({ name, sql }) =>
        name === "legacy_cutover_staged_sidecars"
          ? sql.includes(
              "PRIMARY KEY(`originals_library_path`, `sidecar_path`)",
            )
          : sql.includes(`${name}_id_not_null`),
      ),
    ).toBe(true);
    expect(() =>
      sqlite.exec(`
        insert into optical_drives (
          id, device_path, is_present, last_seen_at, created_at, updated_at
        ) values (null, '/dev/null', 1, 0, 0, 0)
      `),
    ).toThrow();
    sqlite.close();

    const reopened = openTestDatabase(databasePath);
    expect(reopened.checkHealth().status).toBe("ok");
    reopened.close();
  });

  it("serializes simultaneous first openers of a fresh database", async () => {
    for (let round = 0; round < 3; round += 1) {
      const results = await runBarrierWorkers({
        count: 8,
        databasePath: createTestDatabasePath(),
        mode: "open",
      });
      expect(results).toEqual(Array.from({ length: 8 }, () => "ok"));
    }
  });

  it("migrates archive intent separately from started Archive Job attempts", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name))
      .filter(
        (name) => name !== "20260812151540_disc-inspection-archive-requests",
      )
      .sort();
    for (const migrationName of predecessorNames) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      create table __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
    `);
    const recordMigration = sqlite.prepare(`
      insert into __drizzle_migrations (hash, created_at, name)
      values (?, 0, ?)
    `);
    for (const migrationName of predecessorNames) {
      recordMigration.run(`predecessor-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_enabled, is_present, last_seen_at, created_at,
        updated_at
      ) values ('migration-drive', '/dev/sr0', 1, 1, 1, 1, 1);

      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values
        ('queued-disc', 'migration-drive', 'dvd', 'queued-fingerprint',
          'approved', 10, 10, 10),
        ('inspecting-disc', 'migration-drive', 'dvd', 'inspecting-fingerprint',
          'approved', 20, 20, 20),
        ('running-disc', 'migration-drive', 'dvd', 'running-fingerprint',
          'approved', 30, 30, 30),
        ('completed-disc', 'migration-drive', 'dvd', 'completed-fingerprint',
          'archived', 40, 40, 40),
        ('failed-disc', 'migration-drive', 'dvd', 'failed-fingerprint',
          'approved', 50, 50, 50),
        ('approved-without-job', 'migration-drive', 'dvd',
          'approved-without-job-fingerprint', 'approved', 60, 60, 60);

      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, created_at, updated_at
      ) values (
        'completed-archive', 'completed-disc', 'dvd', 'iso',
        '/media/originals/completed.iso', 'completed-fingerprint', 45, 45, 45
      );

      insert into archive_jobs (
        id, detected_disc_id, status, priority, progress_phase,
        progress_percent, created_at, updated_at
      ) values (
        'queued-job', 'queued-disc', 'queued', 50, 'waiting', 0, 10, 10
      );
      insert into archive_jobs (
        id, detected_disc_id, status, priority, progress_phase,
        progress_percent, inspection_token, inspection_updated_at,
        created_at, updated_at
      ) values (
        'inspecting-job', 'inspecting-disc', 'queued', 40,
        'inspecting_drive', 0, 'inspection-token', 20, 20, 20
      );
      insert into archive_jobs (
        id, detected_disc_id, status, priority, progress_phase,
        progress_percent, claimed_by, claim_token, claimed_at, started_at,
        created_at, updated_at
      ) values (
        'running-job', 'running-disc', 'running', 30, 'copying', 35,
        'worker', 'running-token', 31, 31, 30, 32
      );
      insert into archive_jobs (
        id, detected_disc_id, original_disc_archive_id, status, priority,
        progress_phase, progress_percent, claimed_by, claim_token, claimed_at,
        started_at, completed_at, created_at, updated_at
      ) values (
        'completed-job', 'completed-disc', 'completed-archive', 'completed',
        20, 'finalizing', 100, 'worker', 'completed-token', 41, 41, 45, 40, 45
      );
      insert into archive_jobs (
        id, detected_disc_id, status, priority, progress_phase,
        progress_percent, claimed_by, claim_token, claimed_at, started_at,
        error_message, created_at, updated_at
      ) values (
        'failed-job', 'failed-disc', 'failed', 10, 'copying', 55,
        'worker', 'failed-token', 51, 51, 'read failed', 50, 52
      );
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.archiveRequests.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detectedDiscId: "queued-disc", status: "pending" }),
        expect.objectContaining({ detectedDiscId: "inspecting-disc", status: "pending" }),
        expect.objectContaining({ detectedDiscId: "running-disc", status: "running" }),
        expect.objectContaining({ detectedDiscId: "completed-disc", status: "fulfilled" }),
        expect.objectContaining({ detectedDiscId: "failed-disc", status: "needs_attention" }),
        expect.objectContaining({
          detectedDiscId: "approved-without-job",
          status: "pending",
        }),
      ]),
    );
    expect(migrated.archiveJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "running-job",
          attemptOrdinal: 1,
          status: "running",
        }),
        expect.objectContaining({
          id: "completed-job",
          attemptOrdinal: 1,
          status: "completed",
        }),
        expect.objectContaining({
          id: "failed-job",
          attemptOrdinal: 1,
          status: "failed",
        }),
      ]),
    );
    expect(migrated.archiveJobs.list()).toHaveLength(3);
    migrated.close();

    const verified = new DatabaseSync(databasePath);
    expect(verified.prepare("pragma foreign_key_check").all()).toEqual([]);
    verified.close();
  });

  it("keeps cross-query reads coherent while another facade commits", () => {
    const databasePath = createTestDatabasePath();
    const reader = openTestDatabase(databasePath);
    const writer = openTestDatabase(databasePath);
    const drive = writer.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = writer.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "consistent-snapshot-disc",
    });
    writer.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = writer.archiveRequests.create({ detectedDiscId: disc.id });

    const snapshot = reader.readConsistentSnapshot((snapshotAccess) => {
      const detectedDiscsBeforeCommit =
        snapshotAccess.catalog.listDetectedDiscs();
      writer.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: "/media/originals/Consistent Snapshot.iso",
        fingerprint: "consistent-snapshot-disc",
      });

      return {
        detectedDiscsBeforeCommit,
        detectedDiscsAfterCommit:
          snapshotAccess.catalog.listDetectedDiscs(),
        archiveRequestsAfterCommit: snapshotAccess.archiveRequests.list(),
        archivesAfterCommit:
          snapshotAccess.catalog.listOriginalDiscArchives(),
      };
    });

    expect(snapshot.detectedDiscsBeforeCommit).toEqual([
      expect.objectContaining({ id: disc.id, status: "approved" }),
    ]);
    expect(snapshot.detectedDiscsAfterCommit).toEqual([
      expect.objectContaining({ id: disc.id, status: "approved" }),
    ]);
    expect(snapshot.archiveRequestsAfterCommit).toEqual([
      expect.objectContaining({ id: request.id, status: "pending" }),
    ]);
    expect(snapshot.archivesAfterCommit).toEqual([]);
    expect(reader.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({ id: disc.id, status: "archived" }),
    ]);
    expect(reader.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(reader.catalog.listOriginalDiscArchives()).toHaveLength(1);

    reader.close();
    writer.close();
  });

  it("creates the catalog graph and enforces its domain uniqueness rules", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Internal DVD drive",
      isPresent: true,
    });
    const rediscoveredDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    expect(rediscoveredDrive).toMatchObject({
      id: drive.id,
      displayName: "Internal DVD drive",
    });

    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "disc-fingerprint",
      volumeLabel: "MY_MOVIE",
    });
    expect(
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: "disc-fingerprint",
        volumeLabel: "MY_MOVIE",
      }).id,
    ).toBe(disc.id);
    expect(() =>
      access.catalog.updateDetectedDiscStatus(disc.id, "approved"),
    ).toThrow(InvalidStatusTransitionError);
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id, status: "approved" }),
    ]);

    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/My Movie/My Movie.iso",
      fingerprint: "disc-fingerprint",
    });
    expect(() =>
      access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: "/media/originals/My Movie/copy.iso",
        fingerprint: "disc-fingerprint",
      }),
    ).toThrow();
    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual([
      expect.objectContaining({ id: disc.id, status: "archived" }),
    ]);

    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "My Movie",
      year: 2001,
    });
    const trailer = access.catalog.createMediaItem({
      kind: "trailer",
      title: "My Movie Trailer",
      parentId: movie.id,
    });
    expect(access.catalog.listMediaItems()).toEqual([
      expect.objectContaining({ id: movie.id, parentId: null }),
      expect.objectContaining({ id: trailer.id, parentId: movie.id }),
    ]);

    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: createDiscSelectionSourceIdentity({
        kind: "main_feature",
      }),
    });
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        sourceIdentity: createDiscSelectionSourceIdentity({
          kind: "main_feature",
        }),
      }),
    ).toThrow();

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, fingerprint: "disc-fingerprint" }),
    ]);
    expect(selection.mediaItemId).toBe(movie.id);
    expect(selection.sourceIdentity).toEqual({ kind: "main_feature" });
    access.close();
  });

  it("creates a Mapping Proposal atomically against the current catalog revision", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"b".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [2, 3, 4, 5].map((number) => ({
          number,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Atomic Proposal.iso",
      fingerprint: contentId,
    });

    const created = access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      mediaItem: {
        kind: "movie",
        title: "Atomic Proposal",
        year: 2005,
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        label: "Disc two",
      },
    });

    expect(created.mediaItem).toMatchObject({
      kind: "movie",
      title: "Atomic Proposal",
      year: 2005,
    });
    expect(created.discSelection).toMatchObject({
      mediaItemId: created.mediaItem.id,
      originalDiscArchiveId: archive.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      label: "Disc two",
    });

    const mediaItemsBeforeFailure = access.catalog.listMediaItems();
    const selectionsBeforeFailure = access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    });
    expect(() =>
      access.catalog.createMappingProposal({
        originalDiscArchiveId: archive.id,
        catalogRevision: archive.updatedAt,
        mediaItem: { kind: "movie", title: "Stale Proposal" },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        },
      })
    ).toThrow("Catalog review changed; reload before saving Mapping Proposal");
    expect(access.catalog.listMediaItems()).toEqual(mediaItemsBeforeFailure);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(selectionsBeforeFailure);

    const currentRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    expect(() =>
      access.catalog.createMappingProposal({
        originalDiscArchiveId: archive.id,
        catalogRevision: currentRevision,
        mediaItem: { kind: "movie", title: "Duplicate Proposal" },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        },
      })
    ).toThrow();
    expect(access.catalog.listMediaItems()).toEqual(mediaItemsBeforeFailure);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(selectionsBeforeFailure);

    const unconventionalParent = access.catalog.createMediaItem({
      kind: "other",
      title: "Imported unconventional parent",
    });
    expect(access.catalog.createMediaItem({
      parentId: unconventionalParent.id,
      kind: "bonus_feature",
      title: "Flexible general-editor child",
    })).toMatchObject({ parentId: unconventionalParent.id });
    const catalogBeforeAssistedValidation = {
      mediaItems: access.catalog.listMediaItems(),
      discSelections: access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
      }),
    };
    expect(() => access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: currentRevision,
      mediaItem: {
        parentId: unconventionalParent.id,
        kind: "bonus_feature",
        title: "Invalid assisted child",
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
      },
    })).toThrow(
      "Assisted Mapping can attach a Trailer or Bonus Feature only",
    );
    expect(access.catalog.listMediaItems()).toEqual(
      catalogBeforeAssistedValidation.mediaItems,
    );
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(catalogBeforeAssistedValidation.discSelections);

    const attachedExtra = access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: currentRevision,
      mediaItem: {
        parentId: created.mediaItem.id,
        kind: "bonus_feature",
        title: "Valid assisted child",
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
      },
    });
    expect(attachedExtra.mediaItem).toMatchObject({
      parentId: created.mediaItem.id,
      kind: "bonus_feature",
    });
    const revisionAfterExtra = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    const existingItem = access.catalog.createMediaItem({
      kind: "other",
      title: "Existing catalog identity",
    });
    const itemCountBeforeReuse = access.catalog.listMediaItems().length;
    const reused = access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: revisionAfterExtra,
      existingMediaItemId: existingItem.id,
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
      },
    });
    expect(reused).toMatchObject({
      mediaItem: { id: existingItem.id, title: "Existing catalog identity" },
      discSelection: {
        mediaItemId: existingItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
      },
    });
    expect(access.catalog.listMediaItems()).toHaveLength(itemCountBeforeReuse);
    const revisionAfterReuse = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    expect(() => access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: revisionAfterReuse,
      mediaItem: { kind: "season", title: "Unnumbered Season" },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 5 },
      },
    })).toThrow(
      "Assisted Mapping requires a numbered Season beneath a TV Show",
    );
    access.close();
  });

  it("creates one numbered Episode and whole-title Disc Selection per episodic proposal entry", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"6".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [2, 4, 7].map((number) => ({
          number,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Episodic Proposal.iso",
      fingerprint: contentId,
    });

    const created = access.catalog.createEpisodicMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      tvShow: {
        choice: "create_new",
        title: "Example Show",
        year: 2004,
      },
      season: {
        choice: "create_new",
        title: "Example Show Season 2",
        seasonNumber: 2,
      },
      episodes: [
        { titleNumber: 2, title: "Arrival", episodeNumber: 7 },
        { titleNumber: 4, title: "Departure", episodeNumber: 9 },
        { titleNumber: 7, title: "Return", episodeNumber: 8 },
      ],
    });

    expect(created).toMatchObject({
      tvShow: {
        kind: "tv_show",
        parentId: null,
        title: "Example Show",
        year: 2004,
      },
      season: {
        kind: "season",
        title: "Example Show Season 2",
        seasonNumber: 2,
      },
      episodes: [
        {
          mediaItem: { kind: "episode", title: "Arrival", episodeNumber: 7 },
          discSelection: {
            sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
          },
        },
        {
          mediaItem: { kind: "episode", title: "Departure", episodeNumber: 9 },
          discSelection: {
            sourceIdentity: { kind: "dvd_title", titleNumber: 4 },
          },
        },
        {
          mediaItem: { kind: "episode", title: "Return", episodeNumber: 8 },
          discSelection: {
            sourceIdentity: { kind: "dvd_title", titleNumber: 7 },
          },
        },
      ],
    });
    expect(created.season.parentId).toBe(created.tvShow.id);
    expect(created.episodes.every(({ mediaItem, discSelection }) =>
      mediaItem.parentId === created.season.id &&
      discSelection.mediaItemId === mediaItem.id
    )).toBe(true);
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(3);
    access.close();
  });

  it("reuses an explicit TV Show and can create or reuse its numbered Season", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"7".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [1, 2].map((number) => ({
          number,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        })),
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Reused Episodic Hierarchy.iso",
      fingerprint: contentId,
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Existing Show",
    });
    const firstSeason = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Existing Season",
      seasonNumber: 1,
    });

    const reused = access.catalog.createEpisodicMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      tvShow: { choice: "use_existing", mediaItemId: show.id },
      season: { choice: "use_existing", mediaItemId: firstSeason.id },
      episodes: [{ titleNumber: 1, title: "First", episodeNumber: 1 }],
    });
    const revision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    const createdSeason = access.catalog.createEpisodicMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: revision,
      tvShow: { choice: "use_existing", mediaItemId: show.id },
      season: {
        choice: "create_new",
        title: "Existing Show Season 2",
        seasonNumber: 2,
      },
      episodes: [{ titleNumber: 2, title: "Second", episodeNumber: 1 }],
    });

    expect(reused).toMatchObject({
      tvShow: { id: show.id },
      season: { id: firstSeason.id },
    });
    expect(createdSeason).toMatchObject({
      tvShow: { id: show.id },
      season: {
        parentId: show.id,
        kind: "season",
        seasonNumber: 2,
      },
    });
    expect(access.catalog.listMediaItems()).toHaveLength(5);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(2);
    access.close();
  });

  it("applies bounded offset pagination consistently across catalog lists", () => {
    vi.useFakeTimers();
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const catalogEntries = Array.from({ length: 3 }, (_, index) => {
      vi.setSystemTime(new Date(`2026-08-10T12:00:0${index}.000Z`));
      const fingerprint = `bounded-catalog-page-${index}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/Bounded Catalog Page ${index}.iso`,
        fingerprint,
      });
      const mediaItem = access.catalog.createMediaItem({
        kind: "movie",
        title: `Bounded Catalog Page ${index}`,
      });
      const discSelection = access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "main_feature" },
      });
      return { archive, mediaItem, discSelection };
    });

    expect(access.catalog.listOriginalDiscArchives({ limit: 1, offset: 1 }))
      .toEqual([expect.objectContaining({ id: catalogEntries[1]!.archive.id })]);
    expect(access.catalog.listMediaItems({ limit: 1, offset: 1 })).toEqual([
      expect.objectContaining({ id: catalogEntries[1]!.mediaItem.id }),
    ]);
    expect(access.catalog.searchMediaItems({
      query: "Bounded_Catalog",
      limit: 1,
      offset: 1,
    })).toEqual([
      expect.objectContaining({ id: catalogEntries[1]!.mediaItem.id }),
    ]);
    const unicodeMediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Été à Montréal",
    });
    expect(access.catalog.searchMediaItems({
      query: "ÉTÉ_MONTRÉAL",
      limit: 1,
    })).toEqual([
      expect.objectContaining({ id: unicodeMediaItem.id }),
    ]);
    expect(access.catalog.listDiscSelections({ limit: 1, offset: 1 })).toEqual([
      expect.objectContaining({ id: catalogEntries[1]!.discSelection.id }),
    ]);

    expect(() => access.catalog.listOriginalDiscArchives({ offset: 1 }))
      .toThrow("Original Disc Archive offset requires a bounded limit");
    expect(() => access.catalog.listMediaItems({ offset: 1 }))
      .toThrow("Media Item offset requires a bounded limit");
    expect(() => access.catalog.searchMediaItems({
      query: "Bounded",
      limit: 101,
    })).toThrow(
      "Media Item search limit must be a safe integer between 1 and 100",
    );
    expect(() => access.catalog.listDiscSelections({ offset: 1 }))
      .toThrow("Disc Selection offset requires a bounded limit");
    access.close();
  });

  it("lists bounded Catalog Review views with reviewed search and outcome filters", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const createArchive = (suffix: string, volumeLabel: string) => {
      const fingerprint = `catalog-review-history-${suffix}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      return access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/${suffix}.iso`,
        fingerprint,
      });
    };
    const pending = createArchive("pending", "QUEUE_DISC");
    const reviewed = createArchive("reviewed", "HIDDEN_LABEL");
    const archiveOnly = createArchive("archive-only", "ARCHIVE_ONLY_FIND");
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Needle Movie",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: reviewed.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, reviewed.id);
    access.catalog.completeCatalogReview(
      archiveOnly.id,
      archiveOnly.updatedAt,
      "archive_only",
    );

    expect(access.catalog.listCatalogReviewArchives({
      view: "needs_review",
      limit: 20,
    })).toEqual([
      expect.objectContaining({ id: pending.id, discLabel: "QUEUE_DISC" }),
    ]);
    expect(access.catalog.listCatalogReviewArchives({
      view: "reviewed",
      query: "needle",
      limit: 20,
    })).toEqual([
      expect.objectContaining({
        id: reviewed.id,
        catalogReviewOutcome: "reviewed_with_selections",
        mappedMediaItemCount: 1,
        mappedMediaItemTitles: ["Needle Movie"],
      }),
    ]);
    expect(access.catalog.listCatalogReviewArchives({
      view: "reviewed",
      query: "archive only find",
      outcome: "archive_only",
      limit: 20,
    })).toEqual([
      expect.objectContaining({
        id: archiveOnly.id,
        discLabel: "ARCHIVE_ONLY_FIND",
        mappedMediaItemCount: 0,
        mappedMediaItemTitles: [],
      }),
    ]);
    expect(access.catalog.listCatalogReviewArchives({
      view: "reviewed",
      outcome: "reviewed_with_selections",
      limit: 20,
    }).map(({ id }) => id)).toEqual([reviewed.id]);
    expect(() => access.catalog.listCatalogReviewArchives({
      view: "reviewed",
      limit: 101,
    })).toThrow("Catalog Review archive limit must be between 1 and 100");
    access.close();
  });

  it("keeps partially cataloged archives in review until review is explicitly completed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T18:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "catalog-review-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Catalog Review.iso",
      fingerprint: "catalog-review-disc",
    });

    expect(archive.catalogReviewedAt).toBeNull();
    expect(
      access.catalog.listOriginalDiscArchives({ needsCatalogReviewOnly: true }),
    ).toEqual([expect.objectContaining({ id: archive.id })]);

    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Catalog Review",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    expect(
      access.catalog.listOriginalDiscArchives({ needsCatalogReviewOnly: true }),
    ).toEqual([expect.objectContaining({ id: archive.id })]);

    vi.setSystemTime(new Date("2026-08-03T18:05:00.000Z"));
    expect(completeCatalogReview(access, archive.id)).toMatchObject({
      id: archive.id,
      catalogReviewedAt: new Date("2026-08-03T18:05:00.000Z"),
    });
    expect(
      access.catalog.listOriginalDiscArchives({ needsCatalogReviewOnly: true }),
    ).toEqual([]);
    access.close();
  });

  it("persists an explicit Archive-only Review and reopens it when a Disc Selection is added", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "archive-only-review-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Archive Only Review.iso",
      fingerprint: "archive-only-review-disc",
    });
    const completeReview = access.catalog.completeCatalogReview as unknown as (
      id: OriginalDiscArchiveId,
      revision: Date,
      outcome: "reviewed_with_selections" | "archive_only",
    ) => ReturnType<typeof access.catalog.completeCatalogReview> & {
      catalogReviewOutcome: string;
    };

    expect(archive).toMatchObject({
      catalogReviewedAt: null,
      catalogReviewOutcome: "needs_review",
    });
    expect(() =>
      completeReview(archive.id, archive.updatedAt, "reviewed_with_selections")
    ).toThrow("Catalog review requires at least one Disc Selection");

    const archiveOnly = completeReview(
      archive.id,
      archive.updatedAt,
      "archive_only",
    );
    expect(archiveOnly).toMatchObject({
      catalogReviewedAt: expect.any(Date),
      catalogReviewOutcome: "archive_only",
    });
    expect(access.catalog.listOriginalDiscArchives({
      needsCatalogReviewOnly: true,
    })).toEqual([]);
    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .toEqual([]);

    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Archive-only Review Reopened",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: mediaItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const reopened = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]! as typeof archive & { catalogReviewOutcome: string };
    expect(reopened).toMatchObject({
      catalogReviewedAt: null,
      catalogReviewOutcome: "needs_review",
    });
    expect(reopened.updatedAt.getTime()).toBeGreaterThan(
      archiveOnly.updatedAt.getTime(),
    );
    expect(() =>
      completeReview(reopened.id, reopened.updatedAt, "archive_only")
    ).toThrow("Archive-only Review cannot contain Disc Selections");

    const reviewedWithSelections = completeReview(
      reopened.id,
      reopened.updatedAt,
      "reviewed_with_selections",
    );
    expect(reviewedWithSelections).toMatchObject({
      catalogReviewedAt: expect.any(Date),
      catalogReviewOutcome: "reviewed_with_selections",
    });
    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .toHaveLength(1);
    access.close();
  });

  it("never leaves Archive-only Review approved after a concurrent Disc Selection is created", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "concurrent-archive-only-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Concurrent Archive Only.iso",
      fingerprint: "concurrent-archive-only-disc",
    });
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Concurrent Archive-only Selection",
    });

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        {
          operation: "complete-catalog-review",
          originalDiscArchiveId: archive.id,
          catalogRevision: archive.updatedAt,
          catalogReviewOutcome: "archive_only",
        },
        {
          operation: "create-disc-selection",
          originalDiscArchiveId: archive.id,
          mediaItemId: mediaItem.id,
        },
      ],
    });

    const outcomes = results.map((result) =>
      typeof result === "object" && result !== null
        ? result.outcome
        : result,
    );
    expect(outcomes).toContain("created");
    expect(outcomes.every((outcome) =>
      outcome === "created" || outcome === "reviewed" || outcome === "rejected"
    )).toBe(true);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(1);
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
      });
    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .toEqual([]);
    access.close();
  });

  it("reopens catalog review when a Disc Selection is added after completion", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"a".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Reopened Review.iso",
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Main Movie",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);

    const episode = access.catalog.createMediaItem({
      kind: "episode",
      title: "Newly Found Episode",
    });
    const added = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      },
    });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(
      access.catalog.listOriginalDiscArchives({ needsCatalogReviewOnly: true }),
    ).toEqual([expect.objectContaining({ id: archive.id })]);

    const profile = access.encodingProfiles.create({
      key: "review-boundary",
      displayName: "Review boundary",
      mediaDomain: "dvd_video",
      settings: {},
    });
    expect(() =>
      access.encodeJobs.enqueue({
        discSelectionId: added.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Newly Found Episode.mkv",
      }),
    ).toThrow(DomainInvariantError);
    completeCatalogReview(access, archive.id);
    expect(
      access.encodeJobs.enqueue({
        discSelectionId: added.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Newly Found Episode.mkv",
      }),
    ).toMatchObject({ status: "queued" });
    access.close();
  });

  it("uses identical archived DVD coordinates for creation, repair, and review completion", () => {
    const databasePath = createTestDatabasePath();
    let access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"c".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 2,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Coordinate Decisions.iso",
      fingerprint: contentId,
    });
    const episode = access.catalog.createMediaItem({
      kind: "episode",
      title: "Coordinate Decisions",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 3,
        chapterEnd: 6,
      },
    });
    expect(selection).toMatchObject({
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 3,
        chapterEnd: 6,
      },
    });

    const repaired = access.catalog.repairDiscSelection(selection.id, {
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 4,
        chapterEnd: 8,
      },
    });
    expect(repaired).toMatchObject({
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 4,
        chapterEnd: 8,
      },
    });

    const outOfBounds = {
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: {
        kind: "dvd_chapters" as const,
        titleNumber: 2,
        chapterStart: 7,
        chapterEnd: 9,
      },
    };
    const chapterError = /must not exceed DVD title 2's 8 chapters/;
    expect(() => access.catalog.createDiscSelection(outOfBounds))
      .toThrow(chapterError);
    expect(() => access.catalog.repairDiscSelection(repaired.id, outOfBounds))
      .toThrow(chapterError);
    expect(completeCatalogReview(access, archive.id)).toMatchObject({
      catalogReviewedAt: expect.any(Date),
    });
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(
      `update disc_selections
       set source_key = 'dvd:title:2:chapters:4-9', chapter_end = 9
       where id = ?`,
    ).run(repaired.id);
    sqlite.close();

    access = openTestDatabase(databasePath);
    expect(() => completeCatalogReview(access, archive.id))
      .toThrow(chapterError);
    access.close();
  });

  it("uses identical archived DVD scan and title decisions across selection callers", () => {
    const databasePath = createTestDatabasePath();
    let access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const createArchive = (
      suffix: string,
      fingerprint: string,
      scanData?: unknown,
    ) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        ...(scanData === undefined ? {} : { scanData }),
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/${suffix}.iso`,
        fingerprint,
      });
      const mediaItem = access.catalog.createMediaItem({
        kind: "movie",
        title: suffix,
      });
      return { archive, mediaItem };
    };

    const unreviewable = createArchive(
      "Unreviewable Selection Evidence",
      `sha256:${"e".repeat(64)}`,
    );
    const unreviewableSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: unreviewable.archive.id,
      mediaItemId: unreviewable.mediaItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const unreviewableTitle = {
      originalDiscArchiveId: unreviewable.archive.id,
      mediaItemId: unreviewable.mediaItem.id,
      sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
    };
    const scanError = /reviewable DVD title map/;
    expect(() => access.catalog.createDiscSelection(unreviewableTitle))
      .toThrow(scanError);
    expect(() =>
      access.catalog.repairDiscSelection(
        unreviewableSelection.id,
        unreviewableTitle,
      )
    ).toThrow(scanError);

    const contentId = `sha256:${"d".repeat(64)}`;
    const missingTitle = createArchive(
      "Missing Title Evidence",
      contentId,
      {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 2,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    );
    const missingTitleSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: missingTitle.archive.id,
      mediaItemId: missingTitle.mediaItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
    });
    const absentTitle = {
      originalDiscArchiveId: missingTitle.archive.id,
      mediaItemId: missingTitle.mediaItem.id,
      sourceIdentity: { kind: "dvd_title" as const, titleNumber: 1 },
    };
    const titleError = /DVD title 1 is not present in the archived scan/;
    expect(() => access.catalog.createDiscSelection(absentTitle))
      .toThrow(titleError);
    expect(() =>
      access.catalog.repairDiscSelection(
        missingTitleSelection.id,
        absentTitle,
      )
    ).toThrow(titleError);
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    const persistTitle = sqlite.prepare(
      `update disc_selections
       set source_key = ?, kind = 'dvd_title', title_number = 1,
           chapter_start = null, chapter_end = null
       where id = ?`,
    );
    persistTitle.run("dvd:title:1", unreviewableSelection.id);
    persistTitle.run("dvd:title:1", missingTitleSelection.id);
    sqlite.close();

    access = openTestDatabase(databasePath);
    expect(() => completeCatalogReview(access, unreviewable.archive.id))
      .toThrow(scanError);
    expect(() => completeCatalogReview(access, missingTitle.archive.id))
      .toThrow(titleError);
    access.close();
  });

  it("validates a large catalog outside the SQLite writer lock without weakening review or encode checks", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const contentId = `sha256:${"b".repeat(64)}`;
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 100_000,
          chapters: 100_000,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Large Catalog.iso",
      fingerprint: contentId,
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Large Catalog",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const profile = access.encodingProfiles.create({
      key: "large-catalog",
      displayName: "Large catalog",
      mediaDomain: "dvd_video",
      settings: {},
    });

    const sqlite = new DatabaseSync(databasePath);
    const selectionCount = 5_000;
    const insertSelection = sqlite.prepare(`
      insert into disc_selections (
        id,
        original_disc_archive_id,
        media_item_id,
        source_key,
        kind,
        title_number,
        chapter_start,
        chapter_end,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, 'dvd_chapters', 1, ?, ?, 0, 0)
    `);
    sqlite.exec("begin");
    for (let chapter = 1; chapter <= selectionCount; chapter += 1) {
      insertSelection.run(
        `large-selection-${String(chapter).padStart(6, "0")}`,
        archive.id,
        item.id,
        `dvd:title:1:chapters:${chapter}-${chapter}`,
        chapter,
        chapter,
      );
    }
    sqlite.prepare(`
      update original_disc_archives
      set updated_at = updated_at + 1
      where id = ?
    `).run(archive.id);
    sqlite.exec("commit");

    const finalSelectionId =
      `large-selection-${String(selectionCount).padStart(6, "0")}`;
    const canonicalFinalSourceKey =
      `dvd:title:1:chapters:${selectionCount}-${selectionCount}`;
    sqlite.prepare(`
      update disc_selections
      set source_key = 'legacy:noncanonical'
      where id = ?
    `).run(finalSelectionId);
    sqlite.prepare(`
      update original_disc_archives
      set updated_at = updated_at + 1
      where id = ?
    `).run(archive.id);

    expect(() => completeCatalogReview(access, archive.id)).toThrow(
      "Catalog review requires canonical Disc Selection source keys",
    );

    sqlite.prepare(`
      update disc_selections
      set source_key = ?
      where id = ?
    `).run(canonicalFinalSourceKey, finalSelectionId);
    sqlite.prepare(`
      update original_disc_archives
      set updated_at = updated_at + 1
      where id = ?
    `).run(archive.id);
    sqlite.exec("pragma busy_timeout = 0");

    const concurrentSelectionId = "concurrent-large-selection" as DiscSelectionId;
    const staleReviewRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    const staleReviewResults = await runBarrierWorkers(
      {
        databasePath,
        mode: "operation",
        operations: [{
          operation: "complete-catalog-review",
          originalDiscArchiveId: archive.id,
          catalogRevision: staleReviewRevision,
        }],
      },
      {
        beforeRelease() {
          sqlite.exec("begin immediate");
        },
        async afterOperationsStart() {
          await new Promise((resolve) => setTimeout(resolve, 250));
          insertSelection.run(
            concurrentSelectionId,
            archive.id,
            item.id,
            `dvd:title:1:chapters:${selectionCount + 1}-${selectionCount + 1}`,
            selectionCount + 1,
            selectionCount + 1,
          );
          sqlite.prepare(`
            update original_disc_archives
            set catalog_reviewed_at = null, updated_at = updated_at + 1
            where id = ?
          `).run(archive.id);
          sqlite.exec("commit");
        },
      },
    );
    expect(staleReviewResults).toEqual([{ outcome: "rejected" }]);
    expect(access.catalog.listDiscSelections({ ids: [concurrentSelectionId] }))
      .toHaveLength(1);
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });

    let writerAcquiredDuringReviewValidation = false;
    const reviewRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    const reviewResults = await runBarrierWorkers(
      {
        databasePath,
        mode: "operation",
        operations: Array.from({ length: 2 }, () => ({
          operation: "complete-catalog-review" as const,
          originalDiscArchiveId: archive.id,
          catalogRevision: reviewRevision,
        })),
      },
      {
        async afterOperationsStart() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          try {
            sqlite.exec("begin immediate");
            sqlite.prepare(`
              update encoding_profiles
              set display_name = display_name || ' reviewed'
              where id = ?
            `).run(profile.id);
            sqlite.exec("commit");
            writerAcquiredDuringReviewValidation = true;
          } catch {
            // The assertion below reports whether validation held the writer.
          }
        },
      },
    );
    expect(writerAcquiredDuringReviewValidation).toBe(true);
    expect(reviewResults).toEqual(expect.arrayContaining([
      { outcome: "reviewed", id: archive.id },
      { outcome: "rejected" },
    ]));

    sqlite.prepare(`
      update disc_selections
      set source_key = 'legacy:noncanonical'
      where id = ?
    `).run(finalSelectionId);
    sqlite.prepare(`
      update original_disc_archives
      set updated_at = updated_at + 1
      where id = ?
    `).run(archive.id);
    expect(() =>
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Large Catalog invalid.mkv",
      }),
    ).toThrow("Catalog review requires canonical Disc Selection source keys");

    sqlite.prepare(`
      update disc_selections
      set source_key = ?
      where id = ?
    `).run(canonicalFinalSourceKey, finalSelectionId);
    sqlite.prepare(`
      update original_disc_archives
      set updated_at = updated_at + 1
      where id = ?
    `).run(archive.id);

    let writerAcquiredDuringEncodeValidation = false;
    const encodeResults = await runBarrierWorkers(
      {
        databasePath,
        mode: "operation",
        operations: [{
          operation: "enqueue-encode",
          discSelectionId: selection.id,
          encodingProfileId: profile.id,
          outputPath: "/media/movies/Large Catalog.mkv",
        }],
      },
      {
        async afterOperationsStart() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          try {
            sqlite.exec("begin immediate");
            sqlite.prepare(`
              update encoding_profiles
              set display_name = display_name || ' enqueued'
              where id = ?
            `).run(profile.id);
            sqlite.exec("commit");
            writerAcquiredDuringEncodeValidation = true;
          } catch {
            // The assertion below reports whether validation held the writer.
          }
        },
      },
    );
    expect(writerAcquiredDuringEncodeValidation).toBe(true);
    expect(encodeResults).toEqual([
      expect.objectContaining({ outcome: "enqueued" }),
    ]);

    sqlite.close();
    access.close();
  }, 20_000);

  it("lists only Disc Selections currently eligible for encoding", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const createSelection = (suffix: string) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `encode-eligibility-${suffix}`,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/Encode Eligibility ${suffix}.iso`,
        fingerprint: `encode-eligibility-${suffix}`,
      });
      const item = access.catalog.createMediaItem({
        kind: "movie",
        title: `Encode Eligibility ${suffix}`,
      });
      const selection = access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        sourceIdentity: { kind: "main_feature" },
      });
      return { archive, selection };
    };
    const unreviewed = createSelection("unreviewed");
    const reviewed = createSelection("reviewed");
    completeCatalogReview(access, reviewed.archive.id);

    expect(access.catalog.listDiscSelections({ encodeEligibleOnly: true }))
      .toEqual([expect.objectContaining({ id: reviewed.selection.id })]);
    expect(access.catalog.listDiscSelections()).toEqual([
      expect.objectContaining({ id: unreviewed.selection.id }),
      expect.objectContaining({ id: reviewed.selection.id }),
    ]);
    access.close();
  });

  it("preserves dependent Encode Job history when removing a Disc Selection", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "bounded-selection-removal",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Bounded Removal.iso",
      fingerprint: "bounded-selection-removal",
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Bounded Removal",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "preserved-removal-history",
      displayName: "Preserved removal history",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Bounded Removal.mkv",
    });

    expect(() => access.catalog.deleteDiscSelection(selection.id))
      .toThrow(/cannot be deleted.*Encode Job history/i);
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toEqual([expect.objectContaining({ id: selection.id })]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, status: "queued" }),
    ]);
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: expect.any(Date) });
    access.close();
  });

  it("exposes only recovery actions for unsafe legacy Disc Selections and preserves quarantine history", () => {
    const databasePath = createTestDatabasePath();
    let access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"3".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Unsafe Legacy Selection.iso",
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Unsafe Legacy Selection",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "unsafe-legacy-selection",
      displayName: "Unsafe legacy selection",
      mediaDomain: "dvd_video",
      settings: {},
    });
    access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Unsafe Legacy Selection.mkv",
    });
    const claim = access.encodeJobs.claimNext("legacy-worker");
    if (!claim) {
      throw new Error("Expected unsafe legacy Encode Job claim");
    }
    const completedJob = access.encodeJobs.complete(claim);
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update disc_selections
      set source_key = 'caller:title-one'
      where id = ?
    `).run(selection.id);
    sqlite.close();

    access = openTestDatabase(databasePath);
    const availability = access.catalog.listDiscSelectionActionAvailability({
      ids: [selection.id],
    });
    expect(availability).toEqual([{
      discSelectionId: selection.id,
      state: "needs_repair",
      availableActions: ["repair", "remove"],
      reason:
        "Unsafe legacy Disc Selection; repair or remove it before completing Catalog Review",
      relatedEncodeJob: null,
    }]);
    expect(JSON.stringify(availability)).not.toContain(completedJob.outputPath);
    expect(() =>
      access.catalog.listDiscSelectionActionAvailability({
        ids: Array.from({ length: 101 }, () => selection.id),
      })
    ).toThrow(
      "Disc Selection action availability is limited to 100 records",
    );

    const cutoverSqlite = new DatabaseSync(databasePath);
    cutoverSqlite.prepare(`
      update original_disc_archives
      set legacy_cutover_pending = 1
      where id = ?
    `).run(archive.id);
    expect(access.catalog.listDiscSelectionActionAvailability({
      ids: [selection.id],
    })).toEqual([{
      discSelectionId: selection.id,
      state: "changes_unavailable",
      availableActions: [],
      reason:
        "Disc Selection changes are unavailable while legacy cutover repair is pending",
      relatedEncodeJob: null,
    }]);
    expect(() =>
      access.catalog.repairDiscSelection(selection.id, {
        originalDiscArchiveId: archive.id,
        mediaItemId: movie.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      })
    ).toThrow(
      "Disc Selections cannot be changed while legacy cutover repair is pending",
    );
    cutoverSqlite.prepare(`
      update original_disc_archives
      set legacy_cutover_pending = 0
      where id = ?
    `).run(archive.id);
    cutoverSqlite.close();

    const repaired = access.catalog.repairDiscSelection(selection.id, {
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(repaired.id).not.toBe(selection.id);
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toEqual([expect.objectContaining({ id: selection.id })]);
    expect(access.encodeJobs.list(["completed"]))
      .toEqual([expect.objectContaining({
        id: completedJob.id,
        discSelectionId: selection.id,
      })]);
    expect(access.catalog.listDiscSelectionActionAvailability({
      ids: [selection.id, repaired.id],
    })).toEqual([expect.objectContaining({
      discSelectionId: repaired.id,
      state: "editable",
    })]);
    access.catalog.deleteDiscSelection(repaired.id);
    expect(() => access.catalog.deleteMediaItem(movie.id)).toThrow(
      "Media Item deletion is unavailable: 1 Disc Selection reference",
    );
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toEqual([expect.objectContaining({ id: selection.id })]);
    expect(access.encodeJobs.list(["completed"]))
      .toEqual([expect.objectContaining({ id: completedJob.id })]);
    access.close();
  });

  it("does not enqueue after a concurrent Disc Selection reopens review", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"c".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 300,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Concurrent Review.iso",
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Concurrent Review",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const extra = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Concurrent Extra",
    });
    const profile = access.encodingProfiles.create({
      key: "concurrent-review",
      displayName: "Concurrent review",
      mediaDomain: "dvd_video",
      settings: {},
    });
    completeCatalogReview(access, archive.id);

    const concurrentSqlite = new DatabaseSync(databasePath);
    concurrentSqlite.exec("pragma busy_timeout = 5000");
    const timestamp = Date.now();
    const results = await runBarrierWorkers(
      {
        databasePath,
        mode: "operation",
        operations: [{
          operation: "enqueue-encode",
          discSelectionId: selection.id,
          encodingProfileId: profile.id,
          outputPath: "/media/movies/Concurrent Review.mkv",
        }],
      },
      {
        beforeRelease() {
          concurrentSqlite.exec("begin immediate");
        },
        async afterRelease() {
          await new Promise((resolve) => setTimeout(resolve, 100));
          concurrentSqlite.prepare(`
            insert into disc_selections (
              id,
              original_disc_archive_id,
              media_item_id,
              source_key,
              kind,
              title_number,
              chapter_start,
              chapter_end,
              label,
              created_at,
              updated_at
            ) values (?, ?, ?, 'dvd:title:1', 'dvd_title', 1, null, null, null, ?, ?)
          `).run(
            "concurrent-extra-selection",
            archive.id,
            extra.id,
            timestamp,
            timestamp,
          );
          concurrentSqlite.prepare(`
            update original_disc_archives
            set catalog_reviewed_at = null,
                catalog_review_outcome = 'needs_review',
                updated_at = ?
            where id = ?
          `).run(timestamp, archive.id);
          concurrentSqlite.exec("commit");
        },
      },
    );
    concurrentSqlite.close();

    expect(results).toEqual([{ outcome: "rejected" }]);
    expect(access.encodeJobs.list()).toEqual([]);
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(2);
    access.close();
  });

  it("retains Media Item title trimming for explicit facade writes", () => {
    const access = openTestDatabase();
    const item = access.catalog.createMediaItem({
      kind: "other",
      title: "  Created title  ",
    });

    expect(item.title).toBe("Created title");
    expect(
      access.catalog.updateMediaItem(item.id, { title: "  Updated title  " }),
    ).toMatchObject({ title: "Updated title" });
    access.close();
  });

  it("deletes an unused leaf Media Item", () => {
    const access = openTestDatabase();
    const item = access.catalog.createMediaItem({
      kind: "other",
      title: "Mistaken unused item",
    });

    expect(access.catalog.deleteMediaItem(item.id)).toEqual(item);
    expect(access.catalog.listMediaItems({ ids: [item.id] })).toEqual([]);
    access.close();
  });

  it("explains why a Media Item with children cannot be deleted", () => {
    const access = openTestDatabase();
    const parent = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Referenced parent",
    });
    const child = access.catalog.createMediaItem({
      parentId: parent.id,
      kind: "season",
      title: "Referenced child",
      seasonNumber: 1,
    });

    expect(() => access.catalog.deleteMediaItem(parent.id)).toThrow(
      "Media Item deletion is unavailable: 1 child Media Item",
    );
    expect(access.catalog.listMediaItems({ ids: [parent.id, child.id] }))
      .toHaveLength(2);
    access.close();
  });

  it("preserves active Disc Selection references when deleting a Media Item", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "active-media-item-reference",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Active Reference.iso",
      fingerprint: "active-media-item-reference",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Referenced movie",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });

    expect(() => access.catalog.deleteMediaItem(item.id)).toThrow(
      "Media Item deletion is unavailable: 1 Disc Selection reference",
    );
    expect(access.catalog.listMediaItems({ ids: [item.id] })).toHaveLength(1);
    expect(access.catalog.listDiscSelections({ ids: [selection.id] }))
      .toHaveLength(1);
    expect(access.catalog.listMediaItemMaintenance({
      ids: [item.id],
      currentArchiveId: archive.id,
    })).toEqual([{
      mediaItemId: item.id,
      childCount: 0,
      discSelectionReferenceCount: 1,
      referencedArchiveCount: 1,
      otherArchiveCount: 0,
      deletionAvailability: {
        state: "unavailable",
        reason: "1 Disc Selection reference",
      },
    }]);
    access.close();
  });

  it("reports the other archives affected by a shared Media Item edit", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Shared movie",
    });
    const archives = ["first", "second"].map((suffix) => {
      const fingerprint = `shared-media-item-${suffix}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/Shared ${suffix}.iso`,
        fingerprint,
      });
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        sourceIdentity: { kind: "main_feature" },
      });
      return archive;
    });

    expect(access.catalog.listMediaItemMaintenance({
      ids: [item.id],
      currentArchiveId: archives[0]!.id,
    })[0]).toMatchObject({
      discSelectionReferenceCount: 2,
      referencedArchiveCount: 2,
      otherArchiveCount: 1,
      deletionAvailability: {
        state: "unavailable",
        reason: "2 Disc Selection references",
      },
    });
    access.close();
  });

  it("creates and edits an acyclic Media Item hierarchy with every catalog kind", () => {
    const access = openTestDatabase();
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "The Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Season One",
      seasonNumber: 1,
    });
    const episode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Pilot",
      episodeNumber: 1,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "The Movie",
    });
    const trailer = access.catalog.createMediaItem({
      parentId: movie.id,
      kind: "trailer",
      title: "Trailer",
    });
    const bonus = access.catalog.createMediaItem({
      parentId: movie.id,
      kind: "bonus_feature",
      title: "Behind the Scenes",
    });
    const other = access.catalog.createMediaItem({
      parentId: episode.id,
      kind: "other",
      title: "Local Recording",
      year: 1800,
      seasonNumber: 0,
      episodeNumber: 1,
    });
    expect(
      access.catalog.updateMediaItem(other.id, {
        parentId: undefined,
        kind: undefined,
        title: undefined,
        year: undefined,
        seasonNumber: undefined,
        episodeNumber: undefined,
      }),
    ).toMatchObject({
      id: other.id,
      parentId: episode.id,
      kind: "other",
      title: "Local Recording",
      year: 1800,
      seasonNumber: 0,
      episodeNumber: 1,
    });
    expect(
      access.catalog.updateMediaItem(episode.id, {
        parentId: show.id,
        title: "The Pilot",
        episodeNumber: 2,
      }),
    ).toMatchObject({
      id: episode.id,
      parentId: show.id,
      title: "The Pilot",
      episodeNumber: 2,
    });
    expect(() =>
      access.catalog.updateMediaItem(show.id, { parentId: episode.id }),
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listMediaItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: show.id, kind: "tv_show" }),
        expect.objectContaining({ id: season.id, kind: "season" }),
        expect.objectContaining({ id: episode.id, kind: "episode" }),
        expect.objectContaining({ id: movie.id, kind: "movie" }),
        expect.objectContaining({ id: trailer.id, kind: "trailer" }),
        expect.objectContaining({ id: bonus.id, kind: "bonus_feature" }),
        expect.objectContaining({
          id: other.id,
          parentId: episode.id,
          kind: "other",
          year: 1800,
          seasonNumber: 0,
          episodeNumber: 1,
        }),
      ]),
    );
    access.close();
  });

  it("rejects unsupported Media Item kinds on create and update", () => {
    const access = openTestDatabase();

    for (const kind of invalidMediaItemKinds) {
      expect(() =>
        access.catalog.createMediaItem({
          kind: kind as never,
          title: "Unsupported item",
        }),
      ).toThrow(DomainInvariantError);
    }
    const item = access.catalog.createMediaItem({
      kind: "other",
      title: "Valid item",
    });
    for (const kind of invalidMediaItemKinds) {
      expect(() =>
        access.catalog.updateMediaItem(item.id, {
          kind: kind as never,
        }),
      ).toThrow(DomainInvariantError);
    }

    access.close();
  });

  it("rejects every invalid Media Item field on create and update", () => {
    const access = openTestDatabase();

    for (const [label, field, value] of invalidMediaItemFields) {
      expect(
        () =>
          access.catalog.createMediaItem({
            kind: "other",
            title: "Valid title",
            [field]: value,
          } as never),
        `create: ${label}`,
      ).toThrow(DomainInvariantError);
    }

    const item = access.catalog.createMediaItem({
      kind: "other",
      title: "Valid item",
    });
    for (const [label, field, value] of invalidMediaItemFields) {
      expect(
        () =>
          access.catalog.updateMediaItem(
            item.id,
            { [field]: value } as never,
          ),
        `update: ${label}`,
      ).toThrow(DomainInvariantError);
    }
    expect(access.catalog.listMediaItems({ ids: [item.id] })[0]).toMatchObject({
      title: "Valid item",
      year: null,
      seasonNumber: null,
      episodeNumber: null,
    });

    access.close();
  });

  it("rejects missing and malformed Media Item parents on create and update", () => {
    const access = openTestDatabase();
    const missingParentId = "missing-media-item" as MediaItemId;

    expect(() =>
      access.catalog.createMediaItem({
        parentId: missingParentId,
        kind: "other",
        title: "Missing parent",
      }),
    ).toThrow(RecordNotFoundError);
    expect(() =>
      access.catalog.createMediaItem({
        parentId: "" as MediaItemId,
        kind: "other",
        title: "Malformed parent",
      }),
    ).toThrow(DomainInvariantError);

    const item = access.catalog.createMediaItem({
      kind: "other",
      title: "Valid item",
    });
    expect(() =>
      access.catalog.updateMediaItem(item.id, { parentId: missingParentId }),
    ).toThrow(RecordNotFoundError);
    expect(() =>
      access.catalog.updateMediaItem(item.id, { parentId: item.id }),
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listMediaItems({ ids: [item.id] })[0]).toMatchObject({
      parentId: null,
    });

    access.close();
  });

  it("allows more than the hierarchy depth limit as siblings", () => {
    const access = openTestDatabase();
    const parent = access.catalog.createMediaItem({
      kind: "movie",
      title: "Sibling parent",
    });
    const siblingCount = MAX_MEDIA_ITEM_HIERARCHY_DEPTH + 1;

    for (let sibling = 1; sibling <= siblingCount; sibling += 1) {
      access.catalog.createMediaItem({
        parentId: parent.id,
        kind: "bonus_feature",
        title: `Sibling ${sibling}`,
      });
    }

    expect(access.catalog.listMediaItems()).toHaveLength(siblingCount + 1);
    access.close();
  });

  it("bounds Media Item hierarchy depth at the catalog mutation boundary", () => {
    const access = openTestDatabase();
    let parent = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Hierarchy root",
    });
    for (let depth = 1; depth < MAX_MEDIA_ITEM_HIERARCHY_DEPTH; depth += 1) {
      parent = access.catalog.createMediaItem({
        parentId: parent.id,
        kind: "bonus_feature",
        title: `Hierarchy level ${depth}`,
      });
    }

    expect(() =>
      access.catalog.createMediaItem({
        parentId: parent.id,
        kind: "bonus_feature",
        title: `Hierarchy level ${MAX_MEDIA_ITEM_HIERARCHY_DEPTH}`,
      }),
    ).toThrow(DomainInvariantError);
    access.close();
  });

  it("rejects reparenting a maximum-depth Media Item subtree", () => {
    const access = openTestDatabase();
    const root = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Hierarchy root",
    });
    let parent = root;
    for (let depth = 1; depth < MAX_MEDIA_ITEM_HIERARCHY_DEPTH; depth += 1) {
      parent = access.catalog.createMediaItem({
        parentId: parent.id,
        kind: "bonus_feature",
        title: `Hierarchy level ${depth}`,
      });
    }
    const newRoot = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "New hierarchy root",
    });

    expect(() =>
      access.catalog.updateMediaItem(root.id, { parentId: newRoot.id })
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listMediaItems({ ids: [root.id] })[0]).toMatchObject({
      id: root.id,
      parentId: null,
    });
    access.close();
  });

  it("serializes Media Item hierarchy validation with concurrent reparenting", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const root = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Concurrent hierarchy root",
    });
    let parent = root;
    for (
      let depth = 1;
      depth < MAX_MEDIA_ITEM_HIERARCHY_DEPTH - 1;
      depth += 1
    ) {
      parent = access.catalog.createMediaItem({
        parentId: parent.id,
        kind: "bonus_feature",
        title: `Concurrent hierarchy level ${depth}`,
      });
    }
    const newRoot = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Concurrent new root",
    });
    const concurrentSqlite = new DatabaseSync(databasePath);
    concurrentSqlite.exec("pragma busy_timeout = 5000");
    concurrentSqlite.exec("pragma foreign_keys = on");

    const results = await runBarrierWorkers(
      {
        databasePath,
        mode: "operation",
        operations: [{
          operation: "create-media-item",
          parentId: parent.id,
          title: "Concurrent over-depth item",
        }],
      },
      {
        beforeRelease() {
          concurrentSqlite.exec("begin immediate");
        },
        async afterRelease() {
          await new Promise((resolve) => setTimeout(resolve, 100));
          concurrentSqlite.prepare(`
            update media_items
            set parent_id = ?
            where id = ?
          `).run(newRoot.id, root.id);
          concurrentSqlite.exec("commit");
        },
      },
    );

    expect(results).toEqual([{ outcome: "rejected" }]);
    expect(access.catalog.listMediaItems()).toHaveLength(
      MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
    );
    concurrentSqlite.close();
    access.close();
  });

  it("maps main-feature, title, and bounded multi-episode selections to one Media Item each", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"d".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [
          {
            number: 1,
            durationSeconds: 2_400,
            chapters: 8,
            audioStreams: [],
            subtitles: [],
          },
          {
            number: 2,
            durationSeconds: 180,
            chapters: 2,
            audioStreams: [],
            subtitles: [],
          },
        ],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Episode Disc.iso",
      fingerprint: contentId,
    });
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Chapter Show",
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Season 1",
      seasonNumber: 1,
    });
    const firstEpisode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Episode 1",
      episodeNumber: 1,
    });
    const secondEpisode = access.catalog.createMediaItem({
      parentId: season.id,
      kind: "episode",
      title: "Episode 2",
      episodeNumber: 2,
    });
    const trailer = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "trailer",
      title: "Trailer",
    });
    const mainFeature = access.catalog.createMediaItem({
      kind: "movie",
      title: "Main Feature",
    });

    const selections = [
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: mainFeature.id,
        sourceIdentity: { kind: "main_feature" },
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: firstEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: secondEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 5,
          chapterEnd: 8,
        },
      }),
    ];

    expect(selections.map((selection) => selection.mediaItemId)).toEqual([
      mainFeature.id,
      trailer.id,
      firstEpisode.id,
      secondEpisode.id,
    ]);
    const sourceIdentities = selections.map(
      (selection) => selection.sourceIdentity,
    );
    expect(sourceIdentities).toEqual([
      { kind: "main_feature" },
      { kind: "dvd_title", titleNumber: 2 },
      {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      },
      {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 5,
        chapterEnd: 8,
      },
    ]);
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: firstEpisode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 8,
          chapterEnd: 9,
        },
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
      }),
    ).toThrow(DomainInvariantError);
    access.close();

    const reopened = openTestDatabase(databasePath);
    const reopenedSourceIdentities = reopened.catalog
      .listDiscSelections({
        originalDiscArchiveId: archive.id,
      })
      .map((selection) => selection.sourceIdentity);
    expect(reopenedSourceIdentities).toHaveLength(sourceIdentities.length);
    expect(reopenedSourceIdentities).toEqual(
      expect.arrayContaining(sourceIdentities),
    );
    reopened.close();
  });

  it("reconciles discovered Optical Drives without changing missing drives' last-seen time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDatabase();
    const internalDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Internal drive",
      isEnabled: true,
      isPresent: true,
    });

    vi.setSystemTime(new Date("2026-07-26T18:05:00.000Z"));
    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr1",
          displayName: "USB drive",
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: internalDrive.id,
        devicePath: "/dev/sr0",
        isEnabled: true,
        isPresent: false,
        lastSeenAt: new Date("2026-07-26T18:00:00.000Z"),
      }),
      expect.objectContaining({
        devicePath: "/dev/sr1",
        isEnabled: false,
        isPresent: true,
        lastSeenAt: new Date("2026-07-26T18:05:00.000Z"),
      }),
    ]);

    vi.setSystemTime(new Date("2026-07-26T18:10:00.000Z"));
    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          displayName: "Internal drive rediscovered",
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: internalDrive.id,
        displayName: "Internal drive rediscovered",
        isEnabled: false,
        isPresent: true,
        lastSeenAt: new Date("2026-07-26T18:10:00.000Z"),
      }),
      expect.objectContaining({
        devicePath: "/dev/sr1",
        isPresent: false,
        lastSeenAt: new Date("2026-07-26T18:05:00.000Z"),
      }),
    ]);

    access.close();
  });

  it("defaults replacement hardware at an enabled device path to disabled", () => {
    const access = openTestDatabase();
    const original = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        displayName: "Original drive",
        vendor: "Pioneer",
        product: "DVD-RW",
        serialNumber: "ORIGINAL-001",
        isConfiguredDevice: true,
      },
    ])[0]!;

    const configuredReplacement = {
      devicePath: "/dev/sr0",
      displayName: "Replacement drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "REPLACEMENT-002",
      isConfiguredDevice: true,
    };
    expect(
      access.catalog.reconcileOpticalDrives([
        {
          ...configuredReplacement,
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        serialNumber: "REPLACEMENT-002",
        isEnabled: false,
        isPresent: true,
      }),
    ]);
    expect(
      access.catalog.reconcileOpticalDrives([configuredReplacement]),
    ).toEqual([
      expect.objectContaining({ id: original.id, isEnabled: false }),
    ]);

    access.close();
  });

  it.each<{
    caseName: string;
    existingEnabled?: boolean;
    existingSerial?: string;
    observedSerial: string;
    expectedEnabled: boolean;
  }>([
    {
      caseName: "preserves an independently enabled stable target",
      existingEnabled: true,
      existingSerial: "STABLE-002",
      observedSerial: "STABLE-002",
      expectedEnabled: true,
    },
    {
      caseName: "preserves an independently disabled stable target",
      existingEnabled: false,
      existingSerial: "STABLE-002",
      observedSerial: "STABLE-002",
      expectedEnabled: false,
    },
    {
      caseName: "leaves a new target disabled",
      observedSerial: "NEW-002",
      expectedEnabled: false,
    },
    {
      caseName: "disables an existing target whose identity changed",
      existingEnabled: true,
      existingSerial: "ORIGINAL-002",
      observedSerial: "REPLACEMENT-002",
      expectedEnabled: false,
    },
  ])("$caseName when a configured alias retargets", (testCase) => {
    const access = openTestDatabase();
    access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "CONFIGURED-001",
        isConfiguredDevice: true,
      },
    ]);
    if (testCase.existingEnabled !== undefined) {
      access.catalog.upsertOpticalDrive({
        devicePath: "/dev/sr1",
        serialNumber: testCase.existingSerial,
        isEnabled: testCase.existingEnabled,
        isPresent: true,
      });
    }

    access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "CONFIGURED-001",
        isConfiguredDevice: false,
      },
      {
        devicePath: "/dev/sr1",
        serialNumber: testCase.observedSerial,
        isConfiguredDevice: true,
      },
    ]);

    expect(
      access.catalog
        .listOpticalDrives()
        .find((drive) => drive.devicePath === "/dev/sr1"),
    ).toEqual(
      expect.objectContaining({
        isEnabled: testCase.expectedEnabled,
        serialNumber: testCase.observedSerial,
      }),
    );

    access.close();
  });

  it("keeps a pre-discovered disabled alias target disabled on later polls", () => {
    const access = openTestDatabase();
    access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "CONFIGURED-001",
        isConfiguredDevice: true,
      },
      {
        devicePath: "/dev/sr1",
        serialNumber: "STABLE-002",
        isConfiguredDevice: false,
      },
    ]);
    const retargetedSnapshot = [
      {
        devicePath: "/dev/sr0",
        serialNumber: "CONFIGURED-001",
        isConfiguredDevice: false,
      },
      {
        devicePath: "/dev/sr1",
        serialNumber: "STABLE-002",
        isConfiguredDevice: true,
      },
    ];

    const enabledAfterEachPoll = [retargetedSnapshot, retargetedSnapshot].map(
      (snapshot) => {
        access.catalog.reconcileOpticalDrives(snapshot);
        return access.catalog
          .listOpticalDrives()
          .find((drive) => drive.devicePath === "/dev/sr1")?.isEnabled;
      },
    );

    expect(enabledAfterEachPoll).toEqual([false, false]);

    access.close();
  });

  it("disables uncertain same-path hardware after a disappearance", () => {
    const access = openTestDatabase();
    const original = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Original drive",
      vendor: "Pioneer",
      product: "DVD-RW",
      isEnabled: true,
      isPresent: true,
    });

    access.catalog.reconcileOpticalDrives([]);
    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          displayName: "Replacement drive",
          vendor: "Pioneer",
          product: "DVD-RW",
          serialNumber: "NEW-SERIAL",
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        isEnabled: false,
        isPresent: true,
        serialNumber: "NEW-SERIAL",
      }),
    ]);

    access.close();
  });

  it("preserves authorization when a matching serial proves continuity", () => {
    const access = openTestDatabase();
    const original = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      serialNumber: "STABLE-SERIAL",
      isEnabled: true,
      isPresent: true,
    });

    access.catalog.reconcileOpticalDrives([]);
    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          serialNumber: "STABLE-SERIAL",
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        isEnabled: true,
        isPresent: true,
      }),
    ]);

    access.close();
  });

  it("preserves logical identity and authorization across device-path renumbering", () => {
    const access = openTestDatabase();
    const original = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr2",
        serialNumber: "STABLE-RENUMBERED-SERIAL",
        isConfiguredDevice: true,
      },
    ])[0]!;

    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr1",
          serialNumber: "STABLE-RENUMBERED-SERIAL",
          isConfiguredDevice: true,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        devicePath: "/dev/sr1",
        isEnabled: true,
        isPresent: true,
      }),
    ]);

    access.close();
  });

  it("preserves a serial-proven drive when its new path has missing history", () => {
    const access = openTestDatabase();
    const original = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr2",
        serialNumber: "PHYSICAL-OPTICAL-DRIVE",
        isConfiguredDevice: true,
      },
      {
        devicePath: "/dev/sr1",
        serialNumber: "OLD-VIRTUAL-CDROM",
        isConfiguredDevice: false,
      },
    ]).find((drive) => drive.serialNumber === "PHYSICAL-OPTICAL-DRIVE")!;

    const reconciled = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr1",
        serialNumber: "PHYSICAL-OPTICAL-DRIVE",
        isConfiguredDevice: true,
      },
    ]);

    expect(reconciled).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: original.id,
        devicePath: "/dev/sr1",
        isEnabled: true,
        isPresent: true,
      }),
      expect.objectContaining({
        serialNumber: "OLD-VIRTUAL-CDROM",
        isEnabled: false,
        isPresent: false,
      }),
    ]));

    access.close();
  });

  it("separates replacement hardware from a serial-proven renumbered drive", () => {
    const access = openTestDatabase();
    const original = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "MOVED-STABLE-DRIVE",
        isConfiguredDevice: true,
      },
    ])[0]!;

    const reconciled = access.catalog.reconcileOpticalDrives([
      {
        devicePath: "/dev/sr0",
        serialNumber: "REPLACEMENT-AT-OLD-PATH",
        isConfiguredDevice: false,
      },
      {
        devicePath: "/dev/sr1",
        serialNumber: "MOVED-STABLE-DRIVE",
        isConfiguredDevice: true,
      },
    ]);

    expect(reconciled).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: original.id,
        devicePath: "/dev/sr1",
        isEnabled: true,
        isPresent: true,
      }),
      expect.objectContaining({
        devicePath: "/dev/sr0",
        serialNumber: "REPLACEMENT-AT-OLD-PATH",
        isEnabled: false,
        isPresent: true,
      }),
    ]));

    access.close();
  });

  it("treats a matching serial as authoritative when model text changes", () => {
    const access = openTestDatabase();
    const original = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "STABLE-SERIAL",
      isEnabled: true,
      isPresent: true,
    });

    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          vendor: "HL-DT-ST",
          product: "DVDRAM",
          serialNumber: "STABLE-SERIAL",
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        vendor: "HL-DT-ST",
        product: "DVDRAM",
        serialNumber: "STABLE-SERIAL",
        isEnabled: true,
      }),
    ]);

    access.close();
  });

  it("does not treat an empty serial as identity proof", () => {
    const access = openTestDatabase();
    const original = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      vendor: "Pioneer",
      product: "DVD-RW",
      serialNumber: "",
      isEnabled: true,
      isPresent: true,
    });

    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          vendor: "HL-DT-ST",
          product: "DVDRAM",
          serialNumber: "",
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        isEnabled: false,
      }),
    ]);

    access.close();
  });

  it.each([
    ["loses serial evidence", undefined],
    ["gains serial evidence", "NEW-SERIAL"],
  ])("disables a present same-model drive when it %s", (_case, nextSerial) => {
    const access = openTestDatabase();
    const original = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      vendor: "Pioneer",
      product: "DVD-RW",
      ...(nextSerial === undefined ? { serialNumber: "KNOWN-SERIAL" } : {}),
      isEnabled: true,
      isPresent: true,
    });

    expect(
      access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          vendor: "Pioneer",
          product: "DVD-RW",
          ...(nextSerial === undefined ? {} : { serialNumber: nextSerial }),
          isConfiguredDevice: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: original.id,
        isEnabled: false,
        serialNumber: nextSerial ?? null,
      }),
    ]);

    access.close();
  });

  it.each([
    ["gains", undefined, undefined, "Pioneer", "DVD-RW"],
    ["loses", "Pioneer", "DVD-RW", undefined, undefined],
  ])(
    "disables present same-path hardware when model identity evidence %s without serial proof",
    (_case, initialVendor, initialProduct, nextVendor, nextProduct) => {
      const access = openTestDatabase();
      const original = access.catalog.upsertOpticalDrive({
        devicePath: "/dev/sr0",
        vendor: initialVendor,
        product: initialProduct,
        isEnabled: true,
        isPresent: true,
      });

      expect(
        access.catalog.reconcileOpticalDrives([
          {
            devicePath: "/dev/sr0",
            vendor: nextVendor,
            product: nextProduct,
            isConfiguredDevice: false,
          },
        ]),
      ).toEqual([
        expect.objectContaining({
          id: original.id,
          isEnabled: false,
          vendor: nextVendor ?? null,
          product: nextProduct ?? null,
        }),
      ]);

      access.close();
    },
  );

  it("does not apply a late configured-device default after an explicit disable", () => {
    const access = openTestDatabase();
    access.catalog.reconcileOpticalDrives([
      { devicePath: "/dev/sr0", isConfiguredDevice: false },
    ]);
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: false,
      isPresent: true,
    });

    expect(
      access.catalog.reconcileOpticalDrives([
        { devicePath: "/dev/sr0", isConfiguredDevice: true },
      ]),
    ).toEqual([
      expect.objectContaining({ devicePath: "/dev/sr0", isEnabled: false }),
    ]);

    access.close();
  });

  it("does not reinterpret a manually created disabled drive as pending configuration", () => {
    const access = openTestDatabase();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });

    expect(
      access.catalog.reconcileOpticalDrives([
        { devicePath: "/dev/sr0", isConfiguredDevice: true },
      ]),
    ).toEqual([
      expect.objectContaining({ devicePath: "/dev/sr0", isEnabled: false }),
    ]);

    access.close();
  });

  it("enforces total filesystem-verification tuples after migration", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec(`
      pragma foreign_keys = on;
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values ('verification-drive', '/dev/verification', 1, 1, 1, 1);
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'verification-disc', 'verification-drive', 'dvd',
        'verification-fingerprint', 'archived', 1, 1, 1
      );
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, created_at, updated_at
      ) values (
        'verification-archive', 'verification-disc', 'dvd', 'iso',
        '/media/originals/verification.iso', 'verification-fingerprint',
        1, 1, 1
      );
      insert into media_items (
        id, kind, title, created_at, updated_at
      ) values ('verification-item', 'movie', 'Verification', 1, 1);
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        created_at, updated_at
      ) values (
        'verification-selection', 'verification-archive',
        'verification-item', 'dvd:main-feature', 'main_feature', 1, 1
      );
      insert into encoding_profiles (
        id, key, display_name, media_domain, version, is_active, settings,
        created_at, updated_at
      ) values (
        'verification-profile', 'verification-profile',
        'Verification profile', 'dvd_video', 1, 1, '{}', 1, 1
      );
      insert into encode_jobs (
        id, disc_selection_id, encoding_profile_id, output_path,
        created_at, updated_at
      ) values (
        'verification-job', 'verification-selection', 'verification-profile',
        '/media/movies/verification.mkv', 1, 1
      );
    `);

    const validStatuses = [
      "accessible",
      "missing",
      "inaccessible",
      "error",
    ] as const;
    const partialTuples = [
      [null, "Verification message", 1],
      [null, null, 1],
      [null, "Verification message", null],
      ["accessible", null, null],
      ["accessible", "Verification message", null],
      ["accessible", null, 1],
    ] as const;
    const targets = [
      ["original_disc_archives", "verification-archive"],
      ["encode_jobs", "verification-job"],
    ] as const;

    try {
      for (const [table, id] of targets) {
        const update = sqlite.prepare(`
          update ${table}
          set verification_status = ?, verification_message = ?, verified_at = ?
          where id = ?
        `);

        expect(() => update.run(null, null, null, id)).not.toThrow();
        for (const status of validStatuses) {
          expect(() =>
            update.run(status, "Verification message", 1, id),
          ).not.toThrow();
        }
        for (const tuple of partialTuples) {
          expect(() => update.run(...tuple, id)).toThrow(
            /verification_check/,
          );
        }
      }
    } finally {
      sqlite.close();
    }
  });

  it("preserves a legacy disabled choice through migration and configured reconciliation", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    for (const migrationName of [
      "20260722045326_core-catalog-and-queues",
      "20260726160810_encoding-profile-active-state",
    ]) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      create table __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
      insert into __drizzle_migrations (hash, created_at, name) values
        ('legacy-core', 0, '20260722045326_core-catalog-and-queues'),
        ('legacy-profiles', 0, '20260726160810_encoding-profile-active-state');
      insert into optical_drives (
        id, device_path, is_enabled, is_present, last_seen_at, created_at,
        updated_at
      ) values ('legacy-drive', '/dev/sr0', 0, 1, 0, 0, 0);
    `);
    sqlite.close();

    const access = openTestDatabase(databasePath);
    expect(
      access.catalog.reconcileOpticalDrives([
        { devicePath: "/dev/sr0", isConfiguredDevice: true },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "legacy-drive",
        devicePath: "/dev/sr0",
        isEnabled: false,
      }),
    ]);
    access.close();
  });

  it("migrates a database that applied the preceding optical-drive migration", () => {
    const databasePath = createTestDatabasePath();
    const precedingSqlite = new DatabaseSync(databasePath);
    for (const migrationName of [
      "20260722045326_core-catalog-and-queues",
      "20260726160810_encoding-profile-active-state",
    ]) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          precedingSqlite.exec(statement);
        }
      }
    }
    const precedingMigrationName =
      "20260802150655_optical-drive-configuration-default";
    precedingSqlite.exec(`ALTER TABLE \`optical_drives\` ADD \`configuration_default_applied\` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE \`optical_drives\` ADD \`is_configured_target\` integer DEFAULT false NOT NULL;
CREATE TABLE __drizzle_migrations (
  id integer primary key,
  hash text not null,
  created_at numeric,
  name text,
  applied_at text
);
INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES
  ('legacy-core', 0, '20260722045326_core-catalog-and-queues'),
  ('legacy-profiles', 0, '20260726160810_encoding-profile-active-state'),
  ('legacy-optical-default', 0, '${precedingMigrationName}');`);
    precedingSqlite.exec(`
      insert into optical_drives (
        id, device_path, is_enabled, configuration_default_applied,
        is_configured_target, is_present, last_seen_at, created_at, updated_at
      ) values (
        'preceding-drive', '/dev/sr0', 0, 1, 1, 1, 0, 0, 0
      );
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'preceding-disc', 'preceding-drive', 'dvd', 'preceding-fingerprint',
        'archived', 100, 100, 100
      );
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, created_at, updated_at
      ) values (
        'preceding-archive', 'preceding-disc', 'dvd', 'iso',
        '/media/originals/preceding.iso', 'preceding-fingerprint', 200, 200, 200
      );
      insert into media_items (
        id, kind, title, created_at, updated_at
      ) values ('preceding-movie', 'movie', 'Preceding Movie', 300, 300);
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        created_at, updated_at
      ) values (
        'preceding-selection', 'preceding-archive', 'preceding-movie',
        'dvd:main-feature', 'main_feature', 400, 456
      );
      insert into archive_jobs (
        id, detected_disc_id, original_disc_archive_id, status,
        progress_percent, started_at, completed_at, created_at, updated_at
      ) values (
        'preceding-archive-job', 'preceding-disc', 'preceding-archive',
        'completed', 100, 190, 200, 180, 200
      );
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'active-disc', 'preceding-drive', 'dvd', 'active-fingerprint',
        'approved', 500, 500, 500
      );
      insert into archive_jobs (
        id, detected_disc_id, status, progress_percent, claimed_by,
        claim_token, claimed_at, started_at, created_at, updated_at
      ) values (
        'active-archive-job', 'active-disc', 'running', 0, 'active-worker',
        'active-token', 500, 500, 500, 500
      );
    `);
    precedingSqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(
      migrated.catalog.reconcileOpticalDrives([
        { devicePath: "/dev/sr0", isConfiguredDevice: true },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "preceding-drive",
        devicePath: "/dev/sr0",
        isEnabled: false,
      }),
    ]);
    expect(
      migrated.catalog.listOriginalDiscArchives({
        ids: ["preceding-archive" as OriginalDiscArchiveId],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "preceding-archive",
        catalogReviewedAt: new Date(456),
      }),
    ]);
    expect(migrated.archiveJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "preceding-archive-job",
        status: "completed",
        progressPhase: "finalizing",
      }),
      expect.objectContaining({
        id: "active-archive-job",
        status: "running",
        progressPhase: "preparing",
      }),
    ]));
    migrated.close();

    const sqlite = new DatabaseSync(databasePath);
    expect(
      sqlite
        .prepare("select name from pragma_table_info('optical_drives')")
        .all()
        .map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        "configuration_default_resolved",
        "is_configured_target",
      ]),
    );
    expect(
      sqlite
        .prepare("select name from pragma_table_info('optical_drives')")
        .all(),
    ).not.toContainEqual({ name: "configuration_default_applied" });
    expect(
      sqlite
        .prepare(
          "select name from pragma_table_info('original_disc_archives')",
        )
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "legacy_cutover_pending" },
      { name: "verification_message" },
      { name: "verification_status" },
      { name: "verified_at" },
    ]));
    expect(
      sqlite
        .prepare("select name from pragma_table_info('encode_jobs')")
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "partial_cleanup_lease_token" },
      { name: "publication_completion_pending" },
      { name: "publication_pending" },
      { name: "verification_message" },
      { name: "verification_status" },
      { name: "verified_at" },
    ]));
    expect(
      sqlite
        .prepare("select name from pragma_table_info('archive_jobs')")
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "archive_request_id" },
      { name: "attempt_ordinal" },
      { name: "claim_token" },
      { name: "progress_phase" },
    ]));
    expect(
      sqlite
        .prepare(
          "select name from __drizzle_migrations order by id desc limit 8",
        )
        .all(),
    ).toEqual([
      {
        name: "20260812170422_furry_gateway",
      },
      {
        name: "20260812160800_explicit-archive-only-review",
      },
      {
        name: "20260812151540_disc-inspection-archive-requests",
      },
      {
        name: "20260812142359_even_human_robot",
      },
      {
        name: "20260812011518_optical_drive_present_path_identity",
      },
      {
        name: "20260811214753_archive-job-progress-phase",
      },
      {
        name: "20260811051606_blue_oracle",
      },
      {
        name: "20260807000001_explicit-filesystem-verification",
      },
    ]);
    expect(
      sqlite
        .prepare(
          "select configuration_default_resolved as resolved from optical_drives where id = 'preceding-drive'",
        )
        .get(),
    ).toEqual({ resolved: 1 });
    sqlite.close();
  });

  it("migrates existing Catalog Review state without inferring Archive only", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const archiveOnlyMigration =
      "20260812160800_explicit-archive-only-review";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name < archiveOnlyMigration)
      .sort();
    for (const migrationName of predecessorNames) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      create table __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
    `);
    const recordMigration = sqlite.prepare(`
      insert into __drizzle_migrations (hash, created_at, name)
      values (?, 0, ?)
    `);
    for (const migrationName of predecessorNames) {
      recordMigration.run(`pre-archive-only-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values ('review-migration-drive', '/dev/review-migration', 1, 1, 1, 1);
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values
        ('pending-review-disc', 'review-migration-drive', 'dvd',
          'pending-review-fingerprint', 'archived', 1, 1, 1),
        ('completed-review-disc', 'review-migration-drive', 'dvd',
          'completed-review-fingerprint', 'archived', 2, 2, 2);
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, catalog_reviewed_at, created_at, updated_at
      ) values
        ('pending-review-archive', 'pending-review-disc', 'dvd', 'iso',
          '/media/originals/Pending Review.iso', 'pending-review-fingerprint',
          1, null, 1, 1),
        ('completed-review-archive', 'completed-review-disc', 'dvd', 'iso',
          '/media/originals/Completed Review.iso',
          'completed-review-fingerprint', 2, 3, 2, 3);
    `);
    sqlite.close();

    const access = openTestDatabase(databasePath);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        id: "pending-review-archive",
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
      }),
      expect.objectContaining({
        id: "completed-review-archive",
        catalogReviewedAt: new Date(3),
        catalogReviewOutcome: "reviewed_with_selections",
      }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ catalogReviewOutcome: "archive_only" }),
      ]),
    );
    access.close();

    const migratedSqlite = new DatabaseSync(databasePath);
    expect(() =>
      migratedSqlite.prepare(`
        update original_disc_archives
        set catalog_review_outcome = 'archive_only'
        where id = 'pending-review-archive'
      `).run()
    ).toThrow(/original_disc_archives_catalog_review_outcome_check/);
    migratedSqlite.close();
  });

  it("migrates existing Encode Job outcomes before accepting cancellation states", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const precedingMigrations = [
      "20260722045326_core-catalog-and-queues",
      "20260726160810_encoding-profile-active-state",
      "20260802150655_optical-drive-configuration-default",
      "20260802190921_optical-drive-configuration-default-resolved",
      "20260803050348_pretty_living_mummy",
      "20260803175923_gorgeous_wendell_rand",
      "20260803213207_catalog-review-upgrade-guard",
      "20260804011718_catalog-item-other-kind",
      "20260804051834_legacy-cutover-fence",
      "20260804143147_durable-legacy-cutover-staging",
      "20260804182121_dizzy_wither",
      "20260804184603_tense_zzzax",
      "20260805005453_outstanding_texas_twister",
      "20260805015911_heavy_franklin_richards",
      "20260805022523_far_archangel",
      "20260805142313_glamorous_rage",
      "20260805163203_unique_gideon",
      "20260806204012_burly_johnny_storm",
      "20260807000001_explicit-filesystem-verification",
      "20260811051606_blue_oracle",
      "20260811214753_archive-job-progress-phase",
      "20260812011518_optical_drive_present_path_identity",
    ];
    for (const migrationName of precedingMigrations) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      create table __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
    `);
    const recordMigration = sqlite.prepare(`
      insert into __drizzle_migrations (hash, created_at, name)
      values (?, 0, ?)
    `);
    for (const migrationName of precedingMigrations) {
      recordMigration.run(`pre-cancel-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values ('pre-cancel-drive', '/dev/pre-cancel', 1, 1, 1, 1);
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'pre-cancel-disc', 'pre-cancel-drive', 'dvd', 'pre-cancel-disc',
        'archived', 1, 1, 1
      );
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, catalog_reviewed_at, created_at, updated_at
      ) values (
        'pre-cancel-archive', 'pre-cancel-disc', 'dvd', 'iso',
        '/media/originals/pre-cancel.iso', 'pre-cancel-disc', 1, 1, 1, 1
      );
      insert into media_items (
        id, kind, title, created_at, updated_at
      ) values ('pre-cancel-movie', 'movie', 'Pre-cancel Movie', 1, 1);
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        created_at, updated_at
      ) values (
        'pre-cancel-selection', 'pre-cancel-archive', 'pre-cancel-movie',
        'dvd:main-feature', 'main_feature', 1, 1
      );
      insert into archive_jobs (
        id, detected_disc_id, original_disc_archive_id, status,
        progress_phase, progress_percent, created_at, updated_at
      ) values (
        'pre-cancel-archive-job', 'pre-cancel-disc', 'pre-cancel-archive',
        'completed', 'finalizing', 100, 1, 1
      );
    `);
    const insertProfile = sqlite.prepare(`
      insert into encoding_profiles (
        id, key, display_name, media_domain, version, is_active, settings,
        created_at, updated_at
      ) values (?, ?, ?, 'dvd_video', 1, 1, '{}', 1, 1)
    `);
    const insertJob = sqlite.prepare(`
      insert into encode_jobs (
        id, disc_selection_id, encoding_profile_id, output_path,
        reserves_output_path, status, progress_percent, created_at, updated_at
      ) values (?, 'pre-cancel-selection', ?, ?, ?, ?, ?, 1, 1)
    `);
    for (const [index, status] of [
      "queued",
      "running",
      "completed",
      "failed",
    ].entries()) {
      const profileId = `pre-cancel-profile-${status}`;
      insertProfile.run(profileId, profileId, `Pre-cancel ${status}`);
      insertJob.run(
        `pre-cancel-job-${status}`,
        profileId,
        `/media/movies/pre-cancel-${status}.mkv`,
        status === "failed" ? 0 : 1,
        status,
        status === "completed" ? 100 : index,
      );
    }
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(
      migrated.encodeJobs.list().map((job) => ({
        id: job.id,
        status: job.status,
      })),
    ).toEqual(expect.arrayContaining([
      { id: "pre-cancel-job-queued", status: "queued" },
      { id: "pre-cancel-job-running", status: "running" },
      { id: "pre-cancel-job-completed", status: "completed" },
      { id: "pre-cancel-job-failed", status: "failed" },
    ]));
    expect(
      migrated.encodeJobs.requestCancellation(
        "pre-cancel-job-queued" as EncodeJobId,
      ),
    ).toMatchObject({ status: "cancelled" });
    migrated.close();

    const migratedSqlite = new DatabaseSync(databasePath);
    expect(() =>
      migratedSqlite.prepare(`
        update encode_jobs set status = 'cancellation_requested'
        where id = ?
      `).run("pre-cancel-job-running")
    ).not.toThrow();
    expect(() =>
      migratedSqlite.prepare(`
        update encode_jobs set status = 'unsupported' where id = ?
      `).run("pre-cancel-job-queued")
    ).toThrow(/encode_jobs_status_check/);
    expect(() =>
      migratedSqlite.prepare(`
        update archive_jobs set status = 'cancelled' where id = ?
      `).run("pre-cancel-archive-job")
    ).toThrow(/archive_jobs_status_check/);
    migratedSqlite.close();
  });

  it("backfills tentative completion authority from the immediate predecessor", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const precedingMigrations = [
      "20260722045326_core-catalog-and-queues",
      "20260726160810_encoding-profile-active-state",
      "20260802150655_optical-drive-configuration-default",
      "20260802190921_optical-drive-configuration-default-resolved",
      "20260803050348_pretty_living_mummy",
      "20260803175923_gorgeous_wendell_rand",
      "20260803213207_catalog-review-upgrade-guard",
      "20260804011718_catalog-item-other-kind",
      "20260804051834_legacy-cutover-fence",
      "20260804143147_durable-legacy-cutover-staging",
      "20260804182121_dizzy_wither",
      "20260804184603_tense_zzzax",
      "20260805005453_outstanding_texas_twister",
      "20260805015911_heavy_franklin_richards",
      "20260805022523_far_archangel",
      "20260805142313_glamorous_rage",
      "20260805163203_unique_gideon",
    ];
    for (const migrationName of precedingMigrations) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      CREATE TABLE __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
    `);
    const recordMigration = sqlite.prepare(`
      INSERT INTO __drizzle_migrations (hash, created_at, name)
      VALUES (?, 0, ?)
    `);
    for (const migrationName of precedingMigrations) {
      recordMigration.run(`predecessor-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      INSERT INTO optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) VALUES ('predecessor-drive', '/dev/predecessor', 1, 1, 1, 1);
      INSERT INTO detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) VALUES (
        'predecessor-disc', 'predecessor-drive', 'dvd',
        'predecessor-fingerprint', 'archived', 1, 1, 1
      );
      INSERT INTO original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, catalog_reviewed_at, created_at, updated_at
      ) VALUES (
        'predecessor-archive', 'predecessor-disc', 'dvd', 'iso',
        '/media/originals/predecessor.iso', 'predecessor-fingerprint',
        1, 1, 1, 1
      );
      INSERT INTO media_items (
        id, kind, title, created_at, updated_at
      ) VALUES ('predecessor-movie', 'movie', 'Predecessor', 1, 1);
      INSERT INTO disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        created_at, updated_at
      ) VALUES (
        'predecessor-selection', 'predecessor-archive', 'predecessor-movie',
        'dvd:main-feature', 'main_feature', 1, 1
      );
      INSERT INTO encoding_profiles (
        id, key, display_name, media_domain, version, is_active, settings,
        created_at, updated_at
      ) VALUES (
        'predecessor-profile', 'predecessor-profile', 'Predecessor profile',
        'dvd_video', 1, 1, '{}', 1, 1
      );
      INSERT INTO encode_jobs (
        id, disc_selection_id, encoding_profile_id, output_path, status,
        partial_cleanup_output_path, partial_cleanup_claim_token,
        partial_cleanup_lease_token, publication_pending, claimed_by,
        claim_token, claimed_at, started_at, completed_at, created_at,
        updated_at
      ) VALUES (
        'predecessor-job', 'predecessor-selection', 'predecessor-profile',
        '/media/movies/predecessor.mkv', 'completed',
        '/media/movies/predecessor.mkv', 'predecessor-claim',
        'predecessor-mutation', 1, 'predecessor-worker',
        'predecessor-claim', 1, 1, 2, 1, 2
      );
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: "predecessor-job",
        publicationCompletionPending: true,
        publicationPending: true,
        status: "completed",
      }),
    ]);
    const cleanup = migrated.encodeJobs.listPendingPartialCleanups()[0];
    if (!cleanup) {
      throw new Error("Expected predecessor publication provenance");
    }
    migrated.encodeJobs.completePartialCleanup(cleanup);
    expect(migrated.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: "predecessor-job",
        partialCleanupClaimToken: null,
        publicationCompletionPending: false,
        publicationPending: false,
        status: "failed",
      }),
    ]);
    migrated.close();
  });

  it("fails closed when upgrading caller-era unsafe Disc Selections", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const precedingMigrations = [
      "20260722045326_core-catalog-and-queues",
      "20260726160810_encoding-profile-active-state",
      "20260802150655_optical-drive-configuration-default",
      "20260802190921_optical-drive-configuration-default-resolved",
      "20260803050348_pretty_living_mummy",
    ];
    for (const migrationName of precedingMigrations) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      create table __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
    `);
    const recordMigration = sqlite.prepare(`
      insert into __drizzle_migrations (hash, created_at, name)
      values (?, 0, ?)
    `);
    for (const migrationName of precedingMigrations) {
      recordMigration.run(`legacy-${migrationName}`, migrationName);
    }
    const contentId = `sha256:${"a".repeat(64)}`;
    sqlite.prepare(`
      insert into optical_drives (
        id, device_path, is_enabled, is_present, last_seen_at, created_at,
        updated_at
      ) values (?, ?, 1, 1, 0, 0, 0)
    `).run("legacy-drive", "/dev/sr0");
    const insertDetectedDisc = sqlite.prepare(`
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, scan_data,
        detected_at, created_at, updated_at
      ) values (?, ?, 'dvd', ?, 'archived', ?, 0, 0, 0)
    `);
    const titleMapFor = (fingerprint: string) => JSON.stringify({
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 1_800,
        chapters: 4,
        audioStreams: [],
        subtitles: [],
      }],
    });
    insertDetectedDisc.run(
      "duplicate-disc",
      "legacy-drive",
      contentId,
      titleMapFor(contentId),
    );
    const noncanonicalContentId = `sha256:${"b".repeat(64)}`;
    insertDetectedDisc.run(
      "noncanonical-disc",
      "legacy-drive",
      noncanonicalContentId,
      titleMapFor(noncanonicalContentId),
    );
    const scanInvalidContentId = `sha256:${"c".repeat(64)}`;
    insertDetectedDisc.run(
      "scan-invalid-disc",
      "legacy-drive",
      scanInvalidContentId,
      titleMapFor(scanInvalidContentId),
    );
    sqlite.exec(`
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'safe-disc', 'legacy-drive', 'dvd', 'safe-legacy', 'archived', 0, 0, 0
      );
    `);
    sqlite.exec(`
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, created_at, updated_at
      ) values
        ('duplicate-archive', 'duplicate-disc', 'dvd', 'iso',
          '/media/originals/Duplicate Legacy.iso', '${contentId}', 0, 0, 0),
        ('noncanonical-archive', 'noncanonical-disc', 'dvd', 'iso',
          '/media/originals/Noncanonical Legacy.iso', '${noncanonicalContentId}', 0, 0, 0),
        ('scan-invalid-archive', 'scan-invalid-disc', 'dvd', 'iso',
          '/media/originals/Scan Invalid Legacy.iso', '${scanInvalidContentId}', 0, 0, 0);
      insert into media_items (id, kind, title, created_at, updated_at) values
        ('legacy-episode-1', 'episode', 'Legacy Episode One', 0, 0),
        ('legacy-episode-1-copy', 'episode', 'Legacy Episode One Copy', 0, 0),
        ('legacy-main', 'movie', 'Legacy Main Feature', 0, 0),
        ('legacy-main-alias', 'movie', 'Legacy Main Feature Alias', 0, 0),
        ('legacy-noncanonical', 'bonus_feature', 'Noncanonical', 0, 0),
        ('legacy-missing-title', 'bonus_feature', 'Missing Title', 0, 0),
        ('safe-main-item', 'movie', 'Safe Main Feature', 0, 0);
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        title_number, chapter_start, chapter_end, created_at, updated_at
      ) values
        ('duplicate-a', 'duplicate-archive', 'legacy-episode-1',
          'dvd:title:1', 'dvd_title', 1, null, null, 0, 100),
        ('duplicate-b', 'duplicate-archive', 'legacy-episode-1-copy',
          'caller:title-one-copy', 'dvd_title', 1, null, null, 0, 200),
        ('duplicate-main-a', 'duplicate-archive', 'legacy-main',
          'dvd:main-feature', 'main_feature', null, null, null, 0, 210),
        ('duplicate-main-b', 'duplicate-archive', 'legacy-main-alias',
          'caller:main', 'main_feature', null, null, null, 0, 220),
        ('noncanonical', 'noncanonical-archive', 'legacy-noncanonical',
          'caller:title-one', 'dvd_title', 1, null, null, 0, 250),
        ('missing-title', 'scan-invalid-archive', 'legacy-missing-title',
          'dvd:title:999', 'dvd_title', 999, null, null, 0, 300);
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, created_at, updated_at
      ) values
        ('safe-archive', 'safe-disc', 'dvd', 'iso',
          '/media/originals/Safe Legacy.iso', 'safe-legacy', 0, 0, 0);
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        created_at, updated_at
      ) values
        ('safe-main', 'safe-archive', 'safe-main-item',
          'dvd:main-feature', 'main_feature', 0, 400);
      insert into encoding_profiles (
        id, key, display_name, media_domain, version, settings,
        created_at, updated_at
      ) values
        ('legacy-profile', 'legacy', 'Legacy DVD', 'dvd_video', 1, '{}', 0, 0);
      insert into encode_jobs (
        id, disc_selection_id, encoding_profile_id, output_path, status,
        progress_percent, claimed_by, claim_token, claimed_at, started_at,
        completed_at, error_message, created_at, updated_at
      ) values
        ('unsafe-job', 'missing-title', 'legacy-profile',
          '/media/movies/Unsafe Legacy.mkv', 'queued', 0, null, null, null,
          null, null, null, 0, 0),
        ('completed-history', 'noncanonical', 'legacy-profile',
          '/media/movies/Completed Legacy.mkv', 'completed', 100,
          'legacy-worker', 'legacy-claim', 100, 100, 200, null, 0, 200),
        ('failed-history', 'duplicate-b', 'legacy-profile',
          '/media/movies/Failed Legacy.mkv', 'failed', 41,
          'legacy-worker', 'failed-claim', 300, 300, null,
          'legacy transcode failed', 0, 400),
        ('completed-main-history', 'duplicate-main-a', 'legacy-profile',
          '/media/movies/Completed Main Legacy.mkv', 'completed', 100,
          'legacy-worker', 'completed-main-claim', 500, 500, 600, null, 0, 600),
        ('failed-main-alias-history', 'duplicate-main-b', 'legacy-profile',
          '/media/movies/Failed Main Alias Legacy.mkv', 'failed', 59,
          'legacy-worker', 'failed-main-alias-claim', 700, 700, null,
          'legacy main alias transcode failed', 0, 800);
    `);
    sqlite.close();

    const access = openTestDatabase(databasePath);
    for (const archiveId of [
      "duplicate-archive",
      "noncanonical-archive",
      "scan-invalid-archive",
    ]) {
      expect(
        access.catalog.listOriginalDiscArchives({
          ids: [archiveId as OriginalDiscArchiveId],
        })[0],
      ).toMatchObject({ catalogReviewedAt: null });
    }
    expect(
      access.catalog.listOriginalDiscArchives({
        ids: ["safe-archive" as OriginalDiscArchiveId],
      })[0],
    ).toMatchObject({ catalogReviewedAt: new Date(400) });
    expect(() =>
      completeCatalogReview(
        access,
        "duplicate-archive" as OriginalDiscArchiveId,
      )
    ).toThrow(/duplicate logical Disc Selections/);
    expect(() =>
      completeCatalogReview(
        access,
        "noncanonical-archive" as OriginalDiscArchiveId,
      )
    ).toThrow(/canonical Disc Selection source keys/);
    expect(() =>
      completeCatalogReview(
        access,
        "scan-invalid-archive" as OriginalDiscArchiveId,
      )
    ).toThrow(/DVD title 999 is not present/);
    expect(() =>
      access.encodeJobs.enqueue({
        discSelectionId: "missing-title" as DiscSelectionId,
        encodingProfileId: "legacy-profile" as EncodingProfileId,
        outputPath: "/media/movies/Still Unsafe.mkv",
      })
    ).toThrow(DomainInvariantError);
    expect(access.encodeJobs.claimNext("upgrade-worker")).toBeNull();
    expect(access.encodeJobs.list(["failed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "unsafe-job",
          errorMessage: expect.stringContaining("catalog review"),
        }),
        expect.objectContaining({
          id: "failed-history",
          progressPercent: 41,
          errorMessage: "legacy transcode failed",
        }),
        expect.objectContaining({
          id: "failed-main-alias-history",
          progressPercent: 59,
          errorMessage: "legacy main alias transcode failed",
        }),
      ]),
    );
    expect(access.encodeJobs.list(["completed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "completed-history",
          progressPercent: 100,
          completedAt: new Date(200),
          errorMessage: null,
        }),
        expect.objectContaining({
          id: "completed-main-history",
          progressPercent: 100,
          completedAt: new Date(600),
          errorMessage: null,
        }),
      ]),
    );
    expect(() =>
      access.encodeJobs.requeue("unsafe-job" as EncodeJobId)
    ).toThrow(InvalidStatusTransitionError);
    expect(access.encodeJobs.claimNext("requeued-upgrade-worker")).toBeNull();

    const repairedDuplicate = access.catalog.repairDiscSelection(
      "duplicate-b" as DiscSelectionId,
      {
        originalDiscArchiveId: "duplicate-archive" as OriginalDiscArchiveId,
        mediaItemId: "legacy-episode-1-copy" as MediaItemId,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 1,
        },
      },
    );
    expect(repairedDuplicate).toMatchObject({
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 1,
      },
    });
    expect(repairedDuplicate.id).not.toBe("duplicate-b");
    expect(access.catalog.listDiscSelections({
      ids: ["duplicate-b" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "duplicate-b",
        sourceIdentity: {
          kind: "dvd_title",
          titleNumber: 1,
        },
      }),
    ]);
    expect(access.encodeJobs.list(["failed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "failed-history",
          discSelectionId: "duplicate-b",
          progressPercent: 41,
          errorMessage: "legacy transcode failed",
        }),
      ]),
    );
    expect(
      access.catalog.deleteDiscSelection(
        "duplicate-main-b" as DiscSelectionId,
      ),
    ).toMatchObject({
      id: "duplicate-main-b",
      deletedEncodeJobs: 0,
      deletionComplete: true,
    });
    expect(access.catalog.listDiscSelections({
      ids: ["duplicate-main-b" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "duplicate-main-b",
        sourceIdentity: { kind: "main_feature" },
      }),
    ]);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: "duplicate-archive" as OriginalDiscArchiveId,
    })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "duplicate-main-a" }),
      ]),
    );
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: "duplicate-archive" as OriginalDiscArchiveId,
    })).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "duplicate-main-b" }),
      ]),
    );
    expect(access.encodeJobs.list(["failed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "failed-main-alias-history",
          discSelectionId: "duplicate-main-b",
          progressPercent: 59,
          errorMessage: "legacy main alias transcode failed",
        }),
      ]),
    );
    expect(access.encodeJobs.list(["completed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "completed-main-history",
          discSelectionId: "duplicate-main-a",
          completedAt: new Date(600),
        }),
      ]),
    );

    const repairedNoncanonical = access.catalog.repairDiscSelection(
      "noncanonical" as DiscSelectionId,
      {
        originalDiscArchiveId:
          "noncanonical-archive" as OriginalDiscArchiveId,
        mediaItemId: "legacy-noncanonical" as MediaItemId,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    expect(repairedNoncanonical).toMatchObject({
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(repairedNoncanonical.id).not.toBe("noncanonical");
    expect(access.catalog.listDiscSelections({
      ids: ["noncanonical" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "noncanonical",
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
    ]);
    expect(access.encodeJobs.list(["completed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "completed-history",
          discSelectionId: "noncanonical",
          progressPercent: 100,
          completedAt: new Date(200),
          errorMessage: null,
        }),
      ]),
    );

    const repairedMissingTitle = access.catalog.repairDiscSelection(
      "missing-title" as DiscSelectionId,
      {
        originalDiscArchiveId:
          "scan-invalid-archive" as OriginalDiscArchiveId,
        mediaItemId: "legacy-missing-title" as MediaItemId,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    expect(repairedMissingTitle).toMatchObject({
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(repairedMissingTitle.id).not.toBe("missing-title");
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId:
        "scan-invalid-archive" as OriginalDiscArchiveId,
    })).toEqual([
      expect.objectContaining({
        id: repairedMissingTitle.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
    ]);
    expect(access.catalog.listDiscSelections({
      ids: ["missing-title" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "missing-title",
        sourceIdentity: { kind: "dvd_title", titleNumber: 999 },
      }),
    ]);
    expect(access.encodeJobs.list(["failed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "unsafe-job",
          discSelectionId: "missing-title",
          errorMessage: expect.stringContaining("catalog review"),
        }),
      ]),
    );

    for (const archiveId of [
      "duplicate-archive",
      "noncanonical-archive",
      "scan-invalid-archive",
    ]) {
      expect(
        completeCatalogReview(
          access,
          archiveId as OriginalDiscArchiveId,
        ),
      ).toMatchObject({ catalogReviewedAt: expect.any(Date) });
    }
    access.encodingProfiles.setActive({
      id: "legacy-profile" as EncodingProfileId,
      mediaDomain: "dvd_video",
      isActive: true,
    });
    const repairedJob = access.encodeJobs.enqueue({
      discSelectionId: repairedMissingTitle.id,
      encodingProfileId: "legacy-profile" as EncodingProfileId,
      outputPath: "/media/movies/Unsafe Legacy.mkv",
    });
    expect(repairedJob).toMatchObject({
      discSelectionId: repairedMissingTitle.id,
      status: "queued",
    });
    expect(repairedJob.id).not.toBe("unsafe-job");
    expect(access.encodeJobs.claimNext("repaired-upgrade-worker")).toMatchObject({
      id: repairedJob.id,
      discSelectionId: repairedMissingTitle.id,
      status: "running",
    });
    expect(access.encodeJobs.list(["failed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "unsafe-job",
          discSelectionId: "missing-title",
          errorMessage: expect.stringContaining("catalog review"),
        }),
      ]),
    );
    access.close();
  });

  it("upgrades existing Media Items to support the catch-all catalog kind", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const precedingMigrations = [
      "20260722045326_core-catalog-and-queues",
      "20260726160810_encoding-profile-active-state",
      "20260802150655_optical-drive-configuration-default",
      "20260802190921_optical-drive-configuration-default-resolved",
      "20260803050348_pretty_living_mummy",
      "20260803175923_gorgeous_wendell_rand",
      "20260803213207_catalog-review-upgrade-guard",
    ];
    for (const migrationName of precedingMigrations) {
      const migration = readFileSync(
        new URL(`../drizzle/${migrationName}/migration.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          sqlite.exec(statement);
        }
      }
    }
    sqlite.exec(`
      create table __drizzle_migrations (
        id integer primary key,
        hash text not null,
        created_at numeric,
        name text,
        applied_at text
      );
    `);
    const recordMigration = sqlite.prepare(`
      insert into __drizzle_migrations (hash, created_at, name)
      values (?, 0, ?)
    `);
    for (const migrationName of precedingMigrations) {
      recordMigration.run(`legacy-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into media_items (
        id, parent_id, kind, title, created_at, updated_at
      ) values
        ('legacy-movie', null, 'movie', 'Legacy Movie', 100, 100),
        (
          'legacy-extra', 'legacy-movie', 'bonus_feature', 'Legacy Extra',
          100, 100
        );
    `);
    sqlite.close();

    const access = openTestDatabase(databasePath);
    const other = access.catalog.createMediaItem({
      kind: "other",
      title: "Local Recording",
    });

    expect(access.catalog.listMediaItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "legacy-movie", kind: "movie" }),
        expect.objectContaining({
          id: "legacy-extra",
          parentId: "legacy-movie",
          kind: "bonus_feature",
        }),
        expect.objectContaining({ id: other.id, kind: "other" }),
      ]),
    );
    access.close();

    const upgradedSqlite = new DatabaseSync(databasePath);
    expect(upgradedSqlite.prepare("pragma foreign_key_check").all()).toEqual(
      [],
    );
    upgradedSqlite.close();
  });

  it("rejects malformed and resource-unbounded DVD scans at the catalog facade", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"a".repeat(64)}`;
    const baseTitle = {
      number: 1,
      durationSeconds: 1,
      chapters: 1,
      audioStreams: [],
      subtitles: [],
    };

    for (const scanData of [
      { schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION, contentId, titles: [{}] },
      {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: Array.from({ length: MAX_DVD_TITLES + 1 }, (_, index) => ({
          ...baseTitle,
          number: index + 1,
        })),
      },
    ]) {
      expect(() =>
        access.catalog.registerDetectedDisc({
          opticalDriveId: drive.id,
          discKind: "dvd",
          fingerprint: contentId,
          scanData,
        }),
      ).toThrow(DomainInvariantError);
    }
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("rejects a DVD scan whose content identity differs from its fingerprint", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });

    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `sha256:${"a".repeat(64)}`,
        scanData: {
          schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
          contentId: `sha256:${"b".repeat(64)}`,
          titles: [
            {
              number: 1,
              durationSeconds: 1,
              chapters: 1,
              audioStreams: [],
              subtitles: [],
            },
          ],
        },
      }),
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listDetectedDiscs()).toEqual([]);
    access.close();
  });

  it("does not advance a Detected Disc version for identical scan data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const input = {
      opticalDriveId: drive.id,
      discKind: "dvd" as const,
      fingerprint: `sha256:${"a".repeat(64)}`,
      volumeLabel: "UNCHANGED_DISC",
      scanData: {
        schemaVersion: 2,
        contentId: `sha256:${"a".repeat(64)}`,
        titles: [
          {
            number: 1,
            durationSeconds: 1,
            chapters: 1,
            audioStreams: [],
            subtitles: [],
          },
        ],
      },
    };
    const first = access.catalog.registerDetectedDisc(input);

    vi.setSystemTime(new Date("2026-07-26T18:05:00.000Z"));
    const repeated = access.catalog.registerDetectedDisc(input);

    expect(repeated.detectedAt).toEqual(first.detectedAt);
    expect(repeated.updatedAt).toEqual(first.updatedAt);
    access.close();
  });

  it("requires positive safe integer Encoding Profile versions", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const profile = access.encodingProfiles.create({
      key: "version-boundary",
      displayName: "Version boundary",
      mediaDomain: "dvd_video",
      settings: {},
    });
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    sqlite
      .prepare("update encoding_profiles set version = ? where id = ?")
      .run(Number.MAX_SAFE_INTEGER, profile.id);
    sqlite.close();

    const reopened = openTestDatabase(databasePath);
    expect(() =>
      reopened.encodingProfiles.createVersion({
        sourceProfileId: profile.id,
        mediaDomain: "dvd_video",
        settings: {},
      }),
    ).toThrow(DomainInvariantError);
    reopened.close();

    const directSql = new DatabaseSync(databasePath);
    expect(() =>
      directSql
        .prepare(`
          insert into encoding_profiles (
            id, key, display_name, media_domain, version, settings,
            created_at, updated_at
          ) values (?, ?, ?, 'dvd_video', ?, '{}', 0, 0)
        `)
        .run(
          "fractional-profile-version",
          "fractional-version",
          "Fractional version",
          1.5,
        ),
    ).toThrow();
    directSql.close();
  });

  it("creates an active first Encoding Profile version within its media domain", () => {
    const access = openTestDatabase();

    const dvdProfile = access.encodingProfiles.create({
      key: "library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const audioProfile = access.encodingProfiles.create({
      key: "library",
      displayName: "Audio library",
      mediaDomain: "audio",
      settings: { codec: "flac" },
    });

    expect(dvdProfile).toEqual(
      expect.objectContaining({
        key: "library",
        mediaDomain: "dvd_video",
        version: 1,
        isActive: true,
      }),
    );
    expect(
      access.encodingProfiles.list({ mediaDomain: "dvd_video" }),
    ).toEqual([expect.objectContaining({ id: dvdProfile.id })]);
    expect(
      access.encodingProfiles.list({ mediaDomain: "dvd_video" }),
    ).not.toContainEqual(expect.objectContaining({ id: audioProfile.id }));
    expect(() =>
      access.encodingProfiles.create({
        key: "library",
        displayName: "Duplicate DVD library",
        mediaDomain: "dvd_video",
        settings: { preset: "Fast 576p25", container: "mkv" },
      }),
    ).toThrow(DomainInvariantError);

    access.close();
  });

  it("migrates historical active state without rewriting legacy settings", () => {
    const sqlite = new DatabaseSync(createTestDatabasePath());
    const prePrMigration = readFileSync(
      new URL(
        "../drizzle/20260722045326_core-catalog-and-queues/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of prePrMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        sqlite.exec(statement);
      }
    }
    sqlite.exec(`
      insert into encoding_profiles (
        id, key, display_name, media_domain, version, settings,
        created_at, updated_at
      ) values
        ('dvd-v1', 'library', 'DVD library', 'dvd_video', 1,
          '{"preset":"Fast 480p30"}', 0, 0),
        ('dvd-v2', 'library', 'DVD library', 'dvd_video', 2, '{}', 0, 0),
        ('audio-v1', 'library', 'Audio library', 'audio', 1, '{}', 0, 0);
    `);
    const migration = readFileSync(
      new URL(
        "../drizzle/20260726160810_encoding-profile-active-state/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        sqlite.exec(statement);
      }
    }

    expect(
      sqlite
        .prepare(`
          select id, is_active as isActive
          from encoding_profiles
          order by id
        `)
        .all(),
    ).toEqual([
      { id: "audio-v1", isActive: 1 },
      { id: "dvd-v1", isActive: 0 },
      { id: "dvd-v2", isActive: 1 },
    ]);
    expect(
      sqlite
        .prepare("select settings from encoding_profiles where id = 'dvd-v1'")
        .get(),
    ).toEqual({ settings: '{"preset":"Fast 480p30"}' });
    expect(() =>
      sqlite
        .prepare(`
          update encoding_profiles
          set is_active = 1
          where id = 'dvd-v1'
        `)
        .run(),
    ).toThrow();
    sqlite.close();
  });

  it("creates sequential immutable Encoding Profile versions without crossing media domains", () => {
    const access = openTestDatabase();
    const versionOne = access.encodingProfiles.create({
      key: "library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });

    const versionTwo = access.encodingProfiles.createVersion({
      sourceProfileId: versionOne.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30", container: "mkv" },
    });

    expect(versionTwo).toEqual(
      expect.objectContaining({
        key: "library",
        displayName: "DVD library",
        mediaDomain: "dvd_video",
        version: 2,
        isActive: false,
        settings: { preset: "HQ 480p30", container: "mkv" },
      }),
    );
    expect(
      access.encodingProfiles.find({
        key: "library",
        mediaDomain: "dvd_video",
        version: 1,
      }),
    ).toEqual(
      expect.objectContaining({
        id: versionOne.id,
        isActive: true,
        settings: { preset: "Fast 480p30", container: "mkv" },
      }),
    );
    expect(() =>
      access.encodingProfiles.createVersion({
        sourceProfileId: versionOne.id,
        mediaDomain: "audio",
        settings: { codec: "flac" },
      }),
    ).toThrow(DomainInvariantError);

    access.close();
  });

  it("allocates every Encoding Profile version under simultaneous writers", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const versionOne = access.encodingProfiles.create({
      key: "concurrent-library",
      displayName: "Concurrent DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        {
          operation: "create-profile-version",
          sourceProfileId: versionOne.id,
          preset: "HQ 480p30",
        },
        {
          operation: "create-profile-version",
          sourceProfileId: versionOne.id,
          preset: "Super HQ 480p30",
        },
      ],
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "versioned", version: 2 }),
        expect.objectContaining({ outcome: "versioned", version: 3 }),
      ]),
    );
    expect(
      access.encodingProfiles
        .list({ mediaDomain: "dvd_video" })
        .map((profile) => profile.version),
    ).toEqual([1, 2, 3]);
    access.close();
  });

  it("activates at most one Encoding Profile version and permits deactivation", () => {
    const access = openTestDatabase();
    const versionOne = access.encodingProfiles.create({
      key: "library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const versionTwo = access.encodingProfiles.createVersion({
      sourceProfileId: versionOne.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30", container: "mkv" },
    });

    expect(
      access.encodingProfiles.setActive({
        id: versionTwo.id,
        mediaDomain: "dvd_video",
        isActive: true,
      }),
    ).toEqual(expect.objectContaining({ id: versionTwo.id, isActive: true }));
    expect(
      access.encodingProfiles.list({
        mediaDomain: "dvd_video",
        activeOnly: true,
      }),
    ).toEqual([expect.objectContaining({ id: versionTwo.id })]);
    expect(
      access.encodingProfiles.find({
        key: "library",
        mediaDomain: "dvd_video",
        version: 1,
      }),
    ).toEqual(expect.objectContaining({ id: versionOne.id, isActive: false }));

    access.encodingProfiles.setActive({
      id: versionTwo.id,
      mediaDomain: "dvd_video",
      isActive: false,
    });
    expect(
      access.encodingProfiles.list({
        mediaDomain: "dvd_video",
        activeOnly: true,
      }),
    ).toEqual([]);
    expect(() =>
      access.encodingProfiles.setActive({
        id: versionTwo.id,
        mediaDomain: "audio",
        isActive: true,
      }),
    ).toThrow(DomainInvariantError);

    access.close();
  });

  it("serializes simultaneous Encoding Profile activations", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const versionOne = access.encodingProfiles.create({
      key: "concurrent-activation",
      displayName: "Concurrent activation",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30", container: "mkv" },
    });
    const versionTwo = access.encodingProfiles.createVersion({
      sourceProfileId: versionOne.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30", container: "mkv" },
    });
    const versionThree = access.encodingProfiles.createVersion({
      sourceProfileId: versionTwo.id,
      mediaDomain: "dvd_video",
      settings: { preset: "Super HQ 480p30", container: "mkv" },
    });

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        { operation: "activate-profile-version", id: versionTwo.id },
        { operation: "activate-profile-version", id: versionThree.id },
      ],
    });

    expect(results).toEqual([
      expect.objectContaining({ outcome: "activated", id: versionTwo.id }),
      expect.objectContaining({ outcome: "activated", id: versionThree.id }),
    ]);
    expect(
      access.encodingProfiles.list({
        mediaDomain: "dvd_video",
        activeOnly: true,
      }),
    ).toHaveLength(1);
    access.close();
  });

  it("creates archives only from matching approved detected discs", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "approved-disc",
    });
    const archiveInput = {
      detectedDiscId: disc.id,
      discKind: "dvd" as const,
      archiveFormat: "iso" as const,
      archivePath: "/media/originals/Approved Disc.iso",
      fingerprint: "approved-disc",
    };

    expect(() =>
      access.catalog.createOriginalDiscArchive(archiveInput),
    ).toThrow(InvalidStatusTransitionError);
    access.catalog.updateDetectedDiscStatus(disc.id, "rejected");
    expect(() =>
      access.catalog.createOriginalDiscArchive(archiveInput),
    ).toThrow(InvalidStatusTransitionError);

    access.catalog.updateDetectedDiscStatus(disc.id, "detected");
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    expect(() =>
      access.catalog.updateDetectedDiscStatus(disc.id, "archived"),
    ).toThrow(InvalidStatusTransitionError);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id, status: "approved" }),
    ]);
    expect(() =>
      access.catalog.createOriginalDiscArchive({
        ...archiveInput,
        discKind: "blu_ray",
      }),
    ).toThrow();
    expect(() =>
      access.catalog.createOriginalDiscArchive({
        ...archiveInput,
        fingerprint: "different-disc",
      }),
    ).toThrow();
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);

    const collisionDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "collision-disc",
    });
    access.catalog.updateDetectedDiscStatus(collisionDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(collisionDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      ...archiveInput,
      detectedDiscId: collisionDisc.id,
      fingerprint: "collision-disc",
    });
    expect(() =>
      access.catalog.createOriginalDiscArchive(archiveInput),
    ).toThrow();
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);

    const archive = access.catalog.createOriginalDiscArchive({
      ...archiveInput,
      archivePath: "/media/originals/Approved Disc unique.iso",
    });
    expect(archive.detectedDiscId).toBe(disc.id);
    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: disc.id })]),
    );
    access.close();
  });

  it("preserves archived disc identity when the same media is rediscovered", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "immutable-disc",
      volumeLabel: "ORIGINAL_LABEL",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Immutable Disc.iso",
      fingerprint: "immutable-disc",
    });

    expect(
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: "immutable-disc",
        volumeLabel: "REFRESHED_LABEL",
      }),
    ).toMatchObject({
      id: disc.id,
      discKind: "dvd",
      volumeLabel: "REFRESHED_LABEL",
      status: "archived",
    });
    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "blu_ray",
        fingerprint: "immutable-disc",
      }),
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual([
      expect.objectContaining({ id: disc.id, discKind: "dvd" }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, discKind: "dvd" }),
    ]);
    access.close();
  });

  it("freezes archived DVD scan evidence after catalog review", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"b".repeat(64)}`;
    const archivedScan = {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId,
      titles: [{
        number: 1,
        durationSeconds: 2_400,
        chapters: 8,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: archivedScan,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Frozen Evidence.iso",
      fingerprint: contentId,
    });
    const episode = access.catalog.createMediaItem({
      kind: "episode",
      title: "Episode Two",
      episodeNumber: 2,
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 5,
        chapterEnd: 8,
      },
    });
    const reviewed = completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "frozen-evidence",
      displayName: "Frozen evidence",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Frozen Evidence.mkv",
    });

    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: contentId,
        scanData: {
          ...archivedScan,
          titles: [{ ...archivedScan.titles[0]!, chapters: 4 }],
        },
      })
    ).toThrow(DomainInvariantError);
    expect(
      access.catalog.listDetectedDiscs(["archived"], { ids: [disc.id] })[0],
    ).toMatchObject({ scanData: archivedScan });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: reviewed.catalogReviewedAt });
    expect(access.encodeJobs.claimNext("frozen-evidence-worker")).toMatchObject({
      id: job.id,
      discSelectionId: selection.id,
      status: "running",
    });
    access.close();
  });

  it("rejects reviewed-data changes while approval remains active", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const scanData = {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId: fingerprint,
      titles: [
        {
          number: 1,
          durationSeconds: 3600,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        },
      ],
    };
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint,
      scanData,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });

    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "blu_ray",
        fingerprint,
        scanData,
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        scanData: {
          ...scanData,
          titles: [{ ...scanData.titles[0]!, number: 2, chapters: 4 }],
        },
      }),
    ).toThrow(DomainInvariantError);

    expect(
      access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel: "REFRESHED_LABEL",
        scanData,
      }),
    ).toMatchObject({
      id: disc.id,
      discKind: "dvd",
      status: "approved",
      scanData,
      volumeLabel: "REFRESHED_LABEL",
    });
    expect(access.archiveRequests.list(["pending"])).toEqual([
      expect.objectContaining({ id: request.id, detectedDiscId: disc.id }),
    ]);
    access.close();
  });

  it("recognizes archived fingerprints across drives and never claims duplicate preservation", () => {
    const access = openTestDatabase();
    const firstDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isPresent: true,
    });
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: firstDrive.id,
      discKind: "dvd",
      fingerprint: "cross-drive-archived-disc",
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: firstDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cross Drive Archived Disc.iso",
      fingerprint: "cross-drive-archived-disc",
    });

    const rediscovered = access.catalog.registerDetectedDisc({
      opticalDriveId: secondDrive.id,
      discKind: "dvd",
      fingerprint: "cross-drive-archived-disc",
    });
    expect(rediscovered).toMatchObject({
      opticalDriveId: secondDrive.id,
      discKind: "dvd",
      fingerprint: "cross-drive-archived-disc",
      status: "archived",
    });
    expect(() =>
      access.archiveRequests.create({ detectedDiscId: rediscovered.id }),
    ).toThrow(DomainInvariantError);

    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: secondDrive.id,
        discKind: "blu_ray",
        fingerprint: "cross-drive-archived-disc",
      }),
    ).toThrow(DomainInvariantError);
    access.close();
  });

  it("rejects contradictory cross-drive kinds before archive publication", () => {
    const access = openTestDatabase();
    const firstDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isPresent: true,
    });
    const earlierObservation = access.catalog.registerDetectedDisc({
      opticalDriveId: secondDrive.id,
      discKind: "blu_ray",
      fingerprint: "contradictory-pre-publication-disc",
    });

    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: firstDrive.id,
        discKind: "dvd",
        fingerprint: "contradictory-pre-publication-disc",
      }),
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({
        id: earlierObservation.id,
        discKind: "blu_ray",
        status: "detected",
      }),
    ]);
    access.close();
  });

  it("marks every existing cross-drive observation archived on publication", () => {
    const access = openTestDatabase();
    const firstDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isPresent: true,
    });
    const earlierObservation = access.catalog.registerDetectedDisc({
      opticalDriveId: secondDrive.id,
      discKind: "dvd",
      fingerprint: "reverse-order-cross-drive-disc",
    });
    const archiveSource = access.catalog.registerDetectedDisc({
      opticalDriveId: firstDrive.id,
      discKind: "dvd",
      fingerprint: "reverse-order-cross-drive-disc",
    });
    access.catalog.updateDetectedDiscStatus(earlierObservation.id, "scanned");
    access.catalog.updateDetectedDiscStatus(archiveSource.id, "scanned");
    access.catalog.updateDetectedDiscStatus(archiveSource.id, "approved");

    access.catalog.createOriginalDiscArchive({
      detectedDiscId: archiveSource.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Reverse Order Cross Drive.iso",
      fingerprint: "reverse-order-cross-drive-disc",
    });

    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: earlierObservation.id }),
        expect.objectContaining({ id: archiveSource.id }),
      ]),
    );
    expect(access.catalog.listDetectedDiscs(["scanned", "approved"])).toEqual(
      [],
    );
    access.close();
  });

  it("rechecks archived fingerprints globally when claiming cross-drive work", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const firstDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isEnabled: true,
      isPresent: true,
    });
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: firstDrive.id,
      discKind: "dvd",
      fingerprint: "claim-global-archive-check",
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");
    const second = completeDiscInspection(access, {
      opticalDriveId: secondDrive.id,
      mediaGeneration: "global-archive-generation",
      fingerprint: "claim-global-archive-check",
    });
    const request = access.archiveRequests.create({
      detectedDiscId: second.disc.id,
    });
    const concurrentSqlite = new DatabaseSync(databasePath);
    concurrentSqlite.exec("PRAGMA foreign_keys = ON");
    concurrentSqlite.exec("BEGIN IMMEDIATE");
    concurrentSqlite
      .prepare(`
        update detected_discs
        set status = 'archived', updated_at = 0
        where id = ?
      `)
      .run(firstDisc.id);
    concurrentSqlite
      .prepare(`
        insert into original_disc_archives (
          id, detected_disc_id, disc_kind, archive_format, archive_path,
          fingerprint, archived_at, created_at, updated_at
        ) values (?, ?, 'dvd', 'iso', ?, ?, 0, 0, 0)
      `)
      .run(
        "global-archive-guard",
        firstDisc.id,
        "/media/originals/Claim Global Archive Check.iso",
        "claim-global-archive-check",
      );
    concurrentSqlite.exec("COMMIT");
    concurrentSqlite.close();

    expect(
      access.archiveJobs.startForInspection(
        second.inspection.id,
        "global-fingerprint-worker",
      ),
    ).toBeNull();
    expect(access.archiveJobs.list()).toEqual([]);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    access.close();
  });

  it("rejects persisted Disc Selections whose fields contradict their kind", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "selection-shape-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Selection Shape.iso",
      fingerprint: "selection-shape-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Selection Shape",
    });
    for (const titleNumber of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        access.catalog.createDiscSelection({
          originalDiscArchiveId: archive.id,
          mediaItemId: item.id,
          sourceIdentity: { kind: "dvd_title", titleNumber },
        }),
      ).toThrow(DomainInvariantError);
    }
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1.5,
          chapterEnd: 2,
        },
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 2.5,
        },
      }),
    ).toThrow(DomainInvariantError);
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    const insertSelection = sqlite.prepare(`
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        title_number, chapter_start, chapter_end, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `);
    expect(() =>
      insertSelection.run(
        "invalid-main-feature",
        archive.id,
        item.id,
        "invalid:main-feature",
        "main_feature",
        1,
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertSelection.run(
        "invalid-dvd-title",
        archive.id,
        item.id,
        "invalid:dvd-title",
        "dvd_title",
        null,
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertSelection.run(
        "invalid-dvd-chapters",
        archive.id,
        item.id,
        "invalid:dvd-chapters",
        "dvd_chapters",
        1,
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertSelection.run(
        "invalid-fractional-title",
        archive.id,
        item.id,
        "invalid:fractional-title",
        "dvd_title",
        1.5,
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      insertSelection.run(
        "invalid-fractional-chapters",
        archive.id,
        item.id,
        "invalid:fractional-chapters",
        "dvd_chapters",
        1,
        2.5,
        3.5,
      ),
    ).toThrow();
    sqlite.close();
  });

  it("keeps one current Disc Inspection per insertion and fences stale leases", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });

    const first = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "101",
    });
    expect(first.claim).not.toBeNull();
    expect(first.inspection).toMatchObject({
      attemptCount: 1,
      isCurrent: true,
      phase: "reading_metadata",
      status: "running",
    });
    expect(
      access.discInspections.beginOrResume({
        opticalDriveId: drive.id,
        mediaGeneration: "101",
      }),
    ).toMatchObject({ inspection: { id: first.inspection.id }, claim: null });

    vi.advanceTimersByTime(DISC_INSPECTION_LEASE_DURATION_MS + 1);
    const resumed = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "101",
    });
    expect(resumed).toMatchObject({
      inspection: { id: first.inspection.id, attemptCount: 2 },
      claim: { id: first.inspection.id },
    });
    expect(access.discInspections.listAttempts(first.inspection.id)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "interrupted",
        reasonCode: "worker_interrupted",
      }),
    ]);
    expect(() =>
      access.discInspections.renew(first.claim!),
    ).toThrow(StaleJobAttemptError);

    const replacement = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "102",
    });
    expect(replacement.inspection.id).not.toBe(first.inspection.id);
    expect(access.discInspections.list({ currentOnly: true })).toEqual([
      expect.objectContaining({
        id: replacement.inspection.id,
        mediaGeneration: "102",
      }),
    ]);
    expect(
      access.discInspections.list({ ids: [first.inspection.id] }),
    ).toEqual([
      expect.objectContaining({
        id: first.inspection.id,
        isCurrent: false,
        status: "aborted",
      }),
    ]);
    access.close();
  });

  it("persists inspection findings, monotonic hash progress, retry history, and manual reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T01:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    let started = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "201",
    });
    expect(started.claim).not.toBeNull();

    const metadata = access.discInspections.record(started.claim!, {
      type: "metadata",
      volumeLabel: "LANGUAGE_DISC",
      titleCount: 12,
      chapterCount: 48,
      audioStreamCount: 6,
      subtitleStreamCount: 4,
      totalBytes: 1_000,
    });
    expect(metadata).toMatchObject({
      phase: "hashing_content",
      volumeLabel: "LANGUAGE_DISC",
      totalBytes: 1_000,
      bytesHashed: 0,
    });
    expect(
      access.discInspections.record(started.claim!, {
        type: "hash_progress",
        bytesHashed: 440,
        bytesPerSecond: null,
        etaSeconds: null,
      }),
    ).toMatchObject({ bytesHashed: 440, bytesPerSecond: null });
    expect(
      access.discInspections.record(started.claim!, {
        type: "hash_progress",
        bytesHashed: 640,
        bytesPerSecond: 100,
        etaSeconds: 4,
      }),
    ).toMatchObject({
      bytesHashed: 640,
      bytesPerSecond: 100,
      etaSeconds: 4,
    });
    expect(
      access.discInspections.record(started.claim!, {
        type: "hash_progress",
        bytesHashed: 641,
        bytesPerSecond: 101,
        etaSeconds: 3,
      }),
    ).toMatchObject({
      bytesHashed: 641,
      bytesPerSecond: 101,
      etaSeconds: 3,
    });
    expect(access.discInspections.list({ ids: [started.inspection.id] })).toEqual([
      expect.objectContaining({
        bytesHashed: 640,
        bytesPerSecond: 100,
        etaSeconds: 4,
      }),
    ]);
    expect(() =>
      access.discInspections.record(started.claim!, {
        type: "hash_progress",
        bytesHashed: 639,
        bytesPerSecond: null,
        etaSeconds: null,
      }),
    ).toThrow(DomainInvariantError);

    for (let failure = 1; failure <= 5; failure += 1) {
      const failed = access.discInspections.record(started.claim!, {
        type: "retry",
        reasonCode: "drive_not_ready",
        diagnostic: "raw device output",
        retryAt: new Date(Date.now() + 1_000),
      });
      expect(failed.consecutiveFailureCount).toBe(failure);
      if (failure === 1) {
        expect(failed).toMatchObject({
          bytesHashed: 641,
          bytesPerSecond: 101,
          etaSeconds: 3,
        });
      }
      if (failure < 5) {
        expect(failed).toMatchObject({
          phase: "retry_wait",
          status: "running",
        });
        vi.advanceTimersByTime(1_001);
        started = access.discInspections.beginOrResume({
          opticalDriveId: drive.id,
          mediaGeneration: "201",
        });
        expect(started.claim).not.toBeNull();
      } else {
        expect(failed.status).toBe("failed");
      }
    }
    expect(access.discInspections.listAttempts(started.inspection.id)).toHaveLength(5);

    const requested = access.discInspections.requestRetry(
      started.inspection.id,
    );
    expect(requested).toMatchObject({
      attemptCount: 5,
      consecutiveFailureCount: 5,
      manualRetryRequestedAt: expect.any(Date),
      status: "failed",
    });
    const manualAttempt = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "201",
    });
    expect(manualAttempt).toMatchObject({
      inspection: {
        attemptCount: 6,
        consecutiveFailureCount: 0,
        manualRetryRequestedAt: null,
        status: "running",
      },
      claim: { id: started.inspection.id },
    });
    expect(() => access.discInspections.requestRetry(started.inspection.id))
      .toThrow(InvalidStatusTransitionError);
    access.close();
  });

  it.each(["fail", "abort"] as const)(
    "flushes the newest coalesced inspection progress before %s",
    (terminalType) => {
      const access = openTestDatabase();
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/inspection-progress-${terminalType}`,
        isEnabled: true,
        isPresent: true,
      });
      const started = access.discInspections.beginOrResume({
        opticalDriveId: drive.id,
        mediaGeneration: `inspection-progress-${terminalType}`,
      });
      access.discInspections.record(started.claim!, {
        type: "metadata",
        volumeLabel: null,
        titleCount: 0,
        chapterCount: 0,
        audioStreamCount: 0,
        subtitleStreamCount: 0,
        totalBytes: 1_000,
      });
      access.discInspections.record(started.claim!, {
        type: "hash_progress",
        bytesHashed: 100,
        bytesPerSecond: 50,
        etaSeconds: 18,
      });
      access.discInspections.record(started.claim!, {
        type: "hash_progress",
        bytesHashed: 101,
        bytesPerSecond: null,
        etaSeconds: null,
      });
      expect(access.discInspections.list({ ids: [started.inspection.id] }))
        .toEqual([
          expect.objectContaining({
            bytesHashed: 100,
            bytesPerSecond: 50,
            etaSeconds: 18,
          }),
        ]);

      const terminal = access.discInspections.record(
        started.claim!,
        terminalType === "fail"
          ? {
              type: "fail",
              reasonCode: "invalid_metadata",
            }
          : {
              type: "abort",
              reasonCode: "media_changed",
            },
      );
      expect(terminal).toMatchObject({
        status: terminalType === "fail" ? "failed" : "aborted",
        bytesHashed: 101,
        bytesPerSecond: null,
        etaSeconds: null,
      });
      access.close();
    },
  );

  it("defers a manual inspection retry until current media evidence is verified", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const started = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "failed-insertion",
    });
    access.discInspections.record(started.claim!, {
      type: "fail",
      reasonCode: "invalid_metadata",
    });

    expect(access.discInspections.requestRetry(started.inspection.id))
      .toMatchObject({
        manualRetryRequestedAt: expect.any(Date),
        status: "failed",
      });

    const replacement = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "replacement-insertion",
    });
    expect(replacement).toMatchObject({
      inspection: {
        mediaGeneration: "replacement-insertion",
        status: "running",
      },
      claim: { id: replacement.inspection.id },
    });
    expect(replacement.inspection.id).not.toBe(started.inspection.id);
    expect(access.discInspections.list({ ids: [started.inspection.id] }))
      .toEqual([
        expect.objectContaining({
          isCurrent: false,
          manualRetryRequestedAt: null,
          status: "failed",
        }),
      ]);
    access.close();
  });

  it("creates durable Archive Requests without creating Archive Jobs", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "301",
      fingerprint: "request-only-disc",
    });
    expect(
      access.archiveJobs.startForInspection(inspection.id, "idle-worker"),
    ).toBeNull();

    const request = access.archiveRequests.create({
      detectedDiscId: disc.id,
      priority: 25,
    });
    expect(request).toMatchObject({
      detectedDiscId: disc.id,
      priority: 25,
      status: "pending",
    });
    expect(access.archiveJobs.list()).toEqual([]);
    expect(
      access.archiveRequests.create({
        detectedDiscId: disc.id,
        priority: 30,
      }),
    ).toMatchObject({ id: request.id, priority: 30, status: "pending" });

    expect(access.archiveRequests.cancel(request.id)).toMatchObject({
      id: request.id,
      status: "cancelled",
    });
    const replacement = access.archiveRequests.create({
      detectedDiscId: disc.id,
    });
    expect(replacement.id).not.toBe(request.id);
    expect(replacement.status).toBe("pending");
    expect(access.archiveRequests.listRelevantForDetectedDiscs([disc.id]))
      .toEqual([expect.objectContaining({ id: replacement.id })]);
    access.close();
  });

  it("leaves an unrequested completed inspection idle before legacy reconciliation", () => {
    const access = openTestDatabase();
    const legacyDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/legacy",
      isPresent: true,
    });
    const legacyDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: legacyDrive.id,
      discKind: "dvd",
      fingerprint: "legacy-unresolved-fingerprint",
    });
    access.catalog.updateDetectedDiscStatus(legacyDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(legacyDisc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: legacyDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Legacy unresolved.iso",
      fingerprint: legacyDisc.fingerprint,
    });
    const currentDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/current",
      isEnabled: true,
      isPresent: true,
    });
    const { inspection } = completeDiscInspection(access, {
      opticalDriveId: currentDrive.id,
      mediaGeneration: "unrequested-current-disc",
      fingerprint: `sha256:${"a".repeat(64)}`,
    });

    expect(
      access.archiveJobs.startForInspection(inspection.id, "idle-worker"),
    ).toBeNull();
    expect(access.archiveJobs.list()).toEqual([]);
    access.close();
  });

  it("creates one Archive Job per started request attempt and transitions requests atomically", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "401",
      fingerprint: "attempt-disc",
    });
    const request = access.archiveRequests.create({
      detectedDiscId: disc.id,
    });

    const first = access.archiveJobs.startForInspection(
      inspection.id,
      "worker-1",
    );
    expect(first).toMatchObject({
      archiveRequestId: request.id,
      attemptOrdinal: 1,
      status: "running",
    });
    expect(
      access.archiveJobs.startForInspection(inspection.id, "worker-2"),
    ).toBeNull();
    const failed = access.archiveJobs.fail(first!, "read failed");
    expect(failed.status).toBe("failed");
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);

    expect(access.archiveRequests.retry(request.id)).toMatchObject({
      status: "pending",
    });
    const second = access.archiveJobs.startForInspection(
      inspection.id,
      "worker-2",
    );
    expect(second).toMatchObject({
      archiveRequestId: request.id,
      attemptOrdinal: 2,
      status: "running",
    });
    expect(access.archiveRequests.cancel(request.id)).toMatchObject({
      status: "cancellation_requested",
    });
    expect(access.archiveJobs.isCancellationRequested(second!)).toBe(true);
    expect(access.archiveJobs.abort(second!, "operator cancelled")).toMatchObject({
      attemptOrdinal: 2,
      status: "aborted",
    });
    expect(access.archiveJobs.listLatestForRequests([request.id])).toEqual([
      expect.objectContaining({
        id: second!.id,
        attemptOrdinal: 2,
        status: "aborted",
      }),
    ]);
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.archiveJobs.list()).toEqual([
      expect.objectContaining({ attemptOrdinal: 1, status: "failed" }),
      expect.objectContaining({ attemptOrdinal: 2, status: "aborted" }),
    ]);
    access.close();
  });

  it("flushes coalesced Archive Job progress on failure, abort, and recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const access = openTestDatabase();
    const startAttempt = (index: number) => {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/archive-progress-${index}`,
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `archive-progress-${index}`,
        fingerprint: `archive-progress-${index}`,
      });
      const request = access.archiveRequests.create({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.startForInspection(
        inspection.id,
        `archive-progress-worker-${index}`,
      )!;
      return { claim, request };
    };

    const failed = startAttempt(1);
    access.archiveJobs.updateProgress(failed.claim, {
      phase: "copying",
      progressPercent: 10,
    });
    access.archiveJobs.updateProgress(failed.claim, {
      phase: "copying",
      progressPercent: 11,
    });
    expect(access.archiveJobs.fail(failed.claim, "copy failed")).toMatchObject({
      status: "failed",
      progressPhase: "copying",
      progressPercent: 11,
    });

    const aborted = startAttempt(2);
    access.archiveJobs.updateProgress(aborted.claim, {
      phase: "verifying",
      progressPercent: 40,
    });
    access.archiveJobs.updateProgress(aborted.claim, {
      phase: "verifying",
      progressPercent: 41,
    });
    access.archiveRequests.cancel(aborted.request.id);
    expect(
      access.archiveJobs.abort(aborted.claim, "operator cancelled"),
    ).toMatchObject({
      status: "aborted",
      progressPhase: "verifying",
      progressPercent: 41,
    });

    const expired = startAttempt(3);
    access.archiveJobs.updateProgress(expired.claim, {
      phase: "copying",
      progressPercent: 70,
    });
    access.archiveJobs.updateProgress(expired.claim, {
      phase: "copying",
      progressPercent: 71,
    });
    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    expect(access.archiveJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({
        id: expired.claim.id,
        status: "failed",
        progressPhase: "copying",
        progressPercent: 71,
      }),
    ]);
    access.close();
  });

  it("publishes archive provenance and fulfills matching request intent atomically", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "501",
      fingerprint: "publication-disc",
    });
    const request = access.archiveRequests.create({
      detectedDiscId: disc.id,
    });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "publisher",
    )!;
    access.archiveJobs.updateProgress(claim, {
      phase: "copying",
      progressPercent: 60,
    });

    const completed = access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/publication.iso",
      sizeBytes: 1_000,
    });
    expect(completed).toMatchObject({
      originalDiscArchiveId: expect.any(String),
      progressPercent: 100,
      status: "completed",
    });
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        archivePath: "/media/originals/publication.iso",
        fingerprint: "publication-disc",
      }),
    ]);
    expect(() => access.archiveJobs.fail(claim, "stale failure")).toThrow(
      StaleJobAttemptError,
    );
    access.close();
  });

  it("fences stale publication before legacy provenance reconciliation", () => {
    const databasePath = createTestDatabasePath();
    const archiveDirectory = mkdtempSync(
      join(tmpdir(), "rip-dvd-stale-publication-"),
    );
    temporaryDirectories.push(archiveDirectory);
    const legacyArchivePath = join(archiveDirectory, "legacy.iso");
    const archiveBytes = Buffer.from("legacy archive requiring reconciliation");
    writeFileSync(legacyArchivePath, archiveBytes);
    const hasher = createRawDvdContentIdHasher(archiveBytes.byteLength);
    hasher.update(archiveBytes);
    const contentId = hasher.digest();
    const access = openTestDatabase(databasePath);

    const currentDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/current-publication",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: currentDrive.id,
      mediaGeneration: "stale-publication",
      fingerprint: contentId,
    });
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "stale-publisher",
    )!;

    const legacyDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/legacy-provenance",
      isEnabled: true,
      isPresent: true,
    });
    const legacyDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: legacyDrive.id,
      discKind: "dvd",
      fingerprint: "legacy-provenance-fingerprint",
    });
    access.catalog.updateDetectedDiscStatus(legacyDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(legacyDisc.id, "approved");
    const legacyArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: legacyDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: legacyArchivePath,
      fingerprint: legacyDisc.fingerprint,
    });
    expect(legacyArchive.sizeBytes).toBeNull();

    access.archiveRequests.cancel(request.id);

    expect(() =>
      access.archiveJobs.publish(claim, {
        archivePath: join(archiveDirectory, "current.iso"),
        sizeBytes: archiveBytes.byteLength,
      }),
    ).toThrow(StaleJobAttemptError);
    expect(access.catalog.listOriginalDiscArchives({ ids: [legacyArchive.id] }))
      .toEqual([
        expect.objectContaining({ id: legacyArchive.id, sizeBytes: null }),
      ]);
    const sqlite = new DatabaseSync(databasePath);
    expect(
      sqlite.prepare(
        "select count(*) as count from original_disc_archive_content_ids",
      ).get(),
    ).toEqual({ count: 0 });
    sqlite.close();
    access.close();
  });

  it("recovers expired Archive Job attempts into request attention state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T02:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "601",
      fingerprint: "expired-attempt-disc",
    });
    const request = access.archiveRequests.create({
      detectedDiscId: disc.id,
    });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "lost-worker",
    )!;

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    expect(access.archiveJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({ id: claim.id, status: "failed" }),
    ]);
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(() => access.archiveJobs.renewClaim(claim)).toThrow(
      StaleJobAttemptError,
    );
    access.close();
  });

  it("lets request cancellation win without treating an expired lease as helper closure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T02:15:00.000Z"));
    const access = openTestDatabase();
    const createAttempt = (index: number) => {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/cancellation-race-${index}`,
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `cancellation-race-${index}`,
        fingerprint: `cancellation-race-${index}`,
      });
      const request = access.archiveRequests.create({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.startForInspection(
        inspection.id,
        `cancellation-worker-${index}`,
      )!;
      return { claim, request };
    };

    const failureRace = createAttempt(1);
    const cancellation = access.archiveRequests.cancel(failureRace.request.id);
    expect(cancellation.status).toBe("cancellation_requested");
    expect(access.archiveRequests.cancel(failureRace.request.id)).toEqual(
      cancellation,
    );
    expect(
      access.archiveJobs.fail(failureRace.claim, "copy failed concurrently"),
    ).toMatchObject({ status: "aborted" });
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: failureRace.request.id }),
    ]);

    const recoveryRace = createAttempt(2);
    access.archiveRequests.cancel(recoveryRace.request.id);
    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    expect(access.archiveJobs.recoverExpiredClaims()).toEqual([]);
    expect(access.archiveJobs.listExpiredCancellations()).toEqual([
      expect.objectContaining({ id: recoveryRace.claim.id }),
    ]);
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: recoveryRace.claim.id }),
    ]);
    expect(access.archiveRequests.list(["cancellation_requested"])).toEqual([
      expect.objectContaining({ id: recoveryRace.request.id }),
    ]);
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: failureRace.request.id }),
    ]);
    expect(
      access.archiveJobs.finalizeExpiredCancellation(recoveryRace.claim),
    ).toMatchObject({ id: recoveryRace.claim.id, status: "aborted" });
    expect(access.archiveRequests.list(["cancelled"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: failureRace.request.id }),
        expect.objectContaining({ id: recoveryRace.request.id }),
      ]),
    );

    const publicationRace = createAttempt(3);
    access.archiveRequests.cancel(publicationRace.request.id);
    expect(() =>
      access.archiveJobs.publish(publicationRace.claim, {
        archivePath: "/media/originals/cancelled-race.iso",
        sizeBytes: 1_000,
      }),
    ).toThrow(StaleJobAttemptError);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(
      access.archiveJobs.fail(publicationRace.claim, "publication cancelled"),
    ).toMatchObject({ status: "aborted" });
    access.close();
  });

  it("bounds each expired Archive Job recovery transaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T02:30:00.000Z"));
    const access = openTestDatabase();
    for (let index = 0; index < 101; index += 1) {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/bounded-recovery-${index}`,
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `bounded-${index}`,
        fingerprint: `bounded-recovery-${index}`,
      });
      access.archiveRequests.create({ detectedDiscId: disc.id });
      expect(
        access.archiveJobs.startForInspection(
          inspection.id,
          `bounded-worker-${index}`,
        ),
      ).not.toBeNull();
    }

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(100);
    expect(access.archiveJobs.list(["running"])).toHaveLength(1);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(1);
    expect(access.archiveJobs.list(["running"])).toEqual([]);
    access.close();
  });

  it("rotates bounded expired-cancellation recovery so later rows are not starved", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T08:00:00.000Z"));
    const access = openTestDatabase();
    const claimIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/bounded-cancellation-${index}`,
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `bounded-cancellation-${index}`,
        fingerprint: `bounded-cancellation-${index}`,
      });
      const request = access.archiveRequests.create({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.startForInspection(
        inspection.id,
        `bounded-cancellation-worker-${index}`,
      )!;
      claimIds.push(claim.id);
      access.archiveRequests.cancel(request.id);
      vi.advanceTimersByTime(1);
    }

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    const firstPage = access.archiveJobs.listExpiredCancellations();
    const secondPage = access.archiveJobs.listExpiredCancellations();
    expect(firstPage).toHaveLength(100);
    expect(secondPage).toHaveLength(1);
    expect(new Set([...firstPage, ...secondPage].map(({ id }) => id))).toEqual(
      new Set(claimIds),
    );
    expect(access.archiveJobs.listExpiredCancellations()).toHaveLength(100);
    access.close();
  });

  it("excludes simultaneous multi-process starts for the same fingerprint or Optical Drive", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const firstDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isEnabled: true,
      isPresent: true,
    });
    const first = completeDiscInspection(access, {
      opticalDriveId: firstDrive.id,
      mediaGeneration: "701",
      fingerprint: "shared-fingerprint",
    });
    const second = completeDiscInspection(access, {
      opticalDriveId: secondDrive.id,
      mediaGeneration: "702",
      fingerprint: "shared-fingerprint",
    });
    access.archiveRequests.create({ detectedDiscId: first.disc.id });
    access.archiveRequests.create({ detectedDiscId: second.disc.id });

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        { operation: "start-archive", discInspectionId: first.inspection.id },
        { operation: "start-archive", discInspectionId: first.inspection.id },
        { operation: "start-archive", discInspectionId: second.inspection.id },
        { operation: "start-archive", discInspectionId: second.inspection.id },
      ],
    });

    const outcomes = results.map((result) =>
      typeof result === "object" && result !== null
        ? result.outcome
        : result,
    );
    expect(outcomes.filter((outcome) => outcome === "started")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(3);
    expect(access.archiveJobs.list(["running"])).toHaveLength(1);
    access.close();
  });

  it("queues only active DVD video Encoding Profile versions", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "active-encode-profile-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Active Encode Profile.iso",
      fingerprint: "active-encode-profile-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Active Encode Profile",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const activeDvdProfile = access.encodingProfiles.create({
      key: "active-dvd",
      displayName: "Active DVD",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });
    const inactiveDvdProfile = access.encodingProfiles.createVersion({
      sourceProfileId: activeDvdProfile.id,
      mediaDomain: "dvd_video",
      settings: { preset: "HQ 480p30" },
    });
    const activeAudioProfile = access.encodingProfiles.create({
      key: "active-audio",
      displayName: "Active audio",
      mediaDomain: "audio",
      settings: {},
    });

    for (const encodingProfileId of [
      inactiveDvdProfile.id,
      activeAudioProfile.id,
    ]) {
      expect(() =>
        access.encodeJobs.enqueue({
          discSelectionId: selection.id,
          encodingProfileId,
          outputPath: `/media/movies/${encodingProfileId}.mkv`,
        })
      ).toThrow(/active DVD video Encoding Profile/);
    }
    expect(access.encodeJobs.list()).toEqual([]);

    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: activeDvdProfile.id,
      outputPath: "/media/movies/Active Encode Profile.mkv",
    });
    expect(job).toMatchObject({
      encodingProfileId: activeDvdProfile.id,
      status: "queued",
    });
    const claim = access.encodeJobs.claimNext("inactive-profile-retry");
    if (!claim) {
      throw new Error("Expected Encode Job claim");
    }
    access.encodingProfiles.setActive({
      id: activeDvdProfile.id,
      mediaDomain: "dvd_video",
      isActive: false,
    });
    expect(access.encodeJobs.fail(claim, "Encode failed")).toMatchObject({
      id: job.id,
      status: "failed",
    });
    expect(access.encodeJobs.requeue(job.id)).toMatchObject({
      id: job.id,
      encodingProfileId: activeDvdProfile.id,
      status: "queued",
    });
    access.close();
  });

  it("cancels queued Encode Jobs as retained history and releases their output reservation", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/cancel-queued",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cancel-queued-encode-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cancel Queued.iso",
      fingerprint: "cancel-queued-encode-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Cancel Queued",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const firstProfile = access.encodingProfiles.create({
      key: "cancel-queued-first",
      displayName: "Cancel queued first",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const secondProfile = access.encodingProfiles.create({
      key: "cancel-queued-second",
      displayName: "Cancel queued second",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const outputPath = "/media/movies/Cancel Queued.mkv";
    const queued = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: firstProfile.id,
      outputPath,
    });

    expect(access.encodeJobs.requestCancellation(queued.id)).toMatchObject({
      id: queued.id,
      status: "cancelled",
      progressPercent: 0,
    });
    expect(access.encodeJobs.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: queued.id, status: "cancelled" }),
    ]);
    expect(access.encodeJobs.claimNext("cancelled-job-worker")).toBeNull();
    expect(() => access.encodeJobs.requestCancellation(queued.id)).toThrow(
      InvalidStatusTransitionError,
    );
    expect(
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: secondProfile.id,
        outputPath,
      }),
    ).toMatchObject({ status: "queued", outputPath });
    expect(() => access.encodeJobs.requeue(queued.id)).toThrow(
      `Encode Job output is already assigned: ${outputPath}`,
    );
    access.close();
  });

  it("requeues a cancelled Encode Job only while its Disc Selection remains reviewed", () => {
    const access = openTestDatabase();
    const contentId = `sha256:${"d".repeat(64)}`;
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/requeue-cancelled",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Requeue Cancelled.iso",
      fingerprint: contentId,
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Requeue Cancelled",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const profile = access.encodingProfiles.create({
      key: "requeue-cancelled",
      displayName: "Requeue cancelled",
      mediaDomain: "dvd_video",
      settings: {},
    });
    completeCatalogReview(access, archive.id);
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Requeue Cancelled.mkv",
    });

    access.encodeJobs.requestCancellation(job.id);
    expect(access.encodeJobs.requeue(job.id)).toMatchObject({
      id: job.id,
      status: "queued",
    });
    access.encodeJobs.requestCancellation(job.id);

    const extraItem = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Requeue Cancelled Extra",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: extraItem.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 1,
      },
    });
    expect(() => access.encodeJobs.requeue(job.id)).toThrow(
      InvalidStatusTransitionError,
    );
    expect(access.encodeJobs.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: job.id, status: "cancelled" }),
    ]);

    completeCatalogReview(access, archive.id);
    expect(access.encodeJobs.requeue(job.id)).toMatchObject({
      id: job.id,
      status: "queued",
    });
    access.close();
  });

  it("keeps a retained final reserved when its queued re-encode is cancelled", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/cancel-reencode",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cancel-reencode-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cancel Reencode.iso",
      fingerprint: "cancel-reencode-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Cancel Reencode",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const originalProfile = access.encodingProfiles.create({
      key: "cancel-reencode-original",
      displayName: "Cancel reencode original",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const competingProfile = access.encodingProfiles.create({
      key: "cancel-reencode-competing",
      displayName: "Cancel reencode competing",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const outputPath = "/media/movies/Cancel Reencode.mkv";
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: originalProfile.id,
      outputPath,
    });
    const claim = access.encodeJobs.claimNext("completed-before-cancel");
    if (!claim) {
      throw new Error("Expected Encode Job claim");
    }
    access.encodeJobs.complete(claim);
    access.encodeJobs.requeue(job.id);

    expect(access.encodeJobs.requestCancellation(job.id)).toMatchObject({
      id: job.id,
      status: "cancelled",
      replaceExistingOutput: true,
    });
    expect(() =>
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: competingProfile.id,
        outputPath,
      })
    ).toThrow(`Encode Job output is already assigned: ${outputPath}`);
    expect(access.encodeJobs.requeue(job.id)).toMatchObject({
      id: job.id,
      status: "queued",
      replaceExistingOutput: true,
      outputPath,
    });
    access.close();
  });

  it("durably requests running cancellation and lets exactly one terminal outcome win", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/cancel-running",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cancel-running-encode-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cancel Running.iso",
      fingerprint: "cancel-running-encode-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Cancel Running",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const cancellationProfile = access.encodingProfiles.create({
      key: "cancel-running-wins",
      displayName: "Cancel running wins",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const completionProfile = access.encodingProfiles.create({
      key: "complete-running-wins",
      displayName: "Complete running wins",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const cancellationJob = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: cancellationProfile.id,
      outputPath: "/media/movies/Cancel Running.mkv",
    });
    const cancellationClaim = access.encodeJobs.claimNext(
      "cancellation-winner",
    );
    if (!cancellationClaim) {
      throw new Error("Expected running cancellation claim");
    }
    access.encodeJobs.updateProgress(cancellationClaim, {
      phase: "encoding",
      progressPercent: 47,
      etaSeconds: 120,
    });

    expect(
      access.encodeJobs.requestCancellation(cancellationJob.id),
    ).toMatchObject({
      id: cancellationJob.id,
      status: "cancellation_requested",
      progressPhase: "encoding",
      progressPercent: 47,
      progressEtaSeconds: null,
      claimToken: cancellationClaim.claimToken,
    });
    expect(access.encodeJobs.renewClaim(cancellationClaim)).toMatchObject({
      status: "cancellation_requested",
    });
    expect(() => access.encodeJobs.complete(cancellationClaim)).toThrow(
      StaleJobAttemptError,
    );
    expect(() =>
      access.encodeJobs.updateProgress(cancellationClaim, 48)
    ).toThrow(StaleJobAttemptError);
    expect(
      access.encodeJobs.completeCancellation(cancellationClaim),
    ).toMatchObject({
      status: "cancelled",
      claimedBy: null,
      claimToken: null,
      claimedAt: null,
      progressPhase: "encoding",
      progressPercent: 47,
      progressEtaSeconds: null,
    });
    expect(() =>
      access.encodeJobs.fail(cancellationClaim, "stale failure")
    ).toThrow(StaleJobAttemptError);

    const completionJob = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: completionProfile.id,
      outputPath: "/media/movies/Complete Running.mkv",
    });
    const completionClaim = access.encodeJobs.claimNext("completion-winner");
    if (!completionClaim) {
      throw new Error("Expected running completion claim");
    }
    expect(access.encodeJobs.complete(completionClaim)).toMatchObject({
      id: completionJob.id,
      status: "completed",
    });
    expect(() =>
      access.encodeJobs.requestCancellation(completionJob.id)
    ).toThrow(InvalidStatusTransitionError);
    expect(access.encodeJobs.list(["completed"])).toEqual([
      expect.objectContaining({ id: completionJob.id, status: "completed" }),
    ]);
    access.close();
  });

  it("requires worker-confirmed closure before recovering an abandoned cancellation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/abandoned-cancellation",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "abandoned-cancellation-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Abandoned Cancellation.iso",
      fingerprint: "abandoned-cancellation-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Abandoned Cancellation",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "abandoned-cancellation",
      displayName: "Abandoned cancellation",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Abandoned Cancellation.mkv",
    });
    const claim = access.encodeJobs.claimNext("abandoned-cancellation-worker");
    if (!claim) {
      throw new Error("Expected abandoned cancellation claim");
    }
    access.encodeJobs.registerPartialCleanup(claim, {
      publicationPending: true,
    });
    access.encodeJobs.requestCancellation(job.id);
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);

    expect(access.encodeJobs.recoverExpiredClaims()).toEqual([]);
    expect(access.encodeJobs.list(["cancellation_requested"])).toEqual([
      expect.objectContaining({
        id: job.id,
        status: "cancellation_requested",
        claimedBy: "abandoned-cancellation-worker",
        claimToken: claim.claimToken,
      }),
    ]);
    const expiredCancellation =
      access.encodeJobs.listExpiredCancellationClaims()[0];
    if (!expiredCancellation) {
      throw new Error("Expected expired cancellation claim");
    }
    expect(() =>
      access.encodeJobs.completeExpiredCancellation(
        expiredCancellation,
        () => {
          throw new Error("HandBrake output is still active");
        },
      )
    ).toThrow("HandBrake output is still active");
    expect(access.encodeJobs.list(["cancellation_requested"])).toHaveLength(1);
    expect(
      access.encodeJobs.completeExpiredCancellation(
        expiredCancellation,
        () => undefined,
      ),
    ).toMatchObject({
      id: job.id,
      status: "cancelled",
      claimedBy: null,
      claimToken: null,
      errorMessage: null,
      partialCleanupOutputPath: job.outputPath,
      partialCleanupClaimToken: claim.claimToken,
      publicationPending: false,
    });
    expect(() => access.encodeJobs.requeue(job.id)).toThrow(
      InvalidStatusTransitionError,
    );
    const cleanup = access.encodeJobs.listPendingPartialCleanups()[0];
    if (!cleanup) {
      throw new Error("Expected abandoned cancellation cleanup");
    }
    access.encodeJobs.completePartialCleanup(cleanup);
    expect(access.encodeJobs.requeue(job.id)).toMatchObject({
      id: job.id,
      status: "queued",
    });
    access.close();
    vi.useRealTimers();
  });

  it("atomically resolves queued Encode Job cancellation against claiming", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/cancel-claim-race",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cancel-claim-race-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cancel Claim Race.iso",
      fingerprint: "cancel-claim-race-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Cancel Claim Race",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "cancel-claim-race",
      displayName: "Cancel claim race",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Cancel Claim Race.mkv",
    });

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        { operation: "cancel-encode", encodeJobId: job.id },
        { operation: "claim-encode" },
      ],
    });
    const winners = results.filter(
      (result): result is { outcome: "cancelled" | "claimed"; id: string } =>
        typeof result === "object" &&
        result !== null &&
        "outcome" in result &&
        (result.outcome === "cancelled" || result.outcome === "claimed"),
    );
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(job.id);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        status: winners[0]?.outcome === "cancelled" ? "cancelled" : "running",
      }),
    ]);
    access.close();
  });

  it("atomically resolves running cancellation against completion by claim token", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/cancel-completion-race",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cancel-completion-race-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Cancel Completion Race.iso",
      fingerprint: "cancel-completion-race-disc",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Cancel Completion Race",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "cancel-completion-race",
      displayName: "Cancel completion race",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Cancel Completion Race.mkv",
    });
    const claim = access.encodeJobs.claimNext("completion-race-worker");
    if (!claim) {
      throw new Error("Expected completion-race claim");
    }

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        { operation: "cancel-encode", encodeJobId: job.id },
        { operation: "complete-encode", claim },
      ],
    });
    const winners = results.filter(
      (result): result is {
        outcome: "cancellation_requested" | "completed";
        id: string;
      } =>
        typeof result === "object" &&
        result !== null &&
        "outcome" in result &&
        (result.outcome === "cancellation_requested" ||
          result.outcome === "completed"),
    );
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(job.id);
    if (winners[0]?.outcome === "cancellation_requested") {
      expect(access.encodeJobs.completeCancellation(claim)).toMatchObject({
        id: job.id,
        status: "cancelled",
      });
    }
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        status: winners[0]?.outcome === "completed"
          ? "completed"
          : "cancelled",
      }),
    ]);
    access.close();
  });

  it("keeps encode submission idempotent and requeues only on explicit intent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "encode-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Encode Disc.iso",
      fingerprint: "encode-disc",
    });
    const item = access.catalog.createMediaItem({ kind: "movie", title: "Movie" });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const profile = access.encodingProfiles.create({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast 480p30" },
    });

    expect(() =>
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Movie/Movie.mkv",
      }),
    ).toThrow(DomainInvariantError);
    expect(access.encodeJobs.list()).toEqual([]);

    completeCatalogReview(access, archive.id);
    const job = access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Movie/Movie.mkv",
    });
    expect(
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Movie/Movie.mkv",
      }).id,
    ).toBe(job.id);

    const firstClaim = access.encodeJobs.claimNext("encode-worker-1");
    expect(firstClaim?.id).toBe(job.id);
    expect(firstClaim?.claimToken).toBeTruthy();
    expect(access.encodeJobs.claimNext("encode-worker-2")).toBeNull();
    if (!firstClaim) {
      throw new Error("Expected the encode job to be claimed");
    }
    access.encodeJobs.updateProgress(firstClaim, {
      phase: "encoding",
      progressPercent: 10,
      etaSeconds: 100,
    });
    access.encodeJobs.updateProgress(firstClaim, {
      phase: "encoding",
      progressPercent: 11,
      etaSeconds: 95,
    });
    access.encodeJobs.updateProgress(firstClaim, {
      phase: "encoding",
      progressPercent: 12,
      etaSeconds: 90,
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        progressPhase: "encoding",
        progressPercent: 10,
        progressEtaSeconds: 100,
      }),
    ]);
    vi.advanceTimersByTime(1_000);
    access.encodeJobs.updateProgress(firstClaim, {
      phase: "encoding",
      progressPercent: 12,
      etaSeconds: 90,
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        progressPercent: 12,
        progressEtaSeconds: 90,
      }),
    ]);
    access.encodeJobs.updateProgress(firstClaim, {
      phase: "encoding",
      progressPercent: 17,
      etaSeconds: 80,
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        progressPercent: 17,
        progressEtaSeconds: 80,
      }),
    ]);
    access.encodeJobs.updateProgress(firstClaim, {
      phase: "encoding",
      progressPercent: 18,
      etaSeconds: 70,
    });
    expect(access.encodeJobs.complete(firstClaim)).toMatchObject({
      status: "completed",
      progressPhase: "encoding",
      progressPercent: 100,
      progressEtaSeconds: null,
    });
    expect(
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Movie/Movie-remastered.mkv",
        priority: 20,
      }),
    ).toMatchObject({
      id: job.id,
      status: "completed",
      progressPhase: "encoding",
      progressPercent: 100,
      progressEtaSeconds: null,
      replaceExistingOutput: false,
      outputPath: "/media/movies/Movie/Movie.mkv",
      priority: 0,
    });
    expect(access.encodeJobs.claimNext("late-submit-retry")).toBeNull();
    expect(access.encodeJobs.requeue(job.id, {
      outputPath: "/media/movies/Movie/Movie-remastered.mkv",
      priority: 20,
    })).toMatchObject({
      id: job.id,
      status: "queued",
      progressPhase: null,
      progressPercent: 0,
      progressEtaSeconds: null,
      replaceExistingOutput: true,
      claimedBy: null,
      outputPath: "/media/movies/Movie/Movie.mkv",
      priority: 20,
    });
    const secondClaim = access.encodeJobs.claimNext("encode-worker-2");
    if (!secondClaim) {
      throw new Error("Expected the requeued encode job to be claimed");
    }
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(() => access.encodeJobs.updateProgress(firstClaim, 50)).toThrow();
    expect(() => access.encodeJobs.complete(firstClaim)).toThrow();
    expect(() => access.encodeJobs.fail(firstClaim, "stale failure")).toThrow();
    access.encodeJobs.updateProgress(secondClaim, {
      phase: "scanning",
      progressPercent: 16,
      etaSeconds: null,
    });
    access.encodeJobs.updateProgress(secondClaim, {
      phase: "previewing",
      progressPercent: 17,
      etaSeconds: null,
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: job.id,
        progressPhase: "previewing",
        progressPercent: 17,
      }),
    ]);
    access.encodeJobs.updateProgress(secondClaim, {
      phase: "previewing",
      progressPercent: 18,
      etaSeconds: null,
    });
    expect(access.encodeJobs.fail(secondClaim, "encode failed")).toMatchObject({
      status: "failed",
      progressPhase: "previewing",
      progressPercent: 18,
      progressEtaSeconds: null,
      replaceExistingOutput: false,
      errorMessage: "encode failed",
    });
    expect(access.encodeJobs.list()).toHaveLength(1);

    expect(access.encodeJobs.requeue(job.id)).toMatchObject({
      id: job.id,
      status: "queued",
    });
    const abandoned = access.encodeJobs.claimNext("encode-worker-crashed");
    if (!abandoned) {
      throw new Error("Expected the abandoned Encode Job to be claimed");
    }
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS + 1);
    expect(access.encodeJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({
        id: job.id,
        partialCleanupClaimToken: abandoned.claimToken,
        partialCleanupOutputPath: abandoned.outputPath,
        status: "failed",
        errorMessage: "Encode worker lease expired",
      }),
    ]);
    expect(() => access.encodeJobs.updateProgress(abandoned, 50)).toThrow();

    const recoveredOutputPath = "/media/movies/Movie/Movie-recovered.mkv";
    expect(
      access.encodeJobs.enqueue({
        discSelectionId: job.discSelectionId,
        encodingProfileId: job.encodingProfileId,
        outputPath: recoveredOutputPath,
      }),
    ).toMatchObject({
      id: job.id,
      status: "failed",
      outputPath: abandoned.outputPath,
    });
    expect(access.encodeJobs.claimNext("cleanup-not-finished")).toBeNull();
    const [cleanup] = access.encodeJobs.listPendingPartialCleanups();
    expect(cleanup).toEqual({
      claimToken: abandoned.claimToken,
      jobId: job.id,
      leaseToken: null,
      outputPath: abandoned.outputPath,
      publicationPending: false,
    });
    if (!cleanup) {
      throw new Error("Expected pending Encode Job partial cleanup");
    }
    access.encodeJobs.completePartialCleanup(cleanup);
    access.encodeJobs.requeue(job.id, { outputPath: recoveredOutputPath });
    const renewed = access.encodeJobs.claimNext("encode-worker-renewed");
    if (!renewed) {
      throw new Error("Expected the renewed Encode Job to be claimed");
    }
    expect(renewed.outputPath).toBe(recoveredOutputPath);
    vi.advanceTimersByTime(ENCODE_JOB_LEASE_DURATION_MS - 1);
    expect(access.encodeJobs.renewClaim(renewed)).toMatchObject({
      id: job.id,
      status: "running",
    });
    vi.advanceTimersByTime(2);
    expect(access.encodeJobs.recoverExpiredClaims()).toEqual([]);
    access.close();
  });
});
