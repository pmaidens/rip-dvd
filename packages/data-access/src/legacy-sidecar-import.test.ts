import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDataAccess } from "./index.js";

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

  const access = createDataAccess({
    databasePath: join(root, "catalog.sqlite"),
  });
  return {
    access,
    archivePath,
    movieOutputPath,
    originalsLibraryPath,
    trailerOutputPath,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("legacy sidecar import", () => {
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
    expect(fixture.access.catalog.listEncodingProfiles()).toEqual(
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

  it("imports schema-one title maps and derives their legacy fingerprint", () => {
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
    const schemaOneSidecar = {
      schema_version: 1,
      source: archivePath,
      title: "Schema One",
      year: "1998",
      disc_title: "SCHEMA_ONE",
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
          label: "Movie: Schema One",
          source: archivePath,
          output: outputPath,
          title_number: "1",
        },
      ],
    };
    writeFileSync(sidecarPath, JSON.stringify(schemaOneSidecar));
    const beforeImport = readFileSync(sidecarPath, "utf8");
    const access = createDataAccess({ databasePath: join(root, "catalog.sqlite") });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        fingerprint:
          "796dcf764a8d40802e7b99c87e720c857abef3feeb6e045eef75e3f93d1c3a55",
      }),
    ]);
    expect(access.catalog.listDiscSelections()).toEqual([
      expect.objectContaining({ kind: "dvd_title", titleNumber: 1 }),
    ]);
    expect(access.catalog.listEncodingProfiles()).toEqual([
      expect.objectContaining({ settings: { preset: "Fast 480p30" } }),
    ]);
    expect(readFileSync(sidecarPath, "utf8")).toBe(beforeImport);

    access.close();
  });

  it("re-imports idempotently and updates the existing legacy job status", () => {
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
      recordsUpdated: 1,
      issues: [],
    });
    expect(fixture.access.encodeJobs.list()).toEqual(
      expect.arrayContaining(
        firstJobs.map((job) =>
          expect.objectContaining({
            id: job.id,
            outputPath: job.outputPath,
            status: "completed",
          }),
        ),
      ),
    );
    expect(fixture.access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(fixture.access.catalog.listDiscSelections()).toHaveLength(2);
    expect(fixture.access.catalog.listMediaItems()).toHaveLength(2);

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
    const access = createDataAccess({ databasePath: join(root, "catalog.sqlite") });

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
        expect.objectContaining({ code: "duplicate_record", jobIndex: 2 }),
      ]),
    );
    expect(access.catalog.listOriginalDiscArchives()).toHaveLength(1);
    expect(access.encodeJobs.list()).toHaveLength(2);

    access.close();
  });
});
