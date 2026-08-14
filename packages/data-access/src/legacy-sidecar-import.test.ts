import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DomainInvariantError,
} from "./errors.js";
import {
  completeCatalogReview,
  startArchiveJobForTest,
} from "./catalog.test-support.js";
import { decodeDvdTitleMap } from "./dvd-scan.js";
import { createDataAccess } from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";
import { createTemporaryDirectoryFixture } from "./legacy-sidecar.test-support.js";

const temporaryDirectories = createTemporaryDirectoryFixture();

function createFixture() {
  const root = temporaryDirectories.create("rip-dvd-legacy-import-");
  const originalsLibraryPath = join(root, "originals");
  const archiveDirectory = join(originalsLibraryPath, "Example Movie (2001)");
  const archivePath = join(archiveDirectory, "Example Movie (2001).iso");
  const sidecarPath = join(
    archiveDirectory,
    "Example Movie (2001).rip-dvd.json",
  );
  const movieOutputPath = join(
    root,
    "movies",
    "Example Movie (2001)",
    "Example Movie (2001).mkv",
  );
  const trailerOutputPath = join(
    root,
    "movies",
    "Example Movie (2001)",
    "extras",
    "Trailer.mkv",
  );
  mkdirSync(archiveDirectory, { recursive: true });
  mkdirSync(join(root, "movies", "Example Movie (2001)"), {
    recursive: true,
  });
  mkdirSync(join(root, "movies", "Example Movie (2001)", "extras"), {
    recursive: true,
  });
  writeFileSync(archivePath, "preserved DVD image");
  writeFileSync(movieOutputPath, "completed movie encode");
  writeFileSync(
    sidecarPath,
    JSON.stringify({
      schema_version: 2,
      archive_status: "ready",
      source: archivePath,
      title: "Example Movie",
      year: "2001",
      disc_title: "EXAMPLE_MOVIE",
      disc_fingerprint: "example-disc-fingerprint",
      titles: [
        {
          number: 1,
          seconds: 6_000,
          chapters: 12,
          audio_streams: 2,
          subtitles: 3,
        },
        {
          number: 2,
          seconds: 240,
          chapters: 1,
          audio_streams: 1,
          subtitles: 0,
        },
      ],
      jobs: [
        {
          label: "Movie: Example Movie",
          source: archivePath,
          output: movieOutputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        },
        {
          label: "Extra 1: Trailer",
          source: archivePath,
          output: trailerOutputPath,
          preset: "HQ 480p30 Surround",
          selection: "title",
          title_number: 2,
        },
      ],
    }),
  );

  const databasePath = join(root, "catalog.sqlite");
  const access = createLegacySidecarDataAccess({ databasePath });
  return {
    access,
    archivePath,
    databasePath,
    movieOutputPath,
    originalsLibraryPath,
    sidecarPath,
    trailerOutputPath,
  };
}

const SAME_DVD_CONTENT_ID =
  "sha256:c173ea0693af01962a78a28bb2106b93920c0381b6dc06b9fb3f4c71a2e65cef";

function createUnreconciledLegacyDvdFixture(
  fingerprint = SAME_DVD_CONTENT_ID,
  { legacySizeBytes }: { legacySizeBytes?: number | null } = {},
) {
  const root = temporaryDirectories.create(
    "rip-dvd-unreconciled-legacy-identity-",
  );
  const originalsLibraryPath = join(root, "originals");
  const archivePath = join(originalsLibraryPath, "Same DVD.iso");
  const sidecarPath = join(
    originalsLibraryPath,
    "Same DVD.rip-dvd.json",
  );
  const databasePath = join(root, "catalog.sqlite");
  mkdirSync(originalsLibraryPath, { recursive: true });
  writeFileSync(archivePath, "same dvd bytes");
  writeFileSync(sidecarPath, JSON.stringify({
    schema_version: 2,
    archive_status: "ready",
    source: archivePath,
    title: "Same DVD",
    disc_title: "SAME_DISC",
    disc_fingerprint:
      "f29f3d4248b6da5db282553aa8b2edba7c0e71631e23412919a37fc526879765",
    titles: [],
    jobs: [],
  }));

  const importer = createLegacySidecarDataAccess({ databasePath });
  expect(importer.legacySidecars.importLibrary({ originalsLibraryPath }))
    .toMatchObject({ issues: [], sidecarsImported: 1 });
  importer.close();

  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec("delete from original_disc_archive_content_ids");
  if (legacySizeBytes !== undefined) {
    sqlite.prepare(
      "update original_disc_archives set size_bytes = ?",
    ).run(legacySizeBytes);
  }
  sqlite.close();

  const access = createDataAccess({ databasePath });
  const drive = access.catalog.reconcileOpticalDrives([{
    devicePath: "/dev/sr0",
    displayName: "Current drive",
    isConfiguredDevice: true,
  }])[0]!;
  const observation = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
  });
  const disc = access.catalog.updateDetectedDiscStatus(
    observation.id,
    "scanned",
  );

  return { access, archivePath, databasePath, disc, drive };
}

afterEach(() => {
  temporaryDirectories.cleanup();
});

