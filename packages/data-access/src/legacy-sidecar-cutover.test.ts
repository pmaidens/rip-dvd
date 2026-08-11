import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { completeCatalogReview } from "./catalog.test-support.js";
import { decodeDvdTitleMap } from "./dvd-scan.js";
import {
  createDataAccess,
  DomainInvariantError,
  ENCODE_JOB_LEASE_DURATION_MS,
  StaleJobAttemptError,
} from "./index.js";
import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";
import { createTemporaryDirectoryFixture } from "./legacy-sidecar.test-support.js";

const markerFault = vi.hoisted(() => ({
  afterArchiveSnapshot: null as (() => void) | null,
  afterDirectorySync: null as (() => void) | null,
  archivePath: null as string | null,
  directorySyncs: 0,
  failure: "rename" as "directory-sync" | "rename" | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const archiveDescriptors = new Set<number>();
  const isMarker = (path: unknown) =>
    typeof path === "string" && path.endsWith(".rip-dvd-sqlite-catalog");
  return {
    ...actual,
    closeSync(descriptor: number) {
      const result = actual.closeSync(descriptor);
      if (archiveDescriptors.delete(descriptor)) {
        const afterArchiveSnapshot = markerFault.afterArchiveSnapshot;
        markerFault.afterArchiveSnapshot = null;
        afterArchiveSnapshot?.();
      }
      return result;
    },
    fsyncSync(descriptor: number) {
      if (actual.fstatSync(descriptor).isDirectory()) {
        markerFault.directorySyncs += 1;
        if (markerFault.failure === "directory-sync") {
          throw new Error("injected directory sync failure");
        }
        const result = actual.fsyncSync(descriptor);
        const afterDirectorySync = markerFault.afterDirectorySync;
        markerFault.afterDirectorySync = null;
        afterDirectorySync?.();
        return result;
      }
      return actual.fsyncSync(descriptor);
    },
    renameSync(source: string, destination: string) {
      if (markerFault.failure === "rename" && isMarker(destination)) {
        throw new Error("injected marker write failure");
      }
      return actual.renameSync(source, destination);
    },
    openSync(...arguments_: Parameters<typeof actual.openSync>) {
      const descriptor = Reflect.apply(actual.openSync, actual, arguments_);
      if (arguments_[0] === markerFault.archivePath) {
        archiveDescriptors.add(descriptor);
      }
      return descriptor;
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
  vi.useRealTimers();
  delete process.env.RIP_DVD_PYTHON;
  markerFault.afterArchiveSnapshot = null;
  markerFault.afterDirectorySync = null;
  markerFault.archivePath = null;
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

  it("ignores a queue lease helper planted in the invocation directory", () => {
    const root = temporaryDirectories.create("rip-dvd-helper-cwd-");
    const originalsLibraryPath = join(root, "originals");
    const plantedHelperDirectory = join(root, "rip_dvd");
    const executionMarkerPath = join(root, "planted-helper-executed");
    mkdirSync(originalsLibraryPath, { recursive: true });
    mkdirSync(plantedHelperDirectory);
    writeFileSync(
      join(plantedHelperDirectory, "legacy_queue_lease.py"),
      `from pathlib import Path\nPath(${JSON.stringify(executionMarkerPath)}).write_text("executed")\nraise SystemExit(91)\n`,
    );
    const previousWorkingDirectory = process.cwd();
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({
      databasePath: join(root, "catalog.sqlite"),
    });

    try {
      process.chdir(root);
      expect(
        access.legacySidecars.importLibrary({ originalsLibraryPath }),
      ).toMatchObject({
        sidecarsFound: 0,
        sidecarsImported: 0,
        sidecarsSkipped: 0,
      });
      expect(existsSync(executionMarkerPath)).toBe(false);
    } finally {
      process.chdir(previousWorkingDirectory);
      access.close();
    }
  });

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

  it("makes an active attempt stale as soon as cutover staging persists its fence", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-attempt-fence-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Attempt.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Attempt.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Attempt.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "attempt archive");

    const access = createLegacySidecarDataAccess({ databasePath });
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "cutover-attempt-fingerprint",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath,
      fingerprint: "cutover-attempt-fingerprint",
    });
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Attempt",
    });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      kind: "main_feature",
    });
    completeCatalogReview(access, archive.id);
    const preset = "Fast 480p30";
    const profile = access.encodingProfiles.create({
      key: `legacy-handbrake-fast-480p30-${createHash("sha256")
        .update(preset)
        .digest("hex")
        .slice(0, 12)}`,
      displayName: preset,
      mediaDomain: "dvd_video",
      settings: { preset },
    });
    access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath,
    });
    const running = access.encodeJobs.claimNext("cutover-attempt-worker");
    if (!running) {
      throw new Error("Expected Encode Job to be running");
    }
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Attempt",
      disc_fingerprint: "cutover-attempt-fingerprint",
      jobs: [{
        label: "Movie: Attempt",
        source: archivePath,
        output: outputPath,
        preset,
        selection: "main_feature",
        title_number: null,
      }],
    }));

    const pendingPublication = access.encodeJobs.registerPartialCleanup(
      running,
      { publicationPending: true },
    );
    const activeMutation = access.encodeJobs.beginPublicationMutation(
      running,
      pendingPublication,
    );
    expect(() =>
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toThrow(/active Encode publication mutation/);
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: running.id,
        partialCleanupLeaseToken: activeMutation.leaseToken,
        publicationPending: true,
        status: "running",
      }),
    ]);
    const revokedMutation = access.encodeJobs.revokePublication(
      running,
      activeMutation,
    );
    access.encodeJobs.completePartialCleanup(revokedMutation);

    expect(() =>
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toThrow(/injected marker write failure/);
    expect(() => access.encodeJobs.complete(running)).toThrow(
      StaleJobAttemptError,
    );
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: running.id,
        partialCleanupClaimToken: running.claimToken,
        partialCleanupOutputPath: running.outputPath,
        status: "failed",
        completedAt: null,
        errorMessage:
          "Encode Job invalidated by legacy catalog cutover repair",
      }),
    ]);
    markerFault.failure = null;
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, sidecarsSkipped: 0, issues: [] });
    expect(() => access.encodeJobs.complete(running)).toThrow(
      StaleJobAttemptError,
    );
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ id: running.id, status: "failed" }),
    ]);
    const [cutoverCleanup] =
      access.encodeJobs.listPendingPartialCleanups();
    expect(cutoverCleanup).toEqual({
      claimToken: running.claimToken,
      jobId: running.id,
      leaseToken: null,
      outputPath: running.outputPath,
      publicationPending: false,
    });
    if (!cutoverCleanup) {
      throw new Error("Expected cutover partial cleanup provenance");
    }
    expect(() =>
      access.encodeJobs.completePublishedPartial(cutoverCleanup, () => true),
    ).toThrow(/not publication provenance/);
    access.close();
  });

  it("retains first-migration A+B inventory when marker publication fails", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-new-durable-staging-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    const createSidecar = (name: string) => {
      const archivePath = join(originalsLibraryPath, `${name}.iso`);
      const sidecarPath = join(
        originalsLibraryPath,
        `${name}.rip-dvd.json`,
      );
      const outputPath = join(root, "movies", `${name}.mkv`);
      writeFileSync(archivePath, `${name} archive`);
      const sidecarBytes = Buffer.from(JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: name,
        disc_fingerprint: `new-durable-${name.toLowerCase()}-fingerprint`,
        jobs: [{
          label: `Movie: ${name}`,
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }));
      writeFileSync(sidecarPath, sidecarBytes);
      return { outputPath, sidecarBytes, sidecarPath };
    };
    const first = createSidecar("A");
    const second = createSidecar("B");

    const failedPublication = createLegacySidecarDataAccess({ databasePath });
    expect(() =>
      failedPublication.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toThrow(/injected marker write failure/);
    expect(existsSync(markerPath)).toBe(false);
    expect(failedPublication.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(failedPublication.encodeJobs.list()).toEqual([]);
    failedPublication.close();

    const service = createDataAccess({
      databasePath,
      originalsLibraryPath,
    });
    const drive = service.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const concurrentFingerprint = "concurrent-cutover-archive-fingerprint";
    const concurrentArchivePath = join(
      originalsLibraryPath,
      "Concurrent.iso",
    );
    writeFileSync(concurrentArchivePath, "concurrent archive");
    const concurrentDisc = service.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: concurrentFingerprint,
    });
    service.catalog.updateDetectedDiscStatus(concurrentDisc.id, "scanned");
    service.archiveJobs.approve({ detectedDiscId: concurrentDisc.id });
    const concurrentClaim = service.archiveJobs.claimNext(
      "concurrent-worker",
      {
        opticalDriveId: drive.id,
        fingerprint: concurrentFingerprint,
      },
    );
    if (!concurrentClaim) {
      throw new Error("Expected the concurrent Archive Job to be claimed");
    }
    service.archiveJobs.publish(concurrentClaim, {
      archivePath: concurrentArchivePath,
      sizeBytes: 4_700_000_000,
    });
    const concurrentArchive = service.catalog
      .listOriginalDiscArchives()
      .find((archive) => archive.fingerprint === concurrentFingerprint);
    expect(concurrentArchive).toMatchObject({
      legacyCutoverPending: true,
    });
    service.close();

    markerFault.failure = null;
    const incompleteRetry = createLegacySidecarDataAccess({ databasePath });
    const replacementArchivePath = join(originalsLibraryPath, "C.iso");
    writeFileSync(replacementArchivePath, "C archive");
    writeFileSync(second.sidecarPath, JSON.stringify({
      schema_version: 2,
      source: replacementArchivePath,
      title: "C",
      disc_fingerprint: "new-durable-c-fingerprint",
      jobs: [{
        label: "Movie: C",
        source: replacementArchivePath,
        output: join(root, "movies", "C.mkv"),
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    expect(
      incompleteRetry.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(incompleteRetry.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        id: concurrentArchive!.id,
        legacyCutoverPending: true,
      }),
    ]);
    expect(incompleteRetry.encodeJobs.list()).toEqual([]);

    writeFileSync(second.sidecarPath, second.sidecarBytes);
    expect(
      incompleteRetry.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 2,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(true);
    expect(incompleteRetry.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: first.outputPath }),
        expect.objectContaining({ outputPath: second.outputPath }),
      ]),
    );
    expect(
      incompleteRetry.catalog.listOriginalDiscArchives()
        .find((archive) => archive.id === concurrentArchive!.id),
    ).toMatchObject({ legacyCutoverPending: false });
    incompleteRetry.close();
  });

  it("does not grow durable staging beyond its bounded inventory", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-bounded-durable-staging-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const archivePath = join(originalsLibraryPath, "Current.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Current.rip-dvd.json",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "current archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Current",
      disc_fingerprint: "bounded-current-fingerprint",
      jobs: [{
        label: "Movie: Current",
        source: archivePath,
        output: join(root, "movies", "Current.mkv"),
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));

    const migrated = createLegacySidecarDataAccess({ databasePath });
    migrated.close();
    const sqlite = new DatabaseSync(databasePath);
    const insert = sqlite.prepare(`
      insert into legacy_cutover_staged_sidecars (
        originals_library_path,
        sidecar_path,
        archive_path,
        fingerprint
      ) values (?, ?, ?, ?)
    `);
    sqlite.exec("begin immediate");
    for (let index = 0; index < 10_000; index += 1) {
      insert.run(
        originalsLibraryPath,
        join(originalsLibraryPath, `missing-${index}.rip-dvd.json`),
        join(originalsLibraryPath, `missing-${index}.iso`),
        `missing-${index}-fingerprint`,
      );
    }
    sqlite.exec("commit");
    sqlite.close();

    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });
    expect(
      retry.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 0,
      sidecarsSkipped: 1,
    });
    retry.close();

    const inspected = new DatabaseSync(databasePath);
    expect(
      inspected.prepare(`
        select count(*) as count
        from legacy_cutover_staged_sidecars
        where originals_library_path = ?
      `).get(originalsLibraryPath),
    ).toEqual({ count: 10_000 });
    inspected.close();
  });

  it("refuses incomplete replacement after a repair-marker write failure", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-repair-replacement-staging-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    const createSidecar = (name: string) => {
      const archivePath = join(originalsLibraryPath, `${name}.iso`);
      const sidecarPath = join(
        originalsLibraryPath,
        `${name}.rip-dvd.json`,
      );
      const outputPath = join(root, "movies", `${name}.mkv`);
      writeFileSync(archivePath, `${name} archive`);
      const sidecarBytes = Buffer.from(JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: name,
        disc_fingerprint: `repair-replacement-${name.toLowerCase()}-fingerprint`,
        jobs: [{
          label: `Movie: ${name}`,
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }));
      writeFileSync(sidecarPath, sidecarBytes);
      return { outputPath, sidecarBytes, sidecarPath };
    };
    const first = createSidecar("A");
    markerFault.failure = null;
    const initial = createLegacySidecarDataAccess({ databasePath });
    expect(initial.legacySidecars.importLibrary({ originalsLibraryPath }))
      .toMatchObject({ sidecarsImported: 1, issues: [] });
    initial.close();
    const retiredMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      legacyQueueStatus: string;
    };
    writeFileSync(markerPath, `${JSON.stringify({
      ...retiredMarker,
      legacyQueueStatus: "repair",
    })}\n`);
    const second = createSidecar("B");

    markerFault.failure = "rename";
    const failedReplacement = createLegacySidecarDataAccess({ databasePath });
    expect(() =>
      failedReplacement.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toThrow(/injected marker write failure/);
    failedReplacement.close();

    markerFault.failure = null;
    const incompleteRetry = createLegacySidecarDataAccess({ databasePath });
    const replacementArchivePath = join(originalsLibraryPath, "C.iso");
    writeFileSync(replacementArchivePath, "C archive");
    writeFileSync(second.sidecarPath, JSON.stringify({
      schema_version: 2,
      source: replacementArchivePath,
      title: "C",
      disc_fingerprint: "repair-replacement-c-fingerprint",
      jobs: [{
        label: "Movie: C",
        source: replacementArchivePath,
        output: join(root, "movies", "C.mkv"),
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    expect(
      incompleteRetry.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
      issues: [],
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });
    expect(() =>
      completeCatalogReview(
        incompleteRetry,
        incompleteRetry.catalog.listOriginalDiscArchives()[0]!.id,
      ),
    ).toThrow(DomainInvariantError);

    writeFileSync(second.sidecarPath, second.sidecarBytes);
    expect(
      incompleteRetry.legacySidecars.importLibrary({
        originalsLibraryPath,
      }).issues,
    ).toEqual([]);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "retired",
    });
    expect(incompleteRetry.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputPath: first.outputPath }),
        expect.objectContaining({ outputPath: second.outputPath }),
      ]),
    );
    incompleteRetry.close();
  });

  it("fences and retries an anchored identity correction after publication fails", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-anchored-correction-retry-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    const writeArchiveOnlySidecar = (
      sidecarPath: string,
      archivePath: string,
      fingerprint: string,
      title: string,
    ) => {
      writeFileSync(archivePath, `${title} archive`);
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title,
        disc_fingerprint: fingerprint,
        jobs: [],
      }));
    };
    const firstSidecarPath = join(
      originalsLibraryPath,
      "A.rip-dvd.json",
    );
    writeArchiveOnlySidecar(
      firstSidecarPath,
      join(originalsLibraryPath, "A.iso"),
      "anchored-correction-a-fingerprint",
      "A",
    );
    markerFault.failure = null;
    const initial = createLegacySidecarDataAccess({ databasePath });
    expect(initial.legacySidecars.importLibrary({ originalsLibraryPath }))
      .toMatchObject({ sidecarsImported: 1, issues: [] });
    const originalArchiveId = initial.catalog
      .listOriginalDiscArchives()[0]!.id;
    initial.close();
    const retiredMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      legacyQueueStatus: string;
    };
    writeFileSync(markerPath, `${JSON.stringify({
      ...retiredMarker,
      legacyQueueStatus: "repair",
    })}\n`);

    writeArchiveOnlySidecar(
      firstSidecarPath,
      join(originalsLibraryPath, "A-repaired.iso"),
      "anchored-correction-a-repaired-fingerprint",
      "A repaired",
    );
    writeArchiveOnlySidecar(
      join(originalsLibraryPath, "B.rip-dvd.json"),
      join(originalsLibraryPath, "B.iso"),
      "anchored-correction-b-fingerprint",
      "B",
    );
    markerFault.failure = null;
    markerFault.afterDirectorySync = () => {
      markerFault.failure = "directory-sync";
    };
    const failedReplacement = createLegacySidecarDataAccess({ databasePath });
    expect(() =>
      failedReplacement.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toThrow(/injected directory sync failure/);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "retired",
      legacySidecars: expect.arrayContaining([
        expect.objectContaining({
          archivePath: join(originalsLibraryPath, "A-repaired.iso"),
          fingerprint: "anchored-correction-a-repaired-fingerprint",
        }),
      ]),
    });
    failedReplacement.close();

    const service = createDataAccess({
      databasePath,
      originalsLibraryPath,
    });
    const drive = service.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const repairedFingerprint = "anchored-correction-a-repaired-fingerprint";
    const repairedArchivePath = join(
      originalsLibraryPath,
      "A-repaired.iso",
    );
    const disc = service.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: repairedFingerprint,
    });
    service.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    service.archiveJobs.approve({ detectedDiscId: disc.id });
    const claim = service.archiveJobs.claimNext("replacement-worker", {
      opticalDriveId: drive.id,
      fingerprint: repairedFingerprint,
    });
    if (!claim) {
      throw new Error("Expected the repaired Archive Job to be claimed");
    }
    service.archiveJobs.publish(claim, {
      archivePath: repairedArchivePath,
      sizeBytes: 4_700_000_000,
    });
    const replacementArchive = service.catalog
      .listOriginalDiscArchives()
      .find((archive) => archive.fingerprint === repairedFingerprint);
    expect(replacementArchive).toMatchObject({
      legacyCutoverPending: true,
    });
    service.close();

    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });
    expect(
      retry.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 2,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "retired",
    });
    const archives = retry.catalog.listOriginalDiscArchives();
    expect(archives).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: replacementArchive!.id,
        archivePath: repairedArchivePath,
        fingerprint: repairedFingerprint,
        legacyCutoverPending: false,
      }),
      expect.objectContaining({
        archivePath: join(originalsLibraryPath, "B.iso"),
        fingerprint: "anchored-correction-b-fingerprint",
      }),
    ]));
    expect(archives).toEqual(
      archives.map((archive) => expect.objectContaining({
        id: archive.id,
        legacyCutoverPending: false,
      })),
    );
    expect(archives).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: originalArchiveId,
        legacyCutoverPending: false,
      }),
    ]));
    retry.close();
  });

  it("refuses to replace a failed A+B publication with an incomplete A-only inventory", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-durable-staging-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });

    const setup = createLegacySidecarDataAccess({ databasePath });
    const drive = setup.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const createReviewedArchive = (name: string) => {
      const fingerprint = `durable-${name.toLowerCase()}-fingerprint`;
      const archivePath = join(originalsLibraryPath, `${name}.iso`);
      const sidecarPath = join(
        originalsLibraryPath,
        `${name}.rip-dvd.json`,
      );
      const outputPath = join(root, "movies", `${name}.mkv`);
      writeFileSync(archivePath, `${name} archive`);
      const disc = setup.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      setup.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      setup.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = setup.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath,
        fingerprint,
      });
      const item = setup.catalog.createMediaItem({
        kind: "movie",
        title: name,
      });
      setup.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        kind: "main_feature",
      });
      completeCatalogReview(setup, archive.id);
      const sidecarBytes = Buffer.from(JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: name,
        disc_fingerprint: fingerprint,
        jobs: [{
          label: `Movie: ${name}`,
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }));
      writeFileSync(sidecarPath, sidecarBytes);
      return { archive, outputPath, sidecarBytes, sidecarPath };
    };
    const first = createReviewedArchive("A");
    const second = createReviewedArchive("B");
    setup.close();

    const failedPublication = createLegacySidecarDataAccess({ databasePath });
    expect(() =>
      failedPublication.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toThrow(/injected marker write failure/);
    expect(existsSync(markerPath)).toBe(false);
    for (const archive of [first.archive, second.archive]) {
      expect(() =>
        completeCatalogReview(failedPublication, archive.id),
      ).toThrow(DomainInvariantError);
    }
    failedPublication.close();

    unlinkSync(second.sidecarPath);
    markerFault.failure = null;
    const incompleteRetry = createLegacySidecarDataAccess({ databasePath });
    expect(
      incompleteRetry.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(incompleteRetry.encodeJobs.list()).toEqual([]);
    for (const archive of [first.archive, second.archive]) {
      expect(() =>
        completeCatalogReview(incompleteRetry, archive.id),
      ).toThrow(DomainInvariantError);
    }

    writeFileSync(second.sidecarPath, second.sidecarBytes);
    expect(
      incompleteRetry.legacySidecars.importLibrary({
        originalsLibraryPath,
      }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 2,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(existsSync(markerPath)).toBe(true);
    expect(incompleteRetry.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputPath: first.outputPath,
          status: "queued",
        }),
        expect.objectContaining({
          outputPath: second.outputPath,
          status: "queued",
        }),
      ]),
    );
    expect(incompleteRetry.encodeJobs.claimNext("durable-retry-worker"))
      .not.toBeNull();
    incompleteRetry.close();
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

  it.each([2, 3] as const)(
    "fails closed when a schema-%s marker cannot prove source-object provenance",
    (schemaVersion) => {
      const root = temporaryDirectories.create(
        `rip-dvd-cutover-schema-${schemaVersion}-crash-`,
      );
      const originalsLibraryPath = join(root, "originals");
      const archivePath = join(originalsLibraryPath, "Legacy.iso");
      const sidecarPath = join(
        originalsLibraryPath,
        "Legacy.rip-dvd.json",
      );
      const outputPath = join(root, "movies", "Legacy.mkv");
      const databasePath = join(root, "catalog.sqlite");
      const markerPath = join(
        originalsLibraryPath,
        ".rip-dvd-sqlite-catalog",
      );
      mkdirSync(originalsLibraryPath, { recursive: true });
      writeFileSync(archivePath, "archive");
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Legacy",
        disc_fingerprint: `schema-${schemaVersion}-crash-fingerprint`,
        jobs: [{
          label: "Movie: Legacy",
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }));
      markerFault.failure = "directory-sync";
      const interrupted = createLegacySidecarDataAccess({ databasePath });
      expect(() => interrupted.legacySidecars.importLibrary({
        originalsLibraryPath,
      })).toThrow(/injected directory sync failure/i);
      interrupted.close();

      const currentMarker = JSON.parse(
        readFileSync(markerPath, "utf8"),
      ) as {
        legacyJobs: Array<{
          jobIndex: number;
          logicalKey: string;
          sidecarPath: string;
          signature: string;
        }>;
      };
      const legacyJobs = currentMarker.legacyJobs.map((job) =>
        schemaVersion === 2
          ? { logicalKey: job.logicalKey, signature: job.signature }
          : job
      );
      writeFileSync(markerPath, JSON.stringify({
        schemaVersion,
        legacyQueueStatus: "retired",
        authoritativeStore: "sqlite",
        legacyJobs,
        snapshotDigest: createHash("sha256")
          .update(JSON.stringify(legacyJobs))
          .digest("hex"),
      }));
      unlinkSync(archivePath);
      writeFileSync(
        archivePath,
        "replacement archive bytes that historical markers cannot identify",
      );
      markerFault.failure = null;
      const retry = createLegacySidecarDataAccess({ databasePath });

      const report = retry.legacySidecars.importLibrary({
        originalsLibraryPath,
      });

      expect(report).toMatchObject({
        sidecarsImported: 0,
        sidecarsSkipped: 1,
        recordsCreated: { originalDiscArchives: 0, encodeJobs: 0 },
      });
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: expect.stringMatching(/schema-[23].*explicit.*recovery/i),
          sidecarPath,
        }),
      ]));
      expect(retry.catalog.listOriginalDiscArchives()).toEqual([]);
      expect(retry.encodeJobs.list()).toEqual([]);
      retry.close();
    },
  );

  it.each([2, 3] as const)(
    "recovers a schema-%s pre-transaction crash only with explicit operator intent",
    (schemaVersion) => {
      const root = temporaryDirectories.create(
        `rip-dvd-cutover-schema-${schemaVersion}-explicit-recovery-`,
      );
      const originalsLibraryPath = join(root, "originals");
      const archivePath = join(originalsLibraryPath, "Legacy.iso");
      const sidecarPath = join(
        originalsLibraryPath,
        "Legacy.rip-dvd.json",
      );
      const outputPath = join(root, "movies", "Legacy.mkv");
      const databasePath = join(root, "catalog.sqlite");
      const markerPath = join(
        originalsLibraryPath,
        ".rip-dvd-sqlite-catalog",
      );
      mkdirSync(originalsLibraryPath, { recursive: true });
      writeFileSync(archivePath, "archive");
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Legacy",
        disc_fingerprint: `schema-${schemaVersion}-explicit-fingerprint`,
        jobs: [{
          label: "Movie: Legacy",
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }));
      markerFault.failure = "directory-sync";
      const interrupted = createLegacySidecarDataAccess({ databasePath });
      expect(() => interrupted.legacySidecars.importLibrary({
        originalsLibraryPath,
      })).toThrow(/injected directory sync failure/i);
      interrupted.close();
      const currentMarker = JSON.parse(
        readFileSync(markerPath, "utf8"),
      ) as {
        legacyJobs: Array<{
          jobIndex: number;
          logicalKey: string;
          sidecarPath: string;
          signature: string;
        }>;
      };
      const legacyJobs = currentMarker.legacyJobs.map((job) =>
        schemaVersion === 2
          ? { logicalKey: job.logicalKey, signature: job.signature }
          : job
      );
      writeFileSync(markerPath, JSON.stringify({
        schemaVersion,
        legacyQueueStatus: "retired",
        authoritativeStore: "sqlite",
        legacyJobs,
        snapshotDigest: createHash("sha256")
          .update(JSON.stringify(legacyJobs))
          .digest("hex"),
      }));
      if (schemaVersion === 3) {
        mkdirSync(join(root, "movies"), { recursive: true });
        writeFileSync(outputPath, "post-cutover output drift");
      }
      markerFault.failure = null;
      const retry = createLegacySidecarDataAccess({ databasePath });

      const closedReport = retry.legacySidecars.importLibrary({
        originalsLibraryPath,
      });
      const recoveredReport = retry.legacySidecars.importLibrary({
        originalsLibraryPath,
        recoverHistoricalCutover: true,
      });

      expect(closedReport).toMatchObject({
        sidecarsImported: 0,
        recordsCreated: { originalDiscArchives: 0, encodeJobs: 0 },
        issues: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/explicit.*recovery/i),
          }),
        ]),
      });
      expect(recoveredReport.issues).toEqual([]);
      expect(recoveredReport.sidecarsImported).toBe(1);
      expect(retry.catalog.listOriginalDiscArchives()).toEqual([
        expect.objectContaining({ archivePath }),
      ]);
      expect(retry.encodeJobs.list()).toEqual([
        expect.objectContaining({
          outputPath,
          status: schemaVersion === 3 ? "completed" : "queued",
        }),
      ]);
      retry.close();
    },
  );

  it.each([
    {
      bound: "scan bytes",
      normalMessage:
        "Aggregate sidecar scan work exceeds the 67108864-byte limit",
      recoveryMessage:
        "Aggregate recovery sidecar scan work exceeds the 67108864-byte limit",
      sidecarCount: 64,
    },
    {
      bound: "retained bytes",
      normalMessage:
        "Aggregate sidecar bytes exceed the 8388608-byte import limit",
      recoveryMessage:
        "Aggregate recovery sidecar bytes exceed the 8388608-byte import limit",
      sidecarCount: 10,
    },
    {
      bound: "jobs",
      normalMessage:
        "Aggregate legacy jobs exceed the 1000-job import limit",
      recoveryMessage:
        "Aggregate recovery legacy jobs exceed the 1000-job import limit",
      sidecarCount: 11,
    },
  ] as const)(
    "identifies the shared $bound bound in discovery and historical recovery",
    ({ bound, normalMessage, recoveryMessage, sidecarCount }) => {
      const root = temporaryDirectories.create(
        "rip-dvd-cutover-shared-import-budget-",
      );
      const originalsLibraryPath = join(root, "originals");
      const databasePath = join(root, "catalog.sqlite");
      const markerPath = join(
        originalsLibraryPath,
        ".rip-dvd-sqlite-catalog",
      );
      const capturedSidecars: Array<{
        archivePath: string;
        sidecarPath: string;
        sidecar: Record<string, unknown>;
      }> = [];
      mkdirSync(originalsLibraryPath, { recursive: true });
      for (
        let sidecarIndex = 1;
        sidecarIndex <= sidecarCount;
        sidecarIndex += 1
      ) {
        const archivePath = join(
          originalsLibraryPath,
          `Shared Budget ${sidecarIndex}.iso`,
        );
        const sidecarPath = join(
          originalsLibraryPath,
          `Shared Budget ${sidecarIndex}.rip-dvd.json`,
        );
        const sidecar = {
          schema_version: 2,
          source: archivePath,
          title: `Shared Budget ${sidecarIndex}`,
          disc_fingerprint: `shared-job-budget-${sidecarIndex}`,
          jobs: [{
            label: `Extra 1: Shared Budget ${sidecarIndex}`,
            source: archivePath,
            output: join(
              root,
              "movies",
              `shared-budget-${sidecarIndex}-1.mkv`,
            ),
            preset: "Fast 480p30",
            selection: "title",
            title_number: 1,
          }],
        };
        writeFileSync(archivePath, `archive ${sidecarIndex}`);
        writeFileSync(sidecarPath, JSON.stringify(sidecar));
        capturedSidecars.push({ archivePath, sidecarPath, sidecar });
      }
      markerFault.failure = "directory-sync";
      const interrupted = createLegacySidecarDataAccess({ databasePath });
      expect(() => interrupted.legacySidecars.importLibrary({
        originalsLibraryPath,
      })).toThrow(/injected directory sync failure/i);
      interrupted.close();
      const currentMarker = JSON.parse(
        readFileSync(markerPath, "utf8"),
      ) as {
        legacyJobs: Array<{
          jobIndex: number;
          logicalKey: string;
          sidecarPath: string;
          signature: string;
        }>;
      };
      writeFileSync(markerPath, JSON.stringify({
        schemaVersion: 3,
        legacyQueueStatus: "retired",
        authoritativeStore: "sqlite",
        legacyJobs: currentMarker.legacyJobs,
        snapshotDigest: createHash("sha256")
          .update(JSON.stringify(currentMarker.legacyJobs))
          .digest("hex"),
      }));
      for (const [sidecarIndex, captured] of capturedSidecars.entries()) {
        const { archivePath, sidecarPath, sidecar } = captured;
        if (bound === "scan bytes") {
          truncateSync(sidecarPath, 1_048_577);
          continue;
        }
        writeFileSync(sidecarPath, JSON.stringify({
          ...sidecar,
          ...(bound === "retained bytes"
            ? { padding: "x".repeat(840_000) }
            : {}),
          jobs: bound === "jobs"
            ? Array.from({ length: 100 }, (_, jobIndex) => ({
                label: `Extra ${jobIndex + 1}: Shared Budget`,
                source: archivePath,
                output: join(
                  root,
                  "movies",
                  `shared-budget-${sidecarIndex + 1}-${jobIndex + 1}.mkv`,
                ),
                preset: "Fast 480p30",
                selection: "title",
                title_number: jobIndex + 1,
              }))
            : sidecar.jobs,
        }));
      }
      markerFault.failure = null;
      const retry = createLegacySidecarDataAccess({ databasePath });

      const report = retry.legacySidecars.importLibrary({
        originalsLibraryPath,
        recoverHistoricalCutover: true,
      });

      expect(report).toMatchObject({
        sidecarsImported: 0,
        sidecarsSkipped: sidecarCount,
      });
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_sidecar",
          message: normalMessage,
          sidecarPath: originalsLibraryPath,
        }),
        expect.objectContaining({
          code: "invalid_sidecar",
          message: recoveryMessage,
          sidecarPath: originalsLibraryPath,
        }),
      ]));
      expect(retry.catalog.listOriginalDiscArchives()).toEqual([]);
      expect(retry.encodeJobs.list()).toEqual([]);
      retry.close();
    },
    30_000,
  );

  it("uses schema-3 job locations when restart traversal is incomplete", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-schema-3-incomplete-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Z Legacy.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Z Legacy.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Z Legacy.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Z Legacy",
      disc_fingerprint: "schema-3-location-fingerprint",
      jobs: [{
        label: "Movie: Z Legacy",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });
    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    interrupted.close();

    const currentMarker = JSON.parse(
      readFileSync(markerPath, "utf8"),
    ) as {
      legacyJobs: Array<{
        jobIndex: number;
        logicalKey: string;
        sidecarPath: string;
        signature: string;
      }>;
    };
    writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 3,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
      legacyJobs: currentMarker.legacyJobs,
      snapshotDigest: createHash("sha256")
        .update(JSON.stringify(currentMarker.legacyJobs))
        .digest("hex"),
    }));
    for (let index = 1; index <= 9; index += 1) {
      const driftArchivePath = join(
        originalsLibraryPath,
        `A Drift ${index}.iso`,
      );
      writeFileSync(driftArchivePath, "archive");
      writeFileSync(
        join(originalsLibraryPath, `A Drift ${index}.rip-dvd.json`),
        JSON.stringify({
          schema_version: 2,
          source: driftArchivePath,
          title: `A Drift ${index}`,
          disc_fingerprint: `schema-3-drift-${index}`,
          jobs: [],
          padding: "x".repeat(950_000),
        }),
      );
    }
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 10,
    });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringMatching(/schema-[23].*explicit.*recovery/i),
        sidecarPath,
      }),
    ]));
    expect(retry.encodeJobs.list()).toEqual([]);
    retry.close();
  });

  it("recovers valid schema-3 records when corrupt captured payloads exceed the retained-state budget", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-schema-3-corrupt-partial-recovery-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const capturedSidecarPaths: string[] = [];
    const validOutputPath = join(root, "movies", "Captured 10.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    for (let index = 1; index <= 10; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const archivePath = join(
        originalsLibraryPath,
        `Z Captured ${suffix}.iso`,
      );
      const sidecarPath = join(
        originalsLibraryPath,
        `Z Captured ${suffix}.rip-dvd.json`,
      );
      const outputPath = join(root, "movies", `Captured ${suffix}.mkv`);
      writeFileSync(archivePath, `archive ${suffix}`);
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: `Captured ${suffix}`,
        disc_fingerprint: `schema-3-corrupt-${suffix}`,
        jobs: [{
          label: `Movie: Captured ${suffix}`,
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }));
      capturedSidecarPaths.push(sidecarPath);
    }
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });
    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    interrupted.close();
    const currentMarker = JSON.parse(
      readFileSync(markerPath, "utf8"),
    ) as {
      legacyJobs: Array<{
        jobIndex: number;
        logicalKey: string;
        sidecarPath: string;
        signature: string;
      }>;
    };
    writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 3,
      legacyQueueStatus: "retired",
      authoritativeStore: "sqlite",
      legacyJobs: currentMarker.legacyJobs,
      snapshotDigest: createHash("sha256")
        .update(JSON.stringify(currentMarker.legacyJobs))
        .digest("hex"),
    }));
    const corruptBytes = Buffer.alloc(950_000, 0x7b);
    for (const sidecarPath of capturedSidecarPaths.slice(0, 9)) {
      writeFileSync(sidecarPath, corruptBytes);
    }
    for (let index = 1; index <= 9; index += 1) {
      const archivePath = join(originalsLibraryPath, `A Drift ${index}.iso`);
      writeFileSync(archivePath, "archive");
      writeFileSync(
        join(originalsLibraryPath, `A Drift ${index}.rip-dvd.json`),
        JSON.stringify({
          schema_version: 2,
          source: archivePath,
          title: `A Drift ${index}`,
          disc_fingerprint: `schema-3-corrupt-drift-${index}`,
          jobs: [],
          padding: "x".repeat(950_000),
        }),
      );
    }
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
      recoverHistoricalCutover: true,
    });

    expect(report.sidecarsImported).toBe(1);
    expect(report.issues.filter((issue) =>
      issue.code === "corrupt_sidecar"
    )).toHaveLength(9);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath: validOutputPath }),
    ]);
    expect(retry.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({
        fingerprint: "schema-3-corrupt-10",
      }),
    ]);
    for (const sidecarPath of capturedSidecarPaths.slice(0, 9)) {
      expect(readFileSync(sidecarPath)).toEqual(corruptBytes);
    }
    retry.close();
  }, 30_000);

  it("resumes queued and archive-only sidecars when restart discovery becomes incomplete", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-incomplete-restart-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Recovery Movie.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Recovery Movie.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Recovery Movie.mkv");
    const archiveOnlyPath = join(
      originalsLibraryPath,
      "Archive Only.iso",
    );
    const archiveOnlySidecarPath = join(
      originalsLibraryPath,
      "Archive Only.rip-dvd.json",
    );
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(archiveOnlyPath, "archive only");
    writeFileSync(
      archiveOnlySidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archiveOnlyPath,
        title: "Archive Only",
        disc_fingerprint: "archive-only-fingerprint",
        jobs: [],
      }),
    );
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: "Recovery Movie",
        disc_fingerprint: "recovery-movie-fingerprint",
        jobs: [{
          label: "Movie: Recovery Movie",
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );
    const sidecarBytes = readFileSync(sidecarPath);
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });

    expect(() =>
      interrupted.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toThrow(/injected directory sync failure/i);
    expect(existsSync(markerPath)).toBe(true);
    expect(interrupted.encodeJobs.list()).toEqual([]);
    interrupted.close();

    for (let index = 1; index <= 9; index += 1) {
      const driftArchivePath = join(
        originalsLibraryPath,
        `A Drift ${index}.iso`,
      );
      writeFileSync(driftArchivePath, "archive");
      writeFileSync(
        join(originalsLibraryPath, `A Drift ${index}.rip-dvd.json`),
        JSON.stringify({
          schema_version: 2,
          source: driftArchivePath,
          title: `A Drift ${index}`,
          disc_fingerprint: `recovery-drift-${index}`,
          jobs: [],
          padding: "x".repeat(950_000),
        }),
      );
    }
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsFound: 11,
      sidecarsImported: 2,
      sidecarsSkipped: 9,
    });
    expect(report.issues).toEqual([
      expect.objectContaining({
        code: "invalid_sidecar",
        message: expect.stringMatching(/aggregate.*bytes.*8,?388,?608.*limit/i),
      }),
    ]);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(retry.catalog.listOriginalDiscArchives()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ archivePath }),
        expect.objectContaining({ archivePath: archiveOnlyPath }),
      ]),
    );
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    retry.close();
  });

  it("revalidates the captured archive after marker publication and before initial persistence", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-initial-archive-drift-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Captured.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Captured.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Captured.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "old");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Captured",
      disc_fingerprint: "initial-source-drift-fingerprint",
      jobs: [{
        label: "Movie: Captured",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    const sidecarBytes = readFileSync(sidecarPath);
    markerFault.failure = null;
    markerFault.afterDirectorySync = () => {
      unlinkSync(archivePath);
      writeFileSync(
        archivePath,
        "replacement archive bytes from a different object",
      );
    };
    const access = createLegacySidecarDataAccess({ databasePath });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/source archive.*captured.*cutover/i),
          sidecarPath: realpathSync(sidecarPath),
        }),
      ]),
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([]);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    access.close();
  });

  it("rolls back when the captured archive changes after transactional validation", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-transactional-archive-drift-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Captured.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Captured.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Captured.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "original archive object");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Captured",
      disc_fingerprint: "transactional-source-drift-fingerprint",
      jobs: [{
        label: "Movie: Captured",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    const sidecarBytes = readFileSync(sidecarPath);
    markerFault.failure = null;
    markerFault.afterDirectorySync = () => {
      markerFault.archivePath = archivePath;
      markerFault.afterArchiveSnapshot = () => {
        unlinkSync(archivePath);
        writeFileSync(
          archivePath,
          "replacement archive object with different bytes",
        );
      };
    };
    const access = createLegacySidecarDataAccess({ databasePath });

    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      recordsCreated: { originalDiscArchives: 0, encodeJobs: 0 },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/source archive.*captured.*cutover/i),
          sidecarPath: realpathSync(sidecarPath),
        }),
      ]),
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(access.encodeJobs.list()).toEqual([]);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    access.close();
  });

  it("does not publish an earlier same-fingerprint job before a later sidecar fails", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-fingerprint-batch-",
    );
    const originalsLibraryPath = join(root, "originals");
    const firstArchivePath = join(originalsLibraryPath, "First.iso");
    const conflictingArchivePath = join(originalsLibraryPath, "Conflict.iso");
    const continuationArchivePath = join(
      originalsLibraryPath,
      "Continuation.iso",
    );
    const outputPath = join(root, "movies", "First.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(firstArchivePath, "first archive");
    writeFileSync(conflictingArchivePath, "conflicting archive");
    writeFileSync(continuationArchivePath, "continuation archive");
    writeFileSync(
      join(originalsLibraryPath, "a-first.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: firstArchivePath,
        title: "Shared identity",
        disc_fingerprint: "batch-publication-fingerprint",
        jobs: [{
          label: "Movie: Shared identity",
          source: firstArchivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );
    writeFileSync(
      join(originalsLibraryPath, "b-conflict.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: conflictingArchivePath,
        title: "Shared identity",
        disc_fingerprint: "batch-publication-fingerprint",
        jobs: [],
      }),
    );
    writeFileSync(
      join(originalsLibraryPath, "c-continuation.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: continuationArchivePath,
        title: "Continuation",
        disc_fingerprint: "batch-continuation-fingerprint",
        jobs: [],
      }),
    );
    let observedClaim: ReturnType<
      ReturnType<typeof createDataAccess>["encodeJobs"]["claimNext"]
    > | undefined;
    let markerObservedAfterConflict: boolean | undefined;
    markerFault.failure = null;
    markerFault.afterDirectorySync = () => {
      markerFault.archivePath = conflictingArchivePath;
      markerFault.afterArchiveSnapshot = () => {
        const observer = createDataAccess({ databasePath });
        observedClaim = observer.encodeJobs.claimNext("batch-observer");
        observer.close();
        markerFault.archivePath = continuationArchivePath;
        markerFault.afterArchiveSnapshot = () => {
          markerObservedAfterConflict = existsSync(markerPath);
        };
      };
    };
    const access = createLegacySidecarDataAccess({ databasePath });

    const report = access.legacySidecars.importLibrary({ originalsLibraryPath });

    expect(report).toMatchObject({
      sidecarsImported: 2,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/fingerprint.*different path/i),
        }),
      ]),
    });
    expect(observedClaim).toBeNull();
    expect(markerObservedAfterConflict).toBe(true);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });
    expect(access.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(access.catalog.listOriginalDiscArchives()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ catalogReviewedAt: null }),
      ]),
    );
    access.close();
  });

  it("stages both reviewed sides of a fingerprint and path conflict before import", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-reviewed-split-",
    );
    const originalsLibraryPath = join(root, "originals");
    const fingerprintArchivePath = join(originalsLibraryPath, "Fingerprint.iso");
    const pathOwnerArchivePath = join(originalsLibraryPath, "Path Owner.iso");
    const repairedArchivePath = join(originalsLibraryPath, "Repaired.iso");
    const conflictingSidecarPath = join(
      originalsLibraryPath,
      "b-path-owner.rip-dvd.json",
    );
    const importedOutputPath = join(root, "movies", "Imported.mkv");
    const pathOwnerOutputPath = join(root, "movies", "Path Owner.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(fingerprintArchivePath, "fingerprint archive");
    writeFileSync(pathOwnerArchivePath, "path owner archive");
    const setup = createLegacySidecarDataAccess({ databasePath });
    const drive = setup.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const createReviewedArchive = (
      fingerprint: string,
      archivePath: string,
      title: string,
    ) => {
      const disc = setup.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
      });
      setup.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      setup.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = setup.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath,
        fingerprint,
      });
      const item = setup.catalog.createMediaItem({ kind: "movie", title });
      const selection = setup.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        kind: "main_feature",
      });
      completeCatalogReview(setup, archive.id);
      return { archive, selection };
    };
    const fingerprintOwner = createReviewedArchive(
      "reviewed-split-fingerprint",
      fingerprintArchivePath,
      "Fingerprint owner",
    );
    const pathOwner = createReviewedArchive(
      "reviewed-split-path-owner",
      pathOwnerArchivePath,
      "Path Owner",
    );
    const pathOwnerProfile = setup.encodingProfiles.create({
      key: "reviewed-split-path-owner",
      displayName: "Path owner",
      mediaDomain: "dvd_video",
      settings: {},
    });
    setup.encodeJobs.enqueue({
      discSelectionId: pathOwner.selection.id,
      encodingProfileId: pathOwnerProfile.id,
      outputPath: pathOwnerOutputPath,
    });
    setup.close();
    writeFileSync(
      join(originalsLibraryPath, "a-fingerprint.rip-dvd.json"),
      JSON.stringify({
        schema_version: 2,
        source: fingerprintArchivePath,
        title: "Fingerprint owner",
        disc_fingerprint: "reviewed-split-fingerprint",
        jobs: [{
          label: "Movie: Fingerprint owner",
          source: fingerprintArchivePath,
          output: importedOutputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      }),
    );
    writeFileSync(
      conflictingSidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: pathOwnerArchivePath,
        title: "Fingerprint owner",
        disc_fingerprint: "reviewed-split-fingerprint",
        jobs: [],
      }),
    );
    let observedClaim: ReturnType<
      ReturnType<typeof createDataAccess>["encodeJobs"]["claimNext"]
    > | undefined;
    let claimAtMarkerPublication: ReturnType<
      ReturnType<typeof createDataAccess>["encodeJobs"]["claimNext"]
    > | undefined;
    let reviewCompletionAtMarkerPublication: unknown;
    markerFault.failure = null;
    markerFault.afterDirectorySync = () => {
      const observer = createDataAccess({ databasePath });
      try {
        completeCatalogReview(observer, fingerprintOwner.archive.id);
      } catch (error) {
        reviewCompletionAtMarkerPublication = error;
      }
      claimAtMarkerPublication = observer.encodeJobs.claimNext(
        "reviewed-split-marker-observer",
      );
      if (claimAtMarkerPublication) {
        observer.encodeJobs.fail(
          claimAtMarkerPublication,
          "test-only marker publication observation",
        );
        observer.encodeJobs.requeue(claimAtMarkerPublication.id);
      }
      observer.close();
      throw new Error("injected post-marker crash");
    };
    const interrupted = createLegacySidecarDataAccess({ databasePath });
    expect(() =>
      interrupted.legacySidecars.importLibrary({ originalsLibraryPath })
    ).toThrow(/injected post-marker crash/);
    interrupted.close();
    expect(existsSync(markerPath)).toBe(true);
    expect(reviewCompletionAtMarkerPublication).toBeInstanceOf(
      DomainInvariantError,
    );
    expect(claimAtMarkerPublication).toBeNull();

    const observeAfterFirstRecoveredSidecar = () => {
      const observer = createDataAccess({ databasePath });
      const importedJobExists = observer.encodeJobs.list().some(
        (job) => job.outputPath === importedOutputPath,
      );
      if (importedJobExists) {
        observedClaim = observer.encodeJobs.claimNext(
          "reviewed-split-observer",
        );
      } else {
        markerFault.afterArchiveSnapshot = observeAfterFirstRecoveredSidecar;
      }
      observer.close();
    };
    markerFault.afterDirectorySync = () => {
      markerFault.archivePath = pathOwnerArchivePath;
      markerFault.afterArchiveSnapshot = observeAfterFirstRecoveredSidecar;
    };
    const access = createLegacySidecarDataAccess({ databasePath });

    const report = access.legacySidecars.importLibrary({ originalsLibraryPath });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/fingerprint and path/i),
        }),
      ]),
    });
    expect(observedClaim).toBeNull();
    const relatedArchives = access.catalog.listOriginalDiscArchives({
      ids: [fingerprintOwner.archive.id, pathOwner.archive.id],
    });
    expect(relatedArchives).toHaveLength(2);
    expect(relatedArchives).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fingerprintOwner.archive.id,
        catalogReviewedAt: null,
      }),
      expect.objectContaining({
        id: pathOwner.archive.id,
        catalogReviewedAt: null,
      }),
    ]));
    expect(access.encodeJobs.claimNext("reviewed-split-after-import")).toBeNull();

    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });
    writeFileSync(conflictingSidecarPath, "{ still needs repair");
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsFound: 2,
      sidecarsImported: 0,
      sidecarsSkipped: 2,
      issues: [
        expect.objectContaining({
          code: "corrupt_sidecar",
          sidecarPath: conflictingSidecarPath,
        }),
      ],
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });

    unlinkSync(conflictingSidecarPath);
    const upgradedDatabase = new DatabaseSync(databasePath);
    upgradedDatabase.exec(
      "update original_disc_archives set legacy_cutover_pending = false",
    );
    upgradedDatabase.close();
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsFound: 1,
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: [],
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
      legacySidecars: expect.arrayContaining([
        expect.objectContaining({ sidecarPath: conflictingSidecarPath }),
      ]),
    });
    expect(() =>
      completeCatalogReview(access, fingerprintOwner.archive.id)
    ).toThrow(DomainInvariantError);
    expect(() =>
      completeCatalogReview(access, pathOwner.archive.id)
    ).toThrow(DomainInvariantError);

    writeFileSync(repairedArchivePath, "repaired archive");
    writeFileSync(
      conflictingSidecarPath,
      JSON.stringify({
        schema_version: 2,
        source: repairedArchivePath,
        title: "Repaired",
        disc_fingerprint: "reviewed-split-repaired",
        jobs: [],
      }),
    );

    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsImported: 2,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "retired",
    });
    expect(access.catalog.listOriginalDiscArchives()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          archivePath: repairedArchivePath,
          fingerprint: "reviewed-split-repaired",
        }),
      ]),
    );
    expect(access.encodeJobs.claimNext("reviewed-split-after-repair")).toBeNull();
    access.close();
  });

  it("fences public Disc Selection deletion across cutover replay", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-initial-human-catalog-edit-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Authoritative.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Authoritative.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Authoritative.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "authoritative archive");

    const setup = createLegacySidecarDataAccess({ databasePath });
    const drive = setup.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = setup.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "authoritative-catalog-fingerprint",
    });
    setup.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    setup.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = setup.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath,
      fingerprint: "authoritative-catalog-fingerprint",
    });
    const item = setup.catalog.createMediaItem({
      kind: "movie",
      title: "Pre-cutover local title",
      year: 1999,
    });
    const selection = setup.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      kind: "main_feature",
      label: "Pre-cutover local selection",
    });
    completeCatalogReview(setup, archive.id);
    setup.close();

    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Legacy sidecar title",
      year: 1988,
      disc_fingerprint: "authoritative-catalog-fingerprint",
      jobs: [{
        label: "Legacy sidecar selection",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));

    markerFault.failure = null;
    markerFault.afterDirectorySync = () => {
      const human = createDataAccess({ databasePath });
      expect(human.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]).toMatchObject({
        catalogReviewedAt: null,
        legacyCutoverPending: true,
      });
      human.catalog.updateMediaItem(item.id, {
        kind: "other",
        title: "Post-marker human correction",
        year: 2002,
      });
      expect(() =>
        human.catalog.deleteDiscSelection(selection.id)
      ).toThrow(/legacy cutover.*pending/i);
      expect(human.catalog.listDiscSelections({ ids: [selection.id] }))
        .toEqual([expect.objectContaining({ id: selection.id })]);
      expect(human.encodeJobs.claimNext("cutover-public-deletion"))
        .toBeNull();
      expect(() =>
        human.catalog.repairDiscSelection(selection.id, {
          originalDiscArchiveId: archive.id,
          mediaItemId: item.id,
          kind: "main_feature",
          label: "Post-marker source correction",
        })
      ).toThrow(/legacy cutover.*pending/i);
      human.close();
      throw new Error("injected post-publication replay");
    };
    const firstAttempt = createLegacySidecarDataAccess({ databasePath });

    expect(() =>
      firstAttempt.legacySidecars.importLibrary({ originalsLibraryPath })
    ).toThrow(/injected post-publication replay/);
    firstAttempt.close();

    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "retired",
    });
    const pendingReplay = createDataAccess({ databasePath });
    expect(pendingReplay.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]).toMatchObject({
      catalogReviewedAt: null,
      legacyCutoverPending: true,
    });
    expect(pendingReplay.catalog.listDiscSelections({ ids: [selection.id] }))
      .toEqual([expect.objectContaining({ id: selection.id })]);
    expect(pendingReplay.encodeJobs.claimNext("cutover-pending-replay"))
      .toBeNull();
    pendingReplay.close();

    const replay = createLegacySidecarDataAccess({ databasePath });
    expect(
      replay.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, sidecarsSkipped: 0, issues: [] });

    expect(replay.catalog.listMediaItems({ ids: [item.id] })).toEqual([
      expect.objectContaining({
        kind: "other",
        title: "Post-marker human correction",
        year: 2002,
      }),
    ]);
    expect(replay.catalog.listDiscSelections({ ids: [selection.id] })).toEqual([
      expect.objectContaining({ label: "Pre-cutover local selection" }),
    ]);
    expect(replay.catalog.listOriginalDiscArchives({
      ids: [archive.id],
    })[0]).toMatchObject({
      catalogReviewedAt: null,
      legacyCutoverPending: false,
    });
    const retainedJobs = replay.encodeJobs.list();
    expect(retainedJobs).toEqual([
      expect.objectContaining({
        discSelectionId: selection.id,
        outputPath,
        status: "queued",
      }),
    ]);
    expect(
      replay.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, sidecarsSkipped: 0, issues: [] });
    expect(replay.encodeJobs.list()).toEqual(retainedJobs);
    replay.close();
  });

  it("reconciles an existing repair marker before ordinary service access", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-service-bootstrap-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Bootstrap.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Bootstrap.rip-dvd.json",
    );
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const outputPath = join(root, "movies", "Bootstrap.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "bootstrap archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Bootstrap",
      disc_fingerprint: "bootstrap-repair-fingerprint",
      jobs: [{
        label: "Movie: Bootstrap",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    markerFault.failure = null;
    const importer = createLegacySidecarDataAccess({ databasePath });
    expect(importer.legacySidecars.importLibrary({ originalsLibraryPath }))
      .toMatchObject({ sidecarsImported: 1, issues: [] });
    const archive = importer.catalog.listOriginalDiscArchives()[0]!;
    const selection = importer.catalog.listDiscSelections({
      originalDiscArchiveId: archive.id,
    })[0]!;
    const competingProfile = importer.encodingProfiles.create({
      key: "bootstrap-race",
      displayName: "Bootstrap race",
      mediaDomain: "dvd_video",
      settings: {},
    });
    importer.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: competingProfile.id,
      outputPath: join(root, "movies", "Bootstrap race.mkv"),
    });
    const completed = importer.encodeJobs.claimNext("pre-upgrade-completed");
    if (!completed) {
      throw new Error("Expected imported Encode Job to be claimed");
    }
    const completedJob = importer.encodeJobs.complete(completed);
    const running = importer.encodeJobs.claimNext("pre-upgrade-running");
    if (!running) {
      throw new Error("Expected imported Encode Job to be running");
    }
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      legacyQueueStatus: string;
    };
    writeFileSync(markerPath, `${JSON.stringify({
      ...marker,
      legacyQueueStatus: "repair",
    })}\n`);
    importer.close();

    const service = createDataAccess({
      databasePath,
      originalsLibraryPath,
    });

    expect(
      service.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(() => completeCatalogReview(service, archive.id)).toThrow(
      DomainInvariantError,
    );
    expect(service.encodeJobs.claimNext("post-upgrade-worker")).toBeNull();
    expect(service.encodeJobs.list()).toEqual(
      expect.arrayContaining([
        completedJob,
        expect.objectContaining({
          id: running.id,
          partialCleanupClaimToken: running.claimToken,
          partialCleanupOutputPath: running.outputPath,
          status: "failed",
          errorMessage: expect.stringMatching(/cutover.*repair/i),
        }),
      ]),
    );
    expect(() => service.encodeJobs.complete(running)).toThrow(
      StaleJobAttemptError,
    );
    expect(service.encodeJobs.listPendingPartialCleanups()).toContainEqual({
      claimToken: running.claimToken,
      jobId: running.id,
      leaseToken: null,
      outputPath: running.outputPath,
      publicationPending: false,
    });
    service.close();
  });

  it("does not bootstrap a repair cutover across an active publication mutation", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-live-publication-bootstrap-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Live publication.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Live publication.rip-dvd.json",
    );
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    const outputPath = join(root, "movies", "Live publication.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "live publication archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Live publication",
      disc_fingerprint: "live-publication-bootstrap-fingerprint",
      jobs: [{
        label: "Movie: Live publication",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    markerFault.failure = null;
    const importer = createLegacySidecarDataAccess({ databasePath });
    expect(importer.legacySidecars.importLibrary({ originalsLibraryPath }))
      .toMatchObject({ sidecarsImported: 1, issues: [] });
    const running = importer.encodeJobs.claimNext(
      "live-publication-bootstrap-worker",
    );
    if (!running) {
      throw new Error("Expected the live publication Encode Job");
    }
    const publication = importer.encodeJobs.registerPartialCleanup(running, {
      publicationPending: true,
    });
    importer.encodeJobs.beginPublicationMutation(
      running,
      publication,
    );
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      legacyQueueStatus: string;
    };
    writeFileSync(markerPath, `${JSON.stringify({
      ...marker,
      legacyQueueStatus: "repair",
    })}\n`);
    importer.close();

    expect(() =>
      createDataAccess({ databasePath, originalsLibraryPath })
    ).toThrow(/active Encode publication mutation/);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ENCODE_JOB_LEASE_DURATION_MS + 1);
    expect(() =>
      createDataAccess({
        databasePath,
        originalsLibraryPath,
        publicationMutationRecoveryLock: {
          tryAcquire: () => null,
        },
      })
    ).toThrow(/active Encode publication mutation/);

    const release = vi.fn();
    const tryAcquire = vi.fn(() => ({ release }));
    const service = createDataAccess({
      databasePath,
      originalsLibraryPath,
      publicationMutationRecoveryLock: { tryAcquire },
    });
    expect(tryAcquire).toHaveBeenCalledWith(outputPath);
    expect(release).toHaveBeenCalledOnce();
    expect(service.encodeJobs.list()).toEqual([
      expect.objectContaining({
        id: running.id,
        partialCleanupClaimToken: running.claimToken,
        partialCleanupLeaseToken: null,
        publicationPending: false,
        status: "failed",
      }),
    ]);
    service.close();
  });

  it("fences a current-identity archive published after repair bootstrap", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-late-archive-bootstrap-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "service.sqlite");
    const legacyArchivePath = join(originalsLibraryPath, "Late.iso");
    const currentFingerprint = `sha256:${"a".repeat(64)}`;
    const publishedArchivePath = join(
      originalsLibraryPath,
      `${"a".repeat(64)}.iso`,
    );
    const sidecarPath = join(
      originalsLibraryPath,
      "Late.rip-dvd.json",
    );
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(legacyArchivePath, "late archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: legacyArchivePath,
      title: "Late",
      disc_fingerprint: "late-bootstrap-legacy-fingerprint",
      jobs: [],
    }));
    markerFault.failure = null;
    const markerPublisher = createLegacySidecarDataAccess({
      databasePath: join(root, "marker-source.sqlite"),
    });
    expect(
      markerPublisher.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    markerPublisher.close();
    const retiredMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      legacyQueueStatus: string;
    };
    writeFileSync(markerPath, `${JSON.stringify({
      ...retiredMarker,
      legacyQueueStatus: "repair",
    })}\n`);

    const service = createDataAccess({
      databasePath,
      originalsLibraryPath,
    });
    const drive = service.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = service.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: currentFingerprint,
    });
    service.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    service.archiveJobs.approve({ detectedDiscId: disc.id });
    const claim = service.archiveJobs.claimNext("late-bootstrap-worker", {
      opticalDriveId: drive.id,
      fingerprint: currentFingerprint,
    });
    if (!claim) {
      throw new Error("Expected the late Archive Job to be claimed");
    }
    service.archiveJobs.publish(claim, {
      archivePath: publishedArchivePath,
      sizeBytes: 4_700_000_000,
    });
    const archive = service.catalog.listOriginalDiscArchives()[0]!;
    expect(archive).toMatchObject({
      catalogReviewedAt: null,
      legacyCutoverPending: true,
    });
    const item = service.catalog.createMediaItem({
      kind: "movie",
      title: "Late",
    });
    service.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      kind: "main_feature",
    });
    expect(() => completeCatalogReview(service, archive.id)).toThrow(
      DomainInvariantError,
    );
    service.close();
  });

  it("preserves a concurrent human review boundary after staging", () => {
    const frozenNow = new Date("2026-08-04T04:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-concurrent-human-review-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Concurrent.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Concurrent.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Concurrent.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "concurrent archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Concurrent",
      disc_fingerprint: "concurrent-human-review-fingerprint",
      created_at: frozenNow.toISOString(),
      updated_at: frozenNow.toISOString(),
      titles: [{ number: 1, seconds: 600, chapters: 4 }],
      jobs: [{
        label: "Movie: Concurrent",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({ databasePath });
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive.catalogReviewedAt).not.toBeNull();
    expect(archive.updatedAt).toEqual(frozenNow);

    markerFault.archivePath = archivePath;
    const addSelectionAfterReviewStaging = () => {
      const human = createDataAccess({ databasePath });
      const currentArchive = human.catalog.listOriginalDiscArchives({
        ids: [archive.id],
      })[0]!;
      if (currentArchive.catalogReviewedAt !== null) {
        markerFault.afterArchiveSnapshot = addSelectionAfterReviewStaging;
        human.close();
        return;
      }
      const item = human.catalog.createMediaItem({
        kind: "bonus_feature",
        title: "Human feature",
      });
      human.catalog.createDiscSelection({
        originalDiscArchiveId: archive.id,
        mediaItemId: item.id,
        kind: "dvd_title",
        titleNumber: 1,
      });
      human.close();
    };
    markerFault.afterArchiveSnapshot = addSelectionAfterReviewStaging;

    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(access.catalog.listDiscSelections()).toHaveLength(2);
    expect(access.encodeJobs.claimNext("concurrent-human-review-worker"))
      .toBeNull();
    access.close();
  });

  it("recovers the normalized catalog and queue state captured at cutover", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-frozen-state-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Frozen.iso");
    const sidecarPath = join(originalsLibraryPath, "Frozen.rip-dvd.json");
    const outputPath = join(root, "movies", "Frozen.mkv");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive");
    const sidecar = (title: string, year: number, discTitle: string) =>
      JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title,
        year,
        disc_title: discTitle,
        disc_fingerprint: "frozen-state-fingerprint",
        titles: [{ number: 1, seconds: 600 }],
        jobs: [{
          label: "Movie: Frozen",
          source: archivePath,
          output: outputPath,
          preset: "Fast 480p30",
          selection: "main_feature",
          title_number: null,
        }],
      });
    writeFileSync(sidecarPath, sidecar("Frozen Before", 1999, "BEFORE"));
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });
    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    interrupted.close();

    mkdirSync(join(root, "movies"), { recursive: true });
    writeFileSync(outputPath, "post-cutover output");
    const driftedBytes = Buffer.from(
      sidecar("Frozen After", 2026, "AFTER"),
    );
    writeFileSync(sidecarPath, driftedBytes);
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report.issues).toEqual([]);
    expect(
      decodeDvdTitleMap(
        retry.catalog.listDetectedDiscs(["archived"])[0]?.scanData,
      ),
    ).toMatchObject({
      schemaVersion: 2,
      titles: [{ number: 1, durationSeconds: 600 }],
    });
    expect(retry.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ fingerprint: "frozen-state-fingerprint" }),
    ]);
    expect(retry.catalog.listMediaItems()).toEqual([
      expect.objectContaining({ title: "Frozen Before", year: 1999 }),
    ]);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(readFileSync(sidecarPath)).toEqual(driftedBytes);
    retry.close();
  });

  it("refuses source-archive drift after marker publication", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-source-drift-",
    );
    const originalsLibraryPath = join(root, "originals");
    const capturedArchivePath = join(originalsLibraryPath, "Captured.iso");
    const competingArchivePath = join(originalsLibraryPath, "Competing.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Source Drift.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Source Drift.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(capturedArchivePath, "captured archive");
    writeFileSync(competingArchivePath, "competing archive");
    const sidecar = (archivePath: string) => JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Source Drift",
      disc_fingerprint: "source-drift-fingerprint",
      jobs: [{
        label: "Movie: Source Drift",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    });
    writeFileSync(sidecarPath, sidecar(capturedArchivePath));
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });

    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    expect(interrupted.catalog.listOriginalDiscArchives()).toEqual([]);
    const markerBytes = readFileSync(markerPath);
    interrupted.close();

    const driftedSidecarBytes = Buffer.from(sidecar(competingArchivePath));
    writeFileSync(sidecarPath, driftedSidecarBytes);
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
    expect(retry.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ archivePath: capturedArchivePath }),
    ]);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath, status: "queued" }),
    ]);
    expect(readFileSync(markerPath)).toEqual(markerBytes);
    expect(readFileSync(sidecarPath)).toEqual(driftedSidecarBytes);
    retry.close();
  });

  it("refuses replacement of the source archive object captured at cutover", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-archive-object-drift-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Captured.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Captured.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Captured.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "original archive bytes");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Captured",
      disc_fingerprint: "captured-object-fingerprint",
      jobs: [{
        label: "Movie: Captured",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    const sidecarBytes = readFileSync(sidecarPath);
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });

    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    expect(existsSync(markerPath)).toBe(true);
    interrupted.close();

    unlinkSync(archivePath);
    writeFileSync(
      archivePath,
      "replacement archive bytes from a different filesystem object",
    );
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/source archive.*captured.*cutover/i),
          sidecarPath: realpathSync(sidecarPath),
        }),
      ]),
    });
    expect(retry.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(retry.encodeJobs.list()).toEqual([]);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
    retry.close();
  });

  it("reopens reviewed work when archived source evidence changes", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-reviewed-source-drift-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Reviewed.iso");
    const sidecarPath = join(
      originalsLibraryPath,
      "Reviewed.rip-dvd.json",
    );
    const outputPath = join(root, "movies", "Reviewed.mkv");
    const databasePath = join(root, "catalog.sqlite");
    const markerPath = join(
      originalsLibraryPath,
      ".rip-dvd-sqlite-catalog",
    );
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "reviewed archive bytes");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Reviewed",
      disc_fingerprint: "reviewed-source-drift-fingerprint",
      jobs: [{
        label: "Movie: Reviewed",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    }));
    markerFault.failure = null;
    const access = createLegacySidecarDataAccess({ databasePath });
    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({ sidecarsImported: 1, issues: [] });
    const archive = access.catalog.listOriginalDiscArchives()[0]!;
    expect(archive.catalogReviewedAt).not.toBeNull();

    unlinkSync(archivePath);
    writeFileSync(archivePath, "replacement archive bytes");

    expect(
      access.legacySidecars.importLibrary({ originalsLibraryPath }),
    ).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/source archive.*captured.*cutover/i),
        }),
      ]),
    });
    expect(
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0],
    ).toMatchObject({ catalogReviewedAt: null });
    expect(access.encodeJobs.claimNext("reviewed-source-drift-worker"))
      .toBeNull();
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      legacyQueueStatus: "repair",
    });
    access.close();
  });

  it("imports the captured archive and job despite later sidecar drift", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-all-conflicting-",
    );
    const originalsLibraryPath = join(root, "originals");
    const archivePath = join(originalsLibraryPath, "Archive.iso");
    const sidecarPath = join(originalsLibraryPath, "Archive.rip-dvd.json");
    const databasePath = join(root, "catalog.sqlite");
    const originalOutputPath = join(root, "movies", "Original.mkv");
    const conflictingOutputPath = join(root, "movies", "Conflicting.mkv");
    mkdirSync(originalsLibraryPath, { recursive: true });
    writeFileSync(archivePath, "archive bytes");
    const sidecar = (outputPath: string) => JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Archive",
      disc_fingerprint: "all-conflicting-fingerprint",
      jobs: [{
        label: "Movie: Archive",
        source: archivePath,
        output: outputPath,
        preset: "Fast 480p30",
        selection: "main_feature",
        title_number: null,
      }],
    });
    writeFileSync(sidecarPath, sidecar(originalOutputPath));
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });

    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    interrupted.close();

    const conflictingBytes = Buffer.from(sidecar(conflictingOutputPath));
    writeFileSync(sidecarPath, conflictingBytes);
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 1,
      recordsCreated: { originalDiscArchives: 1, encodeJobs: 1 },
      issues: [],
    });
    expect(retry.catalog.listOriginalDiscArchives()).toEqual([
      expect.objectContaining({ archivePath }),
    ]);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({ outputPath: originalOutputPath }),
    ]);
    expect(readFileSync(sidecarPath)).toEqual(conflictingBytes);
    retry.close();
  });

  it("reuses the captured invocation base for relative paths after restart", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-relative-restart-",
    );
    const competingRoot = temporaryDirectories.create(
      "rip-dvd-cutover-relative-competing-",
    );
    const originalsLibraryPath = join(root, "originals");
    const capturedArchivePath = join(originalsLibraryPath, "Relative.iso");
    const competingArchivePath = join(
      competingRoot,
      "originals",
      "Relative.iso",
    );
    const sidecarPath = join(
      originalsLibraryPath,
      "Relative.rip-dvd.json",
    );
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(originalsLibraryPath, { recursive: true });
    mkdirSync(join(competingRoot, "originals"), { recursive: true });
    writeFileSync(capturedArchivePath, "captured archive");
    writeFileSync(competingArchivePath, "competing archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: "originals/Relative.iso",
      title: "Relative",
      disc_fingerprint: "relative-restart-fingerprint",
      jobs: [],
    }));
    const sidecarBytes = readFileSync(sidecarPath);
    const previousWorkingDirectory = process.cwd();
    try {
      markerFault.failure = "directory-sync";
      process.chdir(root);
      const interrupted = createLegacySidecarDataAccess({ databasePath });
      expect(() => interrupted.legacySidecars.importLibrary({
        originalsLibraryPath,
      })).toThrow(/injected directory sync failure/i);
      interrupted.close();

      markerFault.failure = null;
      process.chdir(competingRoot);
      const retry = createLegacySidecarDataAccess({ databasePath });
      const report = retry.legacySidecars.importLibrary({
        originalsLibraryPath,
      });

      expect(report.issues).toEqual([]);
      expect(retry.catalog.listOriginalDiscArchives()).toEqual([
        expect.objectContaining({ archivePath: capturedArchivePath }),
      ]);
      expect(retry.catalog.listOriginalDiscArchives()).not.toEqual([
        expect.objectContaining({ archivePath: competingArchivePath }),
      ]);
      expect(readFileSync(sidecarPath)).toEqual(sidecarBytes);
      retry.close();
    } finally {
      process.chdir(previousWorkingDirectory);
    }
  });

  it("refuses a captured sidecar reached through an ancestor symlink", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-ancestor-symlink-",
    );
    const originalsLibraryPath = join(root, "originals");
    const discDirectory = join(originalsLibraryPath, "Disc");
    const movedDiscDirectory = join(root, "moved-disc");
    const archivePath = join(discDirectory, "Escaped.iso");
    const sidecarPath = join(discDirectory, "Escaped.rip-dvd.json");
    const databasePath = join(root, "catalog.sqlite");
    mkdirSync(discDirectory, { recursive: true });
    writeFileSync(archivePath, "archive");
    writeFileSync(sidecarPath, JSON.stringify({
      schema_version: 2,
      source: archivePath,
      title: "Escaped",
      disc_fingerprint: "escaped-fingerprint",
      jobs: [],
    }));
    const sidecarBytes = readFileSync(sidecarPath);
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });

    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    interrupted.close();

    renameSync(discDirectory, movedDiscDirectory);
    symlinkSync(movedDiscDirectory, discDirectory, "dir");
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 0,
      sidecarsSkipped: 1,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_record",
          message: expect.stringMatching(/source archive.*captured.*cutover/i),
          sidecarPath: join(
            realpathSync(originalsLibraryPath),
            "Disc",
            "Escaped.rip-dvd.json",
          ),
        }),
      ]),
    });
    expect(retry.catalog.listOriginalDiscArchives()).toEqual([]);
    expect(readFileSync(join(movedDiscDirectory, "Escaped.rip-dvd.json")))
      .toEqual(sidecarBytes);
    retry.close();
  });

  it("uses the frozen captured payload when sidecar files become corrupt", () => {
    const root = temporaryDirectories.create(
      "rip-dvd-cutover-corrupt-recovery-budget-",
    );
    const originalsLibraryPath = join(root, "originals");
    const databasePath = join(root, "catalog.sqlite");
    const sidecarPaths: string[] = [];
    mkdirSync(originalsLibraryPath, { recursive: true });
    for (let index = 1; index <= 8; index += 1) {
      const archivePath = join(originalsLibraryPath, `Budget ${index}.iso`);
      const sidecarPath = join(
        originalsLibraryPath,
        `Budget ${index}.rip-dvd.json`,
      );
      writeFileSync(archivePath, `archive ${index}`);
      writeFileSync(sidecarPath, JSON.stringify({
        schema_version: 2,
        source: archivePath,
        title: `Budget ${index}`,
        disc_fingerprint: `recovery-budget-${index}`,
        jobs: [],
      }));
      sidecarPaths.push(sidecarPath);
    }
    markerFault.failure = "directory-sync";
    const interrupted = createLegacySidecarDataAccess({ databasePath });

    expect(() => interrupted.legacySidecars.importLibrary({
      originalsLibraryPath,
    })).toThrow(/injected directory sync failure/i);
    interrupted.close();

    const corruptBytes = Buffer.alloc(1_048_577, 0xff);
    for (const sidecarPath of sidecarPaths) {
      writeFileSync(sidecarPath, corruptBytes);
    }
    markerFault.failure = null;
    const retry = createLegacySidecarDataAccess({ databasePath });

    const report = retry.legacySidecars.importLibrary({
      originalsLibraryPath,
    });

    expect(report).toMatchObject({
      sidecarsImported: 8,
      sidecarsSkipped: 0,
      issues: [],
    });
    expect(retry.catalog.listOriginalDiscArchives()).toHaveLength(8);
    for (const sidecarPath of sidecarPaths) {
      expect(readFileSync(sidecarPath).equals(corruptBytes)).toBe(true);
    }
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

  it("recovers a captured winner after its retired sidecar disappears", () => {
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

    expect(report.issues).toEqual([]);
    expect(retry.encodeJobs.list()).toEqual([
      expect.objectContaining({
        outputPath: join(root, "movies", "Missing.mkv"),
      }),
    ]);
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
