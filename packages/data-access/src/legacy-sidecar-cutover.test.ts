import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDataAccess } from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";

const markerFault = vi.hoisted(() => ({ enabled: true }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isMarker = (path: unknown) =>
    typeof path === "string" && path.endsWith(".rip-dvd-sqlite-catalog");
  return {
    ...actual,
    renameSync(source: string, destination: string) {
      if (markerFault.enabled && isMarker(destination)) {
        throw new Error("injected marker write failure");
      }
      return actual.renameSync(source, destination);
    },
    writeFileSync(...arguments_: Parameters<typeof actual.writeFileSync>) {
      if (markerFault.enabled && isMarker(arguments_[0])) {
        throw new Error("injected marker write failure");
      }
      return Reflect.apply(actual.writeFileSync, actual, arguments_);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  markerFault.enabled = true;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("legacy sidecar cutover", () => {
  it("publishes no SQLite queue state until the marker is durable and retries after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "rip-dvd-cutover-fault-"));
    temporaryDirectories.push(root);
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

    markerFault.enabled = false;
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
});
