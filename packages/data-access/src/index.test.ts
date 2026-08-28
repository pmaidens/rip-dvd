import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginSettledDiscInspectionForTest as beginSettledDiscInspection,
  completeCatalogReview,
} from "./catalog.test-support.js";
import { createRawDvdContentIdHasher } from "./dvd-content-id.js";
import { createDvdMetadataFingerprint } from "./dvd-metadata-fingerprint.js";
import { decodeDvdTitleMap } from "./dvd-scan.js";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  createCorrectedDvdArchiveBoundaryEvidence,
  createNormalDvdArchiveBoundaryEvidence,
  createDataAccess,
  createCleanReadArchiveIntegrityEvidence,
  createDiscSelectionSourceIdentity,
  createUnknownArchiveIntegrityEvidence,
  createWatchableSalvageArchiveIntegrityEvidence,
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
  EncodeOutputFilesystemIdentity,
  MediaItemId,
  OriginalDiscArchiveId,
  RunningEncodeJob,
} from "./index.js";
import type { EncodingProfileId } from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";

const temporaryDirectories: string[] = [];

interface ClassificationVector {
  name: string;
  category:
    | "recognized_medium_error"
    | "not_ready"
    | "unit_attention"
    | "hardware_error"
    | "transport_error"
    | "protection_error"
    | "out_of_range";
  scsiStatus: number;
  hostStatus: number;
  driverStatus: number;
  senseKey: number;
  asc: number;
  ascq: number;
}

type PersistedClassificationVector = ClassificationVector & {
  category: Exclude<ClassificationVector["category"], "recognized_medium_error">;
};

const persistedClassificationVectors = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../../docker/scsi-read-classification-v2-vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ClassificationVector[]
).filter(
  (vector): vector is PersistedClassificationVector =>
    vector.category !== "recognized_medium_error",
);

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
        | "corrected"
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

type ConcurrentOperation = (
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
      operation: "complete-catalog-review-with-replacements";
      originalDiscArchiveId: OriginalDiscArchiveId;
      catalogRevision: Date;
      replacements: Array<{
        predecessorEncodeJobId: EncodeJobId;
        encodingProfileId: EncodingProfileId;
        outputPath: string;
      }>;
    }
  | {
      operation: "create-disc-selection";
      originalDiscArchiveId: OriginalDiscArchiveId;
      mediaItemId: MediaItemId;
    }
  | {
      operation: "correct-disc-selection";
      discSelectionId: DiscSelectionId;
      originalDiscArchiveId: OriginalDiscArchiveId;
      catalogRevision: Date;
      mediaItemId: MediaItemId;
      reason: string;
    }
  | {
      operation: "create-media-item";
      parentId: MediaItemId;
      title: string;
    }
) & { delayMs?: number };

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
    scanData?: unknown;
    sizeBytes?: number;
    volumeLabel?: string;
  },
) {
  const started = beginSettledDiscInspection(access, {
    opticalDriveId: input.opticalDriveId,
    mediaGeneration: input.mediaGeneration,
    mediaCapacityBytes: 2_048,
  });
  if (!started.claim) {
    throw new Error("Expected a new Disc Inspection claim");
  }
  if (input.sizeBytes !== undefined) {
    const titleMap = decodeDvdTitleMap(input.scanData);
    access.discInspections.record(started.claim, {
      type: "metadata",
      volumeLabel: input.volumeLabel ?? null,
      titleCount: titleMap?.titles.length ?? 0,
      chapterCount:
        titleMap?.titles.reduce((total, title) => total + title.chapters, 0) ?? 0,
      audioStreamCount:
        titleMap?.titles.reduce(
          (total, title) => total + title.audioStreams.length,
          0,
        ) ?? 0,
      subtitleStreamCount:
        titleMap?.titles.reduce(
          (total, title) => total + title.subtitles.length,
          0,
        ) ?? 0,
      totalBytes: input.sizeBytes,
    });
  }
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: input.opticalDriveId,
    discKind: "dvd",
    fingerprint: input.fingerprint,
    scanData: input.scanData,
    sizeBytes: input.sizeBytes,
    volumeLabel: input.volumeLabel,
  });
  const scanned = disc.status === "detected"
    ? access.catalog.updateDetectedDiscStatus(disc.id, "scanned")
    : disc;
  const inspection = access.discInspections.record(started.claim, {
    type: "complete",
    detectedDiscId: scanned.id,
  });
  started.restoreSystemTime();
  return { claim: started.claim, disc: scanned, inspection };
}

