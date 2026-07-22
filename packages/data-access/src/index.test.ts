import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDataAccess, InvalidStatusTransitionError } from "./index.js";

const temporaryDirectories: string[] = [];

function createTestDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-data-access-"));
  temporaryDirectories.push(directory);
  return join(directory, "rip-dvd.sqlite");
}

function openTestDatabase(databasePath = createTestDatabasePath()) {
  return createDataAccess({ databasePath });
}

afterEach(() => {
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
    const firstJob = access.archiveJobs.enqueue({
      detectedDiscId: firstDisc.id,
      priority: 1,
    });
    const secondJob = access.archiveJobs.enqueue({
      detectedDiscId: secondDisc.id,
      priority: 10,
    });

    expect(access.archiveJobs.claimNext("archive-worker-1")?.id).toBe(
      secondJob.id,
    );
    expect(access.archiveJobs.claimNext("archive-worker-2")?.id).toBe(
      firstJob.id,
    );
    expect(access.archiveJobs.claimNext("archive-worker-3")).toBeNull();
    expect(() => access.archiveJobs.requeue(firstJob.id)).toThrow(
      InvalidStatusTransitionError,
    );

    const failed = access.archiveJobs.fail(firstJob.id, "drive read failed");
    expect(failed).toMatchObject({
      status: "failed",
      errorMessage: "drive read failed",
    });
    expect(access.archiveJobs.requeue(firstJob.id)).toMatchObject({
      status: "queued",
      claimedBy: null,
      errorMessage: null,
    });
    access.close();
  });

  it("atomically claims a queued job across independent SQLite connections", () => {
    const databasePath = createTestDatabasePath();
    const firstAccess = openTestDatabase(databasePath);
    const secondAccess = openTestDatabase(databasePath);
    const drive = firstAccess.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = firstAccess.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "atomic-claim-disc",
    });
    const queued = firstAccess.archiveJobs.enqueue({ detectedDiscId: disc.id });

    expect(firstAccess.archiveJobs.claimNext("archive-worker-1")?.id).toBe(
      queued.id,
    );
    expect(secondAccess.archiveJobs.claimNext("archive-worker-2")).toBeNull();

    firstAccess.close();
    secondAccess.close();
  });

  it("keeps encode jobs unique by selection and profile version and requeues them", () => {
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

    expect(access.encodeJobs.claimNext("encode-worker-1")?.id).toBe(job.id);
    expect(access.encodeJobs.claimNext("encode-worker-2")).toBeNull();
    expect(access.encodeJobs.complete(job.id)).toMatchObject({
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
    expect(access.encodeJobs.list()).toHaveLength(1);
    access.close();
  });
});
