import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDataAccess } from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";
import { createTemporaryDirectoryFixture } from "./legacy-sidecar.test-support.js";

const markerFault = vi.hoisted(() => ({
  directorySyncs: 0,
  failure: "rename" as "directory-sync" | "rename" | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isMarker = (path: unknown) =>
    typeof path === "string" && path.endsWith(".rip-dvd-sqlite-catalog");
  return {
    ...actual,
    fsyncSync(descriptor: number) {
      if (actual.fstatSync(descriptor).isDirectory()) {
        markerFault.directorySyncs += 1;
        if (markerFault.failure === "directory-sync") {
          throw new Error("injected directory sync failure");
        }
      }
      return actual.fsyncSync(descriptor);
    },
    renameSync(source: string, destination: string) {
      if (markerFault.failure === "rename" && isMarker(destination)) {
        throw new Error("injected marker write failure");
      }
      return actual.renameSync(source, destination);
    },
    writeFileSync(...arguments_: Parameters<typeof actual.writeFileSync>) {
      if (markerFault.failure === "rename" && isMarker(arguments_[0])) {
        throw new Error("injected marker write failure");
      }
      return Reflect.apply(actual.writeFileSync, actual, arguments_);
    },
  };
});

const temporaryDirectories = createTemporaryDirectoryFixture();

afterEach(() => {
  markerFault.directorySyncs = 0;
  markerFault.failure = "rename";
  temporaryDirectories.cleanup();
});

describe("legacy sidecar cutover", () => {
  it("publishes no SQLite queue state until the marker is durable and retries after restart", () => {
    const root = temporaryDirectories.create("rip-dvd-cutover-fault-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Fault Movie.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Fault Movie.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Fault Movie.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Fault Movie",
        disc_fingerprint: "fault-movie-fingerprint",
        jobs: [
          {
            label: "Movie: Fault Movie",
            source: archivePath,
            output: outputPath,
            preset: "Fast 480p30",
            selection: "main_feature",
            title_number: null,
          },
        ],
      }),
    );
    const sidecarBytes = readFileSync(sidecarPath);
    const firstAttempt = createLegacySidecarDataAccess({ databasePath });

    expect(() =>
      firstAttempt.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toThrow(/injected marker write failure/);
    expect(firstAttempt.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(firstAttempt.encodeJobs.list()).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    firstAttempt.close();

    const afterRestart = createDataAccess({ databasePath });
    expect(afterRestart.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(afterRestart.encodeJobs.list()).toEqual([]);
    afterRestart.close();

    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });
    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(true);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    retry.close();

    const completedRestart = createDataAccess({ databasePath });
    expect(completedRestart.encodeJobs.list()).toHaveLength(1);
    completedRestart.close();
  });

  it("re-synchronizes a visible marker before importing after restart", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-sync-fault-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Sync Movie.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Sync Movie.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Sync Movie.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Sync Movie",
        disc_fingerprint: "sync-movie-fingerprint",
        jobs: [
          {
            label: "Movie: Sync Movie",
            source: archivePath,
            output: outputPath,
            preset: "Fast 480p30",
            selection: "main_feature",
            title_number: null,
          },
        ],
      }),
    );
    const sidecarBytes = readFileSync(sidecarPath);
    markerFault.failure = "directory-sync";
    const firstAttempt = createLegacySidecarDataAccess({ databasePath });

    expect(() =>
      firstAttempt.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toThrow(/injected directory sync failure/);
    expect(existsSync(markerPath)).toBe(true);
    expect(firstAttempt.encodeJobs.list()).toEqual([]);
    expect(markerFault.directorySyncs).toBe(1);
    firstAttempt.close();

    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });
    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(markerFault.directorySyncs).toBe(2);
    expect(report.issues).toEqual([]);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    retry.close();
  });

  it("waits for an in-flight legacy mutation before publishing cutover", async () => {
    const root = temporaryDirectories.create("rip-dvd-cutover-race-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Race Movie.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Race Movie.rip-dvd.json",
    );
    const databasePath = join(root, "catalog.sqlite");
    const lockPath = join(
      originalsLibraryPath,
      ".rip-dvd-legacy-queue.lock",
    );
    const initialOutputPath = join(root, "movies", "Race Movie.mkv");
    const finalOutputPath = join(root, "movies", "Interview.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    mkdirSync(lockPath);
    writeFileSync(archivePath, "archive");
    const sidecar = {
      schema_version: 2,
      source: archivePath,
      title: "Race Movie",
      disc_fingerprint: "race-movie-fingerprint",
      jobs: [
        {
          label: "Movie: Race Movie",
          source: archivePath,
          output: initialOutputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        },
      ],
    };
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    const completedSidecarPath = join(root, "completed-sidecar.json");
    writeFileSync(
      completedSidecarPath,
      JSON.stringify({
        ...sidecar,
        jobs: [
          ...sidecar.jobs,
          {
            label: "Extra 1: Interview",
            source: archivePath,
            output: finalOutputPath,
            preset: "Fast 480p30",
            selection: "title",
            title_number: 2,
          },
        ],
      }),
    );
    const legacyMutation = spawn(process.execPath, [
      "-e",
      `const { copyFileSync, rmdirSync } = require("node:fs");
       setTimeout(() => {
         copyFileSync(process.argv[1], process.argv[2]);
         rmdirSync(process.argv[3]);
       }, 200);`,
      completedSidecarPath,
      sidecarPath,
      lockPath,
    ]);
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({ databasePath });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });
    const [exitCode] = await once(legacyMutation, "exit");

    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      sidecarsImported: 1,
      issues: [],
      recordsCreated: { encodeJobs: 2 },
    });
    expect(access.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: initialOutputPath }),
        expect.objectContaining({ outputPath: finalOutputPath }),
      ]),
    );
    expect(readFileSync(sidecarPath)).toEqual(
      readFileSync(completedSidecarPath),
    );
    access.close();
  });
});
import { spawn } from "node:child_process";
import { once } from "node:events";
