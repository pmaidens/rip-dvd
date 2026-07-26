import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";

const temporaryDirectories: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "rip-dvd-legacy-import-"));
  temporaryDirectories.push(root);
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

  const access = createLegacySidecarDataAccess({
    databasePath: join(root, "catalog.sqlite"),
  });
  return {
    access,
    archivePath,
    movieOutputPath,
    originalsLibraryPath,
    sidecarPath,
    trailerOutputPath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("legacy sidecar import", () => {
  it("rejects a nonexistent originals library", () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-missing-library-"));
    temporaryDirectories.push(root);
    const access = createLegacySidecarDataAccess({ databasePath: join(root, "catalog.sqlite") });

    expect(() =>
      access.legacySidecars.importLibrary({
        originalsLibraryPath: join(root, "does-not-exist"),
      }),
    ).toThrow(/originals library does not exist/i);

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

  it("coerces schema-one integer strings consistently while deriving identity", () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-schema-one-import-"));
    temporaryDirectories.push(root);
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
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-relative-import-"));
    temporaryDirectories.push(root);
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
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-ambiguous-import-"));
    temporaryDirectories.push(root);
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
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-partial-import-"));
    temporaryDirectories.push(root);
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
    fixture.access.legacySidecars.importLibrary({
      originalsLibraryPath: fixture.originalsLibraryPath,
    });
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