describe("legacy sidecar import", () => {
  it("fails approval closed while upgraded legacy DVD identities are unresolved", () => {
    const fixture = createUnreconciledLegacyDvdFixture();

    expect(() =>
      fixture.access.archiveRequests.create({ detectedDiscId: fixture.disc.id }),
    ).toThrow(DomainInvariantError);
    expect(fixture.access.catalog.listDetectedDiscs(["scanned"]))
      .toEqual([expect.objectContaining({ id: fixture.disc.id })]);
    expect(fixture.access.archiveJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("fails approval closed for an upgraded NULL-size legacy DVD identity", () => {
    const fixture = createUnreconciledLegacyDvdFixture(
      SAME_DVD_CONTENT_ID,
      { legacySizeBytes: null },
    );

    expect(() =>
      fixture.access.archiveRequests.create({ detectedDiscId: fixture.disc.id }),
    ).toThrow(DomainInvariantError);
    expect(fixture.access.catalog.listDetectedDiscs(["scanned"]))
      .toEqual([expect.objectContaining({ id: fixture.disc.id })]);
    expect(fixture.access.catalog.listOriginalDiscArchives())
      .toEqual([expect.objectContaining({ sizeBytes: null })]);
    fixture.access.close();
  });

  it("fails the generic approved transition closed for an upgraded NULL-size legacy DVD identity", () => {
    const fixture = createUnreconciledLegacyDvdFixture(
      SAME_DVD_CONTENT_ID,
      { legacySizeBytes: null },
    );

    expect(() =>
      fixture.access.catalog.updateDetectedDiscStatus(
        fixture.disc.id,
        "approved",
      ),
    ).toThrow(DomainInvariantError);
    expect(fixture.access.catalog.listDetectedDiscs(["scanned"]))
      .toEqual([expect.objectContaining({ id: fixture.disc.id })]);
    expect(fixture.access.archiveJobs.list()).toEqual([]);
    expect(fixture.access.catalog.listOriginalDiscArchives())
      .toEqual([expect.objectContaining({ sizeBytes: null })]);
    fixture.access.close();
  });

  it("allows approval and claim after bounded legacy identity reconciliation", () => {
    const fingerprint = `sha256:${"0".repeat(64)}`;
    const fixture = createUnreconciledLegacyDvdFixture(fingerprint, {
      legacySizeBytes: null,
    });
    const timestamp = Date.now();
    const sqlite = new DatabaseSync(fixture.databasePath);
    for (let index = 0; index < 4; index += 1) {
      const archivePath = join(
        dirname(fixture.archivePath),
        `Additional Legacy ${index}.iso`,
      );
      writeFileSync(archivePath, `legacy-${index}`);
      sqlite.prepare(`
        insert into detected_discs (
          id, optical_drive_id, disc_kind, fingerprint, status,
          detected_at, created_at, updated_at
        ) values (?, ?, 'dvd', ?, 'archived', ?, ?, ?)
      `).run(
        `additional-legacy-disc-${index}`,
        fixture.drive.id,
        `additional-legacy-fingerprint-${index}`,
        timestamp,
        timestamp,
        timestamp,
      );
      sqlite.prepare(`
        insert into original_disc_archives (
          id, detected_disc_id, disc_kind, archive_format, archive_path,
          fingerprint, size_bytes, archived_at, created_at, updated_at
        ) values (?, ?, 'dvd', 'iso', ?, ?, ?, ?, ?, ?)
      `).run(
        `additional-legacy-archive-${index}`,
        `additional-legacy-disc-${index}`,
        realpathSync(archivePath),
        `additional-legacy-fingerprint-${index}`,
        8,
        timestamp,
        timestamp,
        timestamp,
      );
    }
    sqlite.close();
    expect(() =>
      fixture.access.archiveRequests.create({ detectedDiscId: fixture.disc.id }),
    ).toThrow(DomainInvariantError);

    expect(() => fixture.access.catalog.registerDetectedDisc({
      opticalDriveId: fixture.drive.id,
      discKind: "dvd",
      fingerprint,
      sizeBytes: 15,
    })).toThrow(/bounded progress/i);
    const progressed = new DatabaseSync(fixture.databasePath);
    expect(progressed.prepare(
      "select count(*) as count from original_disc_archive_content_ids",
    ).get()).toEqual({ count: 4 });
    progressed.close();

    expect(fixture.access.catalog.registerDetectedDisc({
      opticalDriveId: fixture.drive.id,
      discKind: "dvd",
      fingerprint,
      sizeBytes: 15,
    })).toMatchObject({ id: fixture.disc.id, status: "scanned" });
    expect(fixture.access.catalog.listOriginalDiscArchives())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          archivePath: realpathSync(fixture.archivePath),
          sizeBytes: 14,
        }),
      ]));
    expect(
      startArchiveJobForTest(
        fixture.access,
        fixture.disc,
        "reconciled-worker",
      ),
    ).toMatchObject({ status: "running" });
    fixture.access.close();
  });

  it("requires operator remediation when a NULL-size legacy identity cannot be proven", () => {
    const fixture = createUnreconciledLegacyDvdFixture(
      SAME_DVD_CONTENT_ID,
      { legacySizeBytes: null },
    );
    truncateSync(fixture.archivePath, 0);

    expect(() => fixture.access.catalog.registerDetectedDisc({
      opticalDriveId: fixture.drive.id,
      discKind: "dvd",
      fingerprint: SAME_DVD_CONTENT_ID,
      sizeBytes: 14,
    })).toThrow(/operator remediation/i);
    expect(() =>
      fixture.access.archiveRequests.create({ detectedDiscId: fixture.disc.id }),
    ).toThrow(DomainInvariantError);
    expect(fixture.access.catalog.listOriginalDiscArchives())
      .toEqual([expect.objectContaining({ sizeBytes: null })]);
    fixture.access.close();
  });

  it.each([
    ["stored-size", undefined],
    ["NULL-size", null],
  ] as const)(
    "fails an upgraded %s pending Archive Request start closed until identity reconciliation",
    (_sizeState, legacySizeBytes) => {
      const fixture = createUnreconciledLegacyDvdFixture(
        SAME_DVD_CONTENT_ID,
        { legacySizeBytes },
      );
      const timestamp = Date.now();
      const sqlite = new DatabaseSync(fixture.databasePath);
      sqlite.prepare(
        "update detected_discs set status = 'approved', updated_at = ? where id = ?",
      ).run(timestamp, fixture.disc.id);
      sqlite.prepare(`
        insert into archive_requests (
          id, detected_disc_id, status, created_at, updated_at
        ) values (?, ?, 'pending', ?, ?)
      `).run(
        "unreconciled-upgrade-request",
        fixture.disc.id,
        timestamp,
        timestamp,
      );
      sqlite.close();

      const started = fixture.access.discInspections.beginOrResume({
        opticalDriveId: fixture.drive.id,
        mediaGeneration: "unreconciled-upgrade-generation",
      });
      const inspection = fixture.access.discInspections.record(started.claim!, {
        type: "complete",
        detectedDiscId: fixture.disc.id,
      });
      expect(() =>
        fixture.access.archiveJobs.startForInspection(
          inspection.id,
          "upgrade-worker",
        ),
      ).toThrow(DomainInvariantError);
      expect(fixture.access.archiveJobs.list()).toEqual([]);
      expect(fixture.access.archiveRequests.list(["pending"]))
        .toEqual([
          expect.objectContaining({ id: "unreconciled-upgrade-request" }),
        ]);
      fixture.access.close();
    },
  );

  it.each([
    ["stored-size", undefined],
    ["NULL-size", null],
  ] as const)(
    "reconciles an upgraded %s identity before publication and refuses duplicate provenance",
    (_sizeState, legacySizeBytes) => {
      const fixture = createUnreconciledLegacyDvdFixture(
        SAME_DVD_CONTENT_ID,
        { legacySizeBytes },
      );
      const timestamp = Date.now();
      const sqlite = new DatabaseSync(fixture.databasePath);
      sqlite.prepare(
        "update detected_discs set status = 'approved', updated_at = ? where id = ?",
      ).run(timestamp, fixture.disc.id);
      sqlite.prepare(`
        insert into archive_requests (
          id, detected_disc_id, status, created_at, updated_at
        ) values (?, ?, 'running', ?, ?)
      `).run(
        "unreconciled-publication-request",
        fixture.disc.id,
        timestamp,
        timestamp,
      );
      sqlite.prepare(`
        insert into archive_jobs (
          id, archive_request_id, detected_disc_id, attempt_ordinal,
          status, progress_phase,
          claimed_by, claim_token, claimed_at,
          started_at, created_at, updated_at
        ) values (?, ?, ?, 1, 'running', 'preparing', ?, ?, ?, ?, ?, ?)
      `).run(
        "unreconciled-publication-job",
        "unreconciled-publication-request",
        fixture.disc.id,
        "upgrade-worker",
        "unreconciled-publication-claim",
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
      sqlite.close();
      const persistedClaim = fixture.access.archiveJobs.list(["running"])[0];
      if (
        persistedClaim?.status !== "running" ||
        persistedClaim.claimToken === null
      ) {
        throw new Error("Expected the upgraded Archive Job to be running");
      }
      const claim = {
        ...persistedClaim,
        status: "running" as const,
        claimToken: persistedClaim.claimToken,
      };

      expect(() =>
        fixture.access.archiveJobs.publish(claim, {
          archivePath: join(dirname(fixture.archivePath), "Duplicate.iso"),
          sizeBytes: 14,
        }),
      ).toThrow(DomainInvariantError);
      expect(fixture.access.archiveJobs.list(["running"]))
        .toEqual([expect.objectContaining({ id: claim.id })]);
      expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
        expect.objectContaining({
          archivePath: realpathSync(fixture.archivePath),
          sizeBytes: 14,
        }),
      ]);
      fixture.access.close();
    },
  );

  it.each([
    ["stored legacy fingerprint", "fresh import"],
    ["current content-ID alias", "fresh import"],
    ["stored legacy fingerprint", "reviewed-schema reopen"],
    ["current content-ID alias", "reviewed-schema reopen"],
  ] as const)(
    "suppresses an Archive Job when original archive lookup uses its %s after %s",
    (lookupRelation, mode) => {
      const root = temporaryDirectories.create(
        "rip-dvd-legacy-current-identity-",
      );
      const originalsLibraryPath = join(root, "originals");
      const archivePath = join(originalsLibraryPath, "Same DVD.iso");
      const sidecarPath = join(
        originalsLibraryPath,
        "Same DVD.rip-dvd.json",
      );
      const databasePath = join(root, "catalog.sqlite");
      const legacyFingerprint =
        "f29f3d4248b6da5db282553aa8b2edba7c0e71631e23412919a37fc526879765";
      mkdirSync(originalsLibraryPath, { recursive: true });
      writeFileSync(archivePath, "same dvd bytes");
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        archive_status: "ready",
        source: archivePath,
        title: "Same DVD",
        disc_title: "SAME_DISC",
        disc_fingerprint: legacyFingerprint,
        titles: [{
          number: 1,
          seconds: 3_600,
          chapters: 10,
          audio_streams: 1,
          subtitles: 0,
        }],
        jobs: [],
      }));
      const importer = createLegacySidecarDataAccess({ databasePath });
      const report = importer.legacySidecars.importLibrary({
        originalsLibraryPath,
      });
      expect(report.issues).toEqual([]);
      expect(report.sidecarsImported).toBe(1);

      let access = importer;
      if (mode === "reviewed-schema reopen") {
        importer.close();
        const sqlite = new DatabaseSync(databasePath);
        try {
          sqlite.exec("delete from original_disc_archive_content_ids");
        } catch (error) {
          if (!String(error).includes("no such table")) {
            throw error;
          }
        } finally {
          sqlite.close();
        }
        access = createDataAccess({ databasePath }) as typeof importer;
      }

      const drive = access.catalog.reconcileOpticalDrives([
        {
          devicePath: "/dev/sr0",
          displayName: "Current drive",
          isConfiguredDevice: true,
        },
      ])[0]!;
      const currentContentId =
        "sha256:c173ea0693af01962a78a28bb2106b93920c0381b6dc06b9fb3f4c71a2e65cef";
      const observedFingerprint =
        lookupRelation === "stored legacy fingerprint"
          ? legacyFingerprint
          : currentContentId;
      const observation = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: observedFingerprint,
        ...(lookupRelation === "current content-ID alias"
          ? {
              scanData: {
                schemaVersion: 2 as const,
                contentId: currentContentId,
                titles: [{
                  number: 1,
                  durationSeconds: 3_600,
                  chapters: 10,
                  audioStreams: [],
                  subtitles: [],
                }],
              },
              sizeBytes: 14,
            }
          : {}),
      });
      const reviewed =
        observation.status === "detected"
          ? access.catalog.updateDetectedDiscStatus(observation.id, "scanned")
          : observation;
      let approvalError: unknown;
      try {
        access.archiveRequests.create({ detectedDiscId: reviewed.id });
      } catch (error) {
        approvalError = error;
      }
      const claim = access.archiveJobs.list(["running"])[0] ?? null;

      expect(reviewed.status).toBe("archived");
      expect(approvalError).toBeInstanceOf(DomainInvariantError);
      expect(claim).toBeNull();
      expect(access.catalog.listOriginalDiscArchives()).toEqual([
        expect.objectContaining({
          archivePath: realpathSync(archivePath),
          fingerprint: legacyFingerprint,
        }),
      ]);
      access.close();
    },
  );

  it("rejects a nonexistent originals library", () => {
    const root = temporaryDirectories.create("rip-dvd-missing-library-");
    const access = createLegacySidecarDataAccess({ databasePath: join(root, "catalog.sqlite") });

    expect(() =>
      access.legacySidecars.importLibrary({
        originalsLibraryPath: join(root, "does-not-exist"),
      }),
    ).toThrow(/originals library does not exist/i);

    access.close();
  });

  it.each([0, 9_000_000_001])(
    "imports a %i-byte legacy archive outside the current DVD hashing policy",
    (sizeBytes) => {
      const fixture = createFixture();
      truncateSync(fixture.archivePath, sizeBytes);

      const report = fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      });

      expect(report.issues).toEqual([]);
      expect(report.sidecarsImported).toBe(1);
      expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
        expect.objectContaining({
          archivePath: fixture.archivePath,
          sizeBytes,
        }),
      ]);
      fixture.access.close();
    },
  );

  it("rejects a legacy archive whose bytes already have current archive provenance", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-legacy-current-content-collision-",
    );
    const originalsLibraryPath = join(root, "originals");
    const currentArchivePath = join(originalsLibraryPath, "Current.iso");
    const legacyArchivePath = join(originalsLibraryPath, "Legacy.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Legacy.rip-dvd.json",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(currentArchivePath, "same dvd bytes");
    writeFileSync(legacyArchivePath, "same dvd bytes");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      archive_status: "ready",
      source: legacyArchivePath,
      title: "Legacy",
      disc_fingerprint:
        "f29f3d4248b6da5db282553aa8b2edba7c0e71631e23412919a37fc526879765",
      titles: [],
      jobs: [],
    }));
    const databasePath = join(root, "catalog.sqlite");
    const access = createLegacySidecarDataAccess({ databasePath });
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/current-drive",
      isPresent: true,
    });
    const contentId =
      "sha256:c173ea0693af01962a78a28bb2106b93920c0381b6dc06b9fb3f4c71a2e65cef";
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: currentArchivePath,
      fingerprint: contentId,
      sizeBytes: 14,
    });
    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec("delete from original_disc_archive_content_ids");
    sqlite.close();

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report.sidecarsImported).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate_record",
        message: expect.stringMatching(/contents.*different.*archive/i),
      }),
    ]));
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        archivePath: currentArchivePath,
        fingerprint: contentId,
      }),
    ]);
    access.close();
  });

  it.each(["direct", "symlink"] as const)(
    "refuses a %s source archive outside the selected originals library",
    (sourceKind) => {
      const root = temporaryDirectories.create(
        `rip-dvd-legacy-external-source-${sourceKind}-`,
      );
      const originalsLibraryPath = join(root, "originals");
      const externalArchivePath = join(root, "External.iso");
      const recordedArchivePath =
        sourceKind === "direct"
          ? externalArchivePath
          : join(originalsLibraryPath, "Linked.iso");
      const sidecarPath = join(
        originalsLibraryPath,
        "External.rip-dvd.json",
      );
      mkdirSync(originalsLibraryPath, { recursive: true });
      writeFileSync(externalArchivePath, "external archive");
      if (sourceKind === "symlink") {
        symlinkSync(externalArchivePath, recordedArchivePath);
      }
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        source: recordedArchivePath,
        title: "External",
        disc_fingerprint: `external-source-${sourceKind}`,
        jobs: [],
      }));
      const sidecarBytes = readFileSync(sidecarPath);
      const access = createLegacySidecarDataAccess({
        databasePath: join(root, "catalog.sqlite"),
      });

      const report = access.legacySidecars.importLibrary({
        originalsLibraryPath,
      });

      expect(report).toMatchObject({
        sidecarsFound: 1,
        sidecarsImported: 0,
        sidecarsSkipped: 1,
        issues: [expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(
            /source archive.*originals library|ancestor symlink/i,
          ),
          sidecarPath,
        })],
      });
      expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
      expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
      access.close();
    },
  );

  it("accepts an archive recorded through the explicitly selected library alias", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-legacy-selected-library-alias-",
    );
    const originalsLibraryPath = join(root, "originals");
    const originalsLibraryAlias = join(root, "originals-alias");
    const archivePath = join(originalsLibraryPath, "Aliased.iso");
    const recordedArchivePath = join(originalsLibraryAlias, "Aliased.iso");
    const outputPath = join(root, "movies", "Aliased.mkv");
    const sidecarPath = join(
      originalsLibraryPath,
      "Aliased.rip-dvd.json",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    symlinkSync(originalsLibraryPath, originalsLibraryAlias, "dir");
    writeFileSync(archivePath, "archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: recordedArchivePath,
      title: "Aliased",
      disc_fingerprint: "selected-library-alias-fingerprint",
      jobs: [{
        label: "Movie: Aliased",
        source: recordedArchivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath: originalsLibraryAlias,
    });

    expect(report.issues).toEqual([]);
    expect(report.sidecarsImported).toBe(1);
    expect(report.originalsLibraryPath).toBe(
      realpathSync(originalsLibraryPath),
    );
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ archivePath: realpathSync(archivePath) }),
    ]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    access.close();
  });

  it("imports a valid sidecar as catalog records and preserves legacy job state", () => {
    const fixture = createFixture();

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 1,
      issues: [],
    });
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        archivePath: fixture.archivePath,
        fingerprint: "example-disc-fingerprint",
      }),
    ]);
    expect(
      decodeDvdTitleMap(
        fixture.access.catalog.listDetectedDiscs(["archived"])[0]?.scanData,
      ),
    ).toEqual({
      schemaVersion: 2,
      contentId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      titles: [
        {
          number: 1,
          durationSeconds: 6_000,
          chapters: 12,
          audioStreams: [{ id: 0 }, { id: 1 }],
          subtitles: [{ id: 0 }, { id: 1 }, { id: 2 }],
        },
        {
          number: 2,
          durationSeconds: 240,
          chapters: 1,
          audioStreams: [{ id: 0 }],
          subtitles: [],
        },
      ],
    });
    expect(fixture.access.catalog.listDiscSelections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: { kind: "main_feature" },
        }),
        expect.objectContaining({
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        }),
      ]),
    );
    expect(fixture.access.catalog.listMediaItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "movie",
          title: "Example Movie",
          year: 2001,
        }),
        expect.objectContaining({ kind: "bonus_feature", title: "Trailer" }),
      ]),
    );
    expect(fixture.access.encodingProfiles.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ settings: { preset: "Fast 480p30" } }),
        expect.objectContaining({
          settings: { preset: "HQ 480p30 Surround" },
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputPath: fixture.movieOutputPath,
          status: "completed",
          progressPercent: 100,
        }),
        expect.objectContaining({
          outputPath: fixture.trailerOutputPath,
          status: "queued",
          progressPercent: 0,
        }),
      ]),
    );

    fixture.access.close();
  });

  it("keeps first-import jobs with one source and distinct media identities separate", () => {
    const fixture = createFixture();
    const alternateOutputPath = join(
      dirname(fixture.trailerOutputPath),
      "Alternate extra.mkv",
    );
    const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    sidecar.jobs.push({
      label: "Extra 2: Alternate extra",
      source: fixture.archivePath,
      output: alternateOutputPath,
      preset: "Fast 480p30",
      selection: "title",
      title_number: 2,
    });
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));

    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ sidecarsImported: 1, issues: [] });
    const jobs = fixture.access.encodeJobs.list();
    const selections = fixture.access.catalog.listDiscSelections();
    const mediaItems = fixture.access.catalog.listMediaItems();
    const trailerJob = jobs.find(
      (job) => job.outputPath === fixture.trailerOutputPath,
    )!;
    const alternateJob = jobs.find(
      (job) => job.outputPath === alternateOutputPath,
    )!;
    const trailerSelection = selections.find(
      (selection) => selection.id === trailerJob.discSelectionId,
    )!;
    const alternateSelection = selections.find(
      (selection) => selection.id === alternateJob.discSelectionId,
    )!;

    expect(alternateSelection.id).not.toBe(trailerSelection.id);
    expect(mediaItems.find(
      (item) => item.id === trailerSelection.mediaItemId,
    )).toMatchObject({ title: "Trailer" });
    expect(mediaItems.find(
      (item) => item.id === alternateSelection.mediaItemId,
    )).toMatchObject({ title: "Alternate extra" });
    expect([trailerSelection, alternateSelection]).toEqual([
      expect.objectContaining({
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      }),
      expect.objectContaining({
        sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
      }),
    ]);

    fixture.access.close();
  });

  it("prefers durable output provenance over edited overlap metadata", () => {
    const fixture = createFixture();
    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ issues: [] });
    const movieJob = fixture.access.encodeJobs.list().find(
      (job) => job.outputPath === fixture.movieOutputPath,
    )!;
    const originalSelection = fixture.access.catalog.listDiscSelections({
      ids: [movieJob.discSelectionId],
    })[0]!;
    fixture.access.catalog.updateMediaItem(originalSelection.mediaItemId, {
      title: "Operator-edited movie",
      year: 2002,
    });
    const decoyMovie = fixture.access.catalog.createMediaItem({
      kind: "movie",
      title: "Example Movie",
      year: 2001,
    });
    fixture.access.catalog.createDiscSelection({
      originalDiscArchiveId: originalSelection.originalDiscArchiveId,
      mediaItemId: decoyMovie.id,
      sourceIdentity: { kind: "main_feature" },
    });

    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(fixture.access.encodeJobs.list().find(
      (job) => job.id === movieJob.id,
    )).toMatchObject({ discSelectionId: originalSelection.id });

    fixture.access.close();
  });

  it("recognizes captured retired provenance before active overlap ambiguity", () => {
    const fixture = createFixture();
    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ issues: [] });
    const movieJob = fixture.access.encodeJobs.list().find(
      (job) => job.outputPath === fixture.movieOutputPath,
    )!;
    const originalSelection = fixture.access.catalog.listDiscSelections({
      ids: [movieJob.discSelectionId],
    })[0]!;
    const archive = fixture.access.catalog.listOriginalDiscArchives({
      ids: [originalSelection.originalDiscArchiveId],
    })[0]!;
    fixture.access.catalog.correctDiscSelection(originalSelection.id, {
      originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt,
      mediaItemId: originalSelection.mediaItemId,
      sourceIdentity: { kind: "main_feature" },
    });
    const duplicateMovie = fixture.access.catalog.createMediaItem({
      kind: "movie",
      title: "Example Movie",
      year: 2001,
    });
    fixture.access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: duplicateMovie.id,
      sourceIdentity: { kind: "main_feature" },
    });

    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(fixture.access.encodeJobs.list().find(
      (job) => job.id === movieJob.id,
    )).toMatchObject({ discSelectionId: originalSelection.id });

    fixture.access.close();
  });

  it.each([
    {
      decoyTitle: "Alternate extra",
      expectedOutcome: "resolved" as const,
      name: "uses Media Item evidence to preserve exact-overlap selection provenance",
    },
    {
      decoyTitle: "Trailer",
      expectedOutcome: "ambiguous" as const,
      name: "fails closed when exact-overlap selection provenance is ambiguous",
    },
  ])("$name", ({ decoyTitle, expectedOutcome }) => {
    const fixture = createFixture();
    const contentId = `sha256:${"a".repeat(64)}`;
    const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8"));
    sidecar.disc_fingerprint = contentId;
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
    const drive = fixture.access.catalog.upsertOpticalDrive({
      devicePath: "/dev/exact-overlap-import",
      isPresent: true,
    });
    const disc = fixture.access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [
          {
            number: 1,
            durationSeconds: 6_000,
            chapters: 12,
            audioStreams: [],
            subtitles: [],
          },
          {
            number: 2,
            durationSeconds: 240,
            chapters: 1,
            audioStreams: [],
            subtitles: [],
          },
        ],
      },
    });
    fixture.access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    fixture.access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = fixture.access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: fixture.archivePath,
      fingerprint: contentId,
    });
    const movie = fixture.access.catalog.createMediaItem({
      kind: "movie",
      title: "Example Movie",
      year: 2001,
    });
    const trailer = fixture.access.catalog.createMediaItem({
      parentId: movie.id,
      kind: "bonus_feature",
      title: "Trailer",
    });
    const decoy = fixture.access.catalog.createMediaItem({
      parentId: movie.id,
      kind: "bonus_feature",
      title: decoyTitle,
    });
    const trailerSelection = fixture.access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: trailer.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
    });
    const decoySelection = fixture.access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: decoy.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
    });

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const importedTrailerJob = fixture.access.encodeJobs.list().find(
      (job) => job.outputPath === fixture.trailerOutputPath,
    );
    if (expectedOutcome === "resolved") {
      expect(report).toMatchObject({ sidecarsImported: 1, issues: [] });
      expect(importedTrailerJob).toMatchObject({
        discSelectionId: trailerSelection.id,
      });
      expect(fixture.access.encodeJobs.list().some(
        (job) => job.discSelectionId === decoySelection.id,
      )).toBe(false);
    } else {
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(
            /multiple Disc Selections.*unambiguous.*provenance/i,
          ),
        }),
      ]));
      expect(importedTrailerJob).toBeUndefined();
      expect(fixture.access.encodeJobs.list().some((job) =>
        job.discSelectionId === trailerSelection.id ||
        job.discSelectionId === decoySelection.id
      )).toBe(false);
    }

    fixture.access.close();
  });

  it("preserves accepted legacy Media Item title whitespace", () => {
    const fixture = createFixture();
    const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8"));
    sidecar.title = "  Example Movie  ";
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({ sidecarsImported: 1, issues: [] });
    const movie = fixture.access.catalog.listMediaItems().find(
      (item) => item.kind === "movie",
    )!;
    const bonus = fixture.access.catalog.listMediaItems().find(
      (item) => item.kind === "bonus_feature",
    )!;
    expect(movie.title).toBe("  Example Movie  ");
    expect(bonus.title).toBe("Trailer");
    expect(
      fixture.access.catalog.updateMediaItem(movie.id, { year: 2002 }),
    ).toMatchObject({ title: "  Example Movie  ", year: 2002 });
    fixture.access.close();
  });

  it("preserves imported completed Encode Job provenance and rejects ordinary historical repair", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const completedJob = fixture.access.encodeJobs.list(["completed"])[0];
    if (!completedJob) {
      throw new Error("Expected an imported completed Encode Job");
    }

    expect(() =>
      fixture.access.catalog.deleteDiscSelection(
        completedJob.discSelectionId,
      )
    ).toThrow(/cannot be deleted.*Encode Job history/i);
    expect(fixture.access.encodeJobs.list(["completed"])).toEqual([
      expect.objectContaining({
        id: completedJob.id,
        discSelectionId: completedJob.discSelectionId,
        outputPath: fixture.movieOutputPath,
      }),
    ]);
    expect(fixture.access.catalog.listDiscSelections({
      ids: [completedJob.discSelectionId],
    })).toHaveLength(1);
    const completedSelection = fixture.access.catalog.listDiscSelections({
      ids: [completedJob.discSelectionId],
    })[0];
    if (!completedSelection) {
      throw new Error("Expected imported completed Disc Selection");
    }
    expect(() =>
      fixture.access.catalog.repairDiscSelection(completedSelection.id, {
        originalDiscArchiveId: completedSelection.originalDiscArchiveId,
        mediaItemId: completedSelection.mediaItemId,
        sourceIdentity: { kind: "main_feature" },
      })
    ).toThrow(/ordinary Encode Job history.*retry identity/i);
    expect(fixture.access.catalog.listDiscSelections({
      ids: [completedSelection.id],
    })).toEqual([completedSelection]);
    const activeSelections = fixture.access.catalog.listDiscSelections({
      originalDiscArchiveId: completedSelection.originalDiscArchiveId,
    });
    expect(activeSelections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: completedSelection.id }),
      ]),
    );
    expect(
      fixture.access.encodeJobs.list().find((job) => job.id === completedJob.id),
    ).toEqual(completedJob);

    const reviewed = fixture.access.catalog.listOriginalDiscArchives({
      ids: [completedSelection.originalDiscArchiveId],
    })[0];
    if (!reviewed?.catalogReviewedAt) {
      throw new Error("Expected imported catalog review completion");
    }
    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsUpdated: 0,
      issues: [],
    });
    expect(fixture.access.catalog.listOriginalDiscArchives({
      ids: [completedSelection.originalDiscArchiveId],
    })).toEqual([
      expect.objectContaining({
        catalogReviewedAt: reviewed.catalogReviewedAt,
        legacyCutoverPending: false,
      }),
    ]);
    expect(
      fixture.access.encodeJobs.list().find((job) => job.id === completedJob.id),
    ).toEqual(completedJob);

    fixture.access.close();
  });

  it("reports an incompatible existing Encoding Profile without assigning it to an imported job", () => {
    const fixture = createFixture();
    const incompatibleProfile = fixture.access.encodingProfiles.create({
      key: "legacy-handbrake-fast-480p30-19c1d39008de",
      displayName: "Incompatible Fast 480p30",
      mediaDomain: "dvd_video",
      settings: { preset: "Very Slow 1080p" },
    });

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          jobIndex: 0,
          message: expect.stringMatching(/encoding profile.*incompatible/i),
          sidecarPath: fixture.sidecarPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          encodingProfileId: incompatibleProfile.id,
          outputPath: fixture.movieOutputPath,
        }),
      ]),
    );
    expect(
      fixture.access.encodingProfiles.find({
        key: incompatibleProfile.key,
        mediaDomain: "dvd_video",
        version: 1,
      }),
    ).toEqual(incompatibleProfile);
    fixture.access.close();
  });

  it("coerces schema-one integer strings consistently while deriving identity", () => {
    const root = temporaryDirectories.create("rip-dvd-schema-one-import-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Schema One.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Schema One.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Schema One.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "legacy archive");
    const archiveFileTime = new Date("1998-06-07T08:09:10.000Z");
    utimesSync(archivePath, archiveFileTime, archiveFileTime);
    const schemaOneSidecar = {
      schema_version: 1,
      source: archivePath,
      title: "Schema One",
      year: " 1998 ",
      disc_title: "SCHEMA_ONE",
      titles: [
        {
          number: " 1 ",
          seconds: " 5400 ",
          chapters: " 10 ",
          audio_streams: " 2 ",
          subtitles: " 1 ",
        },
      ],
      jobs: [
        {
          label: "Movie: Schema One",
          source: archivePath,
          output: outputPath,
          title_number: " 1 ",
        },
      ],
    };
    writeFileSync(sidecarPath, JSON.stringify(schemaOneSidecar));
    const beforeImport = readFileSync(sidecarPath, "utf8");
    const access = createLegacySidecarDataAccess({ databasePath: join(root, "catalog.sqlite") });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        archivedAt: archiveFileTime,
        fingerprint:
          "796dcf764a8d40802e7b99c87e720c857abef3feeb6e045eef75e3f93d1c3a55",
      }),
    ]);
    expect(access.catalog.listDiscSelections()).toEqual([
      expect.objectContaining({
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
    ]);
    expect(access.encodingProfiles.list()).toEqual([
      expect.objectContaining({ settings: { preset: "Fast 480p30" } }),
    ]);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeImport);

    access.close();
  });

  it("creates reviewed title and chapter selections from archived legacy scan evidence", () => {
    const root = temporaryDirectories.create("rip-dvd-legacy-review-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Legacy Review.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Legacy Review.rip-dvd.json",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "legacy review archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      archive_status: "ready",
      source: archivePath,
      title: "Legacy Review",
      disc_fingerprint: "legacy-review-fingerprint",
      titles: [{
        number: 1,
        seconds: 5_400,
        chapters: 8,
        audio_streams: 2,
        subtitles: 1,
      }],
      jobs: [],
    }));
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    const wholeTitleItem = access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Whole title",
    });
    const episode = access.catalog.createMediaItem({
      kind: "episode",
      title: "Chapter-bounded episode",
      episodeNumber: 1,
    });

    expect(
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: wholeTitleItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      }),
    ).toMatchObject({
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: episode.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 5,
          chapterEnd: 8,
        },
      }),
    ).toMatchObject({
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 5,
        chapterEnd: 8,
      },
    });
    expect(() =>
      access.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: access.catalog.createMediaItem({
          kind: "episode",
          title: "Out of bounds",
          episodeNumber: 2,
        }).id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 8,
          chapterEnd: 9,
        },
      })
    ).toThrow(/8 chapters/);
    expect(completeCatalogReview(access, archive.id)).toMatchObject({
      catalogReviewedAt: expect.any(Date),
    });
    access.close();
  });

  it("resolves relative schema-one paths from the legacy invocation directory", () => {
    const root = temporaryDirectories.create("rip-dvd-relative-import-");
    const archiveDirectory = join(root, "Originals", "Relative Movie");
    const archivePath = join(archiveDirectory, "Relative Movie.iso");
    const outputPath = join(root, "Movies", "Relative Movie.mkv");
    mkdirSync(archiveDirectory, { recursive: true });
    writeFileSync(archivePath, "relative archive");
    writeFileSync(
      join(archiveDirectory, "Relative Movie.rip-dvd.json"),
      JSON.stringify({
        schema_version: 1,
        source: "Originals/Relative Movie/Relative Movie.iso",
        title: "Relative Movie",
        disc_title: "RELATIVE_MOVIE",
        titles: [
          {
            number: 1,
            seconds: 5_400,
            chapters: 10,
            audio_streams: 2,
            subtitles: 1,
          },
        ],
        jobs: [
          {
            label: "Movie: Relative Movie",
            source: "Originals/Relative Movie/Relative Movie.iso",
            output: "Movies/Relative Movie.mkv",
            title_number: 1,
          },
        ],
      }),
    );
    const access = createLegacySidecarDataAccess({ databasePath: join(root, "catalog.sqlite") });
    const previousWorkingDirectory = process.cwd();

    let report;
    try {
      process.chdir(root);
      report = access.legacySidecars.importLibrary({
        originalsLibraryPath: "Originals",
      });
    } finally {
      process.chdir(previousWorkingDirectory);
    }

    expect(report).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ archivePath }),
    ]);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath }),
    ]);

    access.close();
  });

  it("reports ambiguous relative paths instead of guessing", () => {
    const root = temporaryDirectories.create("rip-dvd-ambiguous-import-");
    const sidecarDirectory = join(root, "Originals", "Ambiguous Movie");
    const invocationArchive = join(root, "Shared", "Ambiguous.iso");
    const sidecarRelativeArchive = join(
      sidecarDirectory,
      "Shared",
      "Ambiguous.iso",
    );
    mkdirSync(join(root, "Shared"), { recursive: true });
    mkdirSync(join(sidecarDirectory, "Shared"), { recursive: true });
    writeFileSync(invocationArchive, "invocation archive");
    writeFileSync(sidecarRelativeArchive, "sidecar-relative archive");
    writeFileSync(
      join(sidecarDirectory, "Ambiguous Movie.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        archive_status: "ready",
        source: "Shared/Ambiguous.iso",
        title: "Ambiguous Movie",
        disc_fingerprint: "ambiguous-fingerprint",
        titles: [],
        jobs: [],
      }),
    );
    const access = createLegacySidecarDataAccess({ databasePath: join(root, "catalog.sqlite") });
    const previousWorkingDirectory = process.cwd();

    let report;
    try {
      process.chdir(root);
      report = access.legacySidecars.importLibrary({
        originalsLibraryPath: "Originals",
      });
    } finally {
      process.chdir(previousWorkingDirectory);
    }

    expect(report).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: [
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/ambiguous/i),
        }),
      ],
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);

    access.close();
  });

  it("re-imports idempotently without replacing existing queue state", () => {
    const fixture = createFixture();
    const firstReport = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const firstJobs = fixture.access.encodeJobs.list();
    writeFileSync(fixture.trailerOutputPath, "completed trailer encode");

    const secondReport = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(firstReport.sidecarsImported).toBe(1);
    expect(secondReport).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsCreated: {
        originalDiscArchives: 0,
        discSelections: 0,
        mediaItems: 0,
        encodingProfiles: 0,
        encodeJobs: 0,
      },
      recordsUpdated: 0,
      issues: [],
    });
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining(
        firstJobs.map((job) =>
          expect.objectContaining({
            id: job.id,
            outputPath: job.outputPath,
            status: job.status,
          }),
        ),
      ),
    );
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(fixture.access.catalog.listDiscSelections()).toHaveLength(2);
    expect(fixture.access.catalog.listMediaItems()).toHaveLength(2);

    fixture.access.close();
  });

  it("normalizes legacy scan details captured by an earlier importer on retry", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const importedDisc = fixture.access.catalog.listDetectedDiscs([
      "archived",
    ])[0]!;
    const sqlite = new DatabaseSync(fixture.databasePath);
    sqlite.prepare(
      "update detected_discs set scan_data = ? where id = ?",
    ).run(JSON.stringify({
      discTitle: "EXAMPLE_MOVIE",
      legacySchemaVersion: 2,
      titles: [
        {
          number: 1,
          seconds: 6_000,
          chapters: 12,
          audio_streams: 2,
          subtitles: 3,
        },
        {
          number: 2,
          seconds: 240,
          chapters: 1,
          audio_streams: 1,
          subtitles: 0,
        },
      ],
    }), importedDisc.id);
    sqlite.close();

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const repairedDisc = fixture.access.catalog.listDetectedDiscs([
      "archived",
    ])[0]!;

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsUpdated: 1,
      issues: [],
    });
    expect(decodeDvdTitleMap(repairedDisc.scanData)).toMatchObject({
      schemaVersion: 2,
      titles: [
        { number: 1, durationSeconds: 6_000, chapters: 12 },
        { number: 2, durationSeconds: 240, chapters: 1 },
      ],
    });

    fixture.access.close();
  });

  it("recaptures a repaired job omitted by a partial parser failure", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const repairedOutputPath = join(
      fixture.originalsLibraryPath,
      "Repaired Feature.mkv",
    );
    const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    sidecar.jobs.push({ label: "Broken job", title_number: 0 });
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      issues: [expect.objectContaining({ code: "invalid_job", jobIndex: 2 })],
    });
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ catalogReviewedAt: null }),
    ]);
    expect(fixture.access.encodeJobs.claimNext("partial-import-worker"))
      .toBeNull();
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
      legacyJobs: expect.any(Array),
    });

    sidecar.jobs[2] = {
      label: "Extra 2: Repaired Feature",
      source: fixture.archivePath,
      output: repairedOutputPath,
      preset: "Fast 480p30",
      selection: "title",
      title_number: 1,
    };
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));

    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "retired",
      legacyJobs: expect.arrayContaining([
        expect.objectContaining({ jobIndex: 2 }),
      ]),
    });
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: repairedOutputPath }),
      ]),
    );
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ catalogReviewedAt: null }),
    ]);

    fixture.access.close();
  });

  it("does not retire a valid sidecar while a rejected sidecar still needs repair", () => {
    const root = temporaryDirectories.create("rip-dvd-rejected-recovery-");
    const originalsLibraryPath = join(root, "originals");
    const validArchivePath = join(originalsLibraryPath, "Valid.iso");
    const rejectedArchivePath = join(originalsLibraryPath, "Rejected.iso");
    const validSidecarPath = join(
      originalsLibraryPath,
      "Valid.rip-dvd.json",
    );
    const rejectedSidecarPath = join(
      originalsLibraryPath,
      "Rejected.rip-dvd.json",
    );
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(validArchivePath, "valid archive");
    writeFileSync(rejectedArchivePath, "rejected archive");
    const sidecar = (
      archivePath: string,
      title: string,
      fingerprint: string,
    ) => JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title,
      disc_fingerprint: fingerprint,
      jobs: [{
        label: `Movie: ${title}`,
        source: archivePath,
        output: join(root, "movies", `${title}.mkv`),
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    });
    writeFileSync(
      validSidecarPath,
      sidecar(validArchivePath, "Valid", "valid-fingerprint"),
    );
    writeFileSync(rejectedSidecarPath, "{ rejected json");
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    const rejected = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(rejected).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
      issues: [expect.objectContaining({ sidecarPath: rejectedSidecarPath })],
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([]);

    writeFileSync(
      rejectedSidecarPath,
      sidecar(rejectedArchivePath, "Rejected", "rejected-fingerprint"),
    );
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 2,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(true);
    expect(access.catalog.listOriginalDiscArchives()).toHaveLength(2);
    expect(access.encodeJobs.list()).toHaveLength(2);
    access.close();
  });

  it("preserves post-cutover human Media Item edits during normal re-import", () => {
    const fixture = createFixture();
    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    const importedItems = fixture.access.catalog.listMediaItems();
    const movie = importedItems.find((item) => item.kind === "movie");
    const extra = importedItems.find((item) => item.kind === "bonus_feature");
    if (!movie || !extra) {
      throw new Error("Expected imported movie and extra Media Items");
    }
    const correctedMovie = fixture.access.catalog.updateMediaItem(movie.id, {
      kind: "other",
      title: "Corrected Local Movie",
      year: 2002,
    });
    const correctedExtra = fixture.access.catalog.updateMediaItem(extra.id, {
      parentId: null,
      kind: "other",
      title: "Corrected Local Feature",
      year: 2003,
    });
    const extraSelection = fixture.access.catalog.listDiscSelections().find(
      (selection) => selection.mediaItemId === correctedExtra.id,
    );
    if (!extraSelection) {
      throw new Error("Expected imported extra Disc Selection");
    }
    const sqlite = new DatabaseSync(fixture.databasePath);
    sqlite.prepare(
      "update disc_selections set label = ?, updated_at = ? where id = ?",
    ).run("Corrected local selection", Date.now(), extraSelection.id);
    sqlite.close();
    const reviewCompletedAt = fixture.access.catalog
      .listOriginalDiscArchives()[0]?.catalogReviewedAt;
    expect(reviewCompletedAt).not.toBeNull();

    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });

    expect(fixture.access.catalog.listMediaItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: correctedMovie.id,
          parentId: correctedMovie.parentId,
          kind: "other",
          title: "Corrected Local Movie",
          year: 2002,
        }),
        expect.objectContaining({
          id: correctedExtra.id,
          parentId: null,
          kind: "other",
          title: "Corrected Local Feature",
          year: 2003,
        }),
      ]),
    );
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ catalogReviewedAt: reviewCompletedAt }),
    ]);
    expect(fixture.access.catalog.listDiscSelections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: extraSelection.id,
          label: "Corrected local selection",
        }),
      ]),
    );

    fixture.access.close();
  });

  it("preserves a post-cutover human Disc Selection review boundary", () => {
    const fixture = createFixture();
    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    const archive = fixture.access.catalog.listOriginalDiscArchives()[0]!;
    const humanItem = fixture.access.catalog.createMediaItem({
      kind: "bonus_feature",
      title: "Human-added feature",
    });
    fixture.access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: humanItem.id,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
    });
    expect(
      fixture.access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });

    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });

    expect(
      fixture.access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(fixture.access.encodeJobs.claimNext("human-boundary-worker"))
      .toBeNull();
    fixture.access.close();
  });

  it("does not synthesize parents while preserving a detached bonus-only item", () => {
    const fixture = createFixture();
    const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    sidecar.jobs = [sidecar.jobs[1]!];
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    const importedItems = fixture.access.catalog.listMediaItems();
    const bonus = importedItems.find((item) => item.kind === "bonus_feature");
    if (!bonus) {
      throw new Error("Expected imported bonus Media Item");
    }
    fixture.access.catalog.updateMediaItem(bonus.id, { parentId: null });

    for (let retry = 0; retry < 2; retry += 1) {
      expect(
        fixture.access.legacySidecars.importLibrary({
          originalsLibraryPath: fixture.originalsLibraryPath,
        }),
      ).toMatchObject({ sidecarsImported: 1, issues: [] });
    }

    expect(fixture.access.catalog.listMediaItems()).toEqual(
      expect.arrayContaining(
        importedItems.map((item) => expect.objectContaining({ id: item.id })),
      ),
    );
    expect(fixture.access.catalog.listMediaItems()).toHaveLength(
      importedItems.length,
    );
    expect(
      fixture.access.catalog.listMediaItems().find(
        (item) => item.id === bonus.id,
      ),
    ).toMatchObject({ parentId: null });

    fixture.access.close();
  });

  it("reopens a reviewed archive when legacy import finds an unsafe selection", () => {
    const fixture = createFixture();
    expect(
      fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    fixture.access.close();

    const sqlite = new DatabaseSync(fixture.databasePath);
    const archive = sqlite.prepare(
      "select id from original_disc_archives limit 1",
    ).get() as { id: string };
    sqlite.prepare(`
      insert into media_items (id, kind, title, created_at, updated_at)
      values ('unsafe-import-item', 'bonus_feature', 'Unsafe import item', 0, 0)
    `).run();
    sqlite.prepare(`
      insert into disc_selections (
        id, original_disc_archive_id, media_item_id, source_key, kind,
        title_number, created_at, updated_at
      ) values (
        'unsafe-import-selection', ?, 'unsafe-import-item',
        'caller:title:999', 'dvd_title', 999, 0, 0
      )
    `).run(archive.id);
    sqlite.close();

    const retry = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });
    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    retry.close();

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      issues: [],
    });
    const access = createDataAccess({ databasePath: fixture.databasePath });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ catalogReviewedAt: null }),
    ]);
    expect(access.encodeJobs.list(["queued"])).toHaveLength(1);
    expect(access.encodeJobs.claimNext("unsafe-import-worker")).toBeNull();
    access.close();
  });

  it("reopens explicit review when legacy import adds a valid selection", () => {
    const root = temporaryDirectories.create("rip-dvd-legacy-review-reopen-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Reviewed Import.iso");
    const outputPath = join(root, "movies", "Imported Extra.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "reviewed import archive");
    const databasePath = join(root, "catalog.sqlite");
    const access = createLegacySidecarDataAccess({ databasePath });
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
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 1_800,
          chapters: 4,
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
      archivePath,
      fingerprint: contentId,
    });
    const movie = access.catalog.createMediaItem({
      kind: "movie",
      title: "Reviewed Import",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    expect(completeCatalogReview(access, archive.id)).toMatchObject({
      catalogReviewedAt: expect.any(Date),
    });
    writeFileSync(
      join(originalsLibraryPath, "Reviewed Import.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        archive_status: "ready",
        source: archivePath,
        title: "Reviewed Import",
        disc_fingerprint: contentId,
        titles: [{ number: 1, seconds: 1_800, chapters: 4 }],
        jobs: [{
          label: "Extra 1: Imported extra",
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "title",
          title_number: 1,
        }],
      }),
    );

    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(access.encodeJobs.list(["queued"])).toHaveLength(1);
    expect(access.encodeJobs.claimNext("new-import-worker")).toBeNull();
    access.close();
  });

  it("distinguishes identical and conflicting logical jobs across sidecars", () => {
    const root = temporaryDirectories.create("rip-dvd-cross-sidecar-job-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Shared Movie.iso");
    const firstOutputPath = join(root, "movies", "Shared Movie.mkv");
    const conflictingOutputPath = join(
      root,
      "movies",
      "Shared Movie alternate.mkv",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "shared archive");
    const sidecarPath = (name: string) =>
      join(originalsLibraryPath, `${name}.rip-dvd.json`);
    const writeSidecar = (name: string, outputPath: string) => {
      writeFileSync(
        sidecarPath(name),
        JSON.stringify({
          schema_version: 2,
          source: archivePath,
          title: "Shared Movie",
          disc_fingerprint: "shared-movie-fingerprint",
          jobs: [
            {
              label: "Movie: Shared Movie",
              source: archivePath,
              output: outputPath,
              preset: "Fast 480p30",
              selection: "main_feature",
              title_number: null,
            },
          ],
        }),
      );
    };
    writeSidecar("a-first", firstOutputPath);
    writeSidecar("b-conflicting", conflictingOutputPath);
    writeSidecar("c-identical", firstOutputPath);
    const sidecarBytes = new Map(
      ["a-first", "b-conflicting", "c-identical"].map((name) => [
        sidecarPath(name),
        readFileSync(sidecarPath(name)),
      ]),
    );
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 3,
      sidecarsImported: 3,
      sidecarsSkipped: 0,
      issues: [
        expect.objectContaining({
          code: "duplicate_record",
          jobIndex: 0,
          sidecarPath: sidecarPath("b-conflicting"),
          message: expect.stringMatching(/logical Encode Job conflicts/i),
        }),
      ],
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath: firstOutputPath }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ catalogReviewedAt: null }),
    ]);
    expect(access.encodeJobs.claimNext("cross-sidecar-conflict-worker"))
      .toBeNull();
    for (const [path, bytes] of sidecarBytes) {
      expect(readFileSync(path)).toEqual(bytes);
    }

    access.close();
  });

  it("keeps a transaction-conflicted fingerprint active and unclaimable until repair", () => {
    const root = temporaryDirectories.create("rip-dvd-transaction-conflict-");
    const originalsLibraryPath = join(root, "originals");
    const firstArchivePath = join(originalsLibraryPath, "First.iso");
    const conflictingArchivePath = join(originalsLibraryPath, "Conflict.iso");
    const firstSidecarPath = join(
      originalsLibraryPath,
      "a-first.rip-dvd.json",
    );
    const conflictingSidecarPath = join(
      originalsLibraryPath,
      "b-conflict.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "First.mkv");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(firstArchivePath, "first archive");
    writeFileSync(conflictingArchivePath, "conflicting archive");
    const firstSidecar = JSON.stringify({
      schema_version: 2,
      source: firstArchivePath,
      title: "Shared identity",
      disc_fingerprint: "transaction-conflict-fingerprint",
      jobs: [{
        label: "Movie: Shared identity",
        source: firstArchivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    });
    const archiveOnlySidecar = (archivePath: string) => JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Shared identity",
      disc_fingerprint: "transaction-conflict-fingerprint",
      jobs: [],
    });
    writeFileSync(firstSidecarPath, firstSidecar);
    writeFileSync(
      conflictingSidecarPath,
      archiveOnlySidecar(conflictingArchivePath),
    );
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    const conflicted = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(conflicted).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 1,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          sidecarPath: conflictingSidecarPath,
        }),
      ]),
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ catalogReviewedAt: null }),
    ]);
    expect(access.encodeJobs.claimNext("conflicted-import-worker")).toBeNull();

    writeFileSync(
      conflictingSidecarPath,
      archiveOnlySidecar(firstArchivePath),
    );
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 2,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(true);
    expect(access.encodeJobs.claimNext("repaired-import-worker")).toBeNull();
    const repairedArchive = access.catalog.listOriginalDiscArchives()[0]!;
    completeCatalogReview(access, repairedArchive.id);
    expect(access.encodeJobs.claimNext("repaired-import-worker"))
      .toMatchObject({ outputPath });
    access.close();
  });

  it("ignores new and changed legacy jobs after cutover", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const originalJobs = fixture.access.encodeJobs.list();
    const originalMovieJob = originalJobs.find(
      (job) => job.outputPath === fixture.movieOutputPath,
    );
    expect(originalMovieJob).toBeDefined();
    fixture.access.close();

    const conflictingOutputPath = join(
      dirname(fixture.movieOutputPath),
      "Example Movie alternate.mkv",
    );
    const additionalOutputPath = join(
      dirname(fixture.trailerOutputPath),
      "Interview.mkv",
    );
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8"),
    ) as { jobs: Array<Record<string, unknown>> };
    sidecar.jobs[0]!.output = conflictingOutputPath;
    sidecar.jobs.push({
      label: "Extra 2: Interview",
      source: fixture.archivePath,
      output: additionalOutputPath,
      preset: "Fast 480p30",
      selection: "title",
      title_number: 3,
    });
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
    const changedSidecarBytes = readFileSync(fixture.sidecarPath);
    const retry = createLegacySidecarDataAccess({
      databasePath: fixture.databasePath,
    });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsCreated: { encodeJobs: 0 },
      issues: [],
    });
    expect(retry.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: originalMovieJob!.id,
          outputPath: fixture.movieOutputPath,
        }),
      ]),
    );
    expect(retry.encodeJobs.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: conflictingOutputPath }),
      ]),
    );
    expect(readFileSync(fixture.sidecarPath)).toEqual(changedSidecarBytes);
    retry.close();
  });

  it("keeps the canonical winner when a rejected sidecar remains after restart", () => {
    const root = temporaryDirectories.create("rip-dvd-winner-snapshot-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Winner.iso");
    const winnerPath = join(originalsLibraryPath, "a-winner.rip-dvd.json");
    const rejectedPath = join(originalsLibraryPath, "b-rejected.rip-dvd.json");
    const winnerOutput = join(root, "movies", "Winner.mkv");
    const rejectedOutput = join(root, "movies", "Rejected.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    const sidecar = (output: string) =>
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Winner",
        disc_fingerprint: "winner-fingerprint",
        jobs: [{
          label: "Movie: Winner",
          source: archivePath,
          output,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      });
    writeFileSync(winnerPath, sidecar(winnerOutput));
    writeFileSync(rejectedPath, sidecar(rejectedOutput));
    const first = createLegacySidecarDataAccess({ databasePath });

    expect(first.legacySidecars.importLibrary({ originalsLibraryPath }).issues)
      .toEqual([expect.objectContaining({ sidecarPath: rejectedPath })]);
    first.close();
    unlinkSync(winnerPath);

    const retry = createLegacySidecarDataAccess({ databasePath });
    const report = retry.legacySidecars.importLibrary({ originalsLibraryPath });

    expect(report.issues).toEqual([]);
    expect(JSON.parse(readFileSync(
      join(originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      "utf8",
    ))).toMatchObject({
      legacyQueueStatus: "repair",
      legacySidecars: expect.arrayContaining([
        expect.objectContaining({ sidecarPath: winnerPath }),
      ]),
    });
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath: winnerOutput }),
    ]);
    retry.close();
  });

  it("does not admit a brand-new sidecar after SQLite cutover", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const newArchivePath = join(fixture.originalsLibraryPath, "Late.iso");
    const newSidecarPath = join(
      fixture.originalsLibraryPath,
      "Late.rip-dvd.json",
    );
    const newOutputPath = join(dirname(fixture.movieOutputPath), "Late.mkv");
    writeFileSync(newArchivePath, "late archive");
    writeFileSync(
      newSidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: newArchivePath,
        title: "Late",
        disc_fingerprint: "late-fingerprint",
        jobs: [{
          label: "Movie: Late",
          source: newArchivePath,
          output: newOutputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "duplicate_record",
        sidecarPath: newSidecarPath,
        message: expect.stringMatching(/cutover/i),
      }),
    ]);
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(fixture.access.encodeJobs.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: newOutputPath }),
      ]),
    );
    fixture.access.close();
  });

  it("fails closed when schema-1 sidecars drift beyond authoritative SQLite state", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    }));
    const completedJob = fixture.access.encodeJobs
      .list(["completed"])
      .find((job) => job.outputPath === fixture.movieOutputPath)!;
    const requestedRetryOutputPath = join(
      fixture.originalsLibraryPath,
      "retry.mkv",
    );
    const retryJob = fixture.access.encodeJobs.requeue(completedJob.id, {
      outputPath: requestedRetryOutputPath,
      priority: 23,
    });
    const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    sidecar.jobs.push({
      label: "Extra 2: Post-cutover drift",
      source: fixture.archivePath,
      output: join(fixture.originalsLibraryPath, "drift.mkv"),
      preset: "Fast 480p30",
      selection: "title",
      title_number: 3,
    });
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const preservedMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      schemaVersion: number;
      snapshotDigest?: string;
    };

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          jobIndex: 2,
          message: expect.stringMatching(/schema-1.*ambiguous/i),
        }),
      ]),
    );
    expect(preservedMarker).toEqual({
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    });
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: retryJob.id,
          outputPath: completedJob.outputPath,
          priority: 23,
          replaceExistingOutput: true,
          status: "queued",
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
    fixture.access.close();
  });

  it("uses Encode Job provenance to recover schema-1 exact overlaps", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ issues: [] });
    const jobsBefore = fixture.access.encodeJobs.list();
    const movieJob = jobsBefore.find(
      (job) => job.outputPath === fixture.movieOutputPath,
    )!;
    const movieSelection = fixture.access.catalog.listDiscSelections({
      ids: [movieJob.discSelectionId],
    })[0]!;
    const duplicateMovie = fixture.access.catalog.createMediaItem({
      kind: "movie",
      title: "Schema-one duplicate",
      year: 2001,
    });
    fixture.access.catalog.createDiscSelection({
      originalDiscArchiveId: movieSelection.originalDiscArchiveId,
      mediaItemId: duplicateMovie.id,
      sourceIdentity: { kind: "main_feature" },
    });
    writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    }));

    expect(fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(fixture.access.encodeJobs.list()).toEqual(jobsBefore);

    fixture.access.close();
  });

  it("does not freeze schema-1 movie metadata drift into a later upgrade", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const schemaOneMarker = {
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    };
    writeFileSync(markerPath, JSON.stringify(schemaOneMarker));
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8"),
    ) as Record<string, unknown>;
    sidecar.year = 2026;
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));

    const firstRetry = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const secondRetry = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(firstRetry.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate_record",
        message: expect.stringMatching(/schema-1.*ambiguous/i),
      }),
    ]));
    expect(secondRetry.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate_record",
        message: expect.stringMatching(/schema-1.*ambiguous/i),
      }),
    ]));
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(
      schemaOneMarker,
    );
    expect(fixture.access.catalog.listMediaItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Example Movie", year: 2001 }),
      ]),
    );
    fixture.access.close();
  });

  it("preserves an unresolved schema-1 marker after a crash before the first import transaction", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const marker = {
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    };
    writeFileSync(markerPath, JSON.stringify(marker));

    const firstReport = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const secondReport = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(firstReport).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      recordsCreated: { encodeJobs: 0 },
      issues: [
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/schema-1.*recovery/i),
        }),
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/schema-1.*recovery/i),
        }),
      ],
    });
    expect(secondReport).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      recordsCreated: { encodeJobs: 0 },
    });
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(marker);
    fixture.access.close();
  });

  it("preserves schema-1 recovery when an archive-only ISO has been replaced", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-schema-one-archive-only-replacement-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Archive Only.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Archive Only.rip-dvd.json",
    );
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "12345678");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Archive Only",
      disc_fingerprint: "schema-one-archive-only-replacement",
      jobs: [],
    }));
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });
    access.legacySidecars.importLibrary({ originalsLibraryPath });
    const schemaOneMarker = {
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    };
    writeFileSync(markerPath, JSON.stringify(schemaOneMarker));
    unlinkSync(archivePath);
    writeFileSync(archivePath, "87654321");

    const firstRetry = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });
    const secondRetry = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    for (const report of [firstRetry, secondRetry]) {
      expect(report).toMatchObject({
        sidecarsImported: 0,
        sidecarsSkipped: 1,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "invalid_job",
            message: expect.stringMatching(/schema-1.*archive.*recovery/i),
            sidecarPath,
          }),
        ]),
      });
    }
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(
      schemaOneMarker,
    );
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ archivePath, sizeBytes: 8 }),
    ]);
    access.close();
  });

  it("preserves schema-1 recovery for an archive-only sidecar absent from SQLite", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const marker = {
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    };
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8"),
    ) as { jobs: unknown[] };
    sidecar.jobs = [];
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
    writeFileSync(markerPath, JSON.stringify(marker));

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      recordsCreated: {
        originalDiscArchives: 0,
        discSelections: 0,
        mediaItems: 0,
        encodingProfiles: 0,
        encodeJobs: 0,
      },
      issues: [
        expect.objectContaining({
          code: "invalid_job",
          message: expect.stringMatching(/schema-1.*archive.*recovery/i),
          sidecarPath: fixture.sidecarPath,
        }),
      ],
    });
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(marker);
    fixture.access.close();
  });

  it.each(["all-invalid", "mixed-valid-invalid"] as const)(
    "preserves schema-1 operator recovery state for %s jobs",
    (scenario) => {
      const fixture = createFixture();
      const markerPath = join(
        fixture.originalsLibraryPath,
        ".rip-dvd-sqlite-catalog",
      );
      const marker = {
        schemaVersion: 1,
        legacyQueueStatus: "retired",
        authoritativeStore: "sqlite",
      };
      const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8")) as {
        jobs: Array<Record<string, unknown>>;
      };

      if (scenario === "mixed-valid-invalid") {
        fixture.access.legacySidecars.importLibrary({
          originalsLibraryPath: fixture.originalsLibraryPath,
        });
        sidecar.jobs = [
          sidecar.jobs[0]!,
          { ...sidecar.jobs[1]!, title_number: 0 },
        ];
      } else {
        sidecar.jobs = [{ ...sidecar.jobs[0]!, title_number: 0 }];
      }
      writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
      writeFileSync(markerPath, JSON.stringify(marker));

      const report = fixture.access.legacySidecars.importLibrary({
        originalsLibraryPath: fixture.originalsLibraryPath,
      });

      expect(report).toMatchObject({
        sidecarsImported: 0,
        sidecarsSkipped: 1,
        issues: [
          expect.objectContaining({
            code: "invalid_job",
            message: expect.stringMatching(/title_number/),
          }),
        ],
      });
      expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(marker);
      fixture.access.close();
    },
  );

  it("preserves schema-1 recovery through a symlink-alias library root", () => {
    const fixture = createFixture();
    const originalsLibraryAlias = join(
      dirname(fixture.originalsLibraryPath),
      "originals-alias",
    );
    symlinkSync(fixture.originalsLibraryPath, originalsLibraryAlias, "dir");
    const secondArchivePath = join(
      fixture.originalsLibraryPath,
      "Second Movie.iso",
    );
    const secondSidecarPath = join(
      fixture.originalsLibraryPath,
      "Second Movie.rip-dvd.json",
    );
    const secondOutputPath = join(
      dirname(fixture.movieOutputPath),
      "Second Movie.mkv",
    );
    writeFileSync(secondArchivePath, "second DVD image");
    const existingDrive = fixture.access.catalog.upsertOpticalDrive({
      devicePath: "/dev/existing-archive-drive",
      isPresent: true,
    });
    const existingDisc = fixture.access.catalog.registerDetectedDisc({
      opticalDriveId: existingDrive.id,
      discKind: "dvd",
      fingerprint: "second-disc-fingerprint",
      volumeLabel: "SECOND_MOVIE",
    });
    fixture.access.catalog.updateDetectedDiscStatus(existingDisc.id, "scanned");
    fixture.access.catalog.updateDetectedDiscStatus(existingDisc.id, "approved");
    fixture.access.catalog.createOriginalDiscArchive({
      detectedDiscId: existingDisc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: secondArchivePath,
      fingerprint: "second-disc-fingerprint",
    });
    writeFileSync(
      secondSidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: secondArchivePath,
        title: "Second Movie",
        disc_fingerprint: "second-disc-fingerprint",
        jobs: [{
          label: "Movie: Second Movie",
          source: secondArchivePath,
          output: secondOutputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const schemaOneMarker = {
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    };
    writeFileSync(markerPath, JSON.stringify(schemaOneMarker));
    unlinkSync(secondSidecarPath);
    unlinkSync(secondArchivePath);

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: originalsLibraryAlias,
    });

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "invalid_job",
        message: expect.stringMatching(/schema-1.*missing.*recovery input/i),
        sidecarPath: secondArchivePath,
      }),
    ]);
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: fixture.movieOutputPath }),
        expect.objectContaining({ outputPath: fixture.trailerOutputPath }),
        expect.objectContaining({ outputPath: secondOutputPath }),
      ]),
    );
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(
      schemaOneMarker,
    );
    fixture.access.close();
  });

  it("requires explicit recovery before interpreting a schema-2 marker", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const currentMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      legacyJobs: Array<{ logicalKey: string; signature: string }>;
    };
    const legacyJobs = currentMarker.legacyJobs.map(
      ({ logicalKey, signature }) => ({ logicalKey, signature }),
    );
    writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 2,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
      legacyJobs,
      snapshotDigest: createHash("sha256")
        .update(JSON.stringify(legacyJobs))
        .digest("hex"),
    }));

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "invalid_sidecar",
        message: expect.stringMatching(/schema-2\/3.*explicit.*recovery/i),
      }),
    ]));
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
    fixture.access.close();
  });

  it.each([
    ["malformed", { schemaVersion: 2 }],
    ["tampered", {
      schemaVersion: 2,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
      legacyJobs: [],
      snapshotDigest: "0".repeat(64),
    }],
  ])("fails closed for a %s schema-2 marker", (_name, marker) => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      JSON.stringify(marker),
    );

    expect(() => fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toThrow(/cutover marker/i);
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("rejects an oversized cutover marker before parsing or importing", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    writeFileSync(markerPath, Buffer.alloc(8_388_609, 0x20));

    expect(() => fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toThrow(/cutover marker.*8,?388,?608.*byte limit/i);
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(readFileSync(markerPath).byteLength).toBe(8_388_609);
    fixture.access.close();
  });

  it("rejects a cutover marker whose legacy job snapshot exceeds the entry limit", () => {
    const fixture = createFixture();
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const profileKey = "legacy-handbrake-entry-limit";
    const signature = JSON.stringify({
      kind: "main_feature",
      label: "Movie: Marker Entry",
      mediaItemKind: "movie",
      mediaTitle: "Marker Entry",
      outputPath: join(dirname(fixture.movieOutputPath), "marker-entry.mkv"),
      preset: "Marker Entry Preset",
      profileKey,
      sourceKey: "dvd:main-feature",
      titleNumber: null,
    });
    const legacyJobs = Array.from({ length: 1_001 }, (_, index) => ({
      logicalKey: `marker-entry-${index}\0dvd:main-feature\0${profileKey}`,
      jobIndex: 0,
      sidecarPath: fixture.sidecarPath,
      signature,
    }));
    writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 3,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
      legacyJobs,
      snapshotDigest: createHash("sha256")
        .update(JSON.stringify(legacyJobs))
        .digest("hex"),
    }));

    expect(() => fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toThrow(/legacyJobs.*1,?000.*entry limit/i);
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("rejects a cutover marker symlink", () => {
    const fixture = createFixture();
    const markerTarget = join(fixture.originalsLibraryPath, "marker-target");
    writeFileSync(markerTarget, JSON.stringify({
      schemaVersion: 1,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
    }));
    symlinkSync(
      markerTarget,
      join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
    );

    expect(() => fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    })).toThrow(/regular file/i);
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("preserves authoritative failed Encode Job state on re-import", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const claim = fixture.access.encodeJobs.claimNext("encode-worker-review");
    if (!claim) {
      throw new Error("Expected the imported queued Encode Job to be claimable");
    }
    fixture.access.encodeJobs.updateProgress(claim, 37);
    fixture.access.encodeJobs.fail(claim, "transcode failed");

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsUpdated: 0,
      issues: [],
    });
    expect(fixture.access.encodeJobs.list(["failed"])).toEqual([
      expect.objectContaining({
        id: claim.id,
        status: "failed",
        progressPercent: 37,
        errorMessage: "transcode failed",
      }),
    ]);
    const failedSelection = fixture.access.catalog.listDiscSelections({
      ids: [claim.discSelectionId],
    })[0];
    if (
      !failedSelection ||
      failedSelection.sourceIdentity.kind !== "dvd_title"
    ) {
      throw new Error("Expected the failed trailer's DVD title selection");
    }
    expect(() =>
      fixture.access.catalog.repairDiscSelection(failedSelection.id, {
        originalDiscArchiveId: failedSelection.originalDiscArchiveId,
        mediaItemId: failedSelection.mediaItemId,
        sourceIdentity: failedSelection.sourceIdentity,
      })
    ).toThrow(/ordinary Encode Job history.*retry identity/i);
    expect(fixture.access.encodeJobs.requeue(claim.id)).toMatchObject({
      id: claim.id,
      discSelectionId: failedSelection.id,
      status: "queued",
    });

    fixture.access.close();
  });

  it("preserves authoritative completed Encode Job provenance on re-import", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const claim = fixture.access.encodeJobs.claimNext("encode-worker-complete");
    if (!claim) {
      throw new Error("Expected the imported queued Encode Job to be claimable");
    }
    fixture.access.encodeJobs.updateProgress(claim, 73);
    const completed = fixture.access.encodeJobs.complete(claim);

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsUpdated: 0,
      issues: [],
    });
    expect(
      fixture.access.encodeJobs.list().find((job) => job.id === completed.id),
    ).toEqual(completed);

    fixture.access.close();
  });

  it("preserves an authoritative Encode Job retry on re-import", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const completedJob = fixture.access.encodeJobs
      .list(["completed"])
      .find((job) => job.outputPath === fixture.movieOutputPath);
    if (!completedJob) {
      throw new Error("Expected the completed imported Encode Job");
    }
    const requestedRetryOutputPath = join(
      fixture.originalsLibraryPath,
      "retries",
      "Example Movie retry.mkv",
    );
    const retry = fixture.access.encodeJobs.requeue(completedJob.id, {
      outputPath: requestedRetryOutputPath,
      priority: 17,
    });

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      recordsUpdated: 0,
      issues: [],
    });
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: retry.id,
          outputPath: completedJob.outputPath,
          priority: 17,
          replaceExistingOutput: true,
          status: "queued",
          progressPercent: 0,
          completedAt: null,
        }),
      ]),
    );

    fixture.access.close();
  });

  it("preserves legacy archive and completion timestamps", () => {
    const fixture = createFixture();
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8"),
    ) as Record<string, unknown>;
    sidecar.created_at = "2001-01-02T03:04:05+00:00";
    sidecar.updated_at = "2001-01-03T04:05:06+00:00";
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
    const archiveFileTime = new Date("2001-01-03T04:00:00.000Z");
    const outputFileTime = new Date("2001-02-03T04:05:06.000Z");
    utimesSync(fixture.archivePath, archiveFileTime, archiveFileTime);
    utimesSync(fixture.movieOutputPath, outputFileTime, outputFileTime);

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        archivedAt: new Date("2001-01-03T04:05:06.000Z"),
        createdAt: new Date("2001-01-02T03:04:05.000Z"),
      }),
    ]);
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputPath: fixture.movieOutputPath,
          completedAt: outputFileTime,
          createdAt: new Date("2001-01-02T03:04:05.000Z"),
        }),
      ]),
    );

    fixture.access.close();
  });

  it("keeps the library active when any sidecar cannot be represented", () => {
    const root = temporaryDirectories.create("rip-dvd-partial-import-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Valid.iso");
    const movieOutputPath = join(root, "movies", "Valid.mkv");
    const extraOutputPath = join(root, "movies", "Extra.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(join(originalsLibraryPath, "a-corrupt.rip-dvd.json"), "{bad");
    writeFileSync(
      join(originalsLibraryPath, "b-invalid.rip-dvd.json"),
      JSON.stringify([]),
    );
    writeFileSync(
      join(originalsLibraryPath, "c-missing.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: join(originalsLibraryPath, "Missing.iso"),
        disc_fingerprint: "missing-fingerprint",
        jobs: [],
      }),
    );
    writeFileSync(
      join(originalsLibraryPath, "d-valid.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Valid Movie",
        disc_fingerprint: "valid-fingerprint",
        jobs: [
          {
            label: "Movie: Valid Movie",
            source: archivePath,
            output: movieOutputPath,
            preset: "Fast 480p30",
            selection: "main_feature",
            title_number: null,
          },
          { label: "Broken job", title_number: 0 },
          {
            label: "Malformed preset",
            output: join(root, "movies", "Malformed.mkv"),
            preset: 480,
            title_number: 3,
          },
          {
            label: "Missing main-feature selector",
            output: join(root, "movies", "Missing selection.mkv"),
            title_number: null,
          },
          {
            label: "Duplicate movie",
            source: archivePath,
            output: movieOutputPath,
            preset: "Fast 480p30",
            selection: "main_feature",
            title_number: null,
          },
          {
            label: "Extra 1: Featurette",
            source: archivePath,
            output: extraOutputPath,
            preset: "Fast 480p30",
            selection: "title",
            title_number: 2,
          },
        ],
      }),
    );
    const access = createLegacySidecarDataAccess({ databasePath: join(root, "catalog.sqlite") });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 4,
      sidecarsImported: 0,
      sidecarsSkipped: 4,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "corrupt_sidecar" }),
        expect.objectContaining({ code: "invalid_sidecar" }),
        expect.objectContaining({ code: "missing_archive" }),
        expect.objectContaining({ code: "invalid_job", jobIndex: 1 }),
        expect.objectContaining({ code: "invalid_job", jobIndex: 2 }),
        expect.objectContaining({ code: "invalid_job", jobIndex: 3 }),
        expect.objectContaining({ code: "duplicate_record", jobIndex: 4 }),
      ]),
    );
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([]);

    access.close();
  });

  it("keeps valid sidecars active beside malformed UTF-8", () => {
    const fixture = createFixture();
    const archivePath = join(
      fixture.originalsLibraryPath,
      "Malformed UTF-8.iso",
    );
    const sidecarPath = join(
      fixture.originalsLibraryPath,
      "Malformed UTF-8.rip-dvd.json",
    );
    writeFileSync(archivePath, "archive");
    const malformedBytes = Buffer.concat([
      Buffer.from(
        `{"schema_version":2,"source":${JSON.stringify(archivePath)},"title":"`,
      ),
      Buffer.from([0xff]),
      Buffer.from(
        '","disc_fingerprint":"malformed-utf8-fingerprint","jobs":[]}',
      ),
    ]);
    writeFileSync(sidecarPath, malformedBytes);

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
      issues: [
        expect.objectContaining({
          code: "corrupt_sidecar",
          message: expect.stringMatching(/UTF-8/i),
          sidecarPath,
        }),
      ],
    });
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(readFileSync(sidecarPath)).toEqual(malformedBytes);
    fixture.access.close();
  });

  it("keeps the queue active for metadata that cannot enter the cutover marker", () => {
    const fixture = createFixture();
    const archivePath = join(
      fixture.originalsLibraryPath,
      "Unserializable Metadata.iso",
    );
    const sidecarPath = join(
      fixture.originalsLibraryPath,
      "Unserializable Metadata.rip-dvd.json",
    );
    writeFileSync(archivePath, "archive");
    const nestedUnknownTitleValue =
      "[".repeat(20_000) + "null" + "]".repeat(20_000);
    const sidecarBytes = Buffer.from(
      `{"schema_version":2,"archive_status":"ready","source":${JSON.stringify(archivePath)},"title":"Unserializable Metadata","disc_fingerprint":"unserializable-metadata-fingerprint","titles":[{"number":1,"unknown":${nestedUnknownTitleValue}}],"jobs":[]}`,
    );
    writeFileSync(sidecarPath, sidecarBytes);

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
      issues: [
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/serializ.*cutover marker/i),
          sidecarPath,
        }),
      ],
    });
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(false);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    fixture.access.close();
  });

  it("reports an oversized sidecar without reading or importing it", () => {
    const fixture = createFixture();
    const oversizedSidecarPath = join(
      fixture.originalsLibraryPath,
      "Oversized.rip-dvd.json",
    );
    writeFileSync(oversizedSidecarPath, Buffer.alloc(1_048_577, 0x20));

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/exceeds.*byte limit/i),
          sidecarPath: oversizedSidecarPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("reports a sidecar whose job count would make one import transaction unbounded", () => {
    const fixture = createFixture();
    const archivePath = join(
      fixture.originalsLibraryPath,
      "Too Many Jobs.iso",
    );
    const sidecarPath = join(
      fixture.originalsLibraryPath,
      "Too Many Jobs.rip-dvd.json",
    );
    writeFileSync(archivePath, "archive");
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Too Many Jobs",
        disc_fingerprint: "too-many-jobs-fingerprint",
        jobs: Array.from({ length: 101 }, (_, index) => ({
          label: `Extra ${index + 1}: Bounded import`,
          source: archivePath,
          output: join(dirname(fixture.movieOutputPath), `extra-${index + 1}.mkv`),
          preset: `Bounded preset ${index + 1}`,
          selection: "title",
          title_number: index + 1,
        })),
      }),
    );

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/jobs.*100.*limit/i),
          sidecarPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("leaves the legacy queue active when cumulative sidecar bytes exceed the import budget", () => {
    const fixture = createFixture();
    for (let index = 1; index <= 9; index += 1) {
      const archivePath = join(
        fixture.originalsLibraryPath,
        `Aggregate Bytes ${index}.iso`,
      );
      writeFileSync(archivePath, "archive");
      writeFileSync(
        join(
          fixture.originalsLibraryPath,
          `Aggregate Bytes ${index}.rip-dvd.json`,
        ),
        JSON.stringify({
          schema_version: 2,
          source: archivePath,
          title: `Aggregate Bytes ${index}`,
          disc_fingerprint: `aggregate-bytes-${index}`,
          jobs: [],
          padding: "x".repeat(950_000),
        }),
      );
    }

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 10,
      sidecarsImported: 0,
      sidecarsSkipped: 10,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/aggregate.*bytes.*8,?388,?608.*limit/i),
          sidecarPath: fixture.originalsLibraryPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(false);
    fixture.access.close();
  });

  it("keeps valid sidecars recoverable beside corrupt payload bytes", () => {
    const fixture = createFixture();
    for (let index = 1; index <= 8; index += 1) {
      writeFileSync(
        join(
          fixture.originalsLibraryPath,
          `Corrupt Payload ${index}.rip-dvd.json`,
        ),
        `{"padding":"${"x".repeat(950_000)}`,
      );
    }

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 9,
      sidecarsImported: 0,
      sidecarsSkipped: 9,
    });
    expect(report.issues).toHaveLength(8);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "corrupt_sidecar",
          sidecarPath: join(
            fixture.originalsLibraryPath,
            "Corrupt Payload 1.rip-dvd.json",
          ),
        }),
      ]),
    );
    expect(report.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/aggregate.*bytes/i),
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    fixture.access.close();
  });

  it("keeps rejected scan work active without consuming retained-state budget", () => {
    const fixture = createFixture();
    for (let index = 1; index <= 9; index += 1) {
      writeFileSync(
        join(
          fixture.originalsLibraryPath,
          `Rejected Payload ${index}.rip-dvd.json`,
        ),
        `{"padding":"${"x".repeat(950_000)}`,
      );
    }

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 10,
      sidecarsImported: 0,
      sidecarsSkipped: 10,
    });
    expect(report.issues).toHaveLength(9);
    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringMatching(/aggregate.*bytes/i),
      }),
    ]));
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(false);
    fixture.access.close();
  });

  it("leaves the legacy queue active when cumulative jobs exceed the import budget", () => {
    const fixture = createFixture();
    for (let sidecarIndex = 1; sidecarIndex <= 10; sidecarIndex += 1) {
      const archivePath = join(
        fixture.originalsLibraryPath,
        `Aggregate Jobs ${sidecarIndex}.iso`,
      );
      writeFileSync(archivePath, "archive");
      writeFileSync(
        join(
          fixture.originalsLibraryPath,
          `Aggregate Jobs ${sidecarIndex}.rip-dvd.json`,
        ),
        JSON.stringify({
          schema_version: 2,
          source: archivePath,
          title: `Aggregate Jobs ${sidecarIndex}`,
          disc_fingerprint: `aggregate-jobs-${sidecarIndex}`,
          jobs: Array.from({ length: 100 }, (_, jobIndex) => ({
            label: `Extra ${jobIndex + 1}: Aggregate ${sidecarIndex}`,
            source: archivePath,
            output: join(
              dirname(fixture.movieOutputPath),
              `aggregate-${sidecarIndex}-${jobIndex + 1}.mkv`,
            ),
            preset: "Fast 480p30",
            selection: "title",
            title_number: jobIndex + 1,
          })),
        }),
      );
    }

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 11,
      sidecarsImported: 0,
      sidecarsSkipped: 11,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/aggregate.*jobs.*1,?000.*limit/i),
          sidecarPath: fixture.originalsLibraryPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(false);
    fixture.access.close();
  });

  it("reports bounded input that would expand past the marker budget", () => {
    const fixture = createFixture();
    const archivePath = join(
      fixture.originalsLibraryPath,
      "Marker Budget.iso",
    );
    writeFileSync(archivePath, "archive");
    writeFileSync(
      join(
        fixture.originalsLibraryPath,
        "Marker Budget.rip-dvd.json",
      ),
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Marker Budget",
        disc_fingerprint: "f".repeat(90_000),
        jobs: Array.from({ length: 100 }, (_, jobIndex) => ({
          label: `Extra ${jobIndex + 1}: Marker Budget`,
          source: archivePath,
          output: join(
            dirname(fixture.movieOutputPath),
            `marker-budget-${jobIndex + 1}.mkv`,
          ),
          preset: "Fast 480p30",
          selection: "title",
          title_number: jobIndex + 1,
        })),
      }),
    );

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(
            /aggregate.*marker.*8,?388,?608.*limit/i,
          ),
          sidecarPath: fixture.originalsLibraryPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(false);
    fixture.access.close();
  });

  it("leaves the legacy queue active after a truncated traversal and imports every job on retry", () => {
    const fixture = createFixture();
    let deepDirectory = fixture.originalsLibraryPath;
    for (let depth = 1; depth <= 33; depth += 1) {
      deepDirectory = join(deepDirectory, `depth-${depth}`);
      mkdirSync(deepDirectory);
    }
    const archivePath = join(deepDirectory, "Too Deep.iso");
    const sidecarPath = join(deepDirectory, "Too Deep.rip-dvd.json");
    const outputPath = join(dirname(fixture.movieOutputPath), "Too Deep.mkv");
    writeFileSync(archivePath, "archive");
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: "Too Deep.iso",
        title: "Too Deep",
        disc_fingerprint: "too-deep-fingerprint",
        jobs: [{
          label: "Movie: Too Deep",
          source: "Too Deep.iso",
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/depth.*32.*limit/i),
          sidecarPath: deepDirectory,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    const markerPath = join(
      fixture.originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    expect(existsSync(markerPath)).toBe(false);

    const retriedArchivePath = join(
      fixture.originalsLibraryPath,
      "Too Deep.iso",
    );
    const retriedSidecarPath = join(
      fixture.originalsLibraryPath,
      "Too Deep.rip-dvd.json",
    );
    renameSync(archivePath, retriedArchivePath);
    renameSync(sidecarPath, retriedSidecarPath);
    renameSync(
      join(fixture.originalsLibraryPath, "depth-1"),
      join(dirname(fixture.originalsLibraryPath), "retired-depth-tree"),
    );

    const retry = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(retry.issues).toEqual([]);
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: fixture.movieOutputPath }),
        expect.objectContaining({ outputPath: fixture.trailerOutputPath }),
        expect.objectContaining({ outputPath }),
      ]),
    );
    expect(existsSync(markerPath)).toBe(true);
    fixture.access.close();
  });

  it("reports a library that exceeds the total traversal entry limit", () => {
    const fixture = createFixture();
    for (let index = 0; index <= 10_000; index += 1) {
      writeFileSync(
        join(
          fixture.originalsLibraryPath,
          `zz-padding-${String(index).padStart(5, "0")}`,
        ),
        "",
      );
    }

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/entries.*10,?000.*limit/i),
          sidecarPath: fixture.originalsLibraryPath,
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toEqual([]);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(false);
    fixture.access.close();
  });

  it("does not count a depth-limit scan issue as a sidecar", () => {
    const root = temporaryDirectories.create("rip-dvd-depth-report-");
    const originalsLibraryPath = join(root, "originals");
    mkdirSync(originalsLibraryPath);
    let deepDirectory = originalsLibraryPath;
    for (let depth = 1; depth <= 33; depth += 1) {
      deepDirectory = join(deepDirectory, `depth-${depth}`);
      mkdirSync(deepDirectory);
    }
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 0,
      sidecarsImported: 0,
      sidecarsSkipped: 0,
    });
    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "invalid_sidecar",
        message: expect.stringMatching(/depth.*32.*limit/i),
      }),
    ]);
    access.close();
  });

  it("keeps valid sidecars active beside malformed present metadata", () => {
    const fixture = createFixture();
    const malformedCases: Array<[string, Record<string, unknown>]> = [
      ["schema-version", { schema_version: null }],
      ["archive-status", { archive_status: null }],
      ["title", { title: { text: "not a string" } }],
      ["empty-title", { title: "" }],
      ["year", { year: { value: 2001 } }],
      ["disc-title", { disc_title: ["not", "a", "string"] }],
      ["titles", { titles: "not an array" }],
      ["null-titles", { titles: null }],
      ["created-at", { created_at: "not a date" }],
      ["updated-at", { updated_at: { value: "not a date" } }],
      ["fingerprint-delimiter", { disc_fingerprint: "bad\0fingerprint" }],
      [
        "fingerprint",
        {
          disc_fingerprint: { value: "not a string" },
          disc_title: "DERIVABLE",
          titles: [{ number: 1 }],
        },
      ],
    ];
    for (const [name, malformedFields] of malformedCases) {
      const archivePath = join(fixture.originalsLibraryPath, `${name}.iso`);
      writeFileSync(archivePath, name);
      writeFileSync(
        join(fixture.originalsLibraryPath, `${name}.rip-dvd.json`),
        JSON.stringify({
          schema_version: 2,
          archive_status: "ready",
          source: archivePath,
          title: name,
          year: "2001",
          disc_title: name.toUpperCase(),
          disc_fingerprint: `${name}-fingerprint`,
          titles: [],
          jobs: [],
          ...malformedFields,
        }),
      );
    }

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: malformedCases.length + 1,
      sidecarsImported: 0,
      sidecarsSkipped: malformedCases.length + 1,
    });
    expect(report.issues).toHaveLength(malformedCases.length);
    expect(report.issues).toEqual(
      expect.arrayContaining(
        malformedCases.map(([name]) =>
          expect.objectContaining({
            code: "invalid_sidecar",
            sidecarPath: expect.stringContaining(`${name}.rip-dvd.json`),
          }),
        ),
      ),
    );
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([]);

    fixture.access.close();
  });

  it("reports an output owned by another job and imports later jobs", () => {
    const fixture = createFixture();
    writeFileSync(fixture.trailerOutputPath, "completed trailer encode");
    const secondArchivePath = join(
      fixture.originalsLibraryPath,
      "Second Movie.iso",
    );
    const uniqueOutputPath = join(
      fixture.originalsLibraryPath,
      "Second Featurette.mkv",
    );
    writeFileSync(secondArchivePath, "second archive");
    writeFileSync(
      join(fixture.originalsLibraryPath, "Second Movie.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: secondArchivePath,
        title: "Second Movie",
        disc_fingerprint: "second-movie-fingerprint",
        titles: [
          { number: 1, seconds: 5_400, chapters: 10 },
          { number: 2, seconds: 300, chapters: 1 },
        ],
        jobs: [
          {
            label: "Movie: Second Movie",
            source: secondArchivePath,
            output: fixture.movieOutputPath,
            preset: "Fast 480p30",
            selection: "main_feature",
            title_number: null,
          },
          {
            label: "Extra 1: Second Featurette",
            source: secondArchivePath,
            output: uniqueOutputPath,
            preset: "Fast 480p30",
            selection: "title",
            title_number: 2,
          },
        ],
      }),
    );

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 2,
      sidecarsSkipped: 0,
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "duplicate_record", jobIndex: 0 }),
    ]);
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(2);
    expect(fixture.access.encodeJobs.list()).toHaveLength(3);
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: uniqueOutputPath }),
      ]),
    );
    expect(
      fixture.access.catalog.listOriginalDiscArchives().find(
        (archive) => archive.fingerprint === "second-movie-fingerprint",
      ),
    ).toMatchObject({ catalogReviewedAt: null });
    expect(fixture.access.encodeJobs.claimNext("partial-persistence-worker"))
      .toBeNull();

    fixture.access.close();
  });

  it("reports an archive fingerprint found at another source path", () => {
    const fixture = createFixture();
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
    const duplicateArchivePath = join(
      fixture.originalsLibraryPath,
      "Duplicate Copy.iso",
    );
    writeFileSync(duplicateArchivePath, "duplicate archive copy");
    writeFileSync(
      join(fixture.originalsLibraryPath, "Duplicate Copy.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: duplicateArchivePath,
        title: "Duplicate Copy",
        disc_fingerprint: "example-disc-fingerprint",
        jobs: [],
      }),
    );

    const report = fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 1,
      sidecarsSkipped: 1,
    });
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "duplicate_record" }),
    ]);
    expect(fixture.access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ archivePath: fixture.archivePath }),
    ]);

    fixture.access.close();
  });
});
