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

function createImportableLibrary(root: string, title: string) {
  const originalsLibraryPath = join(root, "originals");
  const archivePath = join(originalsLibraryPath, `${title}.iso`);
  const outputPath = join(root, "movies", `${title}.mkv`);
  const sidecarPath = join(originalsLibraryPath, `${title}.rip-dvd.json`);
  mkdirSync(originalsLibraryPath, { recursive: true });
  writeFileSync(archivePath, "archive");
  const sidecarContents = JSON.stringify({
    schema_version: 2,
    source: archivePath,
    title,
    disc_fingerprint: `${title.toLowerCase().replaceAll(" ", "-")}-fingerprint`,
    jobs: [
      {
        label: `Movie: ${title}`,
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      },
    ],
  });
  writeFileSync(sidecarPath, sidecarContents);
  return {
    archivePath,
    originalsLibraryPath,
    outputPath,
    sidecarContents,
    sidecarPath,
  };
}

describe("legacy sidecar import command", () => {
  it("rejects an unknown option before opening SQLite or publishing cutover", () => {
    const root = temporaryDirectories.create("rip-dvd-legacy-cli-typo-");
    const { originalsLibraryPath } = createImportableLibrary(
      root,
      "Typo Movie",
    );
    const intendedDatabasePath = join(root, "intended.sqlite");
    const environmentDatabasePath = join(root, "environment.sqlite");
    const errors: string[] = [];

    const exitCode = runLegacySidecarImportCli({
      argv: [
        "--databse",
        intendedDatabasePath,
        "--originals-library",
        originalsLibraryPath,
      ],
      environment: { RIP_DVD_DATABASE_PATH: environmentDatabasePath },
      writeError: (message) => errors.push(message),
      writeOutput: () => undefined,
    });

    expect(exitCode).toBe(2);
    expect(errors.join("")).toMatch(/unknown option.*--databse/i);
    expect(existsSync(intendedDatabasePath)).toBe(false);
    expect(existsSync(environmentDatabasePath)).toBe(false);
    expect(
      existsSync(join(originalsLibraryPath, ".rip-dvd-sqlite-catalog")),
    ).toBe(false);
  });

  it.each([
    {
      argv: ["unexpected"],
      expectedError: /unexpected argument.*unexpected/i,
      name: "an unexpected positional argument",
    },
    {
      argv: ["--database", "one.sqlite", "--database", "two.sqlite"],
      expectedError: /duplicate option.*--database/i,
      name: "a duplicate path option",
    },
    {
      argv: ["--json", "--json"],
      expectedError: /duplicate option.*--json/i,
      name: "a duplicate flag",
    },
  ])("rejects $name before opening SQLite or publishing cutover", ({
    argv,
    expectedError,
  }) => {
    const root = temporaryDirectories.create("rip-dvd-legacy-cli-invalid-");
    const { originalsLibraryPath } = createImportableLibrary(
      root,
      "Invalid Arguments Movie",
    );
    const environmentDatabasePath = join(root, "environment.sqlite");
    const errors: string[] = [];

    const exitCode = runLegacySidecarImportCli({
      argv: [
        ...argv,
        "--originals-library",
        originalsLibraryPath,
      ],
      environment: { RIP_DVD_DATABASE_PATH: environmentDatabasePath },
      writeError: (message) => errors.push(message),
      writeOutput: () => undefined,
    });

    expect(exitCode).toBe(2);
    expect(errors.join("")).toMatch(expectedError);
    expect(existsSync(environmentDatabasePath)).toBe(false);
    expect(
      existsSync(join(originalsLibraryPath, ".rip-dvd-sqlite-catalog")),
    ).toBe(false);
  });

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
    const databasePath = join(root, "catalog.sqlite");
    const {
      originalsLibraryPath,
      outputPath,
      sidecarContents,
      sidecarPath,
    } = createImportableLibrary(root, "Command Movie");
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
