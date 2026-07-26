import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDataAccess } from "./index.js";
import { runLegacySidecarImportCli } from "./legacy-sidecar-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("legacy sidecar import command", () => {
  it("imports an originals library into the requested SQLite catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-legacy-cli-"));
    temporaryDirectories.push(root);
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const archivePath = join(originalsLibraryPath, "Command Movie.iso");
    const outputPath = join(root, "movies", "Command Movie.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(
      join(originalsLibraryPath, "Command Movie.rip-dvd.json"),
      JSON.stringify({
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
      }),
    );
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
    access.close();
  });
});
