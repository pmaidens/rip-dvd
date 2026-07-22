import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDataAccess,
  DomainInvariantError,
  InvalidStatusTransitionError,
} from "./index.js";

const temporaryDirectories: string[] = [];

type ConcurrentWorkerResult =
  | "ok"
  | { outcome: "archived" | "enqueued" | "rejected"; id?: string }
  | { id: string; claimToken: string }
  | null;

async function runBarrierWorkers({
  count,
  databasePath,
  mode,
  queue,
  operations,
}: {
  count: number;
  databasePath: string;
  mode: "claim" | "open" | "operation";
  queue?: "archive" | "encode";
  operations?: Array<Record<string, unknown>>;
}): Promise<ConcurrentWorkerResult[]> {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = Array.from(
    { length: count },
    (_, index) =>
      new Worker(
        new URL("../test/concurrency-worker.mjs", import.meta.url),
        {
          execArgv: ["--no-warnings"],
          workerData: {
            barrier,
            databasePath,
            mode,
            queue,
            workerId: `${queue ?? mode}-worker-${index}`,
            ...operations?.[index],
          },
        },
      ),
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

function createTestDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-data-access-"));
  temporaryDirectories.push(directory);
  return join(directory, "rip-dvd.sqlite");
}

function openTestDatabase(databasePath = createTestDatabasePath()) {
  return createDataAccess({ databasePath });
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("data-access facade", () => {
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
    expect(identifierTables).toHaveLength(8);
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
      sourceKey: "dvd:title:1",
      kind: "dvd_title",
      titleNumber: 1,
    });
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: trailer.id,
        sourceKey: "dvd:title:1",
        kind: "dvd_title",
        titleNumber: 1,
      }),
    ).toThrow();

    const profileV1 = access.catalog.createEncodingProfile({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      version: 1,
      settings: { preset: "Fast 480p30" },
    });
    const profileV2 = access.catalog.createEncodingProfile({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      version: 2,
      settings: { preset: "HQ 480p30" },
    });
    expect(profileV2.id).not.toBe(profileV1.id);
    const audioProfileV1 = access.catalog.createEncodingProfile({
      key: "dvd-library",
      displayName: "Audio library",
      mediaDomain: "audio",
      version: 1,
      settings: { codec: "flac" },
    });
    expect(audioProfileV1.id).not.toBe(profileV1.id);
    expect(
      access.catalog.findEncodingProfile({
        key: "dvd-library",
        mediaDomain: "audio",
        version: 1,
      }),
    ).toEqual(expect.objectContaining({ id: audioProfileV1.id }));
    expect(() =>
      access.catalog.createEncodingProfile({
        key: "dvd-library",
        displayName: "Duplicate",
        mediaDomain: "dvd_video",
        version: 2,
        settings: {},
      }),
    ).toThrow();

    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ id: archive.id, fingerprint: "disc-fingerprint" }),
    ]);
    expect(selection.mediaItemId).toBe(movie.id);
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
    for (const disc of [firstDisc, secondDisc]) {
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    }
    const duplicateJob = access.archiveJobs.enqueue({
      detectedDiscId: secondDisc.id,
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
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "approved");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "approved");
    const firstJob = access.archiveJobs.enqueue({
      detectedDiscId: firstDisc.id,
      priority: 1,
    });
    const secondJob = access.archiveJobs.enqueue({
      detectedDiscId: secondDisc.id,
      priority: 10,
    });

    const secondClaim = access.archiveJobs.claimNext("archive-worker-1");
    const firstClaim = access.archiveJobs.claimNext("archive-worker-2");
    expect(secondClaim?.id).toBe(secondJob.id);
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

  it("requires current explicit approval to enqueue or claim archive work", () => {
    const databasePath = createTestDatabasePath();
    const access = openTestDatabase(databasePath);
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
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

        const transitionOperation =
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
          count: 2,
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
      isPresent: true,
    });
    const profile = access.catalog.createEncodingProfile({
      key: "contention",
      displayName: "Contention",
      mediaDomain: "dvd_video",
      version: 1,
      settings: {},
    });

    for (const queue of ["archive", "encode"] as const) {
      for (let round = 0; round < 3; round += 1) {
        const disc = access.catalog.registerDetectedDisc({
          opticalDriveId: drive.id,
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
            result !== null && result !== "ok",
        );
        expect(winners).toEqual([
          expect.objectContaining({ id: queuedId }),
        ]);
        expect(winners[0]?.claimToken).toBeTruthy();
      }
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
    const profile = access.catalog.createEncodingProfile({
      key: "dvd-library",
      displayName: "DVD library",
      mediaDomain: "dvd_video",
      version: 1,
      settings: { preset: "Fast 480p30" },
    });

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