function createDiscSelectionCorrectionFixture(input: {
  key: string;
  databasePath?: string;
  correctedItemCount?: number;
  contentIdFill?: string;
  selectionLabel?: string;
}) {
  const access = openTestDatabase(input.databasePath);
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/${input.key}`,
    isPresent: true,
  });
  const contentId = `sha256:${(input.contentIdFill ?? "4").repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    scanData: {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId,
      titles: [{
        number: 1,
        durationSeconds: 5_400,
        chapters: 12,
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
    archivePath: `/media/originals/${input.key}.iso`,
    fingerprint: contentId,
  });
  const mistakenItem = access.catalog.createMediaItem({
    kind: "movie",
    title: `Mistaken ${input.key}`,
  });
  const correctedItems = Array.from(
    { length: input.correctedItemCount ?? 1 },
    (_, index) => access.catalog.createMediaItem({
      kind: "movie",
      title: `Corrected ${input.key} ${index + 1}`,
    }),
  );
  const mistakenSelection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id,
    mediaItemId: mistakenItem.id,
    sourceIdentity: { kind: "main_feature" },
    ...(input.selectionLabel === undefined
      ? {}
      : { label: input.selectionLabel }),
  });
  completeCatalogReview(access, archive.id);
  return {
    access,
    archive,
    mistakenItem,
    correctedItems,
    mistakenSelection,
  };
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

  it("caps Encode queue Disc Selection pages at 100", () => {
    const access = openTestDatabase();

    expect(() =>
      access.readConsistentSnapshot((snapshot) =>
        snapshot.encodeJobs.listQueueDiscSelections({
          historyGroup: "not_encoded",
          limit: 101,
        })
      )
    ).toThrow(
      "Encode queue Disc Selection limit must be a safe integer between 1 and 100",
    );
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
        "disc_selection_supersessions",
      ]),
    );
    expect(identifierTables).toHaveLength(17);
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

  it("migrates historical Disc Inspections without inventing settling evidence", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const settlingMigration = "20260822142722_disc-inspection-settling";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name < settlingMigration)
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
      recordMigration.run(`pre-settling-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_enabled, is_present, last_seen_at, created_at,
        updated_at
      ) values
        ('running-drive', '/dev/running', 1, 1, 1, 1, 1),
        ('completed-drive', '/dev/completed', 1, 1, 1, 1, 1),
        ('failed-drive', '/dev/failed', 1, 1, 1, 1, 1),
        ('aborted-drive', '/dev/aborted', 1, 1, 1, 1, 1);
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'completed-disc', 'completed-drive', 'dvd', 'completed-fingerprint',
        'scanned', 1, 1, 1
      );
      insert into disc_inspections (
        id, optical_drive_id, detected_disc_id, media_generation, is_current,
        status, phase, phase_started_at, attempt_started_at, started_at,
        completed_at, created_at, updated_at
      ) values
        ('running-inspection', 'running-drive', null, 'running-generation', 1,
          'running', 'reading_metadata', 1, 1, 1, null, 1, 1),
        ('completed-inspection', 'completed-drive', 'completed-disc',
          'completed-generation', 1, 'completed', 'confirming_media',
          1, 1, 1, 2, 1, 2),
        ('failed-inspection', 'failed-drive', null, 'failed-generation', 1,
          'failed', 'reading_metadata', 1, 1, 1, 2, 1, 2),
        ('aborted-inspection', 'aborted-drive', null, 'aborted-generation', 0,
          'aborted', 'confirming_media', 1, 1, 1, 2, 1, 2);
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(
      migrated.discInspections.list().map((inspection) => ({
        id: inspection.id,
        status: inspection.status,
        phase: inspection.phase,
        mediaCapacityBytes: inspection.mediaCapacityBytes,
        stableObservationCount: inspection.stableObservationCount,
        settlingQuietWindowStartedAt:
          inspection.settlingQuietWindowStartedAt,
        settlingStartedAt: inspection.settlingStartedAt,
        settlingResetCount: inspection.settlingResetCount,
      })),
    ).toEqual(expect.arrayContaining([
      {
        id: "running-inspection",
        status: "running",
        phase: "reading_metadata",
        mediaCapacityBytes: null,
        stableObservationCount: null,
        settlingQuietWindowStartedAt: null,
        settlingStartedAt: null,
        settlingResetCount: null,
      },
      {
        id: "completed-inspection",
        status: "completed",
        phase: "confirming_media",
        mediaCapacityBytes: null,
        stableObservationCount: null,
        settlingQuietWindowStartedAt: null,
        settlingStartedAt: null,
        settlingResetCount: null,
      },
      {
        id: "failed-inspection",
        status: "failed",
        phase: "reading_metadata",
        mediaCapacityBytes: null,
        stableObservationCount: null,
        settlingQuietWindowStartedAt: null,
        settlingStartedAt: null,
        settlingResetCount: null,
      },
      {
        id: "aborted-inspection",
        status: "aborted",
        phase: "confirming_media",
        mediaCapacityBytes: null,
        stableObservationCount: null,
        settlingQuietWindowStartedAt: null,
        settlingStartedAt: null,
        settlingResetCount: null,
      },
    ]));
    migrated.close();
  });

  it("migrates historical Archive Jobs without inventing read-failure evidence", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const readFailureMigration = "20260822175220_striped_kabuki";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name < readFailureMigration)
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
      recordMigration.run(`pre-read-failure-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_enabled, is_present, last_seen_at, created_at,
        updated_at
      ) values ('historical-drive', '/dev/historical', 1, 1, 1, 1, 1);
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'historical-disc', 'historical-drive', 'dvd',
        'historical-fingerprint', 'approved', 1, 1, 1
      );
      insert into archive_requests (
        id, detected_disc_id, status, priority, created_at, updated_at
      ) values (
        'historical-request', 'historical-disc', 'needs_attention', 0, 1, 2
      );
      insert into archive_jobs (
        id, archive_request_id, detected_disc_id, attempt_ordinal, status,
        priority, progress_phase, progress_percent, progress_bytes,
        last_progress_at, started_at, completed_at, error_message, created_at,
        updated_at
      ) values (
        'historical-job', 'historical-request', 'historical-disc', 1, 'failed',
        0, 'copying', 25, 2048, 2, 1, 2, 'legacy read error', 1, 2
      );
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.archiveJobs.list()).toEqual([
      expect.objectContaining({
        id: "historical-job",
        failureDetailVersion: null,
        readFailureStage: null,
        readFailureCategory: null,
        readFailureClassifierVersion: null,
        readFailureLba: null,
        readFailureRequestedBlockCount: null,
        readFailureRetryCount: null,
        readFailureScsiStatus: null,
        readFailureHostStatus: null,
        readFailureDriverStatus: null,
        readFailureSenseKey: null,
        readFailureAsc: null,
        readFailureAscq: null,
      }),
    ]);
    migrated.close();
  });

  it("migrates historical Original Disc Archives to unknown integrity", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const integrityMigration = "20260814192709_steep_king_cobra";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name < integrityMigration)
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
      recordMigration.run(`pre-integrity-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values (
        'historical-drive', '/dev/historical', 1, 1, 1, 1
      );
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'historical-disc', 'historical-drive', 'dvd',
        'historical-fingerprint', 'archived', 1, 1, 1
      );
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, created_at, updated_at
      ) values (
        'historical-archive', 'historical-disc', 'dvd', 'iso',
        '/media/originals/historical.iso', 'historical-fingerprint', 1, 1, 1
      );
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        id: "historical-archive",
        integrity: "unknown",
        integrityPolicyVersion: null,
        badSectorCount: null,
        badAreaCount: null,
        badSectorRanges: null,
      }),
    ]);
    migrated.close();
  });

  it("preserves version-one salvage evidence without inventing title counts", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const versionOneMigration = "20260814192709_steep_king_cobra";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name <= versionOneMigration)
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
      recordMigration.run(`pre-v2-salvage-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values ('v1-drive', '/dev/v1', 1, 1, 1, 1);
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'v1-disc', 'v1-drive', 'dvd', 'v1-fingerprint', 'archived', 1, 1, 1
      );
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, integrity, integrity_policy_version, bad_sector_count,
        bad_area_count, bad_sector_ranges, archived_at, created_at, updated_at
      ) values (
        'v1-archive', 'v1-disc', 'dvd', 'iso',
        '/media/originals/v1.iso', 'v1-fingerprint', 'watchable_salvage',
        'dvd-watchable-salvage-v1', 1, 1,
        '[{"startLba":10,"sectorCount":1}]', 1, 1, 1
      );
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        id: "v1-archive",
        integrity: "watchable_salvage",
        integrityPolicyVersion: "dvd-watchable-salvage-v1",
        badSectorCount: 1,
        badAreaCount: 1,
        badSectorRanges: [{ startLba: 10, sectorCount: 1 }],
        badSectorCountsByTitle: null,
      }),
    ]);
    migrated.close();
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

  it("adds supersession history without rewriting existing Encode Job provenance", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const supersessionMigration =
      "20260812180200_hard_smiling_tiger";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name < supersessionMigration)
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
      recordMigration.run(`pre-supersession-${migrationName}`, migrationName);
    }
    sqlite.exec(`
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values (
        'pre-supersession-drive', '/dev/pre-supersession', 1, 1, 1, 1
      );
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
        created_at, updated_at
      ) values (
        'pre-supersession-disc', 'pre-supersession-drive', 'dvd',
        'pre-supersession-fingerprint', 'archived', 1, 1, 1
      );
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, catalog_reviewed_at,
        catalog_review_outcome, created_at, updated_at
      ) values (
        'pre-supersession-archive', 'pre-supersession-disc', 'dvd', 'iso',
        '/media/originals/pre-supersession.iso',
        'pre-supersession-fingerprint', 1, 1, 'reviewed_with_selections',
        1, 1
      );
      insert into media_items (
        id, kind, title, created_at, updated_at
      ) values (
        'pre-supersession-movie', 'movie', 'Pre-supersession Movie', 1, 1
      );
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        created_at, updated_at
      ) values (
        'pre-supersession-selection', 'pre-supersession-archive',
        'pre-supersession-movie', 'dvd:main-feature', 'main_feature', 1, 1
      );
      insert into encoding_profiles (
        id, key, display_name, media_domain, version, is_active, settings,
        created_at, updated_at
      ) values (
        'pre-supersession-profile', 'pre-supersession-profile',
        'Pre-supersession profile', 'dvd_video', 1, 1, '{}', 1, 1
      );
      insert into encode_jobs (
        id, disc_selection_id, encoding_profile_id, output_path, status,
        progress_percent, completed_at, created_at, updated_at
      ) values (
        'pre-supersession-job', 'pre-supersession-selection',
        'pre-supersession-profile', '/media/movies/pre-supersession.mkv',
        'completed', 100, 2, 1, 2
      );
    `);
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.catalog.listDiscSelections({
      ids: ["pre-supersession-selection" as DiscSelectionId],
    })).toEqual([expect.objectContaining({
      id: "pre-supersession-selection",
      mediaItemId: "pre-supersession-movie",
      sourceIdentity: { kind: "main_feature" },
    })]);
    expect(migrated.encodeJobs.list()).toEqual([expect.objectContaining({
      id: "pre-supersession-job",
      discSelectionId: "pre-supersession-selection",
      encodingProfileId: "pre-supersession-profile",
      outputPath: "/media/movies/pre-supersession.mkv",
      status: "completed",
    })]);
    expect(migrated.catalog.listDiscSelectionSupersessions({
      discSelectionIds: ["pre-supersession-selection" as DiscSelectionId],
    })).toEqual([]);
    migrated.close();

    const verified = new DatabaseSync(databasePath);
    expect(verified.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(() => verified.exec(`
      insert into disc_selection_supersessions (
        superseded_disc_selection_id, replacement_disc_selection_id,
        created_at
      ) values (
        'pre-supersession-selection', 'pre-supersession-selection', 3
      )
    `)).toThrow(/disc_selection_supersessions_distinct_selections_check/);
    verified.close();
  });

  it("migrates archive intent separately from started Archive Job attempts", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name))
      .filter(
        (name) =>
          name !== "20260812151540_disc-inspection-archive-requests" &&
          name !== "20260820215821_redundant_jocasta" &&
          name !== "20260822142722_disc-inspection-settling" &&
          name !== "20260822175220_striped_kabuki" &&
          name !== "20260822183552_bounded-disc-settling" &&
          name !== "20260822185006_burly_northstar" &&
          name !== "20260822193801_safe_proteus" &&
          name !== "20260822201215_thick_madame_web" &&
          name !== "20260823160205_flat_fixer" &&
          name !== "20260828154312_luxuriant_human_robot" &&
          name !== "20260828160945_fancy_chimera",
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
    const overlappingSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: trailer.id,
      sourceIdentity: createDiscSelectionSourceIdentity({
        kind: "main_feature",
      }),
    });

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, fingerprint: "disc-fingerprint" }),
    ]);
    expect(selection.mediaItemId).toBe(movie.id);
    expect(selection.sourceIdentity).toEqual({ kind: "main_feature" });
    expect(overlappingSelection).toMatchObject({
      mediaItemId: trailer.id,
      sourceIdentity: { kind: "main_feature" },
    });
    expect(overlappingSelection.id).not.toBe(selection.id);
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
    ).toThrow("Assisted Mapping cannot use an overlapping DVD source");
    expect(access.catalog.listMediaItems()).toEqual(mediaItemsBeforeFailure);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(selectionsBeforeFailure);

    const partialOwner = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Partial source owner",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: partialOwner.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 5,
        chapterStart: 2,
        chapterEnd: 4,
      },
    });
    const catalogBeforeCoordinateOverlaps = {
      mediaItems: access.catalog.listMediaItems(),
      discSelections: access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
      }),
    };
    const overlapRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    for (const sourceIdentity of [
      { kind: "dvd_title", titleNumber: 5 },
      {
        kind: "dvd_chapters",
        titleNumber: 5,
        chapterStart: 4,
        chapterEnd: 6,
      },
    ] as const) {
      expect(() => access.catalog.createMappingProposal({
        originalDiscArchiveId: archive.id,
        catalogRevision: overlapRevision,
        mediaItem: { kind: "movie", title: "Coordinate overlap" },
        discSelection: { sourceIdentity },
      })).toThrow("Assisted Mapping cannot use an overlapping DVD source");
      expect(access.catalog.listMediaItems()).toEqual(
        catalogBeforeCoordinateOverlaps.mediaItems,
      );
      expect(access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
      })).toEqual(catalogBeforeCoordinateOverlaps.discSelections);
    }
    expect(access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: overlapRevision,
      mediaItem: { kind: "movie", title: "Disjoint chapters" },
      discSelection: {
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 5,
          chapterStart: 5,
          chapterEnd: 6,
        },
      },
    }).discSelection).toMatchObject({
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 5,
        chapterStart: 5,
        chapterEnd: 6,
      },
    });
    const revisionAfterDisjointProposal =
      access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt;

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
      catalogRevision: revisionAfterDisjointProposal,
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
      catalogRevision: revisionAfterDisjointProposal,
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
      kind: "movie",
      title: "Existing catalog identity",
    });
    const itemCountBeforeReuse = access.catalog.listMediaItems().length;
    const reused = access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: revisionAfterExtra,
      existingMediaItemId: existingItem.id,
      existingMediaItemTmdbIdentity: {
        mediaType: "movie",
        tmdbId: 77_001,
      },
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
    expect(access.catalog.findMediaItemByTmdbIdentity({
      mediaType: "movie",
      tmdbId: 77_001,
    })).toEqual(existingItem);
    expect(access.catalog.findTmdbIdentityByMediaItemId(existingItem.id))
      .toEqual({ mediaType: "movie", tmdbId: 77_001 });
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

  it("accepts an automatic movie proposal and completes its review atomically", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"1".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: [1, 2].map((number) => ({
          number,
          durationSeconds: 5_400,
          chapters: 12,
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
      archivePath: "/media/originals/Automatic Movie.iso",
      fingerprint: contentId,
    });

    const accepted = access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      mediaItem: {
        kind: "movie",
        title: "Automatic Movie",
        year: 1999,
        tmdbIdentity: { mediaType: "movie", tmdbId: 10_350 },
      },
      discSelection: { sourceIdentity: { kind: "main_feature" } },
      completeReview: true,
    });

    expect(access.catalog.findMediaItemByTmdbIdentity({
      mediaType: "movie",
      tmdbId: 10_350,
    })).toEqual(accepted.mediaItem);
    expect(() =>
      access.catalog.updateMediaItem(accepted.mediaItem.id, {
        kind: "other",
      })
    ).toThrow("Media Item kind must match its TMDB identity");
    expect(access.catalog.findMediaItemByTmdbIdentity({
      mediaType: "movie",
      tmdbId: 10_350,
    })).toEqual(accepted.mediaItem);
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        catalogReviewOutcome: "reviewed_with_selections",
        catalogReviewedAt: expect.any(Date),
      });

    const beforeRejectedAcceptance = {
      mediaItems: access.catalog.listMediaItems(),
      selections: access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
      }),
    };
    const currentRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    expect(() => access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: currentRevision,
      mediaItem: { kind: "movie", title: "Must roll back" },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      },
      completeReview: true,
    })).toThrow("reload before accepting the automatic proposal");
    expect(access.catalog.listMediaItems()).toEqual(
      beforeRejectedAcceptance.mediaItems,
    );
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(beforeRejectedAcceptance.selections);
    access.close();
  });

  it("rolls back automatic acceptance while legacy cutover is pending", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/automatic-legacy",
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
          durationSeconds: 5_400,
          chapters: 12,
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
      archivePath: "/media/originals/Automatic Legacy.iso",
      fingerprint: contentId,
    });
    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare(`
      update original_disc_archives
      set legacy_cutover_pending = 1
      where id = ?
    `).run(archive.id);
    sqlite.close();

    expect(() => access.catalog.createMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      mediaItem: { kind: "movie", title: "Must roll back" },
      discSelection: { sourceIdentity: { kind: "main_feature" } },
      completeReview: true,
    })).toThrow("legacy cutover repair is pending");
    expect(access.catalog.listMediaItems()).toEqual([]);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([]);
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
        legacyCutoverPending: true,
      });
    access.close();
  });

  it("keeps exact-overlap Disc Selection identities and Encode Job provenance distinct", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"e".repeat(64)}`;
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
      archivePath: "/media/originals/Exact Overlap.iso",
      fingerprint: contentId,
    });
    const items = ["Concert", "Concert copy", "Song", "Song translation"]
      .map((title) => access.catalog.createMediaItem({ kind: "movie", title }));

    const wholeTitleSelections = items.slice(0, 2).map((mediaItem) =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      })
    );
    const exactChapterSelections = items.slice(2).map((mediaItem) =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: mediaItem.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 2,
          chapterStart: 3,
          chapterEnd: 5,
        },
      })
    );

    expect(new Set([
      ...wholeTitleSelections,
      ...exactChapterSelections,
    ].map(({ id }) => id)).size).toBe(4);
    expect(completeCatalogReview(access, archive.id)).toMatchObject({
      catalogReviewOutcome: "reviewed_with_selections",
    });

    const profile = access.encodingProfiles.create({
      key: "exact-overlap",
      displayName: "Exact overlap",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const historicalSelection = wholeTitleSelections[0]!;
    const historicalJob = access.encodeJobs.enqueue({
      discSelectionId: historicalSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Exact Overlap.mkv",
    });
    const reviewedArchive = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!;
    const correction = access.catalog.correctDiscSelection(
      historicalSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: reviewedArchive.updatedAt,
        mediaItemId: historicalSelection.mediaItemId,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        reason: "Keep a corrected identity for the same intentional source.",
      },
    );

    expect(correction.discSelection.id).not.toBe(historicalSelection.id);
    expect(correction.discSelection.sourceIdentity).toEqual(
      wholeTitleSelections[1]!.sourceIdentity,
    );
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: historicalJob.id,
        discSelectionId: historicalSelection.id,
        status: "cancelled",
      }),
    ]);
    expect(access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [historicalSelection.id],
    })).toEqual([
      expect.objectContaining({
        supersededDiscSelectionId: historicalSelection.id,
        replacementDiscSelectionId: correction.discSelection.id,
      }),
    ]);
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
        titles: [2, 4, 5, 7].map((number) => ({
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

    access.catalog.deleteDiscSelection(
      created.episodes[2]!.discSelection.id,
    );
    const catalogBeforeIntraProposalOverlap = {
      mediaItems: access.catalog.listMediaItems(),
      discSelections: access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
      }),
    };
    expect(() => access.catalog.createEpisodicMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      tvShow: { choice: "create_new", title: "Duplicate Source Show" },
      season: {
        choice: "create_new",
        title: "Duplicate Source Show Season 1",
        seasonNumber: 1,
      },
      episodes: [
        { titleNumber: 7, title: "First mapping", episodeNumber: 1 },
        { titleNumber: 7, title: "Second mapping", episodeNumber: 2 },
      ],
    })).toThrow("Assisted Mapping cannot use an overlapping DVD source");
    expect(access.catalog.listMediaItems()).toEqual(
      catalogBeforeIntraProposalOverlap.mediaItems,
    );
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(catalogBeforeIntraProposalOverlap.discSelections);

    const partialOwner = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Partially mapped episode source",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: partialOwner.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 5,
        chapterStart: 2,
        chapterEnd: 4,
      },
    });

    const catalogBeforeOverlap = {
      mediaItems: access.catalog.listMediaItems(),
      discSelections: access.catalog.listDiscSelections({
        originalDiscArchiveId: archive.id,
      }),
    };
    const currentRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    expect(() => access.catalog.createEpisodicMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: currentRevision,
      tvShow: { choice: "create_new", title: "Overlapping Show" },
      season: {
        choice: "create_new",
        title: "Overlapping Show Season 1",
        seasonNumber: 1,
      },
      episodes: [{
        titleNumber: 5,
        title: "Overlapping Episode",
        episodeNumber: 1,
      }],
    })).toThrow("Assisted Mapping cannot use an overlapping DVD source");
    expect(access.catalog.listMediaItems()).toEqual(
      catalogBeforeOverlap.mediaItems,
    );
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(catalogBeforeOverlap.discSelections);
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
    const existingEpisode = access.catalog.createMediaItem({
      parentId: firstSeason.id,
      kind: "episode",
      title: "Locally edited first episode",
      episodeNumber: 1,
    });

    const reused = access.catalog.createEpisodicMappingProposal({
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      tvShow: { choice: "use_existing", mediaItemId: show.id },
      season: { choice: "use_existing", mediaItemId: firstSeason.id },
      episodes: [{
        titleNumber: 1,
        title: "First",
        episodeNumber: 1,
        existingMediaItemId: existingEpisode.id,
      }],
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
      episodes: [{ mediaItem: { id: existingEpisode.id } }],
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
    expect(() => access.catalog.getCatalogReviewCoverage(
      "missing-archive" as OriginalDiscArchiveId,
    )).toThrow(RecordNotFoundError);
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

  it("serializes concurrent exact-overlap creation without merging identities", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "concurrent-exact-overlap-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Concurrent Exact Overlap.iso",
      fingerprint: "concurrent-exact-overlap-disc",
    });
    const mediaItems = ["Concert", "Alternate catalog identity"].map(
      (title) => access.catalog.createMediaItem({ kind: "movie", title }),
    );

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: mediaItems.map((mediaItem) => ({
        operation: "create-disc-selection" as const,
        originalDiscArchiveId: archive.id,
        mediaItemId: mediaItem.id,
      })),
    });

    expect(results).toEqual([
      expect.objectContaining({ outcome: "created" }),
      expect.objectContaining({ outcome: "created" }),
    ]);
    expect(new Set(results.map((result) =>
      typeof result === "object" && result !== null ? result.id : undefined
    )).size).toBe(2);
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toHaveLength(2);
    const currentArchive = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!;
    expect(access.catalog.completeCatalogReview(
      archive.id,
      currentArchive.updatedAt,
      "reviewed_with_selections",
    )).toMatchObject({ catalogReviewOutcome: "reviewed_with_selections" });
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

  it("updates a job-free Disc Selection in place while distinguishing omission from label clearing", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "job-free-selection-update",
      selectionLabel: "Director's cut",
    });
    if (!correctedItem) {
      throw new Error("Expected a Media Item update target");
    }
    const reviewedRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;

    const updated = access.catalog.updateDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        mediaItemId: correctedItem.id,
      },
    );

    expect(updated).toMatchObject({
      id: mistakenSelection.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
      label: "Director's cut",
    });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({
      catalogReviewOutcome: "needs_review",
      catalogReviewedAt: null,
      updatedAt: expect.any(Date),
    });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt.getTime(),
    ).toBeGreaterThan(reviewedRevision.getTime());

    const cleared = access.catalog.updateDiscSelection(updated.id, {
      originalDiscArchiveId: archive.id,
      label: null,
    });
    expect(cleared).toMatchObject({
      id: mistakenSelection.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
      label: null,
    });
    expect(() =>
      access.catalog.updateDiscSelection(cleared.id, {
        originalDiscArchiveId: archive.id,
      } as unknown as Parameters<
        typeof access.catalog.updateDiscSelection
      >[1])
    ).toThrow("Disc Selection update requires at least one change");
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(access.catalog.updateDiscSelection(cleared.id, {
      originalDiscArchiveId: archive.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    })).toMatchObject({
      id: cleared.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });

    const rangeTarget = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 2,
        chapterEnd: 5,
      },
    });
    const rangeEditable = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 6,
        chapterEnd: 8,
      },
    });
    expect(access.catalog.updateDiscSelection(rangeEditable.id, {
      originalDiscArchiveId: archive.id,
      sourceIdentity: rangeTarget.sourceIdentity,
    })).toMatchObject({
      id: rangeEditable.id,
      sourceIdentity: rangeTarget.sourceIdentity,
    });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: cleared.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
      expect.objectContaining({
        id: rangeEditable.id,
        sourceIdentity: rangeTarget.sourceIdentity,
      }),
    ]));
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

  it("computes whole-archive Review Coverage from immutable scan evidence", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/catalog-review-coverage",
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
        titles: [
          { number: 1, durationSeconds: 5_400, chapters: 12 },
          { number: 2, durationSeconds: 2_400, chapters: 8 },
          { number: 3, durationSeconds: 1_800, chapters: 6 },
          { number: 4, durationSeconds: 90, chapters: 1 },
          { number: 5, durationSeconds: 120, chapters: 0 },
        ].map((title) => ({
          ...title,
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
      archivePath: "/media/originals/Catalog Review Coverage.iso",
      fingerprint: contentId,
    });
    const items = ["Movie", "Episode A", "Episode B"].map((title) =>
      access.catalog.createMediaItem({ kind: "movie", title })
    );
    const createSelection = (
      mediaItemIndex: number,
      sourceIdentity: Parameters<
        typeof access.catalog.createDiscSelection
      >[0]["sourceIdentity"],
    ) => access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: items[mediaItemIndex]!.id,
      sourceIdentity,
    });
    createSelection(0, { kind: "dvd_title", titleNumber: 1 });
    createSelection(1, {
      kind: "dvd_chapters",
      titleNumber: 1,
      chapterStart: 3,
      chapterEnd: 4,
    });
    createSelection(1, {
      kind: "dvd_chapters",
      titleNumber: 2,
      chapterStart: 1,
      chapterEnd: 3,
    });
    createSelection(2, {
      kind: "dvd_chapters",
      titleNumber: 2,
      chapterStart: 3,
      chapterEnd: 5,
    });
    createSelection(1, {
      kind: "dvd_chapters",
      titleNumber: 3,
      chapterStart: 1,
      chapterEnd: 3,
    });
    createSelection(2, {
      kind: "dvd_chapters",
      titleNumber: 3,
      chapterStart: 4,
      chapterEnd: 6,
    });
    createSelection(0, { kind: "main_feature" });
    createSelection(0, { kind: "dvd_title", titleNumber: 5 });
    createSelection(1, { kind: "dvd_title", titleNumber: 5 });

    expect(access.catalog.getCatalogReviewCoverage(archive.id)).toEqual({
      discSelectionCount: 9,
      mediaItemsWithSelections: 3,
      mappedTitles: 3,
      partiallyMappedTitles: 1,
      unmappedTitles: 1,
      mainFeatureSelections: 1,
      titles: [
        { titleNumber: 1, status: "mapped", hasOverlap: true },
        { titleNumber: 2, status: "partially_mapped", hasOverlap: true },
        { titleNumber: 3, status: "mapped", hasOverlap: false },
        { titleNumber: 4, status: "unmapped", hasOverlap: false },
        { titleNumber: 5, status: "mapped", hasOverlap: true },
      ],
    });
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

    expect(access.catalog.getCatalogReviewCoverage(archive.id)).toEqual({
      discSelectionCount: selectionCount + 1,
      mediaItemsWithSelections: 1,
      mappedTitles: 0,
      partiallyMappedTitles: 1,
      unmappedTitles: 0,
      mainFeatureSelections: 1,
      titles: [{
        titleNumber: 1,
        status: "partially_mapped",
        hasOverlap: false,
      }],
    });

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

  it("corrects completed Encode Job provenance by superseding its Disc Selection", () => {
    const {
      access,
      archive,
      mistakenItem,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "completed-selection-correction",
    });
    if (!correctedItem) {
      throw new Error("Expected completed correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "completed-selection-correction",
      displayName: "Completed selection correction",
      mediaDomain: "dvd_video",
      settings: { preset: "HQ" },
    });
    const queued = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Mistaken Movie.mkv",
    });
    const claim = access.encodeJobs.claimNext("completed-correction-worker");
    if (!claim) {
      throw new Error("Expected completed correction Encode Job claim");
    }
    const completed = access.encodeJobs.complete(claim);
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    expect(access.catalog.listDiscSelectionActionAvailability({
      ids: [mistakenSelection.id],
    })).toEqual([{
      discSelectionId: mistakenSelection.id,
      state: "locked_provenance",
      availableActions: ["correct"],
      reason:
        `Encode Job ${completed.id} is completed; correct this Disc Selection by supersession to preserve its provenance`,
      relatedEncodeJob: { id: completed.id, status: "completed" },
    }]);

    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        reason: "The main-feature choice encoded the wrong cut.",
      },
    );

    expect(correction.discSelection).toMatchObject({
      originalDiscArchiveId: archive.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(correction.discSelection.id).not.toBe(mistakenSelection.id);
    expect(correction.supersession).toMatchObject({
      supersededDiscSelectionId: mistakenSelection.id,
      replacementDiscSelectionId: correction.discSelection.id,
      reason: "The main-feature choice encoded the wrong cut.",
    });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([expect.objectContaining({ id: correction.discSelection.id })]);
    expect(access.catalog.listDiscSelections({ ids: [mistakenSelection.id] }))
      .toEqual([expect.objectContaining({
        id: mistakenSelection.id,
        mediaItemId: mistakenItem.id,
        sourceIdentity: { kind: "main_feature" },
      })]);
    expect(access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [
        mistakenSelection.id,
        correction.discSelection.id,
      ],
    })).toEqual([correction.supersession]);
    expect(() => access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: Array.from(
        { length: 101 },
        () => mistakenSelection.id,
      ),
    })).toThrow(
      "Disc Selection supersession lookup is limited to 100 records",
    );
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: queued.id,
        discSelectionId: mistakenSelection.id,
        encodingProfileId: profile.id,
        outputPath: queued.outputPath,
        status: completed.status,
      }),
    ]);
    expect(access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0])
      .toMatchObject({
        catalogReviewOutcome: "needs_review",
        catalogReviewedAt: null,
      });
    completeCatalogReview(access, archive.id);
    expect(access.catalog.listDiscSelectionActionAvailability({
      ids: [correction.discSelection.id],
    })).toEqual([{
      discSelectionId: correction.discSelection.id,
      state: "correction_lineage",
      availableActions: ["correct", "remove"],
      reason:
        "This Disc Selection belongs to immutable correction lineage; correct it by supersession or remove it while retaining history",
      relatedEncodeJob: null,
    }]);
    expect(() => access.catalog.repairDiscSelection(
      correction.discSelection.id,
      {
        originalDiscArchiveId: archive.id,
        mediaItemId: mistakenItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    )).toThrow("belongs to immutable correction lineage");
    const secondCorrection = access.catalog.correctDiscSelection(
      correction.discSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: mistakenItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        reason: "The replacement was also mistaken.",
      },
    );
    expect(access.catalog.listDiscSelections({
      ids: [correction.discSelection.id],
    })).toEqual([expect.objectContaining({
      id: correction.discSelection.id,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    })]);
    expect(access.catalog.listDiscSelectionSupersessions({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([correction.supersession, secondCorrection.supersession]);
    expect(() => access.catalog.listDiscSelectionSupersessions({
      originalDiscArchiveId: archive.id,
      limit: 102,
    })).toThrow(
      "Disc Selection supersession history limit must be a safe integer between 1 and 101",
    );
    expect(
      access.catalog.deleteDiscSelection(secondCorrection.discSelection.id),
    ).toMatchObject({
      id: secondCorrection.discSelection.id,
      deletedEncodeJobs: 0,
      deletionComplete: true,
    });
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([]);
    expect(access.catalog.listDiscSelections({
      ids: [secondCorrection.discSelection.id],
    })).toEqual([
      expect.objectContaining({ id: secondCorrection.discSelection.id }),
    ]);
    expect(access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [
        mistakenSelection.id,
        correction.discSelection.id,
        secondCorrection.discSelection.id,
      ],
    })).toEqual([correction.supersession, secondCorrection.supersession]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: queued.id,
        discSelectionId: mistakenSelection.id,
        status: "completed",
      }),
    ]);
    access.close();
  });

  it("proposes corrected replacement defaults and completes review with explicit opt-out", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-plan-opt-out",
    });
    if (!correctedItem) {
      throw new Error("Expected replacement plan correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-plan-opt-out",
      displayName: "Replacement plan opt-out",
      mediaDomain: "dvd_video",
      settings: { preset: "HQ" },
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement plan opt-out.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-plan-opt-out");
    if (!claim) {
      throw new Error("Expected replacement plan predecessor claim");
    }
    access.encodeJobs.complete(claim);
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );

    expect(access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([{
      predecessorEncodeJobId: predecessor.id,
      replacementDiscSelectionId: correction.discSelection.id,
      proposedEncodingProfileId: profile.id,
      proposedOutputPath: predecessor.outputPath,
      predecessorStatus: "completed",
      predecessorReady: true,
    }]);

    const completion = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [],
    );

    expect(completion).toMatchObject({
      archive: {
        id: archive.id,
        catalogReviewOutcome: "reviewed_with_selections",
        catalogReviewedAt: expect.any(Date),
      },
      replacementEncodeJobs: [],
    });
    expect(access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([{
      replacementDiscSelectionId: correction.discSelection.id,
      predecessorEncodeJob: {
        id: predecessor.id,
        status: "completed",
      },
      replacementEncodeJob: null,
    }]);
    expect(
      access.catalog.deleteDiscSelection(correction.discSelection.id),
    ).toMatchObject({
      id: correction.discSelection.id,
      deletionComplete: true,
    });
    expect(access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([{
      replacementDiscSelectionId: correction.discSelection.id,
      predecessorEncodeJob: {
        id: predecessor.id,
        status: "completed",
      },
      replacementEncodeJob: null,
    }]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: predecessor.id,
        status: "completed",
      }),
    ]);
    access.close();
  });

  it("atomically completes review and admits an opted-in corrected replacement", () => {
    vi.useFakeTimers();
    const firstCompletionAt = new Date("2026-08-26T07:00:00.000Z");
    vi.setSystemTime(firstCompletionAt);
    const databasePath = createTestDatabasePath();
    const logicalOutputDirectory = join(dirname(databasePath), "logical-media");
    const canonicalOutputDirectory = join(
      dirname(databasePath),
      "canonical-media",
    );
    const outputPath = join(
      logicalOutputDirectory,
      "Replacement plan opt-in.mkv",
    );
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      databasePath,
      key: "replacement-plan-opt-in",
    });
    if (!correctedItem) {
      throw new Error("Expected replacement opt-in correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-plan-opt-in",
      displayName: "Replacement plan opt-in",
      mediaDomain: "dvd_video",
      settings: { preset: "HQ" },
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath,
    });
    const predecessorClaim = access.encodeJobs.claimNext(
      "replacement-plan-predecessor",
    );
    if (!predecessorClaim) {
      throw new Error("Expected completed replacement predecessor claim");
    }
    access.encodeJobs.complete(predecessorClaim);
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );

    const completion = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
      }],
    );

    expect(completion.replacementEncodeJobs).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        predecessorEncodeJobId: predecessor.id,
        discSelectionId: correction.discSelection.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
        status: "queued",
        replaceExistingOutput: true,
      }),
    ]);
    const replacement = completion.replacementEncodeJobs[0]!;
    expect(replacement.id).not.toBe(predecessor.id);
    expect(access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([]);
    expect(access.encodeJobs.claimNext("replacement-plan-successor"))
      .toMatchObject({
        id: replacement.id,
        predecessorEncodeJobId: predecessor.id,
        status: "running",
      });
    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
      completedAt: null,
      id: replacement.id,
      predecessorEncodeJobId: predecessor.id,
      status: "running",
    }));
    const replacementClaim = access.encodeJobs.list(["running"])[0] as
      RunningEncodeJob;
    expect(() =>
      access.encodeJobs.complete({
        ...replacementClaim,
        predecessorEncodeJobId: null,
      })
    ).toThrow(StaleJobAttemptError);
    expect(() => access.encodeJobs.complete(replacementClaim)).toThrow(
      "Corrected replacement Encode Job completion requires publication provenance",
    );
    expect(access.encodeJobs.list(["running"])).toContainEqual(
      expect.objectContaining({
        id: replacement.id,
        replaceExistingOutput: true,
        status: "running",
      }),
    );
    const priorOutputIdentity =
      "1048576:2048:4096:1710000000000" as EncodeOutputFilesystemIdentity;
    const logicalRetainedOutputPath =
      `${replacement.outputPath}.failed.${replacementClaim.claimToken}`;
    access.encodeJobs.recordReplacementOutputIdentity(
      replacementClaim,
      priorOutputIdentity,
    );
    const publication = access.encodeJobs.registerPartialCleanup(
      replacementClaim,
      { publicationPending: true },
    );
    expect(() =>
      access.encodeJobs.beginPublicationMutation(
        replacementClaim,
        publication,
      )
    ).toThrow(
      "Corrected publication mutation requires retained output authority",
    );
    expect(() =>
      access.encodeJobs.beginPublicationMutation(
        replacementClaim,
        publication,
        logicalRetainedOutputPath,
      )
    ).toThrow("Encode Job output directory is unavailable");
    mkdirSync(canonicalOutputDirectory);
    symlinkSync(canonicalOutputDirectory, logicalOutputDirectory, "dir");
    const retainedOutputPath = join(
      realpathSync(canonicalOutputDirectory),
      basename(logicalRetainedOutputPath),
    );
    expect(() =>
      access.encodeJobs.beginPublicationMutation(
        replacementClaim,
        publication,
        join("/unrelated", basename(retainedOutputPath)),
      )
    ).toThrow(
      "Retained Encode output path does not match the Encode Job output",
    );
    const fencedPublication = access.encodeJobs.beginPublicationMutation(
      replacementClaim,
      publication,
      retainedOutputPath,
    );
    expect(() =>
      access.encodeJobs.completePublishedClaim(
        replacementClaim,
        fencedPublication,
        () => true,
      )
    ).toThrow("Retained Encode output provenance is incomplete");
    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
      completedAt: null,
      id: replacement.id,
      status: "completed",
      publicationCompletionPending: true,
    }));
    expect(access.encodeJobs.listRetainedOutputs([replacement.id])).toEqual([]);
    expect(() =>
      access.encodeJobs.completePublishedPartial(
        fencedPublication,
        () => true,
        {
          retainedOutputPath: `${retainedOutputPath}.forged`,
          retainedOutputIdentity: priorOutputIdentity,
        },
      )
    ).toThrow("Retained Encode output path conflicts with publication authority");
    expect(access.encodeJobs.listRetainedOutputs([replacement.id])).toEqual([]);
    const finalizedReplacement = access.encodeJobs.completePublishedPartial(
      fencedPublication,
      () => true,
      { retainedOutputPath, retainedOutputIdentity: priorOutputIdentity },
    );
    expect(finalizedReplacement.job).toMatchObject({
      completedAt: firstCompletionAt,
      id: replacement.id,
      replacementOutputIdentity: null,
      status: "completed",
    });
    expect(() =>
      access.encodeJobs.completePublishedPartial(
        fencedPublication,
        () => true,
      )
    ).toThrow("Retained Encode output provenance is incomplete");
    vi.setSystemTime(new Date("2026-08-26T07:01:00.000Z"));
    const replayedPublication = access.encodeJobs.completePublishedPartial(
      fencedPublication,
      () => true,
      { retainedOutputPath, retainedOutputIdentity: priorOutputIdentity },
    );
    expect(replayedPublication).toMatchObject({
      job: expect.objectContaining({ completedAt: firstCompletionAt }),
    });
    access.encodeJobs.completePartialCleanup(fencedPublication);
    const sqlite = new DatabaseSync(databasePath);
    expect(sqlite.prepare(
      "select count(*) as count from corrected_encode_publication_authorities",
    ).get()).toEqual({ count: 0 });
    sqlite.close();
    expect(access.encodeJobs.listRetainedOutputs([replacement.id])).toEqual([{
      id: expect.any(String),
      predecessorEncodeJobId: predecessor.id,
      replacementEncodeJobId: replacement.id,
      retainedOutputPath,
      filesystemIdentity: priorOutputIdentity,
      state: "retained",
      cleanupEligible: true,
      retainedAt: expect.any(Date),
    }]);
    access.readConsistentSnapshot((snapshot) => {
      expect(snapshot.encodeJobs).not.toHaveProperty("listRetainedOutputs");
      expect(
        snapshot.encodeJobs.listRetainedOutputSummaries([replacement.id]),
      ).toEqual([{
        id: expect.any(String),
        predecessorEncodeJobId: predecessor.id,
        replacementEncodeJobId: replacement.id,
        state: "retained",
        cleanupEligible: true,
        retainedAt: expect.any(Date),
      }]);
      expect(snapshot.encodeJobs
        .listDiscSelectionCorrectionRetainedOutputSummaries({
          originalDiscArchiveId: archive.id,
          limit: 1,
        })).toEqual([{
          replacementDiscSelectionId: correction.discSelection.id,
          retainedOutput: {
            id: expect.any(String),
            predecessorEncodeJobId: predecessor.id,
            replacementEncodeJobId: replacement.id,
            state: "retained",
            cleanupEligible: true,
            retainedAt: expect.any(Date),
          },
        }]);
      expect(snapshot.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
        originalDiscArchiveId: archive.id,
        limit: 1,
      })).toEqual([{
        replacementDiscSelectionId: correction.discSelection.id,
        predecessorEncodeJob: {
          id: predecessor.id,
          status: "completed",
        },
        replacementEncodeJob: {
          id: replacement.id,
          status: "completed",
        },
      }]);
    });
    expect(access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
      originalDiscArchiveId: archive.id,
      limit: 1,
    })).toEqual([{
      replacementDiscSelectionId: correction.discSelection.id,
      predecessorEncodeJob: {
        id: predecessor.id,
        status: "completed",
      },
      replacementEncodeJob: {
        id: replacement.id,
        status: "completed",
      },
    }]);
    expect(access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
      originalDiscArchiveId: archive.id,
      limit: 1,
      offset: 1,
    })).toEqual([]);
    expect(() =>
      access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
        originalDiscArchiveId: archive.id,
        limit: 102,
      })
    ).toThrow(
      "Disc Selection correction Encode Job history limit must be a safe integer between 1 and 101",
    );
    expect(() => access.encodeJobs
      .listDiscSelectionCorrectionRetainedOutputSummaries({
        originalDiscArchiveId: archive.id,
        limit: 102,
      })).toThrow(
        "Disc Selection correction Retained Encode output history limit must be a safe integer between 1 and 101",
      );
    const reencodeCompletionAt = new Date("2026-08-26T07:05:00.000Z");
    vi.setSystemTime(reencodeCompletionAt);
    const requeuedReplacement = access.encodeJobs.requeue(replacement.id);
    const reencodeClaim = access.encodeJobs.claimNext("corrected-reencoder");
    if (!reencodeClaim || reencodeClaim.id !== requeuedReplacement.id) {
      throw new Error("Expected corrected re-encode claim");
    }
    const correctedOutputIdentity =
      "corrected-reencode-identity" as EncodeOutputFilesystemIdentity;
    access.encodeJobs.recordReplacementOutputIdentity(
      reencodeClaim,
      correctedOutputIdentity,
    );
    const reencodePublication = access.encodeJobs.registerPartialCleanup(
      reencodeClaim,
      { publicationPending: true },
    );
    const correctedOutputPath = join(
      realpathSync(canonicalOutputDirectory),
      `${basename(replacement.outputPath)}.failed.${reencodeClaim.claimToken}`,
    );
    const fencedReencodePublication = access.encodeJobs
      .beginPublicationMutation(
        reencodeClaim,
        reencodePublication,
        correctedOutputPath,
      );
    const finalizedReencode = access.encodeJobs.completePublishedClaim(
      reencodeClaim,
      fencedReencodePublication,
      () => true,
      {
        retainedOutputPath: correctedOutputPath,
        retainedOutputIdentity: correctedOutputIdentity,
      },
    );
    expect(finalizedReencode).toMatchObject({
      completedAt: reencodeCompletionAt,
      id: replacement.id,
      status: "completed",
    });
    access.encodeJobs.completePartialCleanup(fencedReencodePublication);
    expect(access.encodeJobs.listRetainedOutputs([replacement.id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predecessorEncodeJobId: predecessor.id,
          replacementEncodeJobId: replacement.id,
          retainedOutputPath,
          filesystemIdentity: priorOutputIdentity,
        }),
        expect.objectContaining({
          predecessorEncodeJobId: predecessor.id,
          replacementEncodeJobId: replacement.id,
          retainedOutputPath: correctedOutputPath,
          filesystemIdentity: correctedOutputIdentity,
        }),
      ]),
    );
    const retainedHistory = access.encodeJobs.listRetainedOutputs([
      replacement.id,
    ]);
    expect(retainedHistory).toHaveLength(2);
    expect(access.encodeJobs
      .listDiscSelectionCorrectionRetainedOutputSummaries({
        originalDiscArchiveId: archive.id,
        limit: 2,
      }).map(({ retainedOutput }) => retainedOutput.id)).toEqual(
        retainedHistory.map(({ id }) => id),
      );
    access.close();
  });

  it("stably traverses persisted correction jobs and retained outputs beyond multiple page boundaries", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/correction-history-boundaries",
      isPresent: true,
    });
    const createArchive = (suffix: string, fill: string) => {
      const contentId = `sha256:${fill.repeat(64)}`;
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
      return access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/${suffix}.iso`,
        fingerprint: contentId,
      });
    };
    const archive = createArchive("Correction History Boundaries", "d");
    const unrelatedArchive = createArchive(
      "Unrelated Correction History",
      "e",
    );
    const mistakenItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Correction History Mistake",
    });
    const correctedItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Correction History Correction",
    });
    const profile = access.encodingProfiles.create({
      key: "correction-history-boundaries",
      displayName: "Correction history boundaries",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const historySize = 201;
    const selections = Array.from({ length: historySize }, (_, index) =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: mistakenItem.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: index + 1,
          chapterEnd: index + 1,
        },
      })
    );
    completeCatalogReview(access, archive.id);
    const predecessors = selections.map((selection, index) =>
      access.encodeJobs.enqueue({
        discSelectionId: selection.id,
        encodingProfileId: profile.id,
        outputPath: `/media/movies/correction-history-${String(index).padStart(3, "0")}.mkv`,
      })
    );
    for (let index = 0; index < historySize; index += 1) {
      const claim = access.encodeJobs.claimNext(
        `correction-history-predecessor-${index}`,
      );
      if (!claim) {
        throw new Error("Expected correction-history predecessor claim");
      }
      access.encodeJobs.complete(claim);
    }
    const corrections = selections.map((selection, index) =>
      access.catalog.correctDiscSelection(selection.id, {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: index + 1,
          chapterEnd: index + 1,
        },
        reason: `Correction history ${index}`,
      })
    );
    const expectedPredecessorIds = [...predecessors]
      .sort((left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id)
      )
      .map(({ id }) => id);
    const firstPageBeforeDelayedReplacements = access.encodeJobs
      .listDiscSelectionCorrectionEncodeJobLinks({
        originalDiscArchiveId: archive.id,
        limit: 100,
        offset: 0,
      });
    expect(firstPageBeforeDelayedReplacements).toHaveLength(100);
    expect(firstPageBeforeDelayedReplacements.every(
      ({ replacementEncodeJob }) => replacementEncodeJob === null,
    )).toBe(true);

    const unrelatedSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: unrelatedArchive.id,
      mediaItemId: mistakenItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    completeCatalogReview(access, unrelatedArchive.id);
    const unrelatedPredecessor = access.encodeJobs.enqueue({
      discSelectionId: unrelatedSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/unrelated-correction-history.mkv",
    });
    const unrelatedClaim = access.encodeJobs.claimNext(
      "unrelated-correction-history",
    );
    if (!unrelatedClaim) {
      throw new Error("Expected unrelated correction-history claim");
    }
    access.encodeJobs.complete(unrelatedClaim);
    const unrelatedCorrection = access.catalog.correctDiscSelection(
      unrelatedSelection.id,
      {
        originalDiscArchiveId: unrelatedArchive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [unrelatedArchive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );

    const sqlite = new DatabaseSync(databasePath);
    const insertReplacement = sqlite.prepare(`
      insert into encode_jobs (
        id,
        predecessor_encode_job_id,
        disc_selection_id,
        encoding_profile_id,
        output_path,
        reserves_output_path,
        status,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, 0, 'completed', ?, ?)
    `);
    const insertRetainedOutput = sqlite.prepare(`
      insert into retained_encode_outputs (
        id,
        predecessor_encode_job_id,
        replacement_encode_job_id,
        retained_output_path,
        filesystem_identity,
        state,
        cleanup_eligible,
        retained_at
      ) values (?, ?, ?, ?, ?, 'retained', 1, ?)
    `);
    const replacementIds: EncodeJobId[] = [];
    const retainedOutputIds: string[] = [];
    sqlite.exec("begin");
    for (let index = 0; index < historySize; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const replacementId = `boundary-replacement-${suffix}` as EncodeJobId;
      const retainedOutputId = `boundary-retained-${suffix}`;
      replacementIds.push(replacementId);
      retainedOutputIds.push(retainedOutputId);
      insertReplacement.run(
        replacementId,
        predecessors[index]!.id,
        corrections[index]!.discSelection.id,
        profile.id,
        `/media/movies/correction-history-replacement-${suffix}.mkv`,
        1_000 + index,
        1_000 + index,
      );
      insertRetainedOutput.run(
        retainedOutputId,
        predecessors[index]!.id,
        replacementId,
        `/media/movies/correction-history-retained-${suffix}.mkv`,
        `correction-history-identity-${suffix}`,
        2_000 + index,
      );
    }
    const repeatedRetainedOutputId = "boundary-retained-repeat";
    retainedOutputIds.push(repeatedRetainedOutputId);
    insertRetainedOutput.run(
      repeatedRetainedOutputId,
      predecessors[0]!.id,
      replacementIds[0]!,
      "/media/movies/correction-history-retained-repeat.mkv",
      "correction-history-identity-repeat",
      5_000,
    );
    const unrelatedReplacementId = "unrelated-boundary-replacement";
    insertReplacement.run(
      unrelatedReplacementId,
      unrelatedPredecessor.id,
      unrelatedCorrection.discSelection.id,
      profile.id,
      "/media/movies/unrelated-correction-history-replacement.mkv",
      9_000,
      9_000,
    );
    insertRetainedOutput.run(
      "unrelated-boundary-retained",
      unrelatedPredecessor.id,
      unrelatedReplacementId,
      "/media/movies/unrelated-correction-history-retained.mkv",
      "unrelated-correction-history-identity",
      9_000,
    );
    sqlite.exec("commit");
    expect(sqlite.prepare("pragma foreign_key_check").all()).toEqual([]);
    sqlite.close();

    const correctionJobPages = [0, 100, 200].map((offset) =>
      access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks({
        originalDiscArchiveId: archive.id,
        limit: 100,
        offset,
      })
    );
    expect(correctionJobPages.map((page) => page.length)).toEqual([100, 100, 1]);
    const traversedPredecessorIds = correctionJobPages.flatMap((page) =>
      page.map(({ predecessorEncodeJob }) => predecessorEncodeJob.id)
    );
    expect(traversedPredecessorIds).toEqual(expectedPredecessorIds);
    const traversedReplacementIds = correctionJobPages.flatMap((page) =>
      page.map(({ replacementEncodeJob }) => {
        if (replacementEncodeJob === null) {
          throw new Error("Expected persisted correction replacement");
        }
        return replacementEncodeJob.id;
      })
    );
    const replacementIdByPredecessorId = new Map(
      predecessors.map((predecessor, index) => [
        predecessor.id,
        replacementIds[index]!,
      ]),
    );
    expect(traversedReplacementIds).toEqual(
      expectedPredecessorIds.map(
        (predecessorId) => replacementIdByPredecessorId.get(predecessorId),
      ),
    );
    expect(new Set(traversedReplacementIds).size).toBe(historySize);
    expect(traversedReplacementIds).not.toContain(unrelatedReplacementId);
    const delayedReplacementTraversal = [
      firstPageBeforeDelayedReplacements,
      correctionJobPages[1]!,
      correctionJobPages[2]!,
    ].flatMap((page) =>
      page.map(({ predecessorEncodeJob }) => predecessorEncodeJob.id)
    );
    expect(delayedReplacementTraversal).toEqual(expectedPredecessorIds);
    expect(new Set(delayedReplacementTraversal).size).toBe(historySize);

    const retainedOutputPages = [0, 100, 200].map((offset) =>
      access.encodeJobs
        .listDiscSelectionCorrectionRetainedOutputSummaries({
          originalDiscArchiveId: archive.id,
          limit: 100,
          offset,
        })
    );
    expect(retainedOutputPages.map((page) => page.length)).toEqual([100, 100, 2]);
    const traversedRetainedOutputIds = retainedOutputPages.flatMap((page) =>
      page.map(({ retainedOutput }) => retainedOutput.id)
    );
    expect(traversedRetainedOutputIds).toEqual(retainedOutputIds);
    expect(new Set(traversedRetainedOutputIds).size).toBe(historySize + 1);
    expect(traversedRetainedOutputIds).not.toContain(
      "unrelated-boundary-retained",
    );
    access.close();
  });

  it("keeps a corrected replacement waiting until its predecessor cancellation is terminal", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-waits-for-cancellation",
    });
    if (!correctedItem) {
      throw new Error("Expected waiting replacement correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-waits-for-cancellation",
      displayName: "Replacement waits for cancellation",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement waits for cancellation.mkv",
    });
    const predecessorClaim = access.encodeJobs.claimNext(
      "replacement-waiting-predecessor",
    );
    if (!predecessorClaim) {
      throw new Error("Expected running replacement predecessor");
    }
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    const completion = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
      }],
    );
    const replacement = completion.replacementEncodeJobs[0]!;

    expect(replacement).toMatchObject({
      predecessorEncodeJobId: predecessor.id,
      discSelectionId: correction.discSelection.id,
      status: "queued",
      replaceExistingOutput: false,
    });
    expect(access.encodeJobs.claimNext("replacement-must-wait")).toBeNull();
    expect(access.encodeJobs.completeCancellation(predecessorClaim))
      .toMatchObject({ id: predecessor.id, status: "cancelled" });
    expect(access.encodeJobs.claimNext("replacement-ready-after-cancel"))
      .toMatchObject({
        id: replacement.id,
        predecessorEncodeJobId: predecessor.id,
        status: "running",
      });
    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
      id: replacement.id,
      predecessorEncodeJobId: predecessor.id,
      status: "running",
    }));
    access.close();
  });

  it("preserves retained-final semantics when predecessor cancellation wins", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-retained-final-cancellation",
    });
    if (!correctedItem) {
      throw new Error("Expected retained-final correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-retained-final-cancellation",
      displayName: "Replacement retained final cancellation",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath:
        "/media/movies/Replacement retained final cancellation.mkv",
    });
    const initialClaim = access.encodeJobs.claimNext("retained-final-initial");
    if (!initialClaim) {
      throw new Error("Expected initial retained-final claim");
    }
    access.encodeJobs.complete(initialClaim);
    access.encodeJobs.requeue(predecessor.id);
    const predecessorClaim = access.encodeJobs.claimNext(
      "retained-final-predecessor",
    );
    if (!predecessorClaim) {
      throw new Error("Expected retained-final predecessor claim");
    }
    expect(predecessorClaim.replaceExistingOutput).toBe(true);
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    const replacement = access.catalog
      .completeCatalogReviewWithReplacements(
        archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
          .updatedAt,
        "reviewed_with_selections",
        [{
          predecessorEncodeJobId: predecessor.id,
          encodingProfileId: profile.id,
          outputPath: predecessor.outputPath,
        }],
      ).replacementEncodeJobs[0]!;

    expect(access.encodeJobs.completeCancellation(predecessorClaim))
      .toMatchObject({
        id: predecessor.id,
        status: "cancelled",
        replaceExistingOutput: true,
      });
    expect(access.encodeJobs.claimNext("retained-final-successor"))
      .toMatchObject({
        id: replacement.id,
        predecessorEncodeJobId: predecessor.id,
        replaceExistingOutput: true,
        status: "running",
      });
    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
        id: replacement.id,
        predecessorEncodeJobId: predecessor.id,
        discSelectionId: correction.discSelection.id,
        replaceExistingOutput: true,
        status: "running",
      }));
    access.close();
  });

  it.each([
    ["before predecessor cancellation finishes", "cancelled", false, true],
    ["after predecessor cancellation finishes", "cancelled", false, false],
    ["after predecessor completion wins", "completed", true, false],
  ] as const)(
    "keeps a cancelled same-path corrected successor reserved %s",
    (
      _label,
      predecessorOutcome,
      terminalizeBeforeCorrection,
      cancelBeforeTerminal,
    ) => {
      const key = `cancel-corrected-successor-${predecessorOutcome}`;
      const {
        access,
        archive,
        correctedItems: [correctedItem],
        mistakenSelection,
      } = createDiscSelectionCorrectionFixture({ key });
      if (!correctedItem) throw new Error("Expected cancellation target");
      const profile = access.encodingProfiles.create({
        key,
        displayName: key,
        mediaDomain: "dvd_video",
        settings: {},
      });
      const competingProfile = access.encodingProfiles.create({
        key: `${key}-competing`,
        displayName: `${key} competing`,
        mediaDomain: "dvd_video",
        settings: {},
      });
      const predecessor = access.encodeJobs.enqueue({
        discSelectionId: mistakenSelection.id,
        encodingProfileId: profile.id,
        outputPath: `/media/movies/${key}.mkv`,
      });
      const claim = access.encodeJobs.claimNext(`${key}-predecessor`);
      if (!claim) throw new Error("Expected predecessor claim");
      if (terminalizeBeforeCorrection) {
        access.encodeJobs.complete(claim);
      }
      const correction = access.catalog.correctDiscSelection(
        mistakenSelection.id,
        {
          originalDiscArchiveId: archive.id,
          catalogRevision: access.catalog.listOriginalDiscArchives({
            ids: [archive.id],
          })[0]!.updatedAt,
          mediaItemId: correctedItem.id,
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      );
      const successor = access.catalog.completeCatalogReviewWithReplacements(
        archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
          .updatedAt,
        "reviewed_with_selections",
        [{
          predecessorEncodeJobId: predecessor.id,
          encodingProfileId: profile.id,
          outputPath: predecessor.outputPath,
        }],
      ).replacementEncodeJobs[0]!;

      if (predecessorOutcome === "cancelled" && !cancelBeforeTerminal) {
        access.encodeJobs.completeCancellation(claim);
      }
      expect(access.encodeJobs.requestCancellation(successor.id)).toMatchObject({
        id: successor.id,
        predecessorEncodeJobId: predecessor.id,
        status: "cancelled",
        reservesOutputPath: true,
      });
      if (predecessorOutcome === "cancelled" && cancelBeforeTerminal) {
        access.encodeJobs.completeCancellation(claim);
      }

      expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: predecessor.id,
          status: predecessorOutcome,
          reservesOutputPath: false,
        }),
        expect.objectContaining({
          id: successor.id,
          status: "cancelled",
          reservesOutputPath: true,
        }),
      ]));
      expect(() => access.encodeJobs.enqueue({
        discSelectionId: correction.discSelection.id,
        encodingProfileId: competingProfile.id,
        outputPath: predecessor.outputPath,
      })).toThrow(
        `Encode Job output is already assigned: ${predecessor.outputPath}`,
      );
      access.close();
    },
  );

  it("keeps a terminal predecessor waiting until fenced cleanup is complete", () => {
    const { access, archive, correctedItems: [correctedItem], mistakenSelection } =
      createDiscSelectionCorrectionFixture({ key: "replacement-cleanup-wait" });
    if (!correctedItem) throw new Error("Expected cleanup correction target");
    const profile = access.encodingProfiles.create({
      key: "replacement-cleanup-wait",
      displayName: "Replacement cleanup wait",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement cleanup wait.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-cleanup-wait");
    if (!claim) throw new Error("Expected cleanup predecessor claim");
    const cleanup = access.encodeJobs.registerPartialCleanup(claim);
    access.encodeJobs.fail(claim, "Failed with cleanup pending");
    access.catalog.correctDiscSelection(mistakenSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });

    expect(access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })[0]).toMatchObject({
      predecessorEncodeJobId: predecessor.id,
      predecessorStatus: "failed",
      predecessorReady: false,
    });
    access.encodeJobs.completePartialCleanup(cleanup);
    expect(access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })[0]).toMatchObject({ predecessorReady: true });
    access.close();
  });

  it("queues exactly one corrected replacement when review completions race across connections", async () => {
    const databasePath = createTestDatabasePath();
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-review-race",
      databasePath,
    });
    if (!correctedItem) throw new Error("Expected correction target");
    const profile = access.encodingProfiles.create({
      key: "replacement-review-race",
      displayName: "Replacement review race",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement review race.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-review-race");
    if (!claim) throw new Error("Expected predecessor claim");
    access.encodeJobs.complete(claim);
    access.catalog.correctDiscSelection(mistakenSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    const operation = {
      operation: "complete-catalog-review-with-replacements" as const,
      originalDiscArchiveId: archive.id,
      catalogRevision,
      replacements: [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
      }],
    };

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [operation, operation],
    });

    expect(results.map((result) =>
      typeof result === "object" && result !== null && "outcome" in result
        ? result.outcome
        : result
    ).sort()).toEqual(["rejected", "reviewed"]);
    expect(access.encodeJobs.list().filter(
      (job) => job.predecessorEncodeJobId === predecessor.id,
    )).toHaveLength(1);
    access.close();
  });

  it("transfers a corrected output reservation without a multi-process competitor gap", async () => {
    const databasePath = createTestDatabasePath();
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-reservation-succession-race",
      databasePath,
    });
    if (!correctedItem) throw new Error("Expected correction target");
    const competingItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Competing reservation owner",
    });
    const competingSelection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: competingItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    completeCatalogReview(access, archive.id);
    const profile = access.encodingProfiles.create({
      key: "replacement-reservation-succession-race",
      displayName: "Replacement reservation succession race",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Reservation succession race.mkv",
    });
    const claim = access.encodeJobs.claimNext("reservation-predecessor");
    if (!claim) throw new Error("Expected predecessor claim");
    access.encodeJobs.complete(claim);
    access.catalog.correctDiscSelection(mistakenSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        {
          operation: "complete-catalog-review-with-replacements",
          originalDiscArchiveId: archive.id,
          catalogRevision,
          replacements: [{
            predecessorEncodeJobId: predecessor.id,
            encodingProfileId: profile.id,
            outputPath: predecessor.outputPath,
          }],
        },
        {
          operation: "enqueue-encode",
          discSelectionId: competingSelection.id,
          encodingProfileId: profile.id,
          outputPath: predecessor.outputPath,
        },
      ],
    });

    expect(results.map((result) =>
      typeof result === "object" && result !== null && "outcome" in result
        ? result.outcome
        : result
    ).sort()).toEqual(["rejected", "reviewed"]);
    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: predecessor.id,
        reservesOutputPath: false,
      }),
      expect.objectContaining({
        predecessorEncodeJobId: predecessor.id,
        outputPath: predecessor.outputPath,
        reservesOutputPath: true,
        status: "queued",
      }),
    ]));
    expect(access.encodeJobs.list().filter(
      (job) => job.discSelectionId === competingSelection.id,
    )).toEqual([]);
    access.close();
  });

  it.each([
    ["without a retained final", false, false],
    ["with a retained final", true, true],
  ] as const)("admits a failed predecessor %s with the correct reservation mode", (
    _label,
    retainedFinal,
    expectedReplaceExistingOutput,
  ) => {
    const key = `replacement-failed-${retainedFinal ? "retained" : "empty"}`;
    const { access, archive, correctedItems: [correctedItem], mistakenSelection } =
      createDiscSelectionCorrectionFixture({ key });
    if (!correctedItem) throw new Error("Expected failed correction target");
    const profile = access.encodingProfiles.create({
      key,
      displayName: key,
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: `/media/movies/${key}.mkv`,
    });
    let claim = access.encodeJobs.claimNext(`${key}-initial`);
    if (!claim) throw new Error("Expected failed predecessor claim");
    if (retainedFinal) {
      access.encodeJobs.complete(claim);
      access.encodeJobs.requeue(predecessor.id);
      claim = access.encodeJobs.claimNext(`${key}-replacement`);
      if (!claim) throw new Error("Expected retained-final retry claim");
    }
    access.encodeJobs.fail(claim, "Predecessor failed", {
      preserveReplacementAuthority: retainedFinal,
    });
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    );
    const successor = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: predecessor.outputPath,
      }],
    ).replacementEncodeJobs[0]!;

    expect(access.encodeJobs.claimNext(`${key}-successor`)).toMatchObject({
      id: successor.id,
      predecessorEncodeJobId: predecessor.id,
      replaceExistingOutput: expectedReplaceExistingOutput,
      status: "running",
    });
    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
      id: successor.id,
      discSelectionId: correction.discSelection.id,
      replaceExistingOutput: expectedReplaceExistingOutput,
      status: "running",
    }));
    access.close();
  });

  it("releases a failed non-retained predecessor reservation after explicit opt-out", () => {
    const { access, archive, correctedItems: [correctedItem], mistakenSelection } =
      createDiscSelectionCorrectionFixture({ key: "replacement-failed-opt-out" });
    if (!correctedItem) throw new Error("Expected opt-out correction target");
    const profile = access.encodingProfiles.create({
      key: "replacement-failed-opt-out",
      displayName: "Replacement failed opt-out",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement failed opt-out.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-failed-opt-out");
    if (!claim) throw new Error("Expected opt-out predecessor claim");
    access.encodeJobs.fail(claim, "No final retained");
    access.catalog.correctDiscSelection(mistakenSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });

    access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [],
    );

    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
      id: predecessor.id,
      status: "failed",
      reservesOutputPath: false,
      replaceExistingOutput: false,
    }));
    access.close();
  });

  it("releases a failed non-retained predecessor when its successor uses another path", () => {
    const { access, archive, correctedItems: [correctedItem], mistakenSelection } =
      createDiscSelectionCorrectionFixture({
        key: "replacement-failed-changed-path",
      });
    if (!correctedItem) throw new Error("Expected changed-path correction target");
    const profile = access.encodingProfiles.create({
      key: "replacement-failed-changed-path",
      displayName: "Replacement failed changed path",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement failed prior path.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-failed-changed-path");
    if (!claim) throw new Error("Expected changed-path predecessor claim");
    access.encodeJobs.fail(claim, "No final retained");
    access.catalog.correctDiscSelection(mistakenSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    const successor = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Replacement failed corrected path.mkv",
      }],
    ).replacementEncodeJobs[0]!;

    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: predecessor.id,
        reservesOutputPath: false,
        replaceExistingOutput: false,
      }),
      expect.objectContaining({
        id: successor.id,
        reservesOutputPath: true,
        replaceExistingOutput: false,
      }),
    ]));
    access.close();
  });

  it("keeps a failed predecessor reservation fenced until cleanup finishes", () => {
    const { access, archive, correctedItems: [correctedItem], mistakenSelection } =
      createDiscSelectionCorrectionFixture({
        key: "replacement-failed-cleanup-reservation",
      });
    if (!correctedItem) throw new Error("Expected cleanup correction target");
    const profile = access.encodingProfiles.create({
      key: "replacement-failed-cleanup-reservation",
      displayName: "Replacement failed cleanup reservation",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement failed cleanup.mkv",
    });
    const claim = access.encodeJobs.claimNext(
      "replacement-failed-cleanup-reservation",
    );
    if (!claim) throw new Error("Expected cleanup predecessor claim");
    const cleanup = access.encodeJobs.registerPartialCleanup(claim);
    access.encodeJobs.fail(claim, "Cleanup remains fenced");
    access.catalog.correctDiscSelection(mistakenSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt,
      mediaItemId: correctedItem.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [],
    );

    expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
      id: predecessor.id,
      reservesOutputPath: true,
      partialCleanupOutputPath: predecessor.outputPath,
    }));
    expect(access.encodeJobs.completePartialCleanup(cleanup)).toMatchObject({
      id: predecessor.id,
      status: "failed",
      reservesOutputPath: false,
      partialCleanupOutputPath: null,
    });
    access.close();
  });

  it("carries an unqueued predecessor plan through repeated correction lineage", () => {
    const {
      access,
      archive,
      correctedItems: [firstCorrectedItem, finalCorrectedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-plan-lineage",
      correctedItemCount: 2,
    });
    if (!firstCorrectedItem || !finalCorrectedItem) {
      throw new Error("Expected repeated correction targets");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-plan-lineage",
      displayName: "Replacement plan lineage",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement plan lineage.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-lineage-initial");
    if (!claim) {
      throw new Error("Expected replacement lineage predecessor claim");
    }
    access.encodeJobs.complete(claim);
    const firstCorrection = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: firstCorrectedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [],
    );
    const finalCorrection = access.catalog.correctDiscSelection(
      firstCorrection.discSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: finalCorrectedItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    );

    expect(access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([{
      predecessorEncodeJobId: predecessor.id,
      replacementDiscSelectionId: finalCorrection.discSelection.id,
      proposedEncodingProfileId: profile.id,
      proposedOutputPath: predecessor.outputPath,
      predecessorStatus: "completed",
      predecessorReady: true,
    }]);
    const replacement = access.catalog
      .completeCatalogReviewWithReplacements(
        archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
          .updatedAt,
        "reviewed_with_selections",
        [{
          predecessorEncodeJobId: predecessor.id,
          encodingProfileId: profile.id,
          outputPath: predecessor.outputPath,
        }],
      ).replacementEncodeJobs[0]!;
    expect(replacement).toMatchObject({
      predecessorEncodeJobId: predecessor.id,
      discSelectionId: finalCorrection.discSelection.id,
    });
    access.close();
  });

  it("queues distinct same-profile replacements for every predecessor in repeated correction lineage", () => {
    const {
      access,
      archive,
      correctedItems: [firstCorrectedItem, finalCorrectedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-plan-multiple-lineage-jobs",
      correctedItemCount: 2,
    });
    if (!firstCorrectedItem || !finalCorrectedItem) {
      throw new Error("Expected repeated correction targets");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-plan-multiple-lineage-jobs",
      displayName: "Replacement plan multiple lineage jobs",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const firstPredecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement lineage first.mkv",
    });
    const firstClaim = access.encodeJobs.claimNext(
      "replacement-multiple-lineage-first",
    );
    if (!firstClaim) throw new Error("Expected first lineage claim");
    access.encodeJobs.complete(firstClaim);
    const firstCorrection = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: firstCorrectedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [],
    );

    const secondPredecessor = access.encodeJobs.enqueue({
      discSelectionId: firstCorrection.discSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement lineage second.mkv",
    });
    const secondClaim = access.encodeJobs.claimNext(
      "replacement-multiple-lineage-second",
    );
    if (!secondClaim) throw new Error("Expected second lineage claim");
    access.encodeJobs.complete(secondClaim);
    const finalCorrection = access.catalog.correctDiscSelection(
      firstCorrection.discSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: finalCorrectedItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    );
    const plans = access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    });
    expect(plans.map((plan) => plan.predecessorEncodeJobId)).toEqual([
      firstPredecessor.id,
      secondPredecessor.id,
    ]);

    const replacements = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      plans.map((plan) => ({
        predecessorEncodeJobId: plan.predecessorEncodeJobId,
        encodingProfileId: plan.proposedEncodingProfileId,
        outputPath: plan.proposedOutputPath,
      })),
    ).replacementEncodeJobs;

    expect(replacements).toHaveLength(2);
    expect(replacements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predecessorEncodeJobId: firstPredecessor.id,
        discSelectionId: finalCorrection.discSelection.id,
        encodingProfileId: profile.id,
      }),
      expect.objectContaining({
        predecessorEncodeJobId: secondPredecessor.id,
        discSelectionId: finalCorrection.discSelection.id,
        encodingProfileId: profile.id,
      }),
    ]));

    const ordinary = access.encodeJobs.enqueue({
      discSelectionId: finalCorrection.discSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement lineage ordinary.mkv",
    });
    expect(ordinary).toMatchObject({
      predecessorEncodeJobId: null,
      discSelectionId: finalCorrection.discSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement lineage ordinary.mkv",
    });
    expect(replacements.map(({ id }) => id)).not.toContain(ordinary.id);
    access.close();
  });

  it("bounds corrected replacement plan pages at the public facade", () => {
    const { access, archive } = createDiscSelectionCorrectionFixture({
      key: "replacement-plan-limit",
    });
    expect(() => access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 102,
    })).toThrow("Corrected Encode replacement plan limit cannot exceed 101");
    access.close();
  });

  it("accepts explicit corrected profile and output overrides without moving prior output", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-plan-overrides",
    });
    if (!correctedItem) {
      throw new Error("Expected replacement override correction target");
    }
    const priorProfile = access.encodingProfiles.create({
      key: "replacement-plan-prior-profile",
      displayName: "Replacement plan prior profile",
      mediaDomain: "dvd_video",
      settings: { preset: "Fast" },
    });
    const overrideProfile = access.encodingProfiles.create({
      key: "replacement-plan-override-profile",
      displayName: "Replacement plan override profile",
      mediaDomain: "dvd_video",
      settings: { preset: "HQ" },
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: priorProfile.id,
      outputPath: "/media/movies/Replacement plan prior output.mkv",
    });
    const claim = access.encodeJobs.claimNext("replacement-override-initial");
    if (!claim) {
      throw new Error("Expected replacement override predecessor claim");
    }
    access.encodeJobs.complete(claim);
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    expect(access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archive.id,
      limit: 100,
    })).toEqual([expect.objectContaining({
      proposedEncodingProfileId: priorProfile.id,
      proposedOutputPath: predecessor.outputPath,
    })]);
    const overriddenPath =
      "/media/movies/Replacement plan corrected destination.mkv";
    const replacement = access.catalog
      .completeCatalogReviewWithReplacements(
        archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
          .updatedAt,
        "reviewed_with_selections",
        [{
          predecessorEncodeJobId: predecessor.id,
          encodingProfileId: overrideProfile.id,
          outputPath: overriddenPath,
        }],
      ).replacementEncodeJobs[0]!;

    expect(replacement).toMatchObject({
      predecessorEncodeJobId: predecessor.id,
      discSelectionId: correction.discSelection.id,
      encodingProfileId: overrideProfile.id,
      outputPath: overriddenPath,
      replaceExistingOutput: false,
    });
    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: predecessor.id,
        outputPath: predecessor.outputPath,
        status: "completed",
      }),
      expect.objectContaining({
        id: replacement.id,
        outputPath: overriddenPath,
        status: "queued",
      }),
    ]));
    access.close();
  });

  it("rechecks predecessor eligibility after a concurrent database writer commits", async () => {
    const databasePath = createTestDatabasePath();
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "replacement-claim-predecessor-race",
      databasePath,
    });
    if (!correctedItem) {
      throw new Error("Expected predecessor-race correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "replacement-claim-predecessor-race",
      displayName: "Replacement claim predecessor race",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const predecessor = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Replacement claim predecessor.mkv",
    });
    const predecessorClaim = access.encodeJobs.claimNext(
      "replacement-claim-predecessor-race",
    );
    if (!predecessorClaim) {
      throw new Error("Expected predecessor-race claim");
    }
    access.encodeJobs.complete(predecessorClaim);
    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision: access.catalog.listOriginalDiscArchives({
          ids: [archive.id],
        })[0]!.updatedAt,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );
    const successor = access.catalog.completeCatalogReviewWithReplacements(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
        .updatedAt,
      "reviewed_with_selections",
      [{
        predecessorEncodeJobId: predecessor.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Replacement claim successor.mkv",
      }],
    ).replacementEncodeJobs[0]!;
    expect(successor).toMatchObject({
      discSelectionId: correction.discSelection.id,
      predecessorEncodeJobId: predecessor.id,
      status: "queued",
    });

    const concurrentWriter = new DatabaseSync(databasePath);
    concurrentWriter.exec("PRAGMA busy_timeout = 5000");
    concurrentWriter.exec("BEGIN IMMEDIATE");
    concurrentWriter.prepare(`
      UPDATE encode_jobs
      SET status = 'queued', progress_percent = 0,
          claimed_by = NULL, claim_token = NULL, claimed_at = NULL,
          started_at = NULL, completed_at = NULL, error_message = NULL,
          updated_at = updated_at + 1
      WHERE id = ?
    `).run(predecessor.id);

    const results = await runBarrierWorkers(
      {
        databasePath,
        mode: "operation",
        operations: [{ operation: "claim-encode" }],
      },
      {
        async afterOperationsStart() {
          await new Promise((resolve) => setTimeout(resolve, 100));
          concurrentWriter.exec("COMMIT");
        },
      },
    );

    expect(results).toEqual([{ outcome: "rejected" }]);
    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: predecessor.id, status: "queued" }),
      expect.objectContaining({ id: successor.id, status: "queued" }),
    ]));
    concurrentWriter.close();
    access.close();
  }, 20_000);

  it("requests general cancellation for queued and running jobs during correction", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "active-selection-correction",
    });
    if (!correctedItem) {
      throw new Error("Expected active correction target");
    }
    const runningProfile = access.encodingProfiles.create({
      key: "active-correction-running",
      displayName: "Active correction running",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const queuedProfile = access.encodingProfiles.create({
      key: "active-correction-queued",
      displayName: "Active correction queued",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const runningJob = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: runningProfile.id,
      outputPath: "/media/movies/Active Mistake running.mkv",
    });
    const runningClaim = access.encodeJobs.claimNext(
      "active-correction-worker",
    );
    if (!runningClaim) {
      throw new Error("Expected active correction Encode Job claim");
    }
    const queuedJob = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: queuedProfile.id,
      outputPath: "/media/movies/Active Mistake queued.mkv",
    });
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;

    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    );

    expect(correction.discSelection.id).not.toBe(mistakenSelection.id);
    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: runningJob.id,
        discSelectionId: mistakenSelection.id,
        status: "cancellation_requested",
      }),
      expect.objectContaining({
        id: queuedJob.id,
        discSelectionId: mistakenSelection.id,
        status: "cancelled",
      }),
    ]));
    expect(access.encodeJobs.completeCancellation(runningClaim)).toMatchObject({
      id: runningJob.id,
      discSelectionId: mistakenSelection.id,
      status: "cancelled",
    });
    access.close();
  });

  it("preserves failed and cancelled outcomes when their selection is corrected", () => {
    const {
      access,
      archive,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "terminal-selection-correction",
    });
    if (!correctedItem) {
      throw new Error("Expected terminal correction target");
    }
    const failedProfile = access.encodingProfiles.create({
      key: "terminal-correction-failed",
      displayName: "Terminal correction failed",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const cancelledProfile = access.encodingProfiles.create({
      key: "terminal-correction-cancelled",
      displayName: "Terminal correction cancelled",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const failedJob = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: failedProfile.id,
      outputPath: "/media/movies/Terminal Mistake failed.mkv",
    });
    const failedClaim = access.encodeJobs.claimNext(
      "terminal-correction-worker",
    );
    if (!failedClaim) {
      throw new Error("Expected terminal correction Encode Job claim");
    }
    access.encodeJobs.fail(failedClaim, "Wrong source failed to encode");
    const cancelledJob = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: cancelledProfile.id,
      outputPath: "/media/movies/Terminal Mistake cancelled.mkv",
    });
    access.encodeJobs.requestCancellation(cancelledJob.id);
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;

    const correction = access.catalog.correctDiscSelection(
      mistakenSelection.id,
      {
        originalDiscArchiveId: archive.id,
        catalogRevision,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "main_feature" },
      },
    );

    expect(correction.supersession.reason).toBeNull();
    expect(access.encodeJobs.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: failedJob.id,
        discSelectionId: mistakenSelection.id,
        encodingProfileId: failedProfile.id,
        outputPath: failedJob.outputPath,
        status: "failed",
        errorMessage: "Wrong source failed to encode",
      }),
      expect.objectContaining({
        id: cancelledJob.id,
        discSelectionId: mistakenSelection.id,
        encodingProfileId: cancelledProfile.id,
        outputPath: cancelledJob.outputPath,
        status: "cancelled",
      }),
    ]));
    access.close();
  });

  it("commits one complete supersession when corrections race across connections", async () => {
    const databasePath = createTestDatabasePath();
    const {
      access,
      archive,
      mistakenItem,
      correctedItems: [firstCorrectedItem, secondCorrectedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "concurrent-selection-correction",
      databasePath,
      correctedItemCount: 2,
    });
    if (!firstCorrectedItem || !secondCorrectedItem) {
      throw new Error("Expected concurrent correction targets");
    }
    const profile = access.encodingProfiles.create({
      key: "concurrent-selection-correction",
      displayName: "Concurrent selection correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const queuedJob = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Concurrent Mistake.mkv",
    });
    const catalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [firstCorrectedItem, secondCorrectedItem].map(
        (item, index) => ({
          operation: "correct-disc-selection" as const,
          discSelectionId: mistakenSelection.id,
          originalDiscArchiveId: archive.id,
          catalogRevision,
          mediaItemId: item.id,
          reason: `Concurrent correction ${index + 1}`,
        }),
      ),
    });

    const winner = results.find((result) =>
      typeof result === "object" &&
      result !== null &&
      result.outcome === "corrected"
    );
    const winnerId = typeof winner === "object" && winner !== null
      ? winner.id
      : undefined;
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "corrected" }),
      { outcome: "rejected" },
    ]));
    expect(winnerId).toEqual(expect.any(String));
    const activeSelections = access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    });
    expect(activeSelections).toEqual([
      expect.objectContaining({ id: winnerId }),
    ]);
    expect(access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [mistakenSelection.id],
    })).toEqual([
      expect.objectContaining({
        supersededDiscSelectionId: mistakenSelection.id,
        replacementDiscSelectionId: activeSelections[0]!.id,
        reason: expect.stringMatching(/^Concurrent correction [12]$/),
      }),
    ]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: queuedJob.id,
        discSelectionId: mistakenSelection.id,
        status: "cancelled",
      }),
    ]);
    expect(() =>
      access.catalog.correctDiscSelection(mistakenSelection.id, {
        originalDiscArchiveId: archive.id,
        catalogRevision,
        mediaItemId: mistakenItem.id,
        sourceIdentity: { kind: "main_feature" },
      })
    ).toThrow(/already been superseded or deactivated/);
    access.close();
  });

  it("preserves every job history while corrections contend across connections", async () => {
    const databasePath = createTestDatabasePath();
    const completedFixture = createDiscSelectionCorrectionFixture({
      key: "matrix-completed-correction",
      databasePath,
      contentIdFill: "1",
    });
    const completedProfile = completedFixture.access.encodingProfiles.create({
      key: "matrix-completed-correction",
      displayName: "Matrix completed correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const completedJob = completedFixture.access.encodeJobs.enqueue({
      discSelectionId: completedFixture.mistakenSelection.id,
      encodingProfileId: completedProfile.id,
      outputPath: "/media/movies/Matrix completed correction.mkv",
    });
    const completedClaim = completedFixture.access.encodeJobs.claimNext(
      "matrix-completed-worker",
    );
    if (!completedClaim) {
      throw new Error("Expected completed matrix claim");
    }
    completedFixture.access.encodeJobs.complete(completedClaim);

    const failedFixture = createDiscSelectionCorrectionFixture({
      key: "matrix-failed-correction",
      databasePath,
      contentIdFill: "2",
    });
    const failedProfile = failedFixture.access.encodingProfiles.create({
      key: "matrix-failed-correction",
      displayName: "Matrix failed correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const failedJob = failedFixture.access.encodeJobs.enqueue({
      discSelectionId: failedFixture.mistakenSelection.id,
      encodingProfileId: failedProfile.id,
      outputPath: "/media/movies/Matrix failed correction.mkv",
    });
    const failedClaim = failedFixture.access.encodeJobs.claimNext(
      "matrix-failed-worker",
    );
    if (!failedClaim) {
      throw new Error("Expected failed matrix claim");
    }
    failedFixture.access.encodeJobs.fail(failedClaim, "Matrix failure");

    const cancelledFixture = createDiscSelectionCorrectionFixture({
      key: "matrix-cancelled-correction",
      databasePath,
      contentIdFill: "3",
    });
    const cancelledProfile =
      cancelledFixture.access.encodingProfiles.create({
        key: "matrix-cancelled-correction",
        displayName: "Matrix cancelled correction",
        mediaDomain: "dvd_video",
        settings: {},
      });
    const cancelledJob = cancelledFixture.access.encodeJobs.enqueue({
      discSelectionId: cancelledFixture.mistakenSelection.id,
      encodingProfileId: cancelledProfile.id,
      outputPath: "/media/movies/Matrix cancelled correction.mkv",
    });
    cancelledFixture.access.encodeJobs.requestCancellation(cancelledJob.id);

    const runningFixture = createDiscSelectionCorrectionFixture({
      key: "matrix-running-correction",
      databasePath,
      contentIdFill: "4",
    });
    const runningProfile = runningFixture.access.encodingProfiles.create({
      key: "matrix-running-correction",
      displayName: "Matrix running correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const runningJob = runningFixture.access.encodeJobs.enqueue({
      discSelectionId: runningFixture.mistakenSelection.id,
      encodingProfileId: runningProfile.id,
      outputPath: "/media/movies/Matrix running correction.mkv",
    });
    const runningClaim = runningFixture.access.encodeJobs.claimNext(
      "matrix-running-worker",
    );
    if (!runningClaim) {
      throw new Error("Expected running matrix claim");
    }

    const legacyFixture = createDiscSelectionCorrectionFixture({
      key: "matrix-legacy-correction",
      databasePath,
      contentIdFill: "5",
    });
    const legacyProfile = legacyFixture.access.encodingProfiles.create({
      key: "matrix-legacy-correction",
      displayName: "Matrix legacy correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const legacyJob = legacyFixture.access.encodeJobs.enqueue({
      discSelectionId: legacyFixture.mistakenSelection.id,
      encodingProfileId: legacyProfile.id,
      outputPath: "/media/movies/Matrix legacy correction.mkv",
    });
    const legacyClaim = legacyFixture.access.encodeJobs.claimNext(
      "matrix-legacy-worker",
    );
    if (!legacyClaim) {
      throw new Error("Expected legacy matrix claim");
    }
    legacyFixture.access.encodeJobs.complete(legacyClaim);
    const legacySqlite = new DatabaseSync(databasePath);
    legacySqlite.prepare(`
      update disc_selections set source_key = 'caller:matrix-legacy'
      where id = ?
    `).run(legacyFixture.mistakenSelection.id);
    legacySqlite.close();

    const queuedFixture = createDiscSelectionCorrectionFixture({
      key: "matrix-queued-correction",
      databasePath,
      contentIdFill: "6",
    });
    const queuedProfile = queuedFixture.access.encodingProfiles.create({
      key: "matrix-queued-correction",
      displayName: "Matrix queued correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const queuedJob = queuedFixture.access.encodeJobs.enqueue({
      discSelectionId: queuedFixture.mistakenSelection.id,
      encodingProfileId: queuedProfile.id,
      outputPath: "/media/movies/Matrix queued correction.mkv",
    });

    const fixtures = [
      completedFixture,
      failedFixture,
      cancelledFixture,
      queuedFixture,
      runningFixture,
      legacyFixture,
    ] as const;
    const revisions = fixtures.map((fixture) =>
      fixture.access.catalog.listOriginalDiscArchives({
        ids: [fixture.archive.id],
      })[0]!.updatedAt
    );
    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: fixtures.map((fixture, index) => ({
        operation: "correct-disc-selection" as const,
        discSelectionId: fixture.mistakenSelection.id,
        originalDiscArchiveId: fixture.archive.id,
        catalogRevision: revisions[index]!,
        mediaItemId: fixture.correctedItems[0]!.id,
        reason: `Matrix correction ${index + 1}`,
      })),
    });

    expect(results.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({ outcome: "corrected" })
      ),
    );
    expect(results[5]).toEqual({ outcome: "rejected" });
    for (const fixture of fixtures.slice(0, 5)) {
      expect(fixture.access.catalog.listDiscSelectionSupersessions({
        discSelectionIds: [fixture.mistakenSelection.id],
      })).toEqual([
        expect.objectContaining({
          supersededDiscSelectionId: fixture.mistakenSelection.id,
        }),
      ]);
    }
    expect(legacyFixture.access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [legacyFixture.mistakenSelection.id],
    })).toEqual([]);
    expect(completedFixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: completedJob.id, status: "completed" }),
        expect.objectContaining({ id: failedJob.id, status: "failed" }),
        expect.objectContaining({ id: cancelledJob.id, status: "cancelled" }),
        expect.objectContaining({ id: queuedJob.id, status: "cancelled" }),
        expect.objectContaining({
          id: runningJob.id,
          status: "cancellation_requested",
        }),
        expect.objectContaining({ id: legacyJob.id, status: "completed" }),
      ]),
    );
    expect(legacyFixture.access.catalog.listDiscSelections({
      originalDiscArchiveId: legacyFixture.archive.id,
    })).toEqual([
      expect.objectContaining({ id: legacyFixture.mistakenSelection.id }),
    ]);
    for (const fixture of fixtures) {
      fixture.access.close();
    }
  });

  it("rejects a stale correction without partially superseding or cancelling", () => {
    const {
      access,
      archive,
      mistakenItem,
      correctedItems: [correctedItem],
      mistakenSelection,
    } = createDiscSelectionCorrectionFixture({
      key: "stale-selection-correction",
    });
    if (!correctedItem) {
      throw new Error("Expected stale correction target");
    }
    const profile = access.encodingProfiles.create({
      key: "stale-selection-correction",
      displayName: "Stale selection correction",
      mediaDomain: "dvd_video",
      settings: {},
    });
    const queuedJob = access.encodeJobs.enqueue({
      discSelectionId: mistakenSelection.id,
      encodingProfileId: profile.id,
      outputPath: "/media/movies/Stale Correction Mistake.mkv",
    });
    const reviewedArchive = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!;
    const staleRevision = new Date(reviewedArchive.updatedAt.getTime() - 1);

    expect(() =>
      access.catalog.correctDiscSelection(mistakenSelection.id, {
        originalDiscArchiveId: archive.id,
        catalogRevision: staleRevision,
        mediaItemId: correctedItem.id,
        sourceIdentity: { kind: "main_feature" },
        reason: "This write lost the catalog revision race.",
      })
    ).toThrow(
      "Catalog review changed; reload before saving Disc Selection correction",
    );
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })).toEqual([expect.objectContaining({
      id: mistakenSelection.id,
      mediaItemId: mistakenItem.id,
    })]);
    expect(access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [mistakenSelection.id],
    })).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([expect.objectContaining({
      id: queuedJob.id,
      discSelectionId: mistakenSelection.id,
      status: "queued",
    })]);
    expect(access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]).toEqual(reviewedArchive);
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
    const legacyCatalogRevision = access.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]!.updatedAt;
    expect(() =>
      access.catalog.correctDiscSelection(selection.id, {
        originalDiscArchiveId: archive.id,
        catalogRevision: legacyCatalogRevision,
        mediaItemId: movie.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        reason: "This is legacy repair, not an ordinary correction.",
      })
    ).toThrow("needs unsafe legacy repair, not ordinary correction");
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
    expect(access.catalog.listDiscSelectionSupersessions({
      discSelectionIds: [selection.id, repaired.id],
    })).toEqual([]);
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
      { name: "bad_sector_counts_by_title" },
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
        .prepare("select name from pragma_table_info('encode_jobs')")
        .all(),
    ).not.toContainEqual({ name: "corrected_publication_admitted" });
    expect(
      sqlite
        .prepare("select name from pragma_table_info('retained_encode_outputs')")
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "predecessor_encode_job_id" },
      { name: "replacement_encode_job_id" },
      { name: "retained_output_path" },
      { name: "filesystem_identity" },
      { name: "cleanup_eligible" },
      { name: "retained_at" },
    ]));
    expect(
      sqlite
        .prepare(
          "select name from pragma_table_info('corrected_encode_publication_authorities')",
        )
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "replacement_encode_job_id" },
      { name: "claim_token" },
      { name: "retained_output_path" },
      { name: "filesystem_identity" },
    ]));
    expect(
      sqlite
        .prepare("select name from pragma_table_info('archive_jobs')")
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "archive_request_id" },
      { name: "disc_inspection_id" },
      { name: "attempt_ordinal" },
      { name: "claim_token" },
      { name: "progress_phase" },
      { name: "failure_detail_version" },
      { name: "read_failure_category" },
      { name: "read_failure_classifier_version" },
      { name: "read_failure_lba" },
    ]));
    expect(
      sqlite
        .prepare(
          "select name from __drizzle_migrations order by id desc limit 10",
        )
        .all(),
    ).toEqual([
      {
        name: "20260828160945_fancy_chimera",
      },
      {
        name: "20260828154312_luxuriant_human_robot",
      },
      {
        name: "20260825052933_slippery_famine",
      },
      {
        name: "20260823160205_flat_fixer",
      },
      {
        name: "20260823142401_conscious_alice",
      },
      {
        name: "20260822201215_thick_madame_web",
      },
      {
        name: "20260822193801_safe_proteus",
      },
      {
        name: "20260822185006_burly_northstar",
      },
      {
        name: "20260822183552_bounded-disc-settling",
      },
      {
        name: "20260822175220_striped_kabuki",
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

  it("migrates active-source uniqueness without rewriting selection or job provenance", () => {
    const databasePath = createTestDatabasePath();
    const sqlite = new DatabaseSync(databasePath);
    const migrationsRoot = new URL("../drizzle/", import.meta.url);
    const overlapMigration =
      "20260814152555_allow-intentional-exact-overlaps";
    const predecessorNames = readdirSync(migrationsRoot)
      .filter((name) => /^\d/.test(name) && name < overlapMigration)
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
      recordMigration.run(`pre-overlap-${migrationName}`, migrationName);
    }
    const contentId = `sha256:${"7".repeat(64)}`;
    const scanData = JSON.stringify({
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 8,
        audioStreams: [],
        subtitles: [],
      }],
    });
    sqlite.prepare(`
      insert into optical_drives (
        id, device_path, is_present, last_seen_at, created_at, updated_at
      ) values ('pre-overlap-drive', '/dev/pre-overlap', 1, 1, 1, 1)
    `).run();
    sqlite.prepare(`
      insert into detected_discs (
        id, optical_drive_id, disc_kind, fingerprint, status, scan_data,
        detected_at, created_at, updated_at
      ) values (
        'pre-overlap-disc', 'pre-overlap-drive', 'dvd', ?, 'archived', ?,
        1, 1, 1
      )
    `).run(contentId, scanData);
    sqlite.prepare(`
      insert into original_disc_archives (
        id, detected_disc_id, disc_kind, archive_format, archive_path,
        fingerprint, archived_at, catalog_reviewed_at,
        catalog_review_outcome, created_at, updated_at
      ) values (
        'pre-overlap-archive', 'pre-overlap-disc', 'dvd', 'iso',
        '/media/originals/Pre-overlap.iso', ?, 1, 2,
        'reviewed_with_selections', 1, 2
      )
    `).run(contentId);
    sqlite.exec(`
      insert into media_items (
        id, kind, title, created_at, updated_at
      ) values
        ('pre-overlap-original-item', 'movie', 'Original identity', 1, 1),
        ('pre-overlap-new-item', 'movie', 'Intentional overlap', 1, 1);
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        title_number, created_at, updated_at
      ) values (
        'pre-overlap-selection', 'pre-overlap-archive',
        'pre-overlap-original-item', 'dvd:title:1', 'dvd_title', 1, 1, 1
      );
      insert into encoding_profiles (
        id, key, display_name, media_domain, version, is_active, settings,
        created_at, updated_at
      ) values (
        'pre-overlap-profile', 'pre-overlap-profile', 'Pre-overlap profile',
        'dvd_video', 1, 1, '{}', 1, 1
      );
      insert into encode_jobs (
        id, disc_selection_id, encoding_profile_id, output_path, status,
        progress_percent, completed_at, created_at, updated_at
      ) values (
        'pre-overlap-job', 'pre-overlap-selection', 'pre-overlap-profile',
        '/media/movies/Pre-overlap.mkv', 'completed', 100, 2, 1, 2
      );
    `);
    expect(
      sqlite.prepare(`
        select name from pragma_index_list('disc_selections')
        where name = 'disc_selections_archive_active_source_unique'
      `).get(),
    ).toEqual({ name: "disc_selections_archive_active_source_unique" });
    sqlite.close();

    const migrated = openTestDatabase(databasePath);
    const overlap = migrated.catalog.createDiscSelection({
      originalDiscArchiveId:
        "pre-overlap-archive" as OriginalDiscArchiveId,
      mediaItemId: "pre-overlap-new-item" as MediaItemId,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(overlap.id).not.toBe("pre-overlap-selection");
    expect(migrated.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: "pre-overlap-job",
        discSelectionId: "pre-overlap-selection",
        status: "completed",
      }),
    ]);
    const migratedArchive = migrated.catalog.listOriginalDiscArchives({
      ids: ["pre-overlap-archive" as OriginalDiscArchiveId],
    })[0]!;
    expect(migrated.catalog.completeCatalogReview(
      migratedArchive.id,
      migratedArchive.updatedAt,
      "reviewed_with_selections",
    )).toMatchObject({ catalogReviewOutcome: "reviewed_with_selections" });
    migrated.close();

    const verified = new DatabaseSync(databasePath);
    expect(
      verified.prepare(`
        select name from pragma_index_list('disc_selections')
        where name = 'disc_selections_archive_active_source_unique'
      `).get(),
    ).toBeUndefined();
    expect(
      verified.prepare(`
        select name, "unique" as is_unique
        from pragma_index_list('disc_selections')
        where name = 'disc_selections_archive_active_source_idx'
      `).get(),
    ).toEqual({
      name: "disc_selections_archive_active_source_idx",
      is_unique: 0,
    });
    expect(verified.prepare("pragma foreign_key_check").all()).toEqual([]);
    verified.close();
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
    ).toThrow(/canonical Disc Selection source keys/);
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

  it("recognizes a legacy raw-hash archive by its metadata fingerprint without another read", () => {
    const access = openTestDatabase();
    const firstDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isPresent: true,
    });
    const rawFingerprint = `sha256:${"a".repeat(64)}`;
    const volumeLabel = "LEGACY_ARCHIVE";
    const sizeBytes = 4_700_000_000;
    const titles = [{
      number: 1,
      durationSeconds: 5_400,
      chapters: 18,
      audioStreams: [{
        id: 1,
        languageCode: "en",
        language: "English",
        format: "ac3",
        channels: 6,
      }],
      subtitles: [{
        id: 1,
        languageCode: "en",
        language: "English",
        content: "Normal",
      }],
    }];
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: firstDrive.id,
      discKind: "dvd",
      fingerprint: rawFingerprint,
      volumeLabel,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId: rawFingerprint,
        titles,
      },
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: firstDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Legacy Archive.iso",
      fingerprint: rawFingerprint,
      sizeBytes,
    });
    const metadataFingerprint = createDvdMetadataFingerprint({
      sizeBytes,
      titles,
      volumeLabel,
    });

    const rediscovered = access.catalog.registerDetectedDisc({
      opticalDriveId: secondDrive.id,
      discKind: "dvd",
      fingerprint: metadataFingerprint,
      volumeLabel,
      scanData: {
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId: metadataFingerprint,
        titles,
      },
    });

    expect(rediscovered).toMatchObject({
      opticalDriveId: secondDrive.id,
      fingerprint: metadataFingerprint,
      status: "archived",
    });
    expect(() =>
      access.archiveRequests.create({ detectedDiscId: rediscovered.id }),
    ).toThrow(DomainInvariantError);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, fingerprint: rawFingerprint }),
    ]);
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

  it("claims settling and only lets the owner advance readiness evidence", () => {
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
      mediaCapacityBytes: 2_048,
    });
    expect(first.claim).not.toBeNull();
    expect(first.inspection).toMatchObject({
      attemptCount: 1,
      isCurrent: true,
      phase: "settling",
      mediaGeneration: "101",
      mediaCapacityBytes: 2_048,
      stableObservationCount: 1,
      settlingQuietWindowStartedAt: new Date("2026-08-11T00:00:00.000Z"),
      settlingStartedAt: new Date("2026-08-11T00:00:00.000Z"),
      settlingResetCount: 0,
      status: "running",
    });
    expect(
      access.discInspections.beginOrResume({
        opticalDriveId: drive.id,
        mediaGeneration: "101",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: {
        id: first.inspection.id,
        phase: "settling",
        stableObservationCount: 1,
      },
      claim: null,
    });
    expect(() =>
      access.discInspections.record(first.claim!, {
        type: "metadata",
        volumeLabel: "TOO_EARLY",
        titleCount: 1,
        chapterCount: 1,
        audioStreamCount: 0,
        subtitleStreamCount: 0,
        totalBytes: 2_048,
      }),
    ).toThrow(DomainInvariantError);
    expect(access.discInspections.list({ ids: [first.inspection.id] })).toEqual([
      expect.objectContaining({
        phase: "settling",
        stableObservationCount: 1,
        volumeLabel: null,
      }),
    ]);

    vi.advanceTimersByTime(2_500);
    expect(
      access.discInspections.recordSettlingObservation(first.claim!, {
        mediaGeneration: "101",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: {
        id: first.inspection.id,
        phase: "settling",
        stableObservationCount: 2,
      },
      claim: { id: first.inspection.id },
    });

    vi.advanceTimersByTime(2_500);
    const settled = access.discInspections.recordSettlingObservation(
      first.claim!,
      {
        mediaGeneration: "101",
        mediaCapacityBytes: 2_048,
      },
    );
    expect(settled).toMatchObject({
      inspection: {
        id: first.inspection.id,
        phase: "reading_metadata",
        stableObservationCount: 3,
      },
      claim: { id: first.inspection.id },
    });
    access.close();
  });

  it("requires three fresh matching valid observations after invalid evidence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:10:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const started = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "unready-101",
      mediaCapacityBytes: null,
    });
    expect(started).toMatchObject({
      inspection: {
        phase: "settling",
        mediaCapacityBytes: null,
        stableObservationCount: 0,
        settlingQuietWindowStartedAt: null,
        settlingStartedAt: new Date("2026-08-11T00:10:00.000Z"),
      },
      claim: { id: started.inspection.id },
    });

    vi.advanceTimersByTime(2_500);
    expect(
      access.discInspections.recordSettlingObservation(started.claim!, {
        mediaGeneration: "unready-101",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: {
        phase: "settling",
        stableObservationCount: 1,
      },
    });
    vi.advanceTimersByTime(2_500);
    expect(
      access.discInspections.recordSettlingObservation(started.claim!, {
        mediaGeneration: "unready-101",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: {
        phase: "settling",
        stableObservationCount: 2,
      },
    });

    vi.advanceTimersByTime(1_000);
    expect(
      access.discInspections.recordSettlingObservation(started.claim!, {
        mediaGeneration: "unready-101",
        mediaCapacityBytes: null,
      }),
    ).toMatchObject({
      inspection: {
        phase: "settling",
        mediaCapacityBytes: null,
        stableObservationCount: 0,
        settlingQuietWindowStartedAt: null,
        settlingResetCount: 1,
      },
    });

    vi.advanceTimersByTime(2_500);
    access.discInspections.recordSettlingObservation(started.claim!, {
      mediaGeneration: "unready-101",
      mediaCapacityBytes: 2_048,
    });
    vi.advanceTimersByTime(2_500);
    access.discInspections.recordSettlingObservation(started.claim!, {
      mediaGeneration: "unready-101",
      mediaCapacityBytes: 2_048,
    });
    vi.advanceTimersByTime(2_500);
    expect(
      access.discInspections.recordSettlingObservation(started.claim!, {
        mediaGeneration: "unready-101",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: {
        phase: "reading_metadata",
        stableObservationCount: 3,
        settlingResetCount: 1,
      },
    });
    access.close();
  });

  it("recovers an expired settling claim with a fresh quiet-window proof", () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-11T00:15:00.000Z");
    vi.setSystemTime(startedAt);
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const original = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "201",
      mediaCapacityBytes: 2_048,
    });

    vi.advanceTimersByTime(2_500);
    access.discInspections.recordSettlingObservation(original.claim!, {
      mediaGeneration: "201",
      mediaCapacityBytes: 2_048,
    });
    vi.setSystemTime(
      new Date(
        startedAt.getTime() + 2_500 + DISC_INSPECTION_LEASE_DURATION_MS + 1,
      ),
    );
    const recoveredAt = new Date(Date.now());
    const recovered = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "201",
      mediaCapacityBytes: 2_048,
    });
    expect(recovered).toMatchObject({
      inspection: {
        id: original.inspection.id,
        attemptCount: 2,
        phase: "settling",
        stableObservationCount: 1,
        settlingQuietWindowStartedAt: recoveredAt,
        settlingStartedAt: recoveredAt,
      },
      claim: { id: original.inspection.id },
    });
    expect(recovered.claim?.claimToken).not.toBe(original.claim?.claimToken);
    expect(access.discInspections.listAttempts(original.inspection.id)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "interrupted",
        phase: "settling",
        reasonCode: "worker_interrupted",
      }),
    ]);
    expect(
      access.discInspections.beginOrResume({
        opticalDriveId: drive.id,
        mediaGeneration: "201",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: { stableObservationCount: 1 },
      claim: null,
    });

    vi.advanceTimersByTime(2_500);
    access.discInspections.recordSettlingObservation(recovered.claim!, {
      mediaGeneration: "201",
      mediaCapacityBytes: 2_048,
    });
    vi.advanceTimersByTime(2_500);
    expect(
      access.discInspections.recordSettlingObservation(recovered.claim!, {
        mediaGeneration: "201",
        mediaCapacityBytes: 2_048,
      }),
    ).toMatchObject({
      inspection: {
        id: original.inspection.id,
        attemptCount: 2,
        phase: "reading_metadata",
        stableObservationCount: 3,
      },
    });

    expect(() =>
      access.discInspections.renew(original.claim!),
    ).toThrow(StaleJobAttemptError);
    access.close();
  });

  it("resets changed provisional evidence while recovering the same insertion", () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-11T00:30:00.000Z");
    vi.setSystemTime(startedAt);
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const original = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "301",
      mediaCapacityBytes: 2_048,
    });
    vi.advanceTimersByTime(DISC_INSPECTION_LEASE_DURATION_MS + 1);
    const recovered = access.discInspections.beginOrResume({
      opticalDriveId: drive.id,
      mediaGeneration: "302",
      mediaCapacityBytes: 4_096,
    });

    expect(access.discInspections.list()).toEqual([
      expect.objectContaining({
        id: original.inspection.id,
        attemptCount: 2,
        mediaGeneration: "302",
        mediaCapacityBytes: 4_096,
        phase: "settling",
        stableObservationCount: 1,
        settlingQuietWindowStartedAt: new Date(Date.now()),
        settlingResetCount: 1,
      }),
    ]);
    expect(recovered.claim).toEqual(
      expect.objectContaining({
        id: original.inspection.id,
        mediaGeneration: "302",
      }),
    );
    expect(access.discInspections.listAttempts(original.inspection.id)).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: "interrupted",
        phase: "settling",
      }),
    ]);
    access.close();
  });

  it("persists inspection findings and retains legacy hash-progress compatibility", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T01:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    let started = beginSettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "201",
      mediaCapacityBytes: 2_048,
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
      phase: "confirming_media",
      volumeLabel: "LANGUAGE_DISC",
      totalBytes: 1_000,
      bytesHashed: null,
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
        started = beginSettledDiscInspection(access, {
          opticalDriveId: drive.id,
          mediaGeneration: "201",
          mediaCapacityBytes: 2_048,
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
    const manualAttempt = beginSettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "201",
      mediaCapacityBytes: 2_048,
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
      const started = beginSettledDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `inspection-progress-${terminalType}`,
        mediaCapacityBytes: 2_048,
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
    const started = beginSettledDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "failed-insertion",
      mediaCapacityBytes: 2_048,
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
      mediaCapacityBytes: 2_048,
    });
    expect(replacement).toMatchObject({
      inspection: {
        mediaGeneration: "replacement-insertion",
        status: "running",
      },
      claim: { id: expect.any(String) },
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

  it.each(persistedClassificationVectors)(
    "persists the shared $name classification vector",
    ({ category, scsiStatus, hostStatus, driverStatus, senseKey, asc, ascq }) => {
      const access = openTestDatabase();
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/classification-${category}`,
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `classification-${category}`,
        fingerprint: `classification-${category}`,
      });
      access.archiveRequests.create({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.startForInspection(
        inspection.id,
        `classification-${category}-worker`,
      )!;

      expect(access.archiveJobs.failWithReadFailure(claim, {
        stage: "initial_copy",
        category,
        classifierVersion: "scsi-read-classifier-v2",
        failingLba: 1_024,
        requestedBlockCount: 16,
        retryCount: 0,
        scsiStatus,
        hostStatus,
        driverStatus,
        senseKey,
        asc,
        ascq,
      })).toMatchObject({
        readFailureCategory: category,
        readFailureScsiStatus: scsiStatus,
        readFailureHostStatus: hostStatus,
        readFailureDriverStatus: driverStatus,
      });
      access.close();
    },
  );

  it.each([
    {
      category: "unknown",
      errorMessage: "The Optical Drive returned an unclassified read failure",
      evidence: {
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseKey: 5,
        asc: 32,
        ascq: 0,
      },
    },
    {
      category: "hardware_error",
      errorMessage: "The Optical Drive reported a hardware fault",
      evidence: {
        scsiStatus: 3,
        hostStatus: 0,
        driverStatus: 0x28,
        senseKey: 4,
        asc: 68,
        ascq: 0,
      },
    },
    {
      category: "transport_error",
      errorMessage: "Communication with the Optical Drive failed",
      evidence: {
        scsiStatus: 2,
        hostStatus: 0x13,
        driverStatus: 0,
        senseKey: 3,
        asc: 17,
        ascq: 0,
      },
    },
    {
      category: "protection_error",
      errorMessage: "DVD copy protection or region access failed",
      evidence: {
        scsiStatus: 3,
        hostStatus: 0,
        driverStatus: 0x28,
        senseKey: 5,
        asc: 111,
        ascq: 0x0a,
      },
    },
  ] as const)("keeps $category evidence immutable on the Archive Job attempt that observed it", ({
    category,
    errorMessage,
    evidence,
  }) => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "unknown-read-generation",
      fingerprint: "unknown-read-disc",
    });
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const first = access.archiveJobs.startForInspection(
      inspection.id,
      "worker-1",
    )!;

    expect(
      access.archiveJobs.failWithReadFailure(first, {
        stage: "initial_copy",
        category,
        classifierVersion: "scsi-read-classifier-v2",
        failingLba: 1_024,
        requestedBlockCount: 16,
        retryCount: 2,
        ...evidence,
      }),
    ).toMatchObject({
      status: "failed",
      errorMessage,
      failureDetailVersion: "archive-failure-detail-v1",
      readFailureStage: "initial_copy",
      readFailureCategory: category,
      readFailureClassifierVersion: "scsi-read-classifier-v2",
      readFailureLba: 1_024,
      readFailureRequestedBlockCount: 16,
      readFailureRetryCount: 2,
      readFailureScsiStatus: evidence.scsiStatus,
      readFailureHostStatus: evidence.hostStatus,
      readFailureDriverStatus: evidence.driverStatus,
      readFailureSenseKey: evidence.senseKey,
      readFailureAsc: evidence.asc,
      readFailureAscq: evidence.ascq,
    });

    access.archiveRequests.retry(request.id);
    const second = access.archiveJobs.startForInspection(
      inspection.id,
      "worker-2",
    )!;
    access.archiveJobs.fail(second, "A later attempt failed differently");

    expect(access.archiveJobs.list()).toEqual([
      expect.objectContaining({
        id: first.id,
        attemptOrdinal: 1,
        readFailureLba: 1_024,
        readFailureRetryCount: 2,
      }),
      expect.objectContaining({
        id: second.id,
        attemptOrdinal: 2,
        failureDetailVersion: "archive-failure-detail-v1",
        readFailureStage: null,
        readFailureCategory: null,
        readFailureClassifierVersion: null,
        readFailureLba: null,
        readFailureRequestedBlockCount: null,
        readFailureRetryCount: null,
        readFailureScsiStatus: null,
        readFailureHostStatus: null,
        readFailureDriverStatus: null,
        readFailureSenseKey: null,
        readFailureAsc: null,
        readFailureAscq: null,
      }),
    ]);
    access.close();
  });

  it.each([
    {
      category: "not_ready",
      errorMessage: "The Optical Drive was not ready to read the disc",
      senseKey: 0x02,
      asc: 0x04,
      ascq: 0x01,
    },
    {
      category: "unit_attention",
      errorMessage: "The Optical Drive reported a media change",
      senseKey: 0x06,
      asc: 0x28,
      ascq: 0x00,
    },
  ] as const)(
    "persists exact $category evidence and leaves the Archive Request retryable",
    ({ category, errorMessage, senseKey, asc, ascq }) => {
      const access = openTestDatabase();
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: "/dev/sr0",
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `${category}-generation`,
        fingerprint: `${category}-disc`,
      });
      const request = access.archiveRequests.create({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.startForInspection(
        inspection.id,
        `${category}-worker`,
      )!;

      expect(access.archiveJobs.failWithReadFailure(claim, {
        stage: "initial_copy",
        category,
        classifierVersion: "scsi-read-classifier-v1",
        failingLba: 2_048,
        requestedBlockCount: 31,
        retryCount: 0,
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseKey,
        asc,
        ascq,
      })).toMatchObject({
        status: "failed",
        errorMessage,
        failureDetailVersion: "archive-failure-detail-v1",
        readFailureStage: "initial_copy",
        readFailureCategory: category,
        readFailureLba: 2_048,
        readFailureRequestedBlockCount: 31,
        readFailureRetryCount: 0,
        readFailureSenseKey: senseKey,
        readFailureAsc: asc,
        readFailureAscq: ascq,
      });
      expect(access.archiveRequests.list(["needs_attention"])).toEqual([
        expect.objectContaining({ id: request.id }),
      ]);
      expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
      access.close();
    },
  );

  it.each([
    {
      category: "hardware_error",
      evidence: {
        scsiStatus: null,
        hostStatus: null,
        driverStatus: null,
        senseKey: null,
        asc: null,
        ascq: null,
      },
    },
    {
      category: "transport_error",
      evidence: {
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseKey: 3,
        asc: 17,
        ascq: 0,
      },
    },
    {
      category: "protection_error",
      evidence: {
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseKey: 5,
        asc: 33,
        ascq: 0,
      },
    },
  ] as const)("rejects $category evidence that contradicts its category", ({
    category,
    evidence,
  }) => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: `${category}-generation`,
      fingerprint: `${category}-disc`,
    });
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const job = access.archiveJobs.startForInspection(
      inspection.id,
      `${category}-worker`,
    )!;

    expect(() =>
      access.archiveJobs.failWithReadFailure(job, {
        stage: "initial_copy",
        category,
        classifierVersion: "scsi-read-classifier-v1",
        failingLba: 1_024,
        requestedBlockCount: 16,
        retryCount: 2,
        ...evidence,
      }),
    ).toThrow("read failure evidence does not match category");
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: job.id }),
    ]);
    expect(access.archiveRequests.list(["running"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    access.close();
  });

  it.each([
    { category: "not_ready", senseKey: 0x02, asc: 0x04, ascq: 0x01 },
    { category: "unit_attention", senseKey: 0x06, asc: 0x28, ascq: 0x00 },
    { category: "hardware_error", senseKey: 0x04, asc: 0x44, ascq: 0x00 },
    { category: "protection_error", senseKey: 0x07, asc: 0x27, ascq: 0x00 },
  ] as const)(
    "rejects null required $category evidence at the SQLite boundary",
    ({ category, senseKey, asc, ascq }) => {
      const databasePath = createTestDatabasePath();
      const access = openTestDatabase(databasePath);
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/${category}-constraint`,
        isEnabled: true,
        isPresent: true,
      });
      const { disc, inspection } = completeDiscInspection(access, {
        opticalDriveId: drive.id,
        mediaGeneration: `${category}-constraint`,
        fingerprint: `${category}-constraint`,
      });
      access.archiveRequests.create({ detectedDiscId: disc.id });
      const job = access.archiveJobs.startForInspection(
        inspection.id,
        `${category}-constraint-worker`,
      )!;
      access.archiveJobs.failWithReadFailure(job, {
        stage: "initial_copy",
        category,
        classifierVersion: "scsi-read-classifier-v1",
        failingLba: 1_024,
        requestedBlockCount: 16,
        retryCount: 2,
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseKey,
        asc,
        ascq,
      });
      access.close();

      const sqlite = new DatabaseSync(databasePath);
      const constraint = /archive_jobs_read_failure_category_evidence_check/;
      expect(() =>
        sqlite.prepare(`
          update archive_jobs
          set read_failure_scsi_status = null,
              read_failure_host_status = null,
              read_failure_driver_status = null
          where id = ?
        `).run(job.id),
      ).toThrow(constraint);
      expect(() =>
        sqlite.prepare(`
          update archive_jobs
          set read_failure_sense_key = null
          where id = ?
        `).run(job.id),
      ).toThrow(constraint);
      sqlite.close();
    },
  );

  it("persists out-of-range evidence without relabeling it as disc damage", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "out-of-range-generation",
      fingerprint: "out-of-range-disc",
    });
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const job = access.archiveJobs.startForInspection(
      inspection.id,
      "boundary-worker",
    )!;

    expect(access.archiveJobs.failWithReadFailure(job, {
      stage: "initial_copy",
      category: "out_of_range",
      classifierVersion: "scsi-read-classifier-v1",
      failingLba: 2_048,
      requestedBlockCount: 31,
      retryCount: 0,
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseKey: 5,
      asc: 33,
      ascq: 0,
    })).toMatchObject({
      status: "failed",
      errorMessage:
        "The Optical Drive reported a readable-boundary disagreement",
      failureDetailVersion: "archive-failure-detail-v1",
      readFailureCategory: "out_of_range",
      readFailureLba: 2_048,
      readFailureSenseKey: 5,
      readFailureAsc: 33,
      readFailureAscq: 0,
    });
    expect(access.archiveRequests.list(["needs_attention"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    access.close();
  });

  it("continues an Archive Request on another matching Optical Drive", () => {
    const access = openTestDatabase();
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
    const fingerprint = `dvdmeta-sha256:${"4".repeat(64)}`;
    const scanData = {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const first = completeDiscInspection(access, {
      opticalDriveId: firstDrive.id,
      mediaGeneration: "generation-1",
      fingerprint,
      scanData,
      sizeBytes: 4 * 2_048,
      volumeLabel: "MATCHING_DISC",
    });
    const request = access.archiveRequests.create({
      detectedDiscId: first.disc.id,
    });
    const firstAttempt = access.archiveJobs.startForInspection(
      first.inspection.id,
      "worker-1",
    )!;
    access.archiveJobs.fail(firstAttempt, "unreadable sector");
    access.archiveRequests.retry(request.id);

    const second = completeDiscInspection(access, {
      opticalDriveId: secondDrive.id,
      mediaGeneration: "generation-2",
      fingerprint,
      scanData,
      sizeBytes: 4 * 2_048,
      volumeLabel: "MATCHING_DISC",
    });
    expect(
      access.archiveRequests.hasPendingRequestForDetectedDiscFingerprint(
        second.disc.id,
      ),
    ).toBe(true);
    const secondAttempt = access.archiveJobs.startForInspection(
      second.inspection.id,
      "worker-2",
    );

    expect(secondAttempt).toMatchObject({
      archiveRequestId: request.id,
      attemptOrdinal: 2,
      detectedDiscId: second.disc.id,
      status: "running",
    });
    const attempts = access.archiveJobs.list();
    expect(attempts.map(({ id, detectedDiscId }) => ({ id, detectedDiscId })))
      .toEqual([
        { id: firstAttempt.id, detectedDiscId: first.disc.id },
        { id: secondAttempt!.id, detectedDiscId: second.disc.id },
      ]);
    expect(
      access.catalog
        .listDetectedDiscs(undefined, {
          ids: attempts.map(({ detectedDiscId }) => detectedDiscId),
        })
        .map(({ id, opticalDriveId }) => ({ id, opticalDriveId })),
    ).toEqual([
      { id: first.disc.id, opticalDriveId: firstDrive.id },
      { id: second.disc.id, opticalDriveId: secondDrive.id },
    ]);
    expect(JSON.stringify(attempts)).not.toContain("/dev/sr");
    access.close();
  });

  it("rejects incomplete or mismatched alternate-drive identity evidence", () => {
    const access = openTestDatabase();
    const fingerprint = `dvdmeta-sha256:${"5".repeat(64)}`;
    const scanData = {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const completeEvidence = ({
      devicePath,
      evidenceFingerprint,
      evidenceScanData,
      mediaGeneration,
      totalBytes,
    }: {
      devicePath: string;
      evidenceFingerprint: string;
      evidenceScanData?: unknown;
      mediaGeneration: string;
      totalBytes?: number;
    }) => {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath,
        isEnabled: true,
        isPresent: true,
      });
      return {
        ...completeDiscInspection(access, {
          fingerprint: evidenceFingerprint,
          mediaGeneration,
          opticalDriveId: drive.id,
          scanData: evidenceScanData,
          sizeBytes: totalBytes,
          volumeLabel: "IDENTITY_EVIDENCE",
        }),
        drive,
      };
    };
    const source = completeEvidence({
      devicePath: "/dev/source",
      evidenceFingerprint: fingerprint,
      evidenceScanData: scanData,
      mediaGeneration: "source-generation",
      totalBytes: 4 * 2_048,
    });
    const request = access.archiveRequests.create({
      detectedDiscId: source.disc.id,
    });
    const missingTitleMap = completeEvidence({
      devicePath: "/dev/missing-title-map",
      evidenceFingerprint: fingerprint,
      mediaGeneration: "missing-title-map-generation",
      totalBytes: 4 * 2_048,
    });
    const wrongSize = completeEvidence({
      devicePath: "/dev/wrong-size",
      evidenceFingerprint: fingerprint,
      evidenceScanData: scanData,
      mediaGeneration: "wrong-size-generation",
      totalBytes: 5 * 2_048,
    });
    const otherFingerprint = `dvdmeta-sha256:${"6".repeat(64)}`;
    const mismatchedFingerprint = completeEvidence({
      devicePath: "/dev/wrong-fingerprint",
      evidenceFingerprint: otherFingerprint,
      evidenceScanData: {
        ...scanData,
        contentId: otherFingerprint,
      },
      mediaGeneration: "wrong-fingerprint-generation",
      totalBytes: 4 * 2_048,
    });

    for (const candidate of [
      missingTitleMap,
      wrongSize,
      mismatchedFingerprint,
    ]) {
      expect(
        access.archiveJobs.startForInspection(
          candidate.inspection.id,
          `worker-${candidate.drive.devicePath}`,
        ),
      ).toBeNull();
    }
    expect(access.archiveJobs.list()).toEqual([]);
    expect(access.archiveRequests.list(["pending"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    access.close();
  });

  it("rejects ambiguous matching requests before starting an Archive Job", () => {
    const access = openTestDatabase();
    const fingerprint = `dvdmeta-sha256:${"7".repeat(64)}`;
    const scanData = {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const completeEvidence = (devicePath: string, mediaGeneration: string) => {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath,
        isEnabled: true,
        isPresent: true,
      });
      return completeDiscInspection(access, {
        fingerprint,
        mediaGeneration,
        opticalDriveId: drive.id,
        scanData,
        sizeBytes: 4 * 2_048,
        volumeLabel: "AMBIGUOUS_DISC",
      });
    };
    const first = completeEvidence("/dev/request-source-1", "generation-1");
    const second = completeEvidence("/dev/request-source-2", "generation-2");
    const candidate = completeEvidence("/dev/candidate", "generation-3");
    access.archiveRequests.create({ detectedDiscId: first.disc.id });
    access.archiveRequests.create({ detectedDiscId: second.disc.id });

    expect(() =>
      access.archiveJobs.startForInspection(
        candidate.inspection.id,
        "ambiguous-worker",
      )
    ).toThrow("Disc identity matches multiple pending Archive Requests");
    expect(access.archiveJobs.list()).toEqual([]);
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

  it("tracks Archive Job forward progress separately from lease renewal", () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-20T20:04:10.000Z");
    vi.setSystemTime(startedAt);
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/archive-forward-progress",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "archive-forward-progress",
      fingerprint: "archive-forward-progress",
    });
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "archive-forward-progress-worker",
    )!;

    expect(claim).toMatchObject({
      progressBytes: 0,
      lastProgressAt: startedAt,
    });

    vi.advanceTimersByTime(20_000);
    const renewed = access.archiveJobs.renewClaim(claim);
    expect(renewed.updatedAt).toEqual(new Date("2026-08-20T20:04:30.000Z"));
    expect(renewed.lastProgressAt).toEqual(startedAt);

    vi.advanceTimersByTime(40_000);
    const advanced = access.archiveJobs.updateProgress(claim, {
      phase: "copying",
      progressPercent: 9,
      progressBytes: 638_000_000,
    });
    expect(advanced).toMatchObject({
      progressBytes: 638_000_000,
      lastProgressAt: new Date("2026-08-20T20:05:10.000Z"),
    });

    vi.advanceTimersByTime(20_000);
    access.archiveJobs.renewClaim(claim);
    vi.advanceTimersByTime(40_000);
    const unchanged = access.archiveJobs.updateProgress(claim, {
      phase: "copying",
      progressPercent: 9,
      progressBytes: 638_000_000,
    });
    expect(unchanged.updatedAt).toEqual(new Date("2026-08-20T20:06:10.000Z"));
    expect(unchanged.lastProgressAt).toEqual(
      new Date("2026-08-20T20:05:10.000Z"),
    );

    vi.advanceTimersByTime(20_000);
    access.archiveJobs.renewClaim(claim);
    vi.advanceTimersByTime(40_000);
    expect(
      access.archiveJobs.updateProgress(claim, {
        phase: "copying",
        progressPercent: 9,
        progressBytes: 638_002_048,
      }),
    ).toMatchObject({
      progressBytes: 638_002_048,
      lastProgressAt: new Date("2026-08-20T20:07:10.000Z"),
    });
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
      sizeBytes: 1_000,
    });
    const request = access.archiveRequests.create({
      detectedDiscId: disc.id,
    });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "publisher",
    )!;
    expect(claim.discInspectionId).toBe(inspection.id);
    access.archiveJobs.updateProgress(claim, {
      phase: "copying",
      progressPercent: 60,
    });

    expect(() => access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/publication.iso",
      sizeBytes: 1_000,
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidence(1_000),
      integrityEvidence: {
        integrity: "clean_read",
        policyVersion: "",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      },
    })).toThrow(DomainInvariantError);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: claim.id }),
    ]);

    const validBoundaryEvidence =
      createNormalDvdArchiveBoundaryEvidence(1_000);
    const invalidBoundaryEvidence = [
      {},
      { ...validBoundaryEvidence, policyVersion: "x".repeat(129) },
      { ...validBoundaryEvidence, publishedSizeBytes: 999 },
      { ...validBoundaryEvidence, reportedSizeBytes: 9_000_000_001 },
      { ...validBoundaryEvidence, excludedSectorCount: 1 },
    ];
    for (const boundaryEvidence of invalidBoundaryEvidence) {
      expect(() => access.archiveJobs.publish(claim, {
        archivePath: "/media/originals/publication.iso",
        boundaryEvidence: boundaryEvidence as never,
        sizeBytes: 1_000,
        integrityEvidence: createCleanReadArchiveIntegrityEvidence(
          "dvd-recovery-v1",
        ),
      })).toThrow(DomainInvariantError);
      expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    }

    expect(() => access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/publication.iso",
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidence(900),
      sizeBytes: 900,
      integrityEvidence: createCleanReadArchiveIntegrityEvidence(
        "dvd-recovery-v1",
      ),
    })).toThrow(DomainInvariantError);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);

    const completed = access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/publication.iso",
      boundaryEvidence: validBoundaryEvidence,
      sizeBytes: 1_000,
      integrityEvidence: {
        integrity: "clean_read",
        policyVersion: "dvd-recovery-v1",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      },
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
        boundaryPolicyVersion: "dvd-archive-boundary-v1",
        boundaryReportedSizeBytes: 1_000,
        boundaryPublishedSizeBytes: 1_000,
        boundaryExcludedSectorCount: 0,
        integrity: "clean_read",
        integrityPolicyVersion: "dvd-recovery-v1",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      }),
    ]);
    expect(() => access.archiveJobs.fail(claim, "stale failure")).toThrow(
      StaleJobAttemptError,
    );
    access.close();
  });

  it("publishes a corrected DVD at its actual size with separate clean-read evidence", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/corrected-boundary",
      isEnabled: true,
      isPresent: true,
    });
    const reportedSizeBytes = 8 * 2_048;
    const publishedSizeBytes = 6 * 2_048;
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "corrected-boundary",
      fingerprint: "corrected-boundary",
      sizeBytes: reportedSizeBytes,
    });
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "corrected-boundary-publisher",
    )!;
    const boundaryEvidence = createCorrectedDvdArchiveBoundaryEvidence({
      reportedSizeBytes,
      publishedSizeBytes,
      firstExcludedLba: 6,
      maximumReferencedLba: 5,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 3,
        hostStatus: 0,
        driverStatus: 0x28,
        senseResponseCode: 0x70,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      },
    });

    access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/corrected-boundary.iso",
      boundaryEvidence,
      sizeBytes: publishedSizeBytes,
      integrityEvidence: createCleanReadArchiveIntegrityEvidence(
        "dvd-recovery-v1",
      ),
    });

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        sizeBytes: publishedSizeBytes,
        boundaryPolicyVersion: "dvd-archive-boundary-v1",
        boundaryReportedSizeBytes: reportedSizeBytes,
        boundaryPublishedSizeBytes: publishedSizeBytes,
        boundaryExcludedSectorCount: 2,
        boundaryFirstExcludedLba: 6,
        boundaryMaximumReferencedLba: 5,
        boundaryReadFailureClassifierVersion: "scsi-read-classifier-v2",
        boundaryReadFailureScsiStatus: 3,
        boundaryReadFailureHostStatus: 0,
        boundaryReadFailureDriverStatus: 0x28,
        boundaryReadFailureSenseResponseCode: 0x70,
        boundaryReadFailureSenseKey: 0x05,
        boundaryReadFailureAsc: 0x21,
        boundaryReadFailureAscq: 0,
        integrity: "clean_read",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      }),
    ]);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    access.close();
  });

  it("publishes recovered archives with explicit unknown integrity evidence", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/recovered-archive",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "recovered-archive",
      fingerprint: "recovered-archive",
      sizeBytes: 1_000,
    });
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "recovery-publisher",
    )!;

    access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/recovered.iso",
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidence(1_000),
      sizeBytes: 1_000,
      integrityEvidence: createUnknownArchiveIntegrityEvidence(),
    });

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        integrity: "unknown",
        integrityPolicyVersion: null,
        badSectorCount: null,
        badAreaCount: null,
        badSectorRanges: null,
      }),
    ]);
    access.close();
  });

  it("publishes complete watchable-salvage evidence atomically", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/watchable-salvage",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "watchable-salvage",
      fingerprint: "watchable-salvage",
      sizeBytes: 100_000,
    });
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "watchable-salvage-publisher",
    )!;

    access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/watchable-salvage.iso",
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidence(100_000),
      sizeBytes: 100_000,
      integrityEvidence: createWatchableSalvageArchiveIntegrityEvidence(
        "dvd-watchable-salvage-v2",
        [
          { startLba: 10, sectorCount: 1 },
          { startLba: 20, sectorCount: 1 },
          { startLba: 30, sectorCount: 1 },
        ],
        [
          { titleNumber: 1, badSectorCount: 2 },
          { titleNumber: 2, badSectorCount: 2 },
        ],
      ),
    });

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        integrity: "watchable_salvage",
        integrityPolicyVersion: "dvd-watchable-salvage-v2",
        badSectorCount: 3,
        badAreaCount: 3,
        badSectorRanges: [
          { startLba: 10, sectorCount: 1 },
          { startLba: 20, sectorCount: 1 },
          { startLba: 30, sectorCount: 1 },
        ],
        badSectorCountsByTitle: [
          { titleNumber: 1, badSectorCount: 2 },
          { titleNumber: 2, badSectorCount: 2 },
        ],
      }),
    ]);
    expect(access.archiveRequests.list(["fulfilled"])).toEqual([
      expect.objectContaining({ id: request.id }),
    ]);
    access.close();
  });

  it("constrains archive-boundary and Archive Integrity evidence independently at the SQLite boundary", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/integrity-constraint",
      isEnabled: true,
      isPresent: true,
    });
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "integrity-constraint",
      fingerprint: "integrity-constraint",
      sizeBytes: 1_000,
    });
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "constraint-publisher",
    )!;
    access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/integrity-constraint.iso",
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidence(1_000),
      sizeBytes: 1_000,
      integrityEvidence: createCleanReadArchiveIntegrityEvidence(
        "constraint-policy-v1",
      ),
    });
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    const boundaryColumns = [
      "boundary_policy_version",
      "boundary_reported_size_bytes",
      "boundary_published_size_bytes",
      "boundary_excluded_sector_count",
    ] as const;
    for (const column of boundaryColumns) {
      expect(() =>
        sqlite.exec(`update original_disc_archives set ${column} = null`),
      ).toThrow(/constraint/i);
    }
    for (const mutation of [
      "boundary_policy_version = ''",
      `boundary_policy_version = '${"x".repeat(129)}'`,
      "boundary_reported_size_bytes = 9000000001",
      "boundary_published_size_bytes = 999",
      "boundary_excluded_sector_count = 1",
      "size_bytes = 999",
    ]) {
      expect(() =>
        sqlite.exec(`update original_disc_archives set ${mutation}`),
      ).toThrow(/constraint/i);
    }
    const evidenceColumns = [
      "integrity_policy_version",
      "bad_sector_count",
      "bad_area_count",
      "bad_sector_ranges",
    ] as const;
    for (const column of evidenceColumns) {
      expect(() =>
        sqlite.exec(`update original_disc_archives set ${column} = null`),
      ).toThrow(/constraint/i);
    }
    sqlite.exec(`
      update original_disc_archives
      set integrity = 'watchable_salvage',
          integrity_policy_version = 'salvage-policy-v1',
          bad_sector_count = 1,
          bad_area_count = 1,
          bad_sector_ranges = '[{"startLba":1,"sectorCount":1}]',
          bad_sector_counts_by_title = '[{"titleNumber":1,"badSectorCount":1}]'
    `);
    for (const column of [
      ...evidenceColumns,
      "bad_sector_counts_by_title",
    ] as const) {
      expect(() =>
        sqlite.exec(`update original_disc_archives set ${column} = null`),
      ).toThrow(/constraint/i);
    }
    sqlite.close();
  });

  it("constrains corrected archive-boundary evidence at the SQLite boundary", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/corrected-boundary-constraint",
      isEnabled: true,
      isPresent: true,
    });
    const reportedSizeBytes = 8 * 2_048;
    const publishedSizeBytes = 6 * 2_048;
    const { disc, inspection } = completeDiscInspection(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "corrected-boundary-constraint",
      fingerprint: "corrected-boundary-constraint",
      sizeBytes: reportedSizeBytes,
    });
    access.archiveRequests.create({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.startForInspection(
      inspection.id,
      "corrected-boundary-constraint-publisher",
    )!;
    access.archiveJobs.publish(claim, {
      archivePath: "/media/originals/corrected-boundary-constraint.iso",
      boundaryEvidence: createCorrectedDvdArchiveBoundaryEvidence({
        reportedSizeBytes,
        publishedSizeBytes,
        firstExcludedLba: 6,
        maximumReferencedLba: 5,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v1",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x70,
          senseKey: 0x05,
          asc: 0x21,
          ascq: 0,
        },
      }),
      sizeBytes: publishedSizeBytes,
      integrityEvidence: createCleanReadArchiveIntegrityEvidence(
        "dvd-recovery-v1",
      ),
    });
    access.close();

    const sqlite = new DatabaseSync(databasePath);
    for (const column of [
      "boundary_reported_size_bytes",
      "boundary_published_size_bytes",
      "boundary_excluded_sector_count",
      "boundary_first_excluded_lba",
      "boundary_maximum_referenced_lba",
      "boundary_read_failure_classifier_version",
      "boundary_read_failure_scsi_status",
      "boundary_read_failure_host_status",
      "boundary_read_failure_driver_status",
      "boundary_read_failure_sense_response_code",
      "boundary_read_failure_sense_key",
      "boundary_read_failure_asc",
      "boundary_read_failure_ascq",
    ] as const) {
      expect(() =>
        sqlite.exec(`update original_disc_archives set ${column} = null`),
      ).toThrow(/constraint/i);
    }
    for (const mutation of [
      "size_bytes = null",
      "size_bytes = 16384",
      "boundary_reported_size_bytes = 16383",
      "boundary_published_size_bytes = 12287",
      "boundary_excluded_sector_count = 3",
      "boundary_first_excluded_lba = 5",
      "boundary_maximum_referenced_lba = 6",
      "boundary_read_failure_classifier_version = ''",
      "boundary_read_failure_scsi_status = 0",
      "boundary_read_failure_scsi_status = 259",
      "boundary_read_failure_host_status = 1",
      "boundary_read_failure_driver_status = 2",
      "boundary_read_failure_driver_status = 65576",
      "boundary_read_failure_sense_response_code = 113",
      "boundary_read_failure_sense_key = 4",
      "boundary_read_failure_asc = 32",
      "boundary_read_failure_ascq = 1",
    ]) {
      expect(() =>
        sqlite.exec(`update original_disc_archives set ${mutation}`)
      ).toThrow(/constraint/i);
    }
    sqlite.close();
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
    expect(legacyArchive).toMatchObject({
      sizeBytes: null,
      integrity: "unknown",
      integrityPolicyVersion: null,
      badSectorCount: null,
      badAreaCount: null,
      badSectorRanges: null,
    });

    access.archiveRequests.cancel(request.id);

    expect(() =>
      access.archiveJobs.publish(claim, {
        archivePath: join(archiveDirectory, "current.iso"),
        boundaryEvidence:
          createNormalDvdArchiveBoundaryEvidence(archiveBytes.byteLength),
        integrityEvidence: createCleanReadArchiveIntegrityEvidence(
          "test-clean-v1",
        ),
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
        boundaryEvidence: createNormalDvdArchiveBoundaryEvidence(1_000),
        integrityEvidence: createCleanReadArchiveIntegrityEvidence(
          "test-clean-v1",
        ),
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

  it("excludes simultaneous multi-process starts through an alternate drive", async () => {
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
    const fingerprint = `dvdmeta-sha256:${"8".repeat(64)}`;
    const scanData = {
      schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
      contentId: fingerprint,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const first = completeDiscInspection(access, {
      opticalDriveId: firstDrive.id,
      mediaGeneration: "701",
      fingerprint,
      scanData,
      sizeBytes: 4 * 2_048,
      volumeLabel: "CONCURRENT_ALTERNATE",
    });
    const second = completeDiscInspection(access, {
      opticalDriveId: secondDrive.id,
      mediaGeneration: "702",
      fingerprint,
      scanData,
      sizeBytes: 4 * 2_048,
      volumeLabel: "CONCURRENT_ALTERNATE",
    });
    access.archiveRequests.create({ detectedDiscId: first.disc.id });

    const results = await runBarrierWorkers({
      databasePath,
      mode: "operation",
      operations: [
        { operation: "start-archive", discInspectionId: second.inspection.id },
        { operation: "start-archive", discInspectionId: second.inspection.id },
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
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ detectedDiscId: second.disc.id }),
    ]);
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

  it.each([
    ["cancellation", 0, 150, "cancelled", false],
    ["completion", 150, 0, "completed", true],
  ] as const)(
    "adapts a corrected same-path replacement when %s wins the predecessor race",
    async (
      outcome,
      correctionDelayMs,
      completionDelayMs,
      predecessorStatus,
      replaceExistingOutput,
    ) => {
      const databasePath = createTestDatabasePath();
      const key = `corrected-predecessor-${outcome}-race`;
      const {
        access,
        archive,
        correctedItems: [correctedItem],
        mistakenSelection,
      } = createDiscSelectionCorrectionFixture({ key, databasePath });
      if (!correctedItem) throw new Error("Expected race correction target");
      const profile = access.encodingProfiles.create({
        key,
        displayName: key,
        mediaDomain: "dvd_video",
        settings: {},
      });
      const predecessor = access.encodeJobs.enqueue({
        discSelectionId: mistakenSelection.id,
        encodingProfileId: profile.id,
        outputPath: `/media/movies/${key}.mkv`,
      });
      const claim = access.encodeJobs.claimNext(`${key}-worker`);
      if (!claim) throw new Error("Expected corrected predecessor claim");
      const catalogRevision = access.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!.updatedAt;

      const results = await runBarrierWorkers({
        databasePath,
        mode: "operation",
        operations: [
          {
            operation: "correct-disc-selection",
            discSelectionId: mistakenSelection.id,
            originalDiscArchiveId: archive.id,
            catalogRevision,
            mediaItemId: correctedItem.id,
            reason: `The ${outcome} race corrected the source mapping.`,
            delayMs: correctionDelayMs,
          },
          {
            operation: "complete-encode",
            claim,
            delayMs: completionDelayMs,
          },
        ],
      });

      expect(results[0]).toMatchObject({ outcome: "corrected" });
      expect(results[1]).toMatchObject({
        outcome: outcome === "completion" ? "completed" : "rejected",
      });
      if (outcome === "cancellation") {
        expect(access.encodeJobs.completeCancellation(claim)).toMatchObject({
          id: predecessor.id,
          status: "cancelled",
        });
      }
      expect(access.encodeJobs.list()).toContainEqual(expect.objectContaining({
        id: predecessor.id,
        status: predecessorStatus,
      }));

      const replacement = access.catalog.completeCatalogReviewWithReplacements(
        archive.id,
        access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!
          .updatedAt,
        "reviewed_with_selections",
        [{
          predecessorEncodeJobId: predecessor.id,
          encodingProfileId: profile.id,
          outputPath: predecessor.outputPath,
        }],
      ).replacementEncodeJobs[0]!;

      const replacementClaim = access.encodeJobs.claimNext(
        `${key}-successor`,
      );
      expect(replacementClaim).toMatchObject({
        id: replacement.id,
        predecessorEncodeJobId: predecessor.id,
        replaceExistingOutput,
      });
      access.close();
    },
    20_000,
  );

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
