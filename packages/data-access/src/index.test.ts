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
  InvalidStatusTransitionError,
  MAX_DVD_TITLES,
  StaleJobAttemptError,
} from "./index.js";
import type {
  DetectedDiscId,
  DiscKind,
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
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, count);
  return Promise.all(results);
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
    expect(identifierTables).toHaveLength(9);
    expect(
      identifierTables.every(({ name, sql }) =>
        sql.includes(`${name}_id_not_null`),
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
      sourceKey: "dvd:main-feature",
      kind: "main_feature",
    });
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        sourceKey: "dvd:main-feature",
        kind: "main_feature",
      }),
    ).toThrow();

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, fingerprint: "disc-fingerprint" }),
    ]);
    expect(selection.mediaItemId).toBe(movie.id);
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
      sourceKey: "dvd:main-feature",
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
      ]),
    );
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
        sourceKey: "dvd:main-feature",
        kind: "main_feature",
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        sourceKey: "dvd:title:2",
        kind: "dvd_title",
        titleNumber: 2,
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: firstEpisode.id,
        sourceKey: "dvd:title:1:chapters:1-4",
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      }),
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: secondEpisode.id,
        sourceKey: "dvd:title:1:chapters:5-8",
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
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: firstEpisode.id,
        sourceKey: "dvd:title:1:chapters:8-9",
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
        sourceKey: "dvd:title:3",
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
          "select name from __drizzle_migrations order by id desc limit 3",
        )
        .all(),
    ).toEqual([
      {
        name: "20260803175923_gorgeous_wendell_rand",
      },
      {
        name: "20260803050348_pretty_living_mummy",
      },
      {
        name: "20260802190921_optical-drive-configuration-default-resolved",
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
          sourceKey: `invalid:title:${String(titleNumber)}`,
          kind: "dvd_title",
          titleNumber,
        }),
      ).toThrow(DomainInvariantError);
    }
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        sourceKey: "invalid:fractional-chapter-start",
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
        sourceKey: "invalid:fractional-chapter-end",
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
            sourceKey: "dvd:main-feature",
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
      sourceKey: "dvd:main-feature",
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
    access.encodeJobs.updateProgress(firstClaim, 10);
    access.encodeJobs.updateProgress(firstClaim, 11);
    access.encodeJobs.updateProgress(firstClaim, 12);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, progressPercent: 10 }),
    ]);
    vi.advanceTimersByTime(1_000);
    access.encodeJobs.updateProgress(firstClaim, 12);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, progressPercent: 12 }),
    ]);
    access.encodeJobs.updateProgress(firstClaim, 17);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, progressPercent: 17 }),
    ]);
    access.encodeJobs.updateProgress(firstClaim, 18);
    expect(access.encodeJobs.complete(firstClaim)).toMatchObject({
      status: "completed",
      progressPercent: 100,
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
      progressPercent: 0,
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
    access.encodeJobs.updateProgress(secondClaim, 16);
    access.encodeJobs.updateProgress(secondClaim, 17);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: job.id, progressPercent: 16 }),
    ]);
    expect(access.encodeJobs.fail(secondClaim, "encode failed")).toMatchObject({
      status: "failed",
      progressPercent: 17,
      errorMessage: "encode failed",
    });
    expect(access.encodeJobs.list()).toHaveLength(1);
    access.close();
  });
});
