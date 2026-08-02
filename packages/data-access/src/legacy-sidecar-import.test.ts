import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

afterEach(() => {
  temporaryDirectories.cleanup();
});

describe("legacy sidecar import", () => {
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
      jobs: [],
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
    expect(fixture.access.catalog.listDiscSelections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "main_feature", titleNumber: null }),
        expect.objectContaining({ kind: "dvd_title", titleNumber: 2 }),
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
      expect.objectContaining({ kind: "dvd_title", titleNumber: 1 }),
    ]);
    expect(access.encodingProfiles.list()).toEqual([
      expect.objectContaining({ settings: { preset: "Fast 480p30" } }),
    ]);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeImport);

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
    writeSidecar("b-identical", firstOutputPath);
    writeSidecar("c-conflicting", conflictingOutputPath);
    const sidecarBytes = new Map(
      ["a-first", "b-identical", "c-conflicting"].map((name) => [
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
          sidecarPath: sidecarPath("c-conflicting"),
          message: expect.stringMatching(/logical Encode Job conflicts/i),
        }),
      ],
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath: firstOutputPath }),
    ]);
    for (const [path, bytes] of sidecarBytes) {
      expect(readFileSync(path)).toEqual(bytes);
    }

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

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "duplicate_record",
        sidecarPath: rejectedPath,
        message: expect.stringMatching(/earlier record/i),
      }),
    ]);
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
    const retryOutputPath = join(fixture.originalsLibraryPath, "retry.mkv");
    const retryJob = fixture.access.encodeJobs.enqueue({
      discSelectionId: completedJob.discSelectionId,
      encodingProfileId: completedJob.encodingProfileId,
      outputPath: retryOutputPath,
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
          jobIndex: 0,
          message: expect.stringMatching(/schema-1.*ambiguous/i),
        }),
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
          outputPath: retryOutputPath,
          priority: 23,
          status: "queued",
        }),
      ]),
    );
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
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
    const retryOutputPath = join(
      fixture.originalsLibraryPath,
      "retries",
      "Example Movie retry.mkv",
    );
    const retry = fixture.access.encodeJobs.enqueue({
      discSelectionId: completedJob.discSelectionId,
      encodingProfileId: completedJob.encodingProfileId,
      outputPath: retryOutputPath,
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
          outputPath: retryOutputPath,
          priority: 17,
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

  it("reports bad sidecars and jobs without aborting the rest of the library", () => {
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
      sidecarsImported: 1,
      sidecarsSkipped: 3,
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
    expect(access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(access.encodeJobs.list()).toHaveLength(2);

    access.close();
  });

  it("reports malformed UTF-8 without aborting valid sidecars", () => {
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
      sidecarsImported: 1,
      sidecarsSkipped: 1,
      issues: [
        expect.objectContaining({
          code: "corrupt_sidecar",
          message: expect.stringMatching(/UTF-8/i),
          sidecarPath,
        }),
      ],
    });
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(readFileSync(sidecarPath)).toEqual(malformedBytes);
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
      sidecarsImported: 1,
      sidecarsSkipped: 1,
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
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
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
      sidecarsImported: 1,
      sidecarsSkipped: 1,
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
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
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

  it("does not let corrupt payload bytes suppress a valid sidecar import", () => {
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
      sidecarsImported: 1,
      sidecarsSkipped: 8,
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
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
    fixture.access.close();
  });

  it("keeps rejected scan work separate from the importable-state budget", () => {
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
      sidecarsImported: 1,
      sidecarsSkipped: 9,
    });
    expect(report.issues).toHaveLength(9);
    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringMatching(/aggregate.*bytes/i),
      }),
    ]));
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(fixture.access.encodeJobs.list()).toHaveLength(2);
    expect(
      existsSync(
        join(fixture.originalsLibraryPath, ".rip-dvd-sqlite-catalog"),
      ),
    ).toBe(true);
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

  it("rejects malformed present metadata without aborting valid sidecars", () => {
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
      sidecarsImported: 1,
      sidecarsSkipped: malformedCases.length,
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
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(1);

    fixture.access.close();
  });

  it("reports an output owned by another job and imports later jobs", () => {
    const fixture = createFixture();
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
