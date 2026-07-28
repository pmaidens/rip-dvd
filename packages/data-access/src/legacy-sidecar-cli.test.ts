import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDataAccess } from "./index.js";
import { runLegacySidecarImportCli } from "./legacy-sidecar-cli.js";
import { createTemporaryDirectoryFixture } from "./legacy-sidecar.test-support.js";

const temporaryDirectories = createTemporaryDirectoryFixture();

afterEach(() => {
  temporaryDirectories.cleanup();
});

describe("legacy sidecar import command", () => {
  it("fails before creating a catalog for a nonexistent library", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-missing-cli-library-",
    );
    const databasePath = join(root, "catalog.sqlite");
    const errors: string[] = [];

    const exitCode = runLegacySidecarImportCli({
      argv: [
        "--database",
        databasePath,
        "--originals-library",
        join(root, "does-not-exist"),
      ],
      environment: {},
      writeError: (message) => errors.push(message),
      writeOutput: () => undefined,
    });

    expect(exitCode).toBe(2);
    expect(errors.join("")).toMatch(/originals library does not exist/i);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("imports an originals library into the requested SQLite catalog", () => {
    const root = temporaryDirectories.create("rip-dvd-legacy-cli-");
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const archivePath = join(originalsLibraryPath, "Command Movie.iso");
    const outputPath = join(root, "movies", "Command Movie.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    const sidecarPath = join(
      originalsLibraryPath,
      "Command Movie.rip-dvd.json",
    );
    const sidecarContents = JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Command Movie",
        disc_fingerprint: "command-movie-fingerprint",
        jobs: [
          {
            label: "Movie: Command Movie",
            source: archivePath,
            output: outputPath,
            preset: "Fast 480p30",
            selection: "main_feature",
            title_number: null,
          },
        ],
      });
    writeFileSync(sidecarPath, sidecarContents);
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = runLegacySidecarImportCli({
      argv: [
        "--database",
        databasePath,
        "--originals-library",
        originalsLibraryPath,
        "--json",
      ],
      environment: {},
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      originalsLibraryPath,
      sidecarsFound: 1,
      sidecarsImported: 1,
      issues: [],
    });
    const access = createDataAccess({ databasePath });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(
      existsSync(join(originalsLibraryPath, ".rip-dvd-sqlite-catalog")),
    ).toBe(true);
    expect(readFileSync(sidecarPath, "utf8")).toBe(sidecarContents);
    access.close();
  });
});
