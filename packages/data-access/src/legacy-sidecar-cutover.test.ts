import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
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
  delete process.env.RIP_DVD_PYTHON;
  markerFault.directorySyncs = 0;
  markerFault.failure = "rename";
  temporaryDirectories.cleanup();
});

describe("legacy sidecar cutover", () => {
  function failingLeaseHelper(
    root: string,
    phase: "before-intent" | "before-ready" | "before-released",
  ): string {
    const helperPath = join(root, `lease-helper-${phase}.sh`);
    writeFileSync(
      helperPath,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
state_directory="$4"
case "${phase}" in
  before-intent)
    exit 7
    ;;
  before-ready)
    : > "$state_directory/intent-ready"
    exit 8
    ;;
  before-released)
    : > "$state_directory/intent-ready"
    : > "$state_directory/ready"
    while [ ! -e "$state_directory/release" ]; do sleep 0.01; done
    exit 9
    ;;
esac
`,
    );
    chmodSync(helperPath, 0o755);
    return helperPath;
  }

  function crashingWorkerHelper(
    root: string,
    phase: "before-intent" | "before-ready" | "before-released",
  ): { exitMarkerPath: string; helperPath: string } {
    const helperPath = join(root, `worker-crash-${phase}.sh`);
    const exitMarkerPath = join(root, `worker-crash-${phase}.exited`);
    writeFileSync(
      helperPath,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
state_directory="$4"
trap ': > "${exitMarkerPath}"' EXIT
case "${phase}" in
  before-intent)
    mkdir "$state_directory/error"
    ;;
  before-ready)
    : > "$state_directory/intent-ready"
    sleep 0.5
    mkdir "$state_directory/error"
    ;;
  before-released)
    : > "$state_directory/intent-ready"
    : > "$state_directory/ready"
    while [ ! -e "$state_directory/release" ]; do sleep 0.01; done
    mkdir "$state_directory/error"
    ;;
esac
while [ ! -e "$state_directory/supervisor-abort" ]; do sleep 0.01; done
: > "$state_directory/released"
`,
    );
    chmodSync(helperPath, 0o755);
    return { exitMarkerPath, helperPath };
  }

  it.each([
    ["before-intent", /intent acquisition/i],
    ["before-ready", /queue drain/i],
    ["before-released", /release acknowledgement/i],
  ] as const)(
    "fails cleanly when the lease helper exits %s",
    (phase, expectedPhase) => {
      const root = temporaryDirectories.create(
        `rip-dvd-helper-${phase}-`,
      );
      const originalsLibraryPath = join(root, "originals");
      mkdirSync(originalsLibraryPath, { recursive: true });
      process.env.RIP_DVD_PYTHON = failingLeaseHelper(root, phase);
      markerFault.failure = null;
      const access = createLegacySidecarDataAccess({
        databasePath: join(root, "catalog.sqlite"),
      });

      expect(() =>
        access.legacySidecars.importLibrary({
          originalsLibraryPath,
        }),
      ).toThrow(expectedPhase);
      access.close();
    },
  );

  it("preserves an import failure when queue-lock release also fails", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-import-and-release-failure-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Double Failure.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Double Failure.rip-dvd.json",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Double Failure",
        disc_fingerprint: "double-failure-fingerprint",
        jobs: [{
          label: "Movie: Double Failure",
          source: archivePath,
          output: join(root, "movies", "Double Failure.mkv"),
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );
    process.env.RIP_DVD_PYTHON = failingLeaseHelper(
      root,
      "before-released",
    );
    markerFault.failure = "rename";
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    let thrown: unknown;
    try {
      access.legacySidecars.importLibrary({ originalsLibraryPath });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as Error).message).toMatch(/injected marker write failure/i);
    expect((thrown as Error).message).toMatch(/release acknowledgement/i);
    expect((thrown as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/injected marker write failure/i),
      }),
      expect.objectContaining({
        message: expect.stringMatching(/release acknowledgement/i),
      }),
    ]);
    access.close();
  });

  it.each([
    ["before-intent", /intent acquisition/i],
    ["before-ready", /queue drain/i],
    ["before-released", /release acknowledgement/i],
  ] as const)(
    "fails cleanly and releases the helper when the supervising Worker crashes %s",
    (phase, expectedPhase) => {
      const root = temporaryDirectories.create(
        `rip-dvd-worker-crash-${phase}-`,
      );
      const originalsLibraryPath = join(root, "originals");
      const databasePath = join(root, "catalog.sqlite");
      mkdirSync(originalsLibraryPath, { recursive: true });
      const { exitMarkerPath, helperPath } = crashingWorkerHelper(
        root,
        phase,
      );
      const legacySidecarsModuleUrl = new URL(
        "../dist/legacy-sidecars.js",
        import.meta.url,
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--eval",
          `(async () => {
const { existsSync } = await import("node:fs");
const { createLegacySidecarDataAccess } = await import(${JSON.stringify(legacySidecarsModuleUrl)});
const [, databasePath, originalsLibraryPath, exitMarkerPath] = process.argv;
const access = createLegacySidecarDataAccess({ databasePath });
let failedAsExpected = false;
try {
  access.legacySidecars.importLibrary({ originalsLibraryPath });
} catch (error) {
  failedAsExpected = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  access.close();
}
const sleepState = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 3_000;
while (!existsSync(exitMarkerPath) && Date.now() < deadline) {
  Atomics.wait(sleepState, 0, 0, 10);
}
if (!failedAsExpected || !existsSync(exitMarkerPath)) {
  process.exitCode = 1;
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
          databasePath,
          originalsLibraryPath,
          exitMarkerPath,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, RIP_DVD_PYTHON: helperPath },
          timeout: 7_000,
        },
      );

      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toMatch(expectedPhase);
      expect(existsSync(exitMarkerPath)).toBe(true);
    },
  );

  it("releases real cutover intent when the supervising Worker fails during queue drain", async () => {
    const root = temporaryDirectories.create(
      "rip-dvd-worker-crash-real-drain-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const intentPath = join(
      originalsLibraryPath,
      ".rip-dvd-legacy-queue.intent.lock",
    );
    const gatePath = join(
      originalsLibraryPath,
      ".rip-dvd-legacy-queue.lock",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    const helperPath = join(root, "real-drain-worker-crash.py");
    writeFileSync(
      helperPath,
      `#!/usr/bin/env python3
import fcntl
import os
from pathlib import Path
import sys
import threading

if len(sys.argv) > 1 and sys.argv[1] == "--version":
    raise SystemExit(0)

originals = Path(sys.argv[3])
state = Path(sys.argv[4])
intent = open(originals / ".rip-dvd-legacy-queue.intent.lock", "a+")
gate = open(originals / ".rip-dvd-legacy-queue.lock", "a+")
fcntl.flock(intent, fcntl.LOCK_EX)
(state / "intent-ready").touch()
threading.Timer(0.1, lambda: os.mkdir(state / "error")).start()
fcntl.flock(gate, fcntl.LOCK_EX)
`,
    );
    chmodSync(helperPath, 0o755);
    const holder = spawn("python3", [
      "-c",
      `import fcntl, sys, time
gate = open(sys.argv[1], "a+")
fcntl.flock(gate, fcntl.LOCK_SH)
print("ready", flush=True)
time.sleep(8)`,
      gatePath,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    if (!holder.stdout) {
      throw new Error("Expected the gate-holder readiness pipe");
    }
    await once(holder.stdout, "data");
    holder.stdout.destroy();
    try {
      const legacySidecarsModuleUrl = new URL(
        "../dist/legacy-sidecars.js",
        import.meta.url,
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--eval",
          `(async () => {
const { createLegacySidecarDataAccess } = await import(${JSON.stringify(legacySidecarsModuleUrl)});
const [, databasePath, originalsLibraryPath] = process.argv;
const access = createLegacySidecarDataAccess({ databasePath });
try {
  access.legacySidecars.importLibrary({ originalsLibraryPath });
  process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  access.close();
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
          databasePath,
          originalsLibraryPath,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, RIP_DVD_PYTHON: helperPath },
          timeout: 7_000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toMatch(/queue drain/i);

      const contender = spawnSync(
        "python3",
        [
          "-c",
          `import fcntl, sys
intent = open(sys.argv[1], "a+")
gate = open(sys.argv[2], "a+")
fcntl.flock(intent, fcntl.LOCK_EX | fcntl.LOCK_NB)
fcntl.flock(gate, fcntl.LOCK_SH | fcntl.LOCK_NB)`,
          intentPath,
          gatePath,
        ],
        { encoding: "utf8", timeout: 1_000 },
      );
      expect(contender.error).toBeUndefined();
      expect(contender.status, contender.stderr).toBe(0);
    } finally {
      holder.kill("SIGTERM");
    }
  });

  it("bounds release acknowledgement and reaps a helper that ignores release", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-helper-ignore-release-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const helperPidPath = join(root, "helper.pid");
    mkdirSync(originalsLibraryPath, { recursive: true });
    const helperPath = join(root, "ignore-release.py");
    writeFileSync(
      helperPath,
      `#!/usr/bin/env python3
import fcntl
import os
from pathlib import Path
import signal
import sys
import time

if len(sys.argv) > 1 and sys.argv[1] == "--version":
    raise SystemExit(0)

originals = Path(sys.argv[3])
state = Path(sys.argv[4])
Path(${JSON.stringify(helperPidPath)}).write_text(str(os.getpid()))
intent = open(originals / ".rip-dvd-legacy-queue.intent.lock", "a+")
gate = open(originals / ".rip-dvd-legacy-queue.lock", "a+")
fcntl.flock(intent, fcntl.LOCK_EX)
(state / "intent-ready").touch()
fcntl.flock(gate, fcntl.LOCK_EX)
(state / "ready").touch()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    time.sleep(0.05)
`,
    );
    chmodSync(helperPath, 0o755);
    const legacySidecarsModuleUrl = new URL(
      "../dist/legacy-sidecars.js",
      import.meta.url,
    ).href;

    const child = spawnSync(
      process.execPath,
      [
        "--eval",
        `(async () => {
const { createLegacySidecarDataAccess } = await import(${JSON.stringify(legacySidecarsModuleUrl)});
const [, databasePath, originalsLibraryPath] = process.argv;
const access = createLegacySidecarDataAccess({ databasePath });
try {
  access.legacySidecars.importLibrary({ originalsLibraryPath });
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (!/release acknowledgement/i.test(message)) process.exitCode = 1;
} finally {
  access.close();
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
        databasePath,
        originalsLibraryPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, RIP_DVD_PYTHON: helperPath },
        timeout: 7_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toMatch(/release acknowledgement/i);
    const helperPid = Number(readFileSync(helperPidPath, "utf8"));
    expect(() => process.kill(helperPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

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

  it("waits past the former deadline for an in-flight legacy mutation", async () => {
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
    const intentPath = join(
      originalsLibraryPath,
      ".rip-dvd-legacy-queue.intent.lock",
    );
    const legacyMutation = spawn("python3", [
      "-c",
      `import fcntl, sys, time
intent = open(sys.argv[1], "a+")
gate = open(sys.argv[2], "a+")
fcntl.flock(intent, fcntl.LOCK_EX)
fcntl.flock(gate, fcntl.LOCK_SH)
fcntl.flock(intent, fcntl.LOCK_UN)
print("ready", flush=True)
time.sleep(0.2)
with open(sys.argv[3], "rb") as source:
    contents = source.read()
with open(sys.argv[4], "wb") as destination:
    destination.write(contents)
fcntl.flock(gate, fcntl.LOCK_UN)`,
      intentPath,
      lockPath,
      completedSidecarPath,
      sidecarPath,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    if (!legacyMutation.stdout) {
      throw new Error("Expected the legacy mutation readiness pipe");
    }
    await once(legacyMutation.stdout, "data");
    legacyMutation.stdout.destroy();
    legacyMutation.unref();
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({ databasePath });

    const dateNow = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(20_000);
    const report = (() => {
      try {
        return access.legacySidecars.importLibrary({ originalsLibraryPath });
      } finally {
        dateNow.mockRestore();
      }
    })();
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

  it("reports a captured winner missing after marker publication and restart", () => {
    const root = temporaryDirectories.create("rip-dvd-cutover-missing-winner-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Missing.iso");
    const sidecarPath = join(originalsLibraryPath, "Missing.rip-dvd.json");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Missing",
      disc_fingerprint: "missing-winner-fingerprint",
      jobs: [{
        label: "Movie: Missing",
        source: archivePath,
        output: join(root, "movies", "Missing.mkv"),
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });
    expect(() => interrupted.legacySidecars.importLibrary({ originalsLibraryPath }))
      .toThrow(/directory sync failure/);
    interrupted.close();
    unlinkSync(sidecarPath);
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({ originalsLibraryPath });

    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "invalid_job",
        jobIndex: 0,
        sidecarPath,
        message: expect.stringMatching(/captured.*missing/i),
      }),
    ]);
    expect(retry.encodeJobs.list()).toEqual([]);
    retry.close();
  });

  it("scavenges crash-orphan owner artifacts without trusting a reused PID", () => {
    const root = temporaryDirectories.create("rip-dvd-cutover-orphans-");
    const originalsLibraryPath = join(root, "originals");
    mkdirSync(originalsLibraryPath, { recursive: true });
    const orphanPaths = [
      join(originalsLibraryPath, `.rip-dvd-legacy-queue.lock.${process.pid}.orphan.owner`),
      join(originalsLibraryPath, `.rip-dvd-legacy-queue.owner.${process.pid}.orphan.tmp`),
      join(originalsLibraryPath, `.rip-dvd-legacy-queue.shared.${process.pid}.orphan`),
    ];
    for (const path of orphanPaths) {
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        role: "legacy-command",
      }));
    }
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    expect(access.legacySidecars.importLibrary({ originalsLibraryPath }).issues)
      .toEqual([]);
    expect(orphanPaths.map((path) => existsSync(path))).toEqual([
      false,
      false,
      false,
    ]);
    access.close();
  });

  it("reclaims crashed command and cutover leases before and after publication", () => {
    const root = temporaryDirectories.create("rip-dvd-cutover-stale-lease-");
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Crash.iso");
    const sidecarPath = join(originalsLibraryPath, "Crash.rip-dvd.json");
    const databasePath = join(root, "catalog.sqlite");
    const staleOwner = JSON.stringify({
      schemaVersion: 1,
      pid: 999_999,
      role: "legacy-command",
    });
    const sharedLeasePath = join(
      originalsLibraryPath,
      ".rip-dvd-legacy-queue.shared.crashed",
    );
    const cutoverLockPath = join(
      originalsLibraryPath,
      ".rip-dvd-legacy-queue.lock",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Crash",
        disc_fingerprint: "crash-fingerprint",
        jobs: [{
          label: "Movie: Crash",
          source: archivePath,
          output: join(root, "movies", "Crash.mkv"),
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );
    writeFileSync(sharedLeasePath, staleOwner);
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({ databasePath });

    expect(access.legacySidecars.importLibrary({ originalsLibraryPath }).issues)
      .toEqual([]);
    expect(existsSync(sharedLeasePath)).toBe(false);
    writeFileSync(cutoverLockPath, staleOwner);
    expect(access.legacySidecars.importLibrary({ originalsLibraryPath }).issues)
      .toEqual([]);
    expect(existsSync(cutoverLockPath)).toBe(true);
    expect(access.encodeJobs.list()).toHaveLength(1);
    access.close();
  });
});
