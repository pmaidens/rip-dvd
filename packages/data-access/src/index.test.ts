import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  createDataAccess,
  DVD_TITLE_MAP_SCHEMA_VERSION,
  DomainInvariantError,
  ENCODE_JOB_LEASE_DURATION_MS,
  InvalidStatusTransitionError,
  MAX_DVD_TITLES,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  StaleJobAttemptError,
} from "./index.js";
import type {
  DetectedDiscId,
  DiscKind,
  DiscSelectionId,
  EncodeJobId,
  MediaItemId,
  OriginalDiscArchiveId,
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
        | "created"
        | "enqueued"
        | "rejected"
        | "versioned";
      id?: string;
      version?: number;
    }
  | { id: string; claimToken: string }
  | null;

type ConcurrentOperation =
  | { operation: "enqueue"; detectedDiscId: DetectedDiscId }
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
  | {
      operation: "create-media-item";
      parentId: MediaItemId;
      title: string;
    };

type BarrierWorkerOptions = {
  databasePath: string;
} & (
  | { mode: "open"; count: number }
  | { mode: "claim"; count: number; queue: "archive" | "encode" }
  | { mode: "operation"; operations: readonly ConcurrentOperation[] }
);

async function runBarrierWorkers(
  options: BarrierWorkerOptions,
  hooks: {
    beforeRelease?(): void;
    afterRelease?(): Promise<void> | void;
  } = {},
): Promise<ConcurrentWorkerResult[]> {
  const { databasePath, mode } = options;
  const count = mode === "operation" ? options.operations.length : options.count;
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = Array.from(
    { length: count },
    (_, index) => {
      const queue = mode === "claim" ? options.queue : undefined;
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
            queue,
            workerId: `${queue ?? mode}-worker-${index}`,
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

  await Promise.all(ready);
  hooks.beforeRelease?.();
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, count);
  const workerResults = Promise.all(results);
  await hooks.afterRelease?.();
  return workerResults;
}

async function runAbandonedArchiveClaimWorker(databasePath: string): Promise<{
  id: string;
  claimToken: string;
}> {
  const worker = new Worker(
    new URL("../test/abandon-archive-claim-worker.mjs", import.meta.url),
    {
      execArgv: ["--no-warnings"],
      workerData: { databasePath, workerId: "lost-process-worker" },
    },
  );
  return new Promise((resolve, reject) => {
    let claim: { id: string; claimToken: string } | null | undefined;
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Abandoned Archive Job worker did not exit"));
    }, 2_000);
    timeout.unref();
    worker.once(
      "message",
      (message: { id: string; claimToken: string } | null) => {
        claim = message;
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Abandoned Archive Job worker exited with ${code}`));
      } else if (!claim) {
        reject(new Error("Abandoned Archive Job worker did not claim work"));
      } else {
        resolve(claim);
      }
    });
  });
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

  it("returns the newest records through the bounded list policy", () => {
    vi.useFakeTimers();
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const discs = Array.from({ length: 3 }, (_, index) => {
      vi.setSystemTime(new Date(`2026-01-0${index + 1}T00:00:00.000Z`));
      return access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `newest-${index}`,
      });
    });

    expect(
      access.catalog.listDetectedDiscs(undefined, {
        policy: { mode: "newest", limit: 2 },
      }),
    ).toEqual([
      expect.objectContaining({ id: discs[1]?.id }),
      expect.objectContaining({ id: discs[2]?.id }),
    ]);

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
    expect(identifierTables).toHaveLength(10);
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
    writer.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const job = writer.archiveJobs.enqueue({ detectedDiscId: disc.id });

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
        archiveJobsAfterCommit: snapshotAccess.archiveJobs.list(),
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
    expect(snapshot.archiveJobsAfterCommit).toEqual([
      expect.objectContaining({ id: job.id, status: "queued" }),
    ]);
    expect(snapshot.archivesAfterCommit).toEqual([]);
    expect(reader.catalog.listDetectedDiscs()).toEqual([
      expect.objectContaining({ id: disc.id, status: "archived" }),
    ]);
    expect(reader.archiveJobs.list()).toEqual([]);
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
      kind: "main_feature",
    });
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        kind: "main_feature",
      }),
    ).toThrow();

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, fingerprint: "disc-fingerprint" }),
    ]);
    expect(selection.mediaItemId).toBe(movie.id);
    expect(selection.sourceKey).toBe("dvd:main-feature");
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
      kind: "main_feature",
    });
    expect(
      access.catalog.listOriginalDiscArchives({ needsCatalogReviewOnly: true }),
    ).toEqual([expect.objectContaining({ id: archive.id })]);

    vi.setSystemTime(new Date("2026-08-03T18:05:00.000Z"));
    expect(access.catalog.completeCatalogReview(archive.id)).toMatchObject({
      id: archive.id,
      catalogReviewedAt: new Date("2026-08-03T18:05:00.000Z"),
    });
    expect(
      access.catalog.listOriginalDiscArchives({ needsCatalogReviewOnly: true }),
    ).toEqual([]);
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
      kind: "main_feature",
    });
    access.catalog.completeCatalogReview(archive.id);

    const episode = access.catalog.createMediaItem({
      kind: "episode",
      title: "Newly Found Episode",
    });
    const added = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: episode.id,
      kind: "dvd_chapters",
      titleNumber: 1,
      chapterStart: 1,
      chapterEnd: 4,
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
    access.catalog.completeCatalogReview(archive.id);
    expect(
      access.encodeJobs.enqueue({
        discSelectionId: added.id,
        encodingProfileId: profile.id,
        outputPath: "/media/movies/Newly Found Episode.mkv",
      }),
    ).toMatchObject({ status: "queued" });
    access.close();
  });

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
        kind: "main_feature",
      });
      return { archive, selection };
    };
    const unreviewed = createSelection("unreviewed");
    const reviewed = createSelection("reviewed");
    access.catalog.completeCatalogReview(reviewed.archive.id);

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
      kind: "main_feature",
    });
    access.catalog.completeCatalogReview(archive.id);
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
      kind: "main_feature",
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
    access.catalog.completeCatalogReview(archive.id);

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
            set catalog_reviewed_at = null, updated_at = ?
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
      kind: "other",
      title: "Local Recording",
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
        expect.objectContaining({ id: other.id, kind: "other" }),
      ]),
    );
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
    const access = openTestDatabase();
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
        kind: "main_feature",
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        kind: "dvd_title",
        titleNumber: 2,
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: firstEpisode.id,
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: secondEpisode.id,
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 5,
        chapterEnd: 8,
      }),
    ];

    expect(selections.map((selection) => selection.mediaItemId)).toEqual([
      mainFeature.id,
      trailer.id,
      firstEpisode.id,
      secondEpisode.id,
    ]);
    expect(selections.map((selection) => selection.sourceKey)).toEqual([
      "dvd:main-feature",
      "dvd:title:2",
      "dvd:title:1:chapters:1-4",
      "dvd:title:1:chapters:5-8",
    ]);
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: firstEpisode.id,
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 8,
        chapterEnd: 9,
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        kind: "dvd_title",
        titleNumber: 3,
      }),
    ).toThrow(DomainInvariantError);
    access.close();
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
    ).toContainEqual({ name: "legacy_cutover_pending" });
    expect(
      sqlite
        .prepare("select name from pragma_table_info('encode_jobs')")
        .all(),
    ).toEqual(expect.arrayContaining([
      { name: "partial_cleanup_lease_token" },
      { name: "publication_completion_pending" },
      { name: "publication_pending" },
    ]));
    expect(
      sqlite
        .prepare(
          "select name from __drizzle_migrations order by id desc limit 7",
        )
        .all(),
    ).toEqual([
      {
        name: "20260806204012_burly_johnny_storm",
      },
      {
        name: "20260805163203_unique_gideon",
      },
      {
        name: "20260805142313_glamorous_rage",
      },
      {
        name: "20260805022523_far_archangel",
      },
      {
        name: "20260805015911_heavy_franklin_richards",
      },
      {
        name: "20260805005453_outstanding_texas_twister",
      },
      {
        name: "20260804184603_tense_zzzax",
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
      access.catalog.completeCatalogReview(
        "duplicate-archive" as OriginalDiscArchiveId,
      )
    ).toThrow(/duplicate logical Disc Selections/);
    expect(() =>
      access.catalog.completeCatalogReview(
        "noncanonical-archive" as OriginalDiscArchiveId,
      )
    ).toThrow(/canonical Disc Selection source keys/);
    expect(() =>
      access.catalog.completeCatalogReview(
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
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 1,
      },
    );
    expect(repairedDuplicate).toMatchObject({
      sourceKey: "dvd:title:1:chapters:1-1",
      kind: "dvd_chapters",
    });
    expect(repairedDuplicate.id).not.toBe("duplicate-b");
    expect(access.catalog.listDiscSelections({
      ids: ["duplicate-b" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "duplicate-b",
        sourceKey: "caller:title-one-copy",
        titleNumber: 1,
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
        sourceKey: "caller:main",
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
        kind: "dvd_title",
        titleNumber: 1,
      },
    );
    expect(repairedNoncanonical).toMatchObject({
      sourceKey: "dvd:title:1",
      titleNumber: 1,
    });
    expect(repairedNoncanonical.id).not.toBe("noncanonical");
    expect(access.catalog.listDiscSelections({
      ids: ["noncanonical" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "noncanonical",
        sourceKey: "caller:title-one",
        titleNumber: 1,
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
        kind: "dvd_title",
        titleNumber: 1,
      },
    );
    expect(repairedMissingTitle).toMatchObject({
      sourceKey: "dvd:title:1",
      titleNumber: 1,
    });
    expect(repairedMissingTitle.id).not.toBe("missing-title");
    expect(access.catalog.listDiscSelections({
      originalDiscArchiveId:
        "scan-invalid-archive" as OriginalDiscArchiveId,
    })).toEqual([
      expect.objectContaining({
        id: repairedMissingTitle.id,
        sourceKey: "dvd:title:1",
        titleNumber: 1,
      }),
    ]);
    expect(access.catalog.listDiscSelections({
      ids: ["missing-title" as DiscSelectionId],
    })).toEqual([
      expect.objectContaining({
        id: "missing-title",
        sourceKey: "dvd:title:999",
        titleNumber: 999,
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
        access.catalog.completeCatalogReview(
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
      kind: "dvd_chapters",
      titleNumber: 1,
      chapterStart: 5,
      chapterEnd: 8,
    });
    const reviewed = access.catalog.completeCatalogReview(archive.id);
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
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const job = access.archiveJobs.enqueue({ detectedDiscId: disc.id });

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
    expect(access.archiveJobs.list(["queued"])).toEqual([
      expect.objectContaining({ id: job.id, detectedDiscId: disc.id }),
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
      access.archiveJobs.enqueue({ detectedDiscId: rediscovered.id }),
    ).toThrow(DomainInvariantError);
    expect(access.archiveJobs.claimNext("cross-drive-worker")).toBeNull();

    expect(() =>
      access.catalog.registerDetectedDisc({
        opticalDriveId: secondDrive.id,
        discKind: "blu_ray",
        fingerprint: "cross-drive-archived-disc",
      }),
    ).toThrow(DomainInvariantError);
    expect(access.archiveJobs.claimNext("contradictory-kind-worker")).toBeNull();
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
    expect(access.archiveJobs.claimNext("contradictory-kind-worker")).toBeNull();
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
      isPresent: true,
    });
    const secondDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isPresent: true,
    });
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: firstDrive.id,
      discKind: "dvd",
      fingerprint: "claim-global-archive-check",
    });
    const secondDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: secondDrive.id,
      discKind: "dvd",
      fingerprint: "claim-global-archive-check",
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "approved");
    const duplicateJob = access.archiveJobs.list()[0]!;
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

    expect(access.archiveJobs.claimNext("global-fingerprint-worker")).toBeNull();
    expect(access.archiveJobs.list(["queued"])).toEqual([
      expect.objectContaining({ id: duplicateJob.id }),
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
          kind: "dvd_title",
          titleNumber,
        }),
      ).toThrow(DomainInvariantError);
    }
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1.5,
        chapterEnd: 2,
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 2.5,
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

  it("claims each archive job once and permits only valid status transitions", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "first-disc",
    });
    const secondDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "second-disc",
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");
    const firstJob = access.archiveJobs.approve({
      detectedDiscId: firstDisc.id,
      priority: 1,
    });
    const secondJob = access.archiveJobs.approve({
      detectedDiscId: secondDisc.id,
      priority: 10,
    });

    const secondClaim = access.archiveJobs.claimNext("archive-worker-1");
    expect(secondClaim?.id).toBe(secondJob.id);
    if (!secondClaim) {
      throw new Error("Expected the higher-priority archive job to be claimed");
    }
    access.archiveJobs.fail(secondClaim, "test lane released");
    const firstClaim = access.archiveJobs.claimNext("archive-worker-2");
    expect(firstClaim?.id).toBe(firstJob.id);
    expect(secondClaim?.claimToken).toBeTruthy();
    expect(firstClaim?.claimToken).toBeTruthy();
    expect(access.archiveJobs.claimNext("archive-worker-3")).toBeNull();
    expect(() => access.archiveJobs.requeue(firstJob.id)).toThrow(
      InvalidStatusTransitionError,
    );

    if (!firstClaim) {
      throw new Error("Expected the first archive job to be claimed");
    }
    const failed = access.archiveJobs.fail(firstClaim, "drive read failed");
    expect(failed).toMatchObject({
      status: "failed",
      errorMessage: "drive read failed",
    });
    expect(access.archiveJobs.requeue(firstJob.id)).toMatchObject({
      status: "queued",
      claimedBy: null,
      errorMessage: null,
    });
    const reclaimed = access.archiveJobs.claimNext("archive-worker-4");
    if (!reclaimed) {
      throw new Error("Expected the failed Archive Job to be reclaimed");
    }
    expect(reclaimed.claimToken).not.toBe(firstClaim.claimToken);
    const firstArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: firstDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/First Disc.iso",
      fingerprint: "first-disc",
    });
    expect(() => access.archiveJobs.updateProgress(firstClaim, 50)).toThrow();
    expect(() =>
      access.archiveJobs.complete(firstClaim, firstArchive.id),
    ).toThrow();
    expect(() => access.archiveJobs.fail(firstClaim, "stale failure")).toThrow();
    access.archiveJobs.fail(reclaimed, "second attempt failed");
    access.close();
  });

  it("atomically approves a scanned disc and creates or requeues its Archive Job", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "approval-creates-work",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");

    expect(access.archiveJobs.list()).toEqual([]);
    const approved = access.archiveJobs.approve({ detectedDiscId: disc.id });
    expect(approved).toMatchObject({
      detectedDiscId: disc.id,
      status: "queued",
    });
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);

    const claim = access.archiveJobs.claimNext("approval-worker");
    if (!claim) {
      throw new Error("Expected the approved Archive Job to be claimed");
    }
    access.archiveJobs.fail(claim, "recoverable read failure");

    expect(access.archiveJobs.approve({ detectedDiscId: disc.id })).toMatchObject({
      id: approved.id,
      status: "queued",
      progressPercent: 0,
      errorMessage: null,
    });
    expect(access.archiveJobs.list()).toHaveLength(1);

    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec(`
      create trigger abort_archive_job_insert
      before insert on archive_jobs
      begin
        select raise(abort, 'simulated queue write failure');
      end
    `);
    const secondDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "approval-rolls-back",
    });
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");
    expect(() =>
      access.archiveJobs.approve({ detectedDiscId: secondDisc.id }),
    ).toThrow();
    expect(access.catalog.listDetectedDiscs(["scanned"])).toEqual([
      expect.objectContaining({ id: secondDisc.id }),
    ]);

    sqlite.close();
    access.close();
  });

  it("routes the generic approved transition through the Archive Job transaction", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "generic-approval-creates-work",
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");

    expect(
      access.catalog.updateDetectedDiscStatus(firstDisc.id, "approved"),
    ).toMatchObject({ id: firstDisc.id, status: "approved" });
    expect(access.archiveJobs.list()).toEqual([
      expect.objectContaining({
        detectedDiscId: firstDisc.id,
        status: "queued",
      }),
    ]);

    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec(`
      create trigger abort_generic_approval_archive_job_insert
      before insert on archive_jobs
      begin
        select raise(abort, 'simulated generic approval queue failure');
      end
    `);
    const secondDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "generic-approval-rolls-back",
    });
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");

    expect(() =>
      access.catalog.updateDetectedDiscStatus(secondDisc.id, "approved"),
    ).toThrow();
    expect(access.catalog.listDetectedDiscs(["scanned"]))
      .toEqual([expect.objectContaining({ id: secondDisc.id })]);
    expect(access.archiveJobs.list()).toHaveLength(1);

    sqlite.close();
    access.close();
  });

  it("does not expose direct archive publication on the standard catalog facade", () => {
    const access = createDataAccess({ databasePath: createTestDatabasePath() });
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: `sha256:${"a".repeat(64)}`,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");

    expect(
      Reflect.has(access.catalog, "createOriginalDiscArchive"),
    ).toBe(false);
    expect(access.catalog.listDetectedDiscs(["approved"]))
      .toEqual([expect.objectContaining({ id: disc.id })]);
    expect(access.archiveJobs.list(["queued"]))
      .toEqual([expect.objectContaining({ detectedDiscId: disc.id })]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    access.close();
  });

  it("does not expose direct Archive Job completion on the standard facade", () => {
    const databasePath = createTestDatabasePath();
    const access = createDataAccess({ databasePath });
    const migrationAccess = createLegacySidecarDataAccess({ databasePath });
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "direct-completion-bypass",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.archiveJobs.approve({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.claimNext("standard-caller");
    if (!claim) {
      throw new Error("Expected the approved Archive Job to be claimed");
    }
    migrationAccess.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/migration-seeded.iso",
      fingerprint: disc.fingerprint,
    });

    expect(Reflect.has(access.archiveJobs, "complete")).toBe(false);
    expect(access.archiveJobs.list(["running"]))
      .toEqual([expect.objectContaining({
        id: claim.id,
        originalDiscArchiveId: null,
      })]);
    migrationAccess.close();
    access.close();
  });

  it("atomically claims only the current disc in an enabled present drive", () => {
    const access = openTestDatabase();
    const disabledDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: false,
      isPresent: true,
    });
    const missingDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr1",
      isEnabled: true,
      isPresent: false,
    });
    const firstEnabledDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr2",
      isEnabled: true,
      isPresent: true,
    });
    const secondEnabledDrive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr3",
      isEnabled: true,
      isPresent: true,
    });
    const approve = (
      opticalDriveId: typeof disabledDrive.id,
      fingerprint: string,
      priority: number,
    ) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      const job = access.archiveJobs.approve({
        detectedDiscId: disc.id,
        priority,
      });
      return { disc, job };
    };
    approve(disabledDrive.id, "disabled-disc", 100);
    approve(missingDrive.id, "missing-disc", 90);
    const current = approve(firstEnabledDrive.id, "current-disc", 60);
    const sameDrive = approve(firstEnabledDrive.id, "same-drive-disc", 50);
    const otherDrive = approve(secondEnabledDrive.id, "other-drive-disc", 40);

    const currentClaim = access.archiveJobs.claimNext("current-worker", {
      opticalDriveId: firstEnabledDrive.id,
      fingerprint: current.disc.fingerprint,
    });
    expect(currentClaim?.id).toBe(current.job.id);
    expect(
      access.archiveJobs.claimNext("same-drive-worker", {
        opticalDriveId: firstEnabledDrive.id,
        fingerprint: sameDrive.disc.fingerprint,
      }),
    ).toBeNull();
    expect(
      access.archiveJobs.claimNext("wrong-medium-worker", {
        opticalDriveId: secondEnabledDrive.id,
        fingerprint: "not-the-inserted-disc",
      }),
    ).toBeNull();
    expect(
      access.archiveJobs.claimNext("other-drive-worker", {
        opticalDriveId: secondEnabledDrive.id,
        fingerprint: otherDrive.disc.fingerprint,
      })?.id,
    ).toBe(otherDrive.job.id);

    access.close();
  });

  it("recovers an expired Archive Job claim as a bounded retryable failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T03:00:00.000Z"));
    const databasePath = createTestDatabasePath();
    const firstProcess = openTestDatabase(databasePath);
    const drive = firstProcess.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = firstProcess.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "expired-archive-claim",
    });
    firstProcess.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const job = firstProcess.archiveJobs.approve({ detectedDiscId: disc.id });
    const abandoned = firstProcess.archiveJobs.claimNext("lost-worker")!;
    firstProcess.close();

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    const replacementProcess = openTestDatabase(databasePath);
    expect(replacementProcess.archiveJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({
        id: job.id,
        status: "failed",
        errorMessage: "Archive worker lease expired",
      }),
    ]);
    expect(replacementProcess.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({ id: job.id, progressPercent: 0 }),
    ]);
    expect(
      replacementProcess.archiveJobs.approve({ detectedDiscId: disc.id }),
    ).toMatchObject({ id: job.id, status: "queued" });
    const replacement = replacementProcess.archiveJobs.claimNext(
      "replacement-worker",
    );
    expect(replacement?.id).toBe(job.id);
    expect(() =>
      replacementProcess.archiveJobs.updateProgress(abandoned, 50),
    ).toThrow();
    replacementProcess.close();
  });

  it("recovers and reclaims work after the owning process disappears", async () => {
    const databasePath = createTestDatabasePath();
    const setup = openTestDatabase(databasePath);
    const drive = setup.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = setup.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "process-loss-archive-claim",
    });
    setup.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    const job = setup.archiveJobs.approve({ detectedDiscId: disc.id });
    setup.close();

    const abandoned = await runAbandonedArchiveClaimWorker(databasePath);
    expect(abandoned.id).toBe(job.id);
    const sqlite = new DatabaseSync(databasePath);
    sqlite
      .prepare("update archive_jobs set updated_at = ? where id = ?")
      .run(Date.now() - ARCHIVE_JOB_LEASE_DURATION_MS - 1, job.id);
    sqlite.close();

    const replacement = openTestDatabase(databasePath);
    expect(replacement.archiveJobs.recoverExpiredClaims()).toEqual([
      expect.objectContaining({ id: job.id, status: "failed" }),
    ]);
    replacement.archiveJobs.approve({ detectedDiscId: disc.id });
    const reclaimed = replacement.archiveJobs.claimNext("replacement-process");
    expect(reclaimed).toMatchObject({ id: job.id, status: "running" });
    expect(reclaimed?.claimToken).not.toBe(abandoned.claimToken);
    replacement.close();
  });

  it("bounds each expired Archive Job recovery transaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T03:00:00.000Z"));
    const access = openTestDatabase();
    for (let index = 0; index < 101; index += 1) {
      const fingerprint = `bounded-recovery-${index}`;
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/bounded-recovery-${index}`,
        isEnabled: true,
        isPresent: true,
      });
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.archiveJobs.approve({ detectedDiscId: disc.id });
      expect(
        access.archiveJobs.claimNext(`bounded-worker-${index}`, {
          opticalDriveId: drive.id,
          fingerprint,
        }),
      ).not.toBeNull();
    }

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS + 1);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(100);
    expect(access.archiveJobs.list(["running"])).toHaveLength(1);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(1);
    expect(access.archiveJobs.list(["running"])).toEqual([]);
    access.close();
  });

  it("renews only the current Archive Job owner before lease expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T03:00:00.000Z"));
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "renewed-archive-claim",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.archiveJobs.approve({ detectedDiscId: disc.id });
    const claim = access.archiveJobs.claimNext("live-worker")!;

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS - 1);
    const renewed = access.archiveJobs.renewClaim(claim);
    expect(renewed.updatedAt).toEqual(new Date("2026-08-03T03:00:59.999Z"));
    vi.advanceTimersByTime(2);
    expect(access.archiveJobs.recoverExpiredClaims()).toEqual([]);

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(1);
    expect(() => access.archiveJobs.renewClaim(claim)).toThrow();
    access.close();
  });

  it("rejects every Archive Job mutation after its lease expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T03:00:00.000Z"));
    const access = openTestDatabase();
    const createClaim = (label: string, index: number) => {
      const drive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/sr${index}`,
        isEnabled: true,
        isPresent: true,
      });
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: `expired-${label}-claim`,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.archiveJobs.approve({ detectedDiscId: disc.id });
      return access.archiveJobs.claimNext(`worker-${label}`, {
        opticalDriveId: drive.id,
        fingerprint: `expired-${label}-claim`,
      })!;
    };
    const progressClaim = createClaim("progress", 0);
    const failureClaim = createClaim("failure", 1);
    const publishClaim = createClaim("publish", 2);

    vi.advanceTimersByTime(ARCHIVE_JOB_LEASE_DURATION_MS);

    expect(() => access.archiveJobs.updateProgress(progressClaim, 50)).toThrow(
      StaleJobAttemptError,
    );
    expect(() => access.archiveJobs.fail(failureClaim, "copy failed")).toThrow(
      StaleJobAttemptError,
    );
    expect(() =>
      access.archiveJobs.publish(publishClaim, {
        archivePath: "/media/originals/expired-publish.iso",
        sizeBytes: 9,
      }),
    ).toThrow(StaleJobAttemptError);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.archiveJobs.recoverExpiredClaims()).toHaveLength(3);
    access.close();
  });

  it("atomically publishes archive provenance and terminal Archive Job success", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const createClaim = (fingerprint: string) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      const job = access.archiveJobs.approve({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.claimNext(`worker-${fingerprint}`, {
        opticalDriveId: drive.id,
        fingerprint,
      });
      if (!claim) {
        throw new Error("Expected the Archive Job to be claimed");
      }
      return { claim, disc, job };
    };

    const successful = createClaim("atomic-publish-success");
    const publishedJob = access.archiveJobs.publish(successful.claim, {
      archivePath: "/media/originals/atomic-publish-success.iso",
      sizeBytes: 4_700_000_000,
    });
    const publishedArchive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(publishedArchive).toMatchObject({
      detectedDiscId: successful.disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      fingerprint: "atomic-publish-success",
      sizeBytes: 4_700_000_000,
    });
    expect(publishedJob).toMatchObject({
      id: successful.job.id,
      originalDiscArchiveId: publishedArchive.id,
      status: "completed",
      progressPercent: 100,
    });
    expect(access.catalog.listDetectedDiscs(["archived"])).toEqual([
      expect.objectContaining({ id: successful.disc.id }),
    ]);

    const failed = createClaim("atomic-publish-rollback");
    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec(`
      create trigger abort_archive_job_completion
      before update on archive_jobs
      when new.status = 'completed'
      begin
        select raise(abort, 'simulated completion failure');
      end
    `);
    expect(() =>
      access.archiveJobs.publish(failed.claim, {
        archivePath: "/media/originals/atomic-publish-rollback.iso",
        sizeBytes: 4_700_000_000,
      }),
    ).toThrow();
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: publishedArchive.id }),
    ]);
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: failed.disc.id }),
    ]);
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: failed.job.id }),
    ]);

    sqlite.close();
    access.close();
  });

  it("does not requeue archive work after approval or provenance changes", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const createFailedJob = (fingerprint: string) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const job = access.archiveJobs.enqueue({ detectedDiscId: disc.id });
      const claim = access.archiveJobs.claimNext(`worker-${fingerprint}`);
      if (!claim) {
        throw new Error("Expected the Archive Job to be claimed");
      }
      access.archiveJobs.fail(claim, "preservation failed");
      return { disc, job };
    };

    const rejected = createFailedJob("rejected-requeue-disc");
    access.catalog.updateDetectedDiscStatus(rejected.disc.id, "rejected");
    expect(() => access.archiveJobs.requeue(rejected.job.id)).toThrow(
      InvalidStatusTransitionError,
    );

    const archived = createFailedJob("archived-requeue-disc");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: archived.disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Archived Requeue Disc.iso",
      fingerprint: "archived-requeue-disc",
    });
    expect(() => access.archiveJobs.requeue(archived.job.id)).toThrow(
      InvalidStatusTransitionError,
    );
    expect(access.archiveJobs.list(["failed"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rejected.job.id }),
        expect.objectContaining({ id: archived.job.id }),
      ]),
    );
    access.close();
  });

  it("requires current explicit approval to enqueue or claim archive work", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "approval-race-disc",
    });

    expect(() =>
      access.archiveJobs.enqueue({ detectedDiscId: disc.id }),
    ).toThrow(DomainInvariantError);
    access.catalog.updateDetectedDiscStatus(disc.id, "rejected");
    expect(() =>
      access.archiveJobs.enqueue({ detectedDiscId: disc.id }),
    ).toThrow(DomainInvariantError);
    access.catalog.updateDetectedDiscStatus(disc.id, "detected");
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const job = access.archiveJobs.enqueue({ detectedDiscId: disc.id });
    expect(access.archiveJobs.list(["queued"])).toEqual([
      expect.objectContaining({ id: job.id }),
    ]);

    const concurrentAccess = openTestDatabase(databasePath);
    concurrentAccess.catalog.updateDetectedDiscStatus(disc.id, "rejected");
    expect(access.archiveJobs.claimNext("archive-worker-rejected")).toBeNull();
    expect(access.archiveJobs.list(["queued"])).toEqual([]);

    const eligibleDisc = concurrentAccess.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "still-approved-disc",
    });
    concurrentAccess.catalog.updateDetectedDiscStatus(
      eligibleDisc.id,
      "scanned",
    );
    concurrentAccess.catalog.updateDetectedDiscStatus(
      eligibleDisc.id,
      "approved",
    );
    const eligibleJob = access.archiveJobs.enqueue({
      detectedDiscId: eligibleDisc.id,
    });
    const eligibleClaim = access.archiveJobs.claimNext(
      "archive-worker-approved",
    );
    expect(eligibleClaim?.id).toBe(eligibleJob.id);
    if (!eligibleClaim) {
      throw new Error("Expected the still-approved Archive Job to be claimed");
    }
    access.archiveJobs.fail(eligibleClaim, "approval gate regression");

    expect(() =>
      access.archiveJobs.enqueue({ detectedDiscId: disc.id }),
    ).toThrow(DomainInvariantError);

    concurrentAccess.catalog.updateDetectedDiscStatus(disc.id, "detected");
    expect(access.archiveJobs.claimNext("archive-worker-detected")).toBeNull();
    expect(() =>
      access.archiveJobs.enqueue({ detectedDiscId: disc.id }),
    ).toThrow(DomainInvariantError);

    concurrentAccess.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    concurrentAccess.catalog.updateDetectedDiscStatus(disc.id, "approved");
    concurrentAccess.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Approval Race Disc.iso",
      fingerprint: "approval-race-disc",
    });
    expect(access.archiveJobs.claimNext("archive-worker-archived")).toBeNull();
    expect(() =>
      access.archiveJobs.enqueue({ detectedDiscId: disc.id }),
    ).toThrow(DomainInvariantError);
    expect(access.archiveJobs.list(["queued"])).toEqual([]);

    concurrentAccess.close();
    access.close();
  });

  it("atomically coalesces enqueue races with rejection and archival", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });

    for (const transition of ["reject", "archive"] as const) {
      for (let round = 0; round < 5; round += 1) {
        const fingerprint = `${transition}-enqueue-race-${round}`;
        const disc = access.catalog.registerDetectedDisc({
          opticalDriveId: drive.id,
          discKind: "dvd",
          fingerprint,
        });
        access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
        access.catalog.updateDetectedDiscStatus(disc.id, "approved");

        const transitionOperation: ConcurrentOperation =
          transition === "reject"
            ? {
                operation: "reject",
                detectedDiscId: disc.id,
              }
            : {
                operation: "archive",
                detectedDiscId: disc.id,
                discKind: "dvd",
                archivePath: `/media/originals/Enqueue Race ${round}.iso`,
                fingerprint,
              };
        const results = await runBarrierWorkers({
          databasePath,
          mode: "operation",
          operations: [
            { operation: "enqueue", detectedDiscId: disc.id },
            transitionOperation,
          ],
        });

        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              outcome: transition === "reject" ? "rejected" : "archived",
            }),
          ]),
        );
        expect(
          access.archiveJobs
            .list(["queued"])
            .filter((job) => job.detectedDiscId === disc.id),
        ).toEqual([]);
        expect(access.archiveJobs.claimNext("enqueue-race-worker")).toBeNull();
      }
    }

    access.close();
  });

  it("requires the matching archive before completing an archive attempt", () => {
    const access = openTestDatabase();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const createApprovedDisc = (fingerprint: string) => {
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      return disc;
    };
    const targetDisc = createApprovedDisc("target-disc");
    const otherDisc = createApprovedDisc("other-disc");
    const job = access.archiveJobs.enqueue({ detectedDiscId: targetDisc.id });
    const claim = access.archiveJobs.claimNext("archive-worker-1");
    if (!claim) {
      throw new Error("Expected the archive job to be claimed");
    }
    const targetArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: targetDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Target.iso",
      fingerprint: "target-disc",
    });
    const otherArchive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: otherDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/media/originals/Other.iso",
      fingerprint: "other-disc",
    });

    expect(() => access.archiveJobs.complete(claim, otherArchive.id)).toThrow();
    expect(access.archiveJobs.list(["running"])).toEqual([
      expect.objectContaining({ id: job.id, originalDiscArchiveId: null }),
    ]);
    expect(access.archiveJobs.complete(claim, targetArchive.id)).toMatchObject({
      id: job.id,
      status: "completed",
      originalDiscArchiveId: targetArchive.id,
      progressPercent: 100,
    });
    expect(() => access.archiveJobs.requeue(job.id)).toThrow(
      InvalidStatusTransitionError,
    );
    access.close();
  });

  it("atomically claims both queues under repeated simultaneous contention", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const profile = access.encodingProfiles.create({
      key: "contention",
      displayName: "Contention",
      mediaDomain: "dvd_video",
      settings: {},
    });

    for (const queue of ["archive", "encode"] as const) {
      for (let round = 0; round < 3; round += 1) {
        const contentionDrive =
          queue === "archive"
            ? access.catalog.upsertOpticalDrive({
                devicePath: `/dev/archive-contention-${round}`,
                isEnabled: true,
                isPresent: true,
              })
            : drive;
        const disc = access.catalog.registerDetectedDisc({
          opticalDriveId: contentionDrive.id,
          discKind: "dvd",
          fingerprint: `${queue}-contention-disc-${round}`,
        });
        let queuedId: string;
        access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
        access.catalog.updateDetectedDiscStatus(disc.id, "approved");
        if (queue === "archive") {
          queuedId = access.archiveJobs.enqueue({
            detectedDiscId: disc.id,
          }).id;
        } else {
          const archive = access.catalog.createOriginalDiscArchive({
            detectedDiscId: disc.id,
            discKind: "dvd",
            archiveFormat: "iso",
            archivePath: `/media/originals/Contention ${round}.iso`,
            fingerprint: `${queue}-contention-disc-${round}`,
          });
          const item = access.catalog.createMediaItem({
            kind: "movie",
            title: `Contention ${round}`,
          });
          const selection = access.catalog.createDiscSelection({
            originalDiscArchiveId: archive.id,
            mediaItemId: item.id,
            kind: "main_feature",
          });
          access.catalog.completeCatalogReview(archive.id);
          queuedId = access.encodeJobs.enqueue({
            discSelectionId: selection.id,
            encodingProfileId: profile.id,
            outputPath: `/media/movies/Contention ${round}.mkv`,
          }).id;
        }

        const results = await runBarrierWorkers({
          count: 6,
          databasePath,
          mode: "claim",
          queue,
        });
        const winners = results.filter(
          (result): result is { id: string; claimToken: string } =>
            typeof result === "object" &&
            result !== null &&
            "claimToken" in result,
        );
        expect(winners).toEqual([
          expect.objectContaining({ id: queuedId }),
        ]);
        expect(winners[0]?.claimToken).toBeTruthy();
      }
    }
    access.close();
  });

  it("claims only one cross-drive Archive Job for each fingerprint", async () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    for (let round = 0; round < 3; round += 1) {
      const firstDrive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/cross-drive-${round}-a`,
        isEnabled: true,
        isPresent: true,
      });
      const secondDrive = access.catalog.upsertOpticalDrive({
        devicePath: `/dev/cross-drive-${round}-b`,
        isEnabled: true,
        isPresent: true,
      });
      const fingerprint = `cross-drive-claim-${round}`;
      const firstDisc = access.catalog.registerDetectedDisc({
        opticalDriveId: firstDrive.id,
        discKind: "dvd",
        fingerprint,
      });
      const secondDisc = access.catalog.registerDetectedDisc({
        opticalDriveId: secondDrive.id,
        discKind: "dvd",
        fingerprint,
      });
      for (const disc of [firstDisc, secondDisc]) {
        access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
        access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      }
      const jobIds = [
        access.archiveJobs.enqueue({ detectedDiscId: firstDisc.id }).id,
        access.archiveJobs.enqueue({ detectedDiscId: secondDisc.id }).id,
      ];

      const results = await runBarrierWorkers({
        count: 6,
        databasePath,
        mode: "claim",
        queue: "archive",
      });
      const winners = results.filter(
        (result): result is { id: string; claimToken: string } =>
          typeof result === "object" &&
          result !== null &&
          "claimToken" in result,
      );
      expect(winners).toHaveLength(1);
      expect(jobIds).toContain(winners[0]?.id);
      expect(
        access.archiveJobs
          .list(["running"])
          .filter((job) => jobIds.includes(job.id)),
      ).toHaveLength(1);
      expect(
        access.archiveJobs
          .list(["queued"])
          .filter((job) => jobIds.includes(job.id)),
      ).toHaveLength(1);
    }
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
      kind: "main_feature",
    });
    access.catalog.completeCatalogReview(archive.id);
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

  it("keeps encode jobs unique by selection and profile version and requeues them", () => {
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
      kind: "main_feature",
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

    access.catalog.completeCatalogReview(archive.id);
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
      status: "queued",
      progressPhase: null,
      progressPercent: 0,
      progressEtaSeconds: null,
      replaceExistingOutput: false,
      claimedBy: null,
      outputPath: "/media/movies/Movie/Movie-remastered.mkv",
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
    expect(() =>
      access.encodeJobs.enqueue({
        discSelectionId: job.discSelectionId,
        encodingProfileId: job.encodingProfileId,
        outputPath: recoveredOutputPath,
      }),
    ).toThrow(/failed.*queued/i);
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
    access.encodeJobs.enqueue({
      discSelectionId: job.discSelectionId,
      encodingProfileId: job.encodingProfileId,
      outputPath: recoveredOutputPath,
    });
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
