import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveJobProgress } from "@rip-dvd/data-access";

import {
  DvdArchiveReadFailureError,
  preserveDvdArchive,
  createNodeDvdCopyRunner,
  quarantinePublishedArchive,
  withCancelledDvdArchiveInactive,
  type DvdCopyRunner,
} from "./dvd-archiver.js";
import {
  createCleanDvdRecoveryResult,
  createDamagedDvdRecoveryResult,
  DvdReadFailureError,
  DVD_READ_FAILURE_RESULT_PREFIX,
  DVD_RECOVERY_RESULT_PREFIX,
} from "./dvd-recovery-contracts.js";
import {
  createOutOfRangeDvdReadFailure,
  createOutOfRangeDvdReadFailureResult,
} from "./dvd-read-failure.test-support.js";
import { dvdRescueWorkspacePaths } from "./dvd-rescue-workspace.js";
import {
  createInProcessDvdRescueWorkspaceLock,
  DVD_RESCUE_WORKSPACE_LOCK_DIRECTORY_NAME,
} from "./dvd-rescue-workspace-lock.js";

const temporaryDirectories: string[] = [];
const orphanedWriterPids: number[] = [];
const supportsLinuxWriterOwnership =
  existsSync("/proc/self/fd") &&
  spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

function emitCleanRecoveryProtocol(
  stderr: EventEmitter,
  declaredByteCount: number,
): void {
  stderr.emit(
    "data",
    Buffer.from(
      `${DVD_RECOVERY_RESULT_PREFIX}${JSON.stringify({
        protocolVersion: 1,
        declaredByteCount,
        recoveredByteCount: declaredByteCount,
        recoveryPolicyVersion: "dvd-recovery-v1",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorBitmapHex: "",
      })}\n`,
    ),
  );
}

function createMockDvdCopyChild() {
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const authorizationReady = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
  });
  const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
  const probeAuthorizationReady = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
  });
  const probeAuthorizationGrant = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    write: vi.fn(
      (
        _chunk: string,
        callback: (error?: Error | null) => void,
      ) => {
        callback();
        return true;
      },
    ),
  });
  return Object.assign(new EventEmitter(), {
    stderr,
    stdio: [
      null,
      null,
      stderr,
      null,
      authorizationReady,
      authorizationStart,
      probeAuthorizationReady,
      probeAuthorizationGrant,
    ] as [
      null,
      null,
      typeof stderr,
      null,
      typeof authorizationReady,
      typeof authorizationStart,
      typeof probeAuthorizationReady,
      typeof probeAuthorizationGrant,
    ],
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
}

function createOriginalsLibrary(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createProvenBoundaryFailure(
  declaredByteCount: number,
  firstFailingLba: number,
) {
  return {
    ...createOutOfRangeDvdReadFailureResult({
      declaredByteCount,
      firstFailingLba,
      requestedBlockCount: 1,
      requestedLba: firstFailingLba,
    }),
    retryOrdinal: 1,
    boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
    candidateConfirmationCount: 2 as const,
    precedingSectorLba: firstFailingLba - 1,
  };
}

async function createInterruptedDamagedPublication(
  archiveRequestId: string,
  digest: string,
) {
  const originalsLibraryPath = createOriginalsLibrary();
  const root = realpathSync(originalsLibraryPath);
  const sizeBytes = 2 * 2_048;
  const rescuedImage = Buffer.alloc(sizeBytes, 6);
  rescuedImage.fill(0, 2_048);
  const recoveryResult = createDamagedDvdRecoveryResult(sizeBytes, [
    { startLba: 1, sectorCount: 1 },
  ]);
  const baseOptions = {
    archiveRequestId,
    devicePath: "/dev/sr0",
    expectedTitleMap: {
      schemaVersion: 2 as const,
      contentId: `dvdmeta-sha256:${digest}`,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    },
    fingerprint: `dvdmeta-sha256:${digest}`,
    originalsLibraryPath,
    sizeBytes,
    verifySource: async () => undefined,
    onProgress: () => undefined,
  };
  const interrupted = await preserveDvdArchive({
    ...baseOptions,
    runner: {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, rescuedImage);
        return recoveryResult;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    },
    salvageValidator: {
      validate: vi.fn().mockResolvedValue({
        badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
        outcome: "accepted",
      }),
    },
    signal: new AbortController().signal,
  });
  return {
    baseOptions,
    interrupted,
    rescuedImage,
    rescuePaths: dvdRescueWorkspacePaths(root, archiveRequestId),
    root,
  };
}

async function createCorrectedDamagedRetryWorkspace(
  archiveRequestId: string,
  digest: string,
) {
  const originalsLibraryPath = createOriginalsLibrary();
  const root = realpathSync(originalsLibraryPath);
  const reportedSizeBytes = 8 * 2_048;
  const firstExcludedLba = 6;
  const publishedSizeBytes = firstExcludedLba * 2_048;
  const fullImage = Buffer.alloc(reportedSizeBytes, 59);
  fullImage.fill(0, 1 * 2_048, 2 * 2_048);
  fullImage.fill(0, 7 * 2_048, 8 * 2_048);
  const legacyDamage = createDamagedDvdRecoveryResult(
    reportedSizeBytes,
    [
      { startLba: 1, sectorCount: 1 },
      { startLba: 7, sectorCount: 1 },
    ],
  );
  const retainedDamage = createDamagedDvdRecoveryResult(
    reportedSizeBytes,
    [{ startLba: 1, sectorCount: 1 }],
  );
  const correctedDamage = createDamagedDvdRecoveryResult(
    publishedSizeBytes,
    [{ startLba: 1, sectorCount: 1 }],
  );
  const boundaryFailure = createProvenBoundaryFailure(
    reportedSizeBytes,
    firstExcludedLba,
  );
  const baseOptions = {
    archiveRequestId,
    completenessProver: {
      async prove() {
        return { maximumReferencedLba: firstExcludedLba - 1 };
      },
    },
    devicePath: "/dev/sr0",
    expectedTitleMap: {
      schemaVersion: 2 as const,
      contentId: `dvdmeta-sha256:${digest}`,
      titles: [],
    },
    fingerprint: `dvdmeta-sha256:${digest}`,
    originalsLibraryPath,
    signal: new AbortController().signal,
    sizeBytes: reportedSizeBytes,
    verifySource: async () => undefined,
    onProgress: () => undefined,
  };
  const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
    copy,
    isActive: () => false,
    withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
    waitForInactive: vi.fn(async () => undefined),
  });
  const rejectedSalvage = {
    validate: vi.fn().mockResolvedValue({
      outcome: "rejected" as const,
      reason: "referenced_content" as const,
    }),
  };

  await expect(preserveDvdArchive({
    ...baseOptions,
    runner: runner(vi.fn(async ({ outputPath }) => {
      writeFileSync(outputPath, fullImage);
      return legacyDamage;
    })),
    salvageValidator: rejectedSalvage,
  })).rejects.toThrow("DVD salvage rejected");

  await expect(preserveDvdArchive({
    ...baseOptions,
    revalidateReadFailure: async () => undefined,
    runner: runner(vi.fn(async ({ continuation }) => {
      expect(continuation).toMatchObject({
        kind: "damaged",
        recoveryResult: legacyDamage,
      });
      throw new DvdReadFailureError(boundaryFailure, retainedDamage);
    })),
    salvageValidator: rejectedSalvage,
  })).rejects.toThrow("DVD salvage rejected");

  const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
  expect(readFileSync(rescuePaths.imagePath)).toEqual(
    fullImage.subarray(0, publishedSizeBytes),
  );
  expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")))
    .toMatchObject({
      schemaVersion: 3,
      imageByteCount: publishedSizeBytes,
      recoveryProtocol: expect.objectContaining({
        declaredByteCount: publishedSizeBytes,
        badSectorCount: 1,
        badSectorBitmapHex: "02",
      }),
    });

  return {
    baseOptions,
    correctedDamage,
    firstExcludedLba,
    fullImage,
    publishedSizeBytes,
    reportedSizeBytes,
    rescuePaths,
    root,
    runner,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const pid of orphanedWriterPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function waitFor(
  condition: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startOrphanedWriter(
  lockPath: string,
  partialPath: string,
  readyPath: string,
  devicePath?: string,
): Promise<number> {
  const fixturePath = fileURLToPath(
    new URL("../test/orphaned-dvd-writer.mjs", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [fixturePath, lockPath, partialPath, readyPath, devicePath ?? "-"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [status] = await once(child, "close");
  if (status !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8"));
  }
  const pid = Number(Buffer.concat(stdout).toString("utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("orphaned writer fixture returned an invalid PID");
  }
  orphanedWriterPids.push(pid);
  await waitFor(
    () => existsSync(readyPath),
    "orphaned writer fixture did not become ready",
  );
  return pid;
}

async function stopOrphanedWriter(
  pid: number,
  ownershipReleased: () => boolean,
): Promise<void> {
  process.kill(pid, "SIGKILL");
  orphanedWriterPids.splice(orphanedWriterPids.indexOf(pid), 1);
  await waitFor(
    ownershipReleased,
    "orphaned writer fixture did not release its OS ownership",
  );
}

describe("DVD archive publication", () => {
  it.runIf(supportsLinuxWriterOwnership)(
    "keeps restart cancellation pending while an orphan holds only the device",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const devicePath = "/dev/zero";
      const readyPath = join(originalsLibraryPath, ".device-only-writer-ready");
      const writerPid = await startOrphanedWriter(
        "-",
        "-",
        readyPath,
        devicePath,
      );
      const options = {
        devicePath,
        fingerprint: `sha256:${"a".repeat(64)}`,
        mutation: vi.fn(() => undefined),
        originalsLibraryPath,
        runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
      };

      await expect(
        withCancelledDvdArchiveInactive(options),
      ).rejects.toThrow("DVD archive device is still active");
      expect(
        readdirSync(realpathSync(originalsLibraryPath)),
      ).toEqual([basename(readyPath)]);

      await stopOrphanedWriter(writerPid, () => {
        const descriptorPath = `/proc/${writerPid}/fd`;
        return (
          !existsSync(descriptorPath) || readdirSync(descriptorPath).length === 0
        );
      });
      await expect(
        withCancelledDvdArchiveInactive(options),
      ).resolves.toBeUndefined();
    },
  );

  it.runIf(supportsLinuxWriterOwnership)(
    "holds device exclusion through cancellation finalization",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const mutation = vi.fn(() => {
        expect(
          spawnSync(
            "flock",
            ["--exclusive", "--nonblock", "/dev/zero", "true"],
            { stdio: "ignore" },
          ).status,
        ).not.toBe(0);
        return undefined;
      });

      await withCancelledDvdArchiveInactive({
        devicePath: "/dev/zero",
        fingerprint: `sha256:${"b".repeat(64)}`,
        mutation,
        originalsLibraryPath,
        runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
      });

      expect(mutation).toHaveBeenCalledOnce();
    },
  );

  it("bounds a cancellation-recovery lock helper that never closes", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stderr,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnLockProcess = vi.fn(() => child);
    const runner = createNodeDvdCopyRunner({
      deviceLockTimeoutMs: 10,
      requireInactive: () => undefined,
      spawnLockProcess,
      timeoutMs: 1_000,
    });

    await expect(
      withCancelledDvdArchiveInactive({
        devicePath: "/dev/zero",
        fingerprint: `sha256:${"c".repeat(64)}`,
        mutation: vi.fn(() => undefined),
        originalsLibraryPath,
        runner,
      }),
    ).rejects.toThrow("DVD archive device lock timed out");

    expect(spawnLockProcess).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("keeps cancellation pending when corrected rescue state is invalid", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "d".repeat(64);
    const archiveRequestId = "cancelled-invalid-corrected-rescue";
    const archivePath = join(root, `dvdmeta-${digest}.iso`);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const retentionMapPath = `${rescuePaths.mapPath}.retaining`;
    writeFileSync(archivePath, Buffer.alloc(6 * 2_048, 17));
    writeFileSync(rescuePaths.mapPath, "invalid rescue map\n");
    writeFileSync(retentionMapPath, "interrupted rescue map\n");
    const mutation = vi.fn();
    const options = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      mutation,
      originalsLibraryPath,
      runner: {
        copy: vi.fn(),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, guardedMutation) =>
          guardedMutation()
        ),
        waitForInactive: vi.fn(async () => undefined),
      },
      sizeBytes: 8 * 2_048,
      workspaceLock: createInProcessDvdRescueWorkspaceLock(),
    };

    await expect(
      withCancelledDvdArchiveInactive(options),
    ).rejects.toThrow("DVD rescue state is invalid");
    await expect(
      withCancelledDvdArchiveInactive(options),
    ).rejects.toThrow("DVD rescue state is invalid");

    expect(mutation).not.toHaveBeenCalled();
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
    expect(existsSync(retentionMapPath)).toBe(true);
    expect(
      readdirSync(root).some((name) => name.includes(".invalid-")),
    ).toBe(false);
  });

  it("does not quarantine a destination substituted at cleanup authorization", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archivePath = join(root, "authorized-cleanup-race.iso");
    const publishedArchive = Buffer.alloc(2_048, 23);
    const concurrentArchive = Buffer.alloc(2_048, 29);
    writeFileSync(archivePath, publishedArchive);
    const publishedMetadata = lstatSync(archivePath);

    await expect(
      quarantinePublishedArchive(
        archivePath,
        `${publishedMetadata.dev}:${publishedMetadata.ino}`,
        async () => {
          unlinkSync(archivePath);
          writeFileSync(archivePath, concurrentArchive);
        },
      ),
    ).rejects.toThrow("Published DVD archive changed before cleanup");

    expect(readFileSync(archivePath)).toEqual(concurrentArchive);
    expect(existsSync(`${archivePath}.failed`)).toBe(false);
  });

  it("does not overwrite a failed path created at cleanup authorization", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archivePath = join(root, "authorized-failed-path-race.iso");
    const failedPath = `${archivePath}.failed`;
    const publishedArchive = Buffer.alloc(2_048, 31);
    const concurrentFailedArchive = Buffer.alloc(2_048, 37);
    writeFileSync(archivePath, publishedArchive);
    const publishedMetadata = lstatSync(archivePath);

    await expect(
      quarantinePublishedArchive(
        archivePath,
        `${publishedMetadata.dev}:${publishedMetadata.ino}`,
        () => writeFileSync(failedPath, concurrentFailedArchive),
      ),
    ).rejects.toThrow(
      "Published DVD archive failed path changed before cleanup",
    );

    expect(readFileSync(archivePath)).toEqual(publishedArchive);
    expect(readFileSync(failedPath)).toEqual(concurrentFailedArchive);
  });

  it.runIf(supportsLinuxWriterOwnership)(
    "excludes a pre-fix writer for another fingerprint and originals root",
    async () => {
      const previousOriginalsLibraryPath = createOriginalsLibrary();
      const replacementOriginalsLibraryPath = createOriginalsLibrary();
      const previousRoot = realpathSync(previousOriginalsLibraryPath);
      const replacementRoot = realpathSync(replacementOriginalsLibraryPath);
      const devicePath = "/dev/zero";
      const previousDigest = "a".repeat(64);
      const replacementDigest =
        "4561ae53176c6dec6f7e715600037e5d53d1a82d9bd8a3f6f9ac2af067bc1503";
      const previousPartialPath = join(
        previousRoot,
        `.${previousDigest}.iso.rip-dvd-partial`,
      );
      const writerPid = await startOrphanedWriter(
        "-",
        previousPartialPath,
        join(previousRoot, ".pre-fix-writer-ready"),
        devicePath,
      );
      const options = {
        devicePath,
        fingerprint: `sha256:${replacementDigest}`,
        originalsLibraryPath: replacementOriginalsLibraryPath,
        runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
        signal: new AbortController().signal,
        sizeBytes: 2_048,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      };

      await expect(preserveDvdArchive(options)).rejects.toThrow(
        "DVD archive device is still active",
      );
      expect(readFileSync(previousPartialPath, "utf8")).toBe("live partial");
      expect(readdirSync(replacementRoot)).toEqual([]);

      await stopOrphanedWriter(writerPid, () => {
        const descriptorPath = `/proc/${writerPid}/fd`;
        return (
          !existsSync(descriptorPath) || readdirSync(descriptorPath).length === 0
        );
      });
      await expect(preserveDvdArchive(options)).resolves.toMatchObject({
        recovered: false,
      });
    },
  );

  it.runIf(supportsLinuxWriterOwnership)(
    "recovers an inactive attempt-unique partial after direct worker replacement",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const root = realpathSync(originalsLibraryPath);
      const devicePath = "/dev/zero";
      const digest =
        "4561ae53176c6dec6f7e715600037e5d53d1a82d9bd8a3f6f9ac2af067bc1503";
      const partialPath = join(
        root,
        `.${digest}.11111111-1111-4111-8111-111111111111.iso.rip-dvd-partial`,
      );
      const lockDigest = createHash("sha256")
        .update(devicePath)
        .digest("hex");
      const lockPath = join(root, `.rip-dvd-device-${lockDigest}.lock`);
      const readyPath = join(root, ".orphaned-writer-ready");
      const writerPid = await startOrphanedWriter(
        lockPath,
        partialPath,
        readyPath,
        devicePath,
      );
      const options = {
        devicePath,
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
        signal: new AbortController().signal,
        sizeBytes: 2_048,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      };

      await expect(preserveDvdArchive(options)).rejects.toThrow(
        "DVD archive copy is still active",
      );
      expect(readFileSync(partialPath, "utf8")).toBe("live partial");
      expect(existsSync(`${partialPath}.failed`)).toBe(false);
      expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
      expect(
        readdirSync(root).filter((name) =>
          name.endsWith(".iso.rip-dvd-partial"),
        ),
      ).toEqual([basename(partialPath)]);

      await stopOrphanedWriter(
        writerPid,
        () =>
          spawnSync(
            "flock",
            ["--exclusive", "--nonblock", lockPath, "true"],
            { stdio: "ignore" },
          ).status === 0,
      );

      await expect(
        preserveDvdArchive({
          ...options,
          runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
        }),
      ).resolves.toMatchObject({ recovered: false });
      expect(existsSync(partialPath)).toBe(false);
      expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe(
        "live partial",
      );
    },
  );

  it.runIf(supportsLinuxWriterOwnership)(
    "quarantines repeated inactive attempt-unique partials for only the same fingerprint",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const root = realpathSync(originalsLibraryPath);
      const digest =
        "231552f40a93fbd25f6328825ddb49288b8076f1d42809b0852eaff66d9a4118";
      const partialPaths = [
        join(
          root,
          `.${digest}.11111111-1111-4111-8111-111111111111.iso.rip-dvd-partial`,
        ),
        join(
          root,
          `.${digest}.22222222-2222-4222-8222-222222222222.iso.rip-dvd-partial`,
        ),
      ];
      writeFileSync(partialPaths[0]!, "first failed attempt");
      writeFileSync(partialPaths[1]!, "second failed attempt");
      const otherFingerprintPartial = join(
        root,
        `.${"f".repeat(64)}.33333333-3333-4333-8333-333333333333.iso.rip-dvd-partial`,
      );
      writeFileSync(otherFingerprintPartial, "other disc");
      const content = Buffer.from("fresh");
      const runner: DvdCopyRunner = {
        copy: vi.fn(async ({ outputPath, sizeBytes }) => {
          writeFileSync(outputPath, content);
          return createCleanDvdRecoveryResult(sizeBytes);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      };

      await expect(
        preserveDvdArchive({
          devicePath: "/dev/sr0",
          fingerprint: `sha256:${digest}`,
          originalsLibraryPath,
          runner,
          signal: new AbortController().signal,
          sizeBytes: content.byteLength,
          verifySource: async () => undefined,
          onProgress: () => undefined,
        }),
      ).resolves.toMatchObject({ recovered: false });

      expect(readFileSync(`${partialPaths[0]}.failed`, "utf8")).toBe(
        "first failed attempt",
      );
      expect(readFileSync(`${partialPaths[1]}.failed`, "utf8")).toBe(
        "second failed attempt",
      );
      expect(readFileSync(otherFingerprintPartial, "utf8")).toBe("other disc");
    },
  );

  it.runIf(supportsLinuxWriterOwnership)(
    "fails closed before quarantining when attempt-partial recovery is unsafe",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const root = realpathSync(originalsLibraryPath);
      const digest = "a".repeat(64);
      const inactivePartial = join(
        root,
        `.${digest}.11111111-1111-4111-8111-111111111111.iso.rip-dvd-partial`,
      );
      const unsafePartial = join(
        root,
        `.${digest}.22222222-2222-4222-8222-222222222222.iso.rip-dvd-partial`,
      );
      const outsidePath = join(root, "outside");
      writeFileSync(inactivePartial, "recoverable evidence");
      writeFileSync(outsidePath, "outside");
      symlinkSync(outsidePath, unsafePartial);
      const runner: DvdCopyRunner = {
        copy: vi.fn(),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      };

      await expect(
        preserveDvdArchive({
          devicePath: "/dev/sr0",
          fingerprint: `sha256:${digest}`,
          originalsLibraryPath,
          runner,
          signal: new AbortController().signal,
          sizeBytes: 9,
          verifySource: async () => undefined,
          onProgress: () => undefined,
        }),
      ).rejects.toThrow("DVD archive partial path is unsafe");

      expect(runner.copy).not.toHaveBeenCalled();
      expect(readFileSync(inactivePartial, "utf8")).toBe(
        "recoverable evidence",
      );
      expect(existsSync(`${inactivePartial}.failed`)).toBe(false);
      expect(readFileSync(outsidePath, "utf8")).toBe("outside");
    },
  );

  it("bounds attempt-partial discovery before mutating or retrying", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "b".repeat(64);
    const partialPath = join(
      root,
      `.${digest}.11111111-1111-4111-8111-111111111111.iso.rip-dvd-partial`,
    );
    writeFileSync(partialPath, "recoverable evidence");
    for (let index = 0; index < 4_096; index += 1) {
      writeFileSync(join(root, `unrelated-${index}`), "");
    }
    const runner: DvdCopyRunner = {
      copy: vi.fn(),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: 9,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("DVD archive partial recovery exceeds the safety limit");

    expect(runner.copy).not.toHaveBeenCalled();
    expect(readFileSync(partialPath, "utf8")).toBe("recoverable evidence");
    expect(existsSync(`${partialPath}.failed`)).toBe(false);
  });

  it("does not count nested rescue lock sentinels as archive entries", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const lockDirectory = join(
      root,
      DVD_RESCUE_WORKSPACE_LOCK_DIRECTORY_NAME,
    );
    mkdirSync(lockDirectory, { mode: 0o700 });
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(lockDirectory, `request-${index}.lock`), "");
    }
    const content = Buffer.from("fresh archive");
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        writeFileSync(outputPath, content);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      fingerprint: `sha256:${"c".repeat(64)}`,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).resolves.toMatchObject({ recovered: false });

    expect(runner.copy).toHaveBeenCalledOnce();
    expect(readdirSync(lockDirectory)).toHaveLength(4_097);
  });

  it.runIf(supportsLinuxWriterOwnership)(
    "fails closed while a pre-upgrade deterministic partial is open",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const root = realpathSync(originalsLibraryPath);
      const digest =
        "4561ae53176c6dec6f7e715600037e5d53d1a82d9bd8a3f6f9ac2af067bc1503";
      const partialPath = join(root, `.${digest}.iso.rip-dvd-partial`);
      const readyPath = join(root, ".legacy-writer-ready");
      const writerPid = await startOrphanedWriter(
        "-",
        partialPath,
        readyPath,
      );
      const options = {
        devicePath: "/dev/zero",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
        signal: new AbortController().signal,
        sizeBytes: 2_048,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      };

      await expect(preserveDvdArchive(options)).rejects.toThrow(
        "DVD archive copy is still active",
      );
      expect(readFileSync(partialPath, "utf8")).toBe("live partial");
      expect(existsSync(`${partialPath}.failed`)).toBe(false);

      await stopOrphanedWriter(writerPid, () => {
        const descriptorPath = `/proc/${writerPid}/fd`;
        return (
          !existsSync(descriptorPath) || readdirSync(descriptorPath).length === 0
        );
      });
      await expect(
        preserveDvdArchive({
          ...options,
          runner: createNodeDvdCopyRunner({ timeoutMs: 1_000 }),
        }),
      ).resolves.toMatchObject({ recovered: false });
      expect(existsSync(partialPath)).toBe(false);
      expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe(
        "live partial",
      );
    },
  );

  it("runs the bounded libdvdcss reader and streams byte progress", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const outputPath = join(
      originalsLibraryPath,
      ".disc.iso.rip-dvd-partial",
    );
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const authorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
    const child = Object.assign(new EventEmitter(), {
      stderr,
      stdio: [
        null,
        null,
        stderr,
        null,
        authorizationReady,
        authorizationStart,
      ] as [
        null,
        null,
        typeof stderr,
        null,
        typeof authorizationReady,
        typeof authorizationStart,
      ],
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnProcess = vi.fn(() => child);
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess,
    });
    const copied: number[] = [];

    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath,
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: (bytes) => copied.push(bytes),
    });
    authorizationReady.emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    stderr.emit("data", Buffer.from("4 bytes copied, 1 s\r9 bytes copied, 2 s\n"));
    emitCleanRecoveryProtocol(stderr, 9);
    child.emit("close", 0, null);
    await completion;

    expect(spawnProcess).toHaveBeenCalledWith(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--no-fork",
        "--conflict-exit-code",
        "75",
        "/proc/self/fd/3",
        "rip-dvd-dvdcss-reader",
        "copy-authorized",
        "/dev/zero",
        outputPath,
        "9",
      ],
      {
        shell: false,
        stdio: [
          "ignore",
          "ignore",
          "pipe",
          expect.any(Number),
          "pipe",
          "pipe",
          "pipe",
          "pipe",
        ],
      },
    );
    expect(authorizationStart.end).toHaveBeenCalledWith("1");
    expect(copied).toEqual([4, 9]);
  });

  it("consumes structured unreadable-sector evidence from the native reader", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const sizeBytes = 4 * 2_048;
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(originalsLibraryPath, ".disc.iso.rip-dvd-partial"),
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stderr.emit(
      "data",
      Buffer.from(
        `${DVD_RECOVERY_RESULT_PREFIX}${JSON.stringify({
          protocolVersion: 1,
          declaredByteCount: sizeBytes,
          recoveredByteCount: 2 * 2_048,
          recoveryPolicyVersion: "dvd-recovery-v1",
          badSectorCount: 2,
          badAreaCount: 1,
          badSectorBitmapHex: "06",
        })}\n`,
      ),
    );
    child.emit("close", 0, null);

    await expect(completion).resolves.toEqual(
      createDamagedDvdRecoveryResult(sizeBytes, [
        { startLba: 1, sectorCount: 2 },
      ]),
    );
  });

  it.each([
    {
      category: "unknown",
      message: "DVD read failed with structured unknown evidence",
      status: {
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 112,
        senseKey: 5,
        asc: 32,
        ascq: 0,
      },
    },
    {
      category: "hardware_error",
      message: "DVD read failed after an Optical Drive hardware fault",
      status: {
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 112,
        senseKey: 4,
        asc: 68,
        ascq: 0,
      },
    },
    {
      category: "transport_error",
      message: "DVD read failed while communicating with the Optical Drive",
      status: {
        scsiStatus: 2,
        hostStatus: 7,
        driverStatus: 0,
        senseResponseCode: 112,
        senseKey: 3,
        asc: 17,
        ascq: 0,
      },
    },
    {
      category: "protection_error",
      message: "DVD read failed because DVD access was protected",
      status: {
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 114,
        senseKey: 5,
        asc: 111,
        ascq: 4,
      },
    },
  ] as const)("returns one complete $category read failure from the native reader", async ({
    category,
    message,
    status,
  }) => {
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const sizeBytes = 4 * 2_048;
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(originalsLibraryPath, ".disc.iso.rip-dvd-partial"),
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stderr.emit(
      "data",
      Buffer.from(
        `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v2",
          category,
          ...status,
          informationLba: 1,
          requestedLba: 0,
          requestedBlockCount: 4,
          retryOrdinal: 0,
        })}\n`,
      ),
    );
    child.emit("close", 3, null);

    await expect(completion).rejects.toMatchObject({
      message,
      readFailure: {
        protocolVersion: 1,
        classifierVersion: "scsi-read-classifier-v2",
        category,
        informationLba: 1,
        requestedLba: 0,
        requestedBlockCount: 4,
        retryOrdinal: 0,
        ...status,
      },
    });
  });

  it.each([
    {
      category: "not_ready",
      message: "DVD read failed because the Optical Drive was not ready",
      senseResponseCode: 0x70,
      senseKey: 0x02,
      asc: 0x04,
      ascq: 0x01,
    },
    {
      category: "unit_attention",
      message: "DVD read failed after an Optical Drive media-state change",
      senseResponseCode: 0x72,
      senseKey: 0x06,
      asc: 0x28,
      ascq: 0x00,
    },
  ] as const)(
    "returns one complete $category read failure from the native reader",
    async ({ category, message, senseResponseCode, senseKey, asc, ascq }) => {
      const child = createMockDvdCopyChild();
      const runner = createNodeDvdCopyRunner({
        requireInactive: () => undefined,
        spawnProcess: vi.fn(() => child),
      });
      const completion = runner.copy({
        devicePath: "/dev/zero",
        outputPath: join(
          createOriginalsLibrary(),
          `.${category}.iso.rip-dvd-partial`,
        ),
        sizeBytes: 4 * 2_048,
        signal: new AbortController().signal,
        onBytesCopied: () => undefined,
      });

      child.stdio[4].emit(
        "data",
        Buffer.from("rip-dvd-copy-authorization-ready\n"),
      );
      child.stderr.emit(
        "data",
        Buffer.from(
          `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify({
            protocolVersion: 1,
            classifierVersion: "scsi-read-classifier-v2",
            category,
            scsiStatus: 2,
            hostStatus: 0,
            driverStatus: 8,
            senseResponseCode,
            senseKey,
            asc,
            ascq,
            informationLba: null,
            requestedLba: 0,
            requestedBlockCount: 4,
            retryOrdinal: 0,
          })}\n`,
        ),
      );
      child.emit("close", 3, null);

      await expect(completion).rejects.toMatchObject({
        message,
        readFailure: {
          category,
          senseResponseCode,
          senseKey,
          asc,
          ascq,
          requestedLba: 0,
          requestedBlockCount: 4,
          retryOrdinal: 0,
        },
      });
    },
  );

  it("returns one complete out-of-range failure from the native reader", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const sizeBytes = 40 * 2_048;
    const readFailure = createOutOfRangeDvdReadFailureResult({
      declaredByteCount: sizeBytes,
      firstFailingLba: 35,
      requestedBlockCount: 9,
      requestedLba: 31,
    });
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(originalsLibraryPath, ".disc.iso.rip-dvd-partial"),
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stderr.emit(
      "data",
      Buffer.from(
        `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify(readFailure)}\n`,
      ),
    );
    child.emit("close", 3, null);

    await expect(completion).rejects.toMatchObject({
      message: "DVD read stopped at the readable boundary",
      readFailure,
    });
  });

  it("returns retained damage with a proven boundary from the native reader", async () => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const sizeBytes = 40 * 2_048;
    const firstFailingLba = 35;
    const readFailure = createProvenBoundaryFailure(
      sizeBytes,
      firstFailingLba,
    );
    const recoveryResult = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 5, sectorCount: 1 },
    ]);
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".damaged-boundary.iso.rip-dvd-partial",
      ),
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stderr.emit(
      "data",
      Buffer.from(
        `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify({
          ...readFailure,
          protocolVersion: 2,
          recoveryProtocol: {
            protocolVersion: 1,
            declaredByteCount: sizeBytes,
            recoveredByteCount: sizeBytes - 2_048,
            recoveryPolicyVersion: "dvd-recovery-v1",
            badSectorCount: 1,
            badAreaCount: 1,
            badSectorBitmapHex: "2000000000",
          },
        })}\n`,
      ),
    );
    child.emit("close", 3, null);

    await expect(completion).rejects.toMatchObject({
      message: "DVD read stopped at the readable boundary",
      readFailure,
      recoveryResult,
    });
  });

  it("reauthorizes source and claim state around every boundary probe", async () => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const authorizeProbe = vi.fn(() => undefined);
    const sizeBytes = 40 * 2_048;
    const readFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: sizeBytes,
        firstFailingLba: 35,
        requestedBlockCount: 1,
        requestedLba: 35,
        retainedImageByteCount: 35 * 2_048,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: 34,
    };
    const completion = runner.copy({
      authorizeProbe,
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".proven-boundary.iso.rip-dvd-partial",
      ),
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    for (let index = 0; index < 8; index += 1) {
      child.stdio[6]!.emit(
        "data",
        Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
      );
    }
    child.stderr.emit(
      "data",
      Buffer.from(
        `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify(readFailure)}\n`,
      ),
    );
    child.emit("close", 3, null);

    await expect(completion).rejects.toMatchObject({ readFailure });
    expect(authorizeProbe).toHaveBeenCalledTimes(8);
    expect(child.stdio[7]!.write).toHaveBeenCalledTimes(8);
    expect(child.stdio[7]!.write).toHaveBeenCalledWith(
      "1",
      expect.any(Function),
    );
  });

  it("stops boundary probing when source reauthorization fails", async () => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const sourceChanged = new Error("DVD medium changed during probing");
    const completion = runner.copy({
      authorizeProbe: () => {
        throw sourceChanged;
      },
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".rejected-boundary.iso.rip-dvd-partial",
      ),
      sizeBytes: 40 * 2_048,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stdio[6]!.emit(
      "data",
      Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
    );

    await expect(completion).rejects.toBe(sourceChanged);
    expect(child.stdio[7]!.write).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails safely when the boundary probe grant pipe reports an error", async () => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const pipeFailure = new Error("DVD boundary probe grant failed");
    child.stdio[7]!.write.mockImplementation((_chunk, callback) => {
      queueMicrotask(() => {
        child.stdio[7]!.emit("error", pipeFailure);
        callback(pipeFailure);
      });
      return false;
    });
    const completion = runner.copy({
      authorizeProbe: () => undefined,
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".failed-boundary-grant.iso.rip-dvd-partial",
      ),
      sizeBytes: 40 * 2_048,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stdio[6]!.emit(
      "data",
      Buffer.from("rip-dvd-boundary-probe-authorization-ready\n"),
    );

    await expect(completion).rejects.toBe(pipeFailure);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("retains an unsupported bounded sense response as unknown evidence", async () => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".unsupported-sense.iso.rip-dvd-partial",
      ),
      sizeBytes: 4 * 2_048,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stderr.emit(
      "data",
      Buffer.from(
        `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v2",
          category: "unknown",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x7f,
          senseKey: null,
          asc: null,
          ascq: null,
          informationLba: null,
          requestedLba: 0,
          requestedBlockCount: 4,
          retryOrdinal: 0,
        })}\n`,
      ),
    );
    child.emit("close", 3, null);

    await expect(completion).rejects.toMatchObject({
      readFailure: expect.objectContaining({
        category: "unknown",
        senseResponseCode: 0x7f,
        senseKey: null,
        asc: null,
        ascq: null,
      }),
    });
  });

  it.each([
    {
      name: "duplicate",
      lines: (payload: string) => [payload, payload],
      status: 3,
    },
    {
      name: "contradictory",
      lines: (payload: string) => [
        payload,
        `${DVD_RECOVERY_RESULT_PREFIX}${JSON.stringify({
          protocolVersion: 1,
          declaredByteCount: 4 * 2_048,
          recoveredByteCount: 4 * 2_048,
          recoveryPolicyVersion: "dvd-recovery-v1",
          badSectorCount: 0,
          badAreaCount: 0,
          badSectorBitmapHex: "",
        })}`,
      ],
      status: 3,
    },
    {
      name: "partial",
      lines: () => [`${DVD_READ_FAILURE_RESULT_PREFIX}{"protocolVersion":1`],
      status: 3,
    },
    {
      name: "missing",
      lines: () => [],
      status: 3,
    },
    {
      name: "unsupported classifier version",
      mutate: { classifierVersion: "scsi-read-classifier-v3" },
      status: 3,
    },
    {
      name: "unsupported category",
      mutate: { category: "medium_error" },
      status: 3,
    },
    {
      name: "category and sense mismatch",
      mutate: { category: "not_ready" },
      status: 3,
    },
    {
      name: "hardware category with non-hardware sense",
      mutate: { category: "hardware_error" },
      status: 3,
    },
    {
      name: "transport category without a transport completion",
      mutate: { category: "transport_error" },
      status: 3,
    },
    {
      name: "protection category with non-protection sense",
      mutate: { category: "protection_error" },
      status: 3,
    },
    {
      name: "unsupported exit status",
      status: 4,
    },
    {
      name: "extra raw helper field",
      mutate: { rawSenseBuffer: "private-unbounded-output" },
      status: 3,
    },
    {
      name: "inconsistent information LBA",
      mutate: { informationLba: 4 },
      status: 3,
    },
    {
      name: "partial transport status",
      mutate: { hostStatus: null },
      status: 3,
    },
  ])("fails closed on a $name terminal outcome", async ({ lines, mutate, status }) => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".invalid-read-failure.iso.rip-dvd-partial",
      ),
      sizeBytes: 4 * 2_048,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });
    const payload = `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify({
      protocolVersion: 1,
      classifierVersion: "scsi-read-classifier-v2",
      category: "unknown",
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode: 112,
      senseKey: 5,
      asc: 32,
      ascq: 0,
      informationLba: 1,
      requestedLba: 0,
      requestedBlockCount: 4,
      retryOrdinal: 0,
      ...mutate,
    })}`;

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    for (const line of lines?.(payload) ?? [payload]) {
      child.stderr.emit("data", Buffer.from(`${line}\n`));
    }
    child.emit("close", status, null);

    const error = await completion.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DvdReadFailureError);
  });

  it.each([
    { name: "missing terminal", includeTerminal: false, status: 3 },
    { name: "mismatched exit", includeTerminal: true, status: 4 },
  ])("does not retain raw stderr for a $name", async ({
    includeTerminal,
    status,
  }) => {
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(
        createOriginalsLibrary(),
        ".private-terminal.iso.rip-dvd-partial",
      ),
      sizeBytes: 4 * 2_048,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    if (includeTerminal) {
      child.stderr.emit(
        "data",
        Buffer.from(
          `${DVD_READ_FAILURE_RESULT_PREFIX}${JSON.stringify({
            protocolVersion: 1,
            classifierVersion: "scsi-read-classifier-v2",
            category: "unknown",
            scsiStatus: 2,
            hostStatus: 0,
            driverStatus: 8,
            senseResponseCode: 0x70,
            senseKey: 5,
            asc: 32,
            ascq: 0,
            informationLba: 1,
            requestedLba: 0,
            requestedBlockCount: 4,
            retryOrdinal: 0,
          })}\n`,
        ),
      );
    }
    child.stderr.emit(
      "data",
      Buffer.from(
        "SG_IO raw sense deadbeef on /dev/private-drive for /media/private.iso\n",
      ),
    );
    child.emit("close", status, null);

    const error = await completion.catch((reason: unknown) => reason);
    expect(error).toEqual(
      new Error("DVD read failure helper result is invalid"),
    );
    expect(String(error)).not.toContain("private-drive");
    expect(String(error)).not.toContain("private.iso");
    expect(String(error)).not.toContain("deadbeef");
  });

  it("authorizes the native reader to retry only unresolved rescue sectors", async () => {
    vi.useFakeTimers();
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const spawnProcess = vi.fn(() => child);
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess,
    });
    const sizeBytes = 4 * 2_048;
    const outputPath = join(
      originalsLibraryPath,
      ".request.rip-dvd-rescue.iso",
    );
    let authorize!: () => void;
    const authorization = new Promise<void>((resolve) => {
      authorize = resolve;
    });
    const completion = runner.copy({
      authorizeStart: () => authorization,
      devicePath: "/dev/zero",
      outputPath,
      continuation: {
        kind: "damaged",
        imageFilesystemIdentity: "1:2",
        recoveryResult: createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
          { startLba: 3, sectorCount: 1 },
        ]),
      },
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    expect(child.stdio[5].end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(child.kill).not.toHaveBeenCalled();
    authorize();
    await authorization;
    await Promise.resolve();
    expect(child.stdio[5].end).toHaveBeenCalledWith("10a");
    emitCleanRecoveryProtocol(child.stderr, sizeBytes);
    child.emit("close", 0, null);

    await expect(completion).resolves.toEqual(
      createCleanDvdRecoveryResult(sizeBytes),
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "flock",
      expect.arrayContaining([
        "rip-dvd-dvdcss-reader",
        "resume-authorized",
        "/dev/zero",
        outputPath,
        String(sizeBytes),
      ]),
      expect.any(Object),
    );
  });

  it("limits corrected recovery to retained unresolved sectors", async () => {
    const child = createMockDvdCopyChild();
    const spawnProcess = vi.fn(() => child);
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess,
    });
    const sizeBytes = 8 * 2_048;
    const correctedSizeBytes = 6 * 2_048;
    const outputPath = join(
      createOriginalsLibrary(),
      ".corrected-request.rip-dvd-rescue.iso",
    );
    const completion = runner.copy({
      authorizeStart: () => undefined,
      devicePath: "/dev/zero",
      outputPath,
      continuation: {
        kind: "corrected",
        imageByteCount: correctedSizeBytes,
        imageFilesystemIdentity: "1:2",
        readFailure: createProvenBoundaryFailure(sizeBytes, 6),
        recoveryResult: createDamagedDvdRecoveryResult(
          correctedSizeBytes,
          [{ startLba: 1, sectorCount: 1 }],
        ),
      },
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    await Promise.resolve();
    expect(child.stdio[5].end).toHaveBeenCalledWith("102");
    emitCleanRecoveryProtocol(child.stderr, correctedSizeBytes);
    child.emit("close", 0, null);

    await expect(completion).resolves.toEqual(
      createCleanDvdRecoveryResult(correctedSizeBytes),
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "flock",
      expect.arrayContaining([
        "rip-dvd-dvdcss-reader",
        "resume-authorized",
        "/dev/zero",
        outputPath,
        String(correctedSizeBytes),
      ]),
      expect.any(Object),
    );
  });

  it("authorizes the native reader to continue from the committed boundary prefix", async () => {
    vi.useFakeTimers();
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const spawnProcess = vi.fn(() => child);
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess,
    });
    const sizeBytes = 4 * 2_048;
    const outputPath = join(
      originalsLibraryPath,
      ".request.rip-dvd-rescue.iso",
    );
    let authorize!: () => void;
    const authorization = new Promise<void>((resolve) => {
      authorize = resolve;
    });
    const completion = runner.copy({
      authorizeStart: () => authorization,
      devicePath: "/dev/zero",
      outputPath,
      continuation: {
        kind: "boundary",
        imageByteCount: 2 * 2_048,
        imageFilesystemIdentity: "1:2",
        readFailure: createOutOfRangeDvdReadFailureResult({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        }),
      },
      sizeBytes,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    expect(child.stdio[5].end).not.toHaveBeenCalled();
    authorize();
    await authorization;
    await Promise.resolve();
    expect(child.stdio[5].end).toHaveBeenCalledWith(`1${2 * 2_048}`);
    emitCleanRecoveryProtocol(child.stderr, sizeBytes);
    child.emit("close", 0, null);

    await expect(completion).resolves.toEqual(
      createCleanDvdRecoveryResult(sizeBytes),
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "flock",
      expect.arrayContaining([
        "rip-dvd-dvdcss-reader",
        "resume-boundary-authorized",
        "/dev/zero",
        outputPath,
        String(sizeBytes),
      ]),
      expect.any(Object),
    );
  });

  it("rejects a malformed native recovery result", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath: join(originalsLibraryPath, ".disc.iso.rip-dvd-partial"),
      sizeBytes: 2_048,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });
    const assertion = expect(completion).rejects.toThrow(
      "DVD recovery helper result is malformed",
    );

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    child.stderr.emit(
      "data",
      Buffer.from(`${DVD_RECOVERY_RESULT_PREFIX}{not-json}\n`),
    );
    child.emit("close", 0, null);

    await assertion;
  });

  it("preserves a copy failure diagnostic after extensive progress", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const outputPath = join(
      originalsLibraryPath,
      ".disc.iso.rip-dvd-partial",
    );
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const authorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
    const child = Object.assign(new EventEmitter(), {
      stderr,
      stdio: [
        null,
        null,
        stderr,
        null,
        authorizationReady,
        authorizationStart,
      ] as [
        null,
        null,
        typeof stderr,
        null,
        typeof authorizationReady,
        typeof authorizationStart,
      ],
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: () => child,
    });
    const completion = runner.copy({
      devicePath: "/dev/zero",
      outputPath,
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });
    authorizationReady.emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    const progress = Array.from(
      { length: 30 },
      (_, index) => `${(index + 1) * 63_488} bytes copied`,
    );
    stderr.emit(
      "data",
      Buffer.from(
        `${progress.join("\n")}\nDVD content read failed at byte 1904640: Input/output error\n`,
      ),
    );
    child.emit("close", 1, null);

    await expect(completion).rejects.toThrow(
      "DVD archive copy failed: DVD content read failed at byte 1904640: Input/output error",
    );
  });

  it("matches native reader capacity to configured drive concurrency", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const children = Array.from({ length: 2 }, () => {
      const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const authorizationReady = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
      return Object.assign(new EventEmitter(), {
        stderr,
        stdio: [
          null,
          null,
          stderr,
          null,
          authorizationReady,
          authorizationStart,
        ] as [
          null,
          null,
          typeof stderr,
          null,
          typeof authorizationReady,
          typeof authorizationStart,
        ],
        kill: vi.fn(() => true),
        unref: vi.fn(),
      });
    });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(children[0])
      .mockReturnValueOnce(children[1]);
    const runner = createNodeDvdCopyRunner({
      maxActiveCopies: 2,
      requireInactive: () => undefined,
      spawnProcess,
    });
    const controller = new AbortController();
    const copies = [
      runner.copy({
        devicePath: "/dev/zero",
        outputPath: join(originalsLibraryPath, ".first.iso.rip-dvd-partial"),
        sizeBytes: 9,
        signal: controller.signal,
        onBytesCopied: () => undefined,
      }),
      runner.copy({
        devicePath: "/dev/null",
        outputPath: join(originalsLibraryPath, ".second.iso.rip-dvd-partial"),
        sizeBytes: 9,
        signal: controller.signal,
        onBytesCopied: () => undefined,
      }),
    ];

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    for (const child of children) {
      child.stdio[4].emit(
        "data",
        Buffer.from("rip-dvd-copy-authorization-ready\n"),
      );
      emitCleanRecoveryProtocol(child.stderr, 9);
      child.emit("close", 0, null);
    }
    await expect(Promise.all(copies)).resolves.toEqual([
      createCleanDvdRecoveryResult(9),
      createCleanDvdRecoveryResult(9),
    ]);
  });

  it("keeps rescue-output exclusion across different devices", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      maxActiveCopies: 2,
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const outputPath = join(
      originalsLibraryPath,
      ".request-owned.rip-dvd-rescue.iso",
    );
    const copy = runner.copy({
      devicePath: "/dev/zero",
      outputPath,
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    expect(runner.isActive("/dev/null", outputPath)).toBe(true);

    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    emitCleanRecoveryProtocol(child.stderr, 9);
    child.emit("close", 0, null);
    await expect(copy).resolves.toEqual(createCleanDvdRecoveryResult(9));
    expect(runner.isActive("/dev/null", outputPath)).toBe(false);
  });

  it.runIf(supportsLinuxWriterOwnership)(
    "detects an orphaned rescue writer through another device",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const outputPath = join(
        originalsLibraryPath,
        ".request-owned.rip-dvd-rescue.iso",
      );
      const readyPath = join(originalsLibraryPath, ".orphaned-writer-ready");
      const writerPid = await startOrphanedWriter(
        "-",
        outputPath,
        readyPath,
      );
      const runner = createNodeDvdCopyRunner({
        requireInactive: () => undefined,
      });

      expect(runner.isActive("/dev/null", outputPath)).toBe(true);

      await stopOrphanedWriter(
        writerPid,
        () => !runner.isActive("/dev/null", outputPath),
      );
    },
  );

  it("scopes cancellation-recovery exclusion to the matching device tombstone", async () => {
    vi.useFakeTimers();
    const originalsLibraryPath = createOriginalsLibrary();
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const authorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
    const child = Object.assign(new EventEmitter(), {
      stderr,
      stdio: [
        null,
        null,
        stderr,
        null,
        authorizationReady,
        authorizationStart,
      ] as [
        null,
        null,
        typeof stderr,
        null,
        typeof authorizationReady,
        typeof authorizationStart,
      ],
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const spawnLockProcess = vi.fn(() => {
      const lockChild = Object.assign(new EventEmitter(), {
        stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        kill: vi.fn(() => true),
        unref: vi.fn(),
      });
      queueMicrotask(() => lockChild.emit("close", 0, null));
      return lockChild;
    });
    const runner = createNodeDvdCopyRunner({
      maxActiveCopies: 2,
      requireInactive: () => undefined,
      spawnLockProcess,
      spawnProcess: vi.fn(() => child),
      timeoutMs: 10,
    });
    const activeOutputPath = join(
      originalsLibraryPath,
      ".active.iso.rip-dvd-partial",
    );
    const activeCopy = runner.copy({
      devicePath: "/dev/zero",
      outputPath: activeOutputPath,
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });
    const activeCopyOutcome = activeCopy.catch((error: unknown) => error);
    const sameDeviceMutation = vi.fn(() => undefined);
    const otherDeviceMutation = vi.fn(() => undefined);

    expect(() =>
      runner.withDeviceInactive("/dev/zero", sameDeviceMutation),
    ).toThrow("DVD archive copy is still active");
    await expect(
      runner.withDeviceInactive("/dev/null", otherDeviceMutation),
    ).resolves.toBeUndefined();
    expect(sameDeviceMutation).not.toHaveBeenCalled();
    expect(otherDeviceMutation).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10);
    await expect(activeCopyOutcome).resolves.toEqual(
      new Error("DVD archive copy timed out"),
    );
    expect(() =>
      runner.withDeviceInactive("/dev/zero", sameDeviceMutation),
    ).toThrow("DVD archive copy is still active");
    child.emit("close", null, "SIGKILL");
    await runner.waitForInactive("/dev/zero", activeOutputPath);
    await expect(
      runner.withDeviceInactive("/dev/zero", sameDeviceMutation),
    ).resolves.toBeUndefined();
    expect(sameDeviceMutation).toHaveBeenCalledOnce();
  });

  it("rejects invalid native reader capacity", () => {
    expect(() =>
      createNodeDvdCopyRunner({ maxActiveCopies: 0 }),
    ).toThrow("DVD archive copy capacity is invalid");
  });

  it("rejects a stale copy after the device lock but before device I/O", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const authorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
    const child = Object.assign(new EventEmitter(), {
      stderr,
      stdio: [
        null,
        null,
        stderr,
        null,
        authorizationReady,
        authorizationStart,
      ] as [
        null,
        null,
        typeof stderr,
        null,
        typeof authorizationReady,
        typeof authorizationStart,
      ],
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    const completion = runner.copy({
      authorizeStart() {
        throw new Error("Stale archive job attempt");
      },
      devicePath: "/dev/zero",
      outputPath: join(
        originalsLibraryPath,
        ".stale.iso.rip-dvd-partial",
      ),
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    });

    authorizationReady.emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    await expect(completion).rejects.toThrow("Stale archive job attempt");
    expect(authorizationStart.end).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
  });

  it("times out without close and blocks retry until the reader closes", async () => {
    vi.useFakeTimers();
    const originalsLibraryPath = createOriginalsLibrary();
    const children = Array.from({ length: 2 }, () => {
      const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const authorizationReady = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
      });
      const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
      return Object.assign(new EventEmitter(), {
        stderr,
        stdio: [
          null,
          null,
          stderr,
          null,
          authorizationReady,
          authorizationStart,
        ] as [
          null,
          null,
          typeof stderr,
          null,
          typeof authorizationReady,
          typeof authorizationStart,
        ],
        kill: vi.fn(() => true),
        unref: vi.fn(),
      });
    });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(children[0])
      .mockReturnValueOnce(children[1]);
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess,
      timeoutMs: 10,
    });
    const request = {
      devicePath: "/dev/zero",
      outputPath: join(originalsLibraryPath, ".disc.iso.rip-dvd-partial"),
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    };
    let outcome: unknown;
    void runner.copy(request).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    expect(
      runner.isActive(request.devicePath, request.outputPath),
    ).toBe(true);
    let inactive = false;
    const closed = runner
      .waitForInactive(request.devicePath, request.outputPath)
      .then(() => {
        inactive = true;
      });

    await vi.advanceTimersByTimeAsync(10);
    expect(outcome).toEqual(new Error("DVD archive copy timed out"));
    expect(inactive).toBe(false);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(children[0]!.stderr.destroy).toHaveBeenCalledOnce();
    expect(children[0]!.unref).toHaveBeenCalledOnce();
    await expect(runner.copy(request)).rejects.toThrow(
      "DVD archive copy is still active",
    );
    expect(spawnProcess).toHaveBeenCalledOnce();

    children[0]!.emit("close", null, "SIGKILL");
    await closed;
    await Promise.resolve();
    await Promise.resolve();
    expect(
      runner.isActive(request.devicePath, request.outputPath),
    ).toBe(false);
    const retry = runner.copy(request);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    children[1]!.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    emitCleanRecoveryProtocol(children[1]!.stderr, 9);
    children[1]!.emit("close", 0, null);
    await expect(retry).resolves.toEqual(createCleanDvdRecoveryResult(9));
  });

  it("stops a DVD copy after copied bytes stop advancing", async () => {
    vi.useFakeTimers();
    const child = createMockDvdCopyChild();
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
      stallTimeoutMs: 100,
      timeoutMs: 1_000,
    });
    const outputPath = join(
      createOriginalsLibrary(),
      ".stalled.iso.rip-dvd-partial",
    );
    let outcome: unknown;
    void runner.copy({
      devicePath: "/dev/zero",
      outputPath,
      sizeBytes: 1_000,
      signal: new AbortController().signal,
      onBytesCopied: () => undefined,
    }).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    child.stdio[4].emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );

    await vi.advanceTimersByTimeAsync(90);
    child.stderr.emit("data", Buffer.from("10 bytes\n"));
    await vi.advanceTimersByTimeAsync(90);
    expect(outcome).toBeUndefined();

    child.stderr.emit("data", Buffer.from("10 bytes\n"));
    await vi.advanceTimersByTimeAsync(10);
    expect(outcome).toEqual(new Error("DVD archive copy stalled"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
    await runner.waitForInactive("/dev/zero", outputPath);
  });

  it("contains progress callback failures and waits for the reader to close", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const authorizationReady = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    });
    const authorizationStart = { destroy: vi.fn(), end: vi.fn() };
    const child = Object.assign(new EventEmitter(), {
      stderr,
      stdio: [
        null,
        null,
        stderr,
        null,
        authorizationReady,
        authorizationStart,
      ] as [
        null,
        null,
        typeof stderr,
        null,
        typeof authorizationReady,
        typeof authorizationStart,
      ],
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    const runner = createNodeDvdCopyRunner({
      requireInactive: () => undefined,
      spawnProcess: vi.fn(() => child),
    });
    let settled = false;
    const completion = runner
      .copy({
        devicePath: "/dev/zero",
        outputPath: join(originalsLibraryPath, ".disc.iso.rip-dvd-partial"),
        sizeBytes: 9,
        signal: new AbortController().signal,
        onBytesCopied: () => {
          throw new Error("progress persistence failed");
        },
      })
      .finally(() => {
        settled = true;
      });

    authorizationReady.emit(
      "data",
      Buffer.from("rip-dvd-copy-authorization-ready\n"),
    );
    expect(() => stderr.emit("data", Buffer.from("4 bytes copied\r"))).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(completion).rejects.toThrow("progress persistence failed");
  });

  it("copies through a hidden partial path and publishes only after full success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.from("dvd-image");
    const digest = "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const progress: ArchiveJobProgress[] = [];
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        expect(basename(outputPath)).toMatch(/^\..+\.rip-dvd-partial$/);
        vi.setSystemTime(2_000);
        onBytesCopied(2);
        vi.setSystemTime(3_000);
        onBytesCopied(4);
        vi.setSystemTime(4_000);
        onBytesCopied(6);
        writeFileSync(outputPath, content);
        vi.setSystemTime(5_000);
        onBytesCopied(content.byteLength);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const verifySource = vi.fn(async () => undefined);

    const result = await preserveDvdArchive({
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource,
      onProgress: (value) => progress.push(value),
    });

    expect(result).toEqual({
      archivePath: join(
        realpathSync(originalsLibraryPath),
        `dvdmeta-${digest}.iso`,
      ),
      archiveFilesystemIdentity: expect.stringMatching(/^\d+:[1-9]\d*$/),
      integrityEvidence: {
        integrity: "clean_read",
        policyVersion: "dvd-recovery-v1",
        badSectorCount: 0,
        badAreaCount: 0,
        badSectorRanges: [],
      },
      recovered: false,
      sizeBytes: content.byteLength,
    });
    expect(readFileSync(result.archivePath)).toEqual(content);
    expect(
      existsSync(join(originalsLibraryPath, `.${digest}.iso.rip-dvd-partial`)),
    ).toBe(false);
    expect(progress).toEqual([
      { phase: "preparing", progressPercent: 0 },
      { phase: "copying", progressPercent: 0 },
      { phase: "copying", progressPercent: 22, progressBytes: 2 },
      { phase: "copying", progressPercent: 44, progressBytes: 4 },
      {
        phase: "copying",
        progressPercent: 66,
        progressBytes: 6,
        etaSeconds: 2,
      },
      { phase: "copying", progressPercent: 99, progressBytes: 9 },
      { phase: "finalizing", progressPercent: 99 },
    ]);
    expect(verifySource).toHaveBeenCalledOnce();
  });

  it("rejects malformed recovery evidence before publishing a complete image", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.from("dvd-image");
    const digest = "a".repeat(64);
    let partialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, content);
        return {
          ...createCleanDvdRecoveryResult(sizeBytes),
          recoveredByteCount: sizeBytes - 1,
        };
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      fingerprint: `sha256:${digest}`,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toThrow("DVD recovery result is invalid");

    expect(existsSync(join(
      realpathSync(originalsLibraryPath),
      `${digest}.iso`,
    ))).toBe(false);
    expect(readFileSync(`${partialPath}.failed`)).toEqual(content);
  });

  it("retains a rescued image for validation without publishing it", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.alloc(4 * 2_048, 7);
    const digest = "7".repeat(64);
    const progress: ArchiveJobProgress[] = [];
    let partialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, content);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
          { startLba: 3, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const verifySource = vi.fn(async () => undefined);

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: content.byteLength,
        verifySource,
        onProgress: (value) => progress.push(value),
      }),
    ).rejects.toThrow(
      "DVD rescue requires validation: 2 unreadable sectors in 2 areas; LBAs 1, 3",
    );

    const root = realpathSync(originalsLibraryPath);
    expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
    expect(readFileSync(`${partialPath}.failed`)).toEqual(content);
    expect(verifySource).toHaveBeenCalledOnce();
    expect(progress.at(-1)).toEqual({
      phase: "verifying",
      progressPercent: 99,
    });
  });

  it("revalidates the source after salvage validation before publication", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.alloc(2 * 2_048, 0);
    const digest = "8".repeat(64);
    let partialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, content);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const salvageValidator = {
      validate: vi.fn().mockResolvedValue({
        badSectorCountsByTitle: [],
        outcome: "accepted",
      }),
    };
    const verifySource = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("DVD medium changed during validation"));

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner,
      salvageValidator,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource,
      onProgress: () => undefined,
    })).rejects.toThrow("DVD medium changed during validation");

    expect(verifySource).toHaveBeenCalledTimes(2);
    expect(salvageValidator.validate).toHaveBeenCalledOnce();
    expect(
      existsSync(join(realpathSync(originalsLibraryPath), `dvdmeta-${digest}.iso`)),
    ).toBe(false);
    expect(readFileSync(`${partialPath}.failed`)).toEqual(content);
  });

  it.each([
    {
      archiveRequestId: "11111111-1111-4111-8111-111111111111",
      failure: "Archive Request cancellation requested",
      label: "cancellation",
    },
    {
      archiveRequestId: "22222222-2222-4222-8222-222222222222",
      failure: "Stale Archive Job attempt",
      label: "lease loss",
    },
  ])("keeps prior rescue state valid after $label", async ({
    archiveRequestId,
    failure,
  }) => {
    const originalsLibraryPath = createOriginalsLibrary();
    const sizeBytes = 2 * 2_048;
    const digest = archiveRequestId.startsWith("1")
      ? "a".repeat(64)
      : "b".repeat(64);
    const rescuedImage = Buffer.alloc(sizeBytes, 4);
    rescuedImage.fill(0, 2_048);
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const firstRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, rescuedImage);
        return damagedRecovery;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: firstRunner,
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue requires validation");

    const root = realpathSync(originalsLibraryPath);
    const rescueImageName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.iso"),
    );
    const rescueImagePath = join(root, rescueImageName!);
    const interruptedRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ continuation, outputPath }) => {
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: damagedRecovery,
        });
        const improvedImage = Buffer.from(readFileSync(outputPath));
        improvedImage.fill(4, 2_048);
        writeFileSync(outputPath, improvedImage);
        throw new Error(failure);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: interruptedRunner,
      signal: new AbortController().signal,
    })).rejects.toThrow(failure);

    expect(existsSync(rescueImagePath)).toBe(true);
    const completionRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ continuation, outputPath, sizeBytes: expectedSize }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: damagedRecovery,
        });
        expect(readFileSync(outputPath)).toEqual(Buffer.alloc(sizeBytes, 4));
        return createCleanDvdRecoveryResult(expectedSize);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    const completed = await preserveDvdArchive({
      ...baseOptions,
      runner: completionRunner,
      signal: new AbortController().signal,
    });

    expect(readFileSync(completed.archivePath)).toEqual(Buffer.alloc(sizeBytes, 4));
    await completed.finalizePublication?.();
    expect(existsSync(rescueImagePath)).toBe(false);
  });

  it("rejects malformed accepted salvage evidence before publication", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.alloc(6 * 2_048, 0);
    const digest = "9".repeat(64);
    let partialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, content);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
          { startLba: 3, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner,
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [{
            badSectorCount: 3,
            titleNumber: 1,
          }],
          outcome: "accepted",
        }),
      },
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toThrow(
      "Watchable-salvage per-title evidence exceeds the policy bound",
    );

    expect(existsSync(join(
      realpathSync(originalsLibraryPath),
      `dvdmeta-${digest}.iso`,
    ))).toBe(false);
    expect(readFileSync(`${partialPath}.failed`)).toEqual(content);
  });

  it("cannot publish when validation loses cancellation or lease authority", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.alloc(4 * 2_048, 0);
    const digest = "6".repeat(64);
    const controller = new AbortController();
    const authorityLost = new Error("Archive validation authority lost");
    let partialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        partialPath = outputPath;
        writeFileSync(outputPath, content);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner,
      salvageValidator: {
        validate: vi.fn(async () => {
          controller.abort(authorityLost);
          return {
            badSectorCountsByTitle: [{
              badSectorCount: 1,
              titleNumber: 1,
            }],
            outcome: "accepted" as const,
          };
        }),
      },
      signal: controller.signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toBe(authorityLost);

    expect(existsSync(join(
      realpathSync(originalsLibraryPath),
      `dvdmeta-${digest}.iso`,
    ))).toBe(false);
    expect(readFileSync(`${partialPath}.failed`)).toEqual(content);
  });

  it("reauthorizes after image sync before publishing a clean archive", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "7".repeat(64);
    const sizeBytes = 2 * 2_048;
    const content = Buffer.alloc(sizeBytes, 7);
    let authorityLost = false;
    const staleClaim = new Error("Stale Archive Job attempt after image sync");
    const authorizeMutation = vi.fn(() => {
      if (authorityLost) {
        throw staleClaim;
      }
    });

    await expect(preserveDvdArchive({
      archiveRequestId: "archive-request:disc:sync-fence",
      authorizeMutation,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, content);
          return createCleanDvdRecoveryResult(sizeBytes);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes,
      sync: async (path) => {
        if (path !== root) {
          authorityLost = true;
        }
      },
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toBe(staleClaim);

    expect(authorizeMutation).toHaveBeenCalledTimes(3);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("quarantines its own published inode after rollback authority expires", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "c".repeat(64);
    const sizeBytes = 2 * 2_048;
    const content = Buffer.alloc(sizeBytes, 12);
    let authorityLost = false;
    const staleClaim = new Error("Stale Archive Job rollback attempt");
    const authorizeMutation = vi.fn(() => {
      if (authorityLost) {
        throw staleClaim;
      }
    });

    await expect(preserveDvdArchive({
      archiveRequestId: "archive-request:disc:stale-rollback",
      authorizeMutation,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, content);
          return createCleanDvdRecoveryResult(sizeBytes);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes,
      sync: async (path) => {
        if (path === root) {
          authorityLost = true;
          throw new Error("archive directory sync failed after publication");
        }
      },
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toThrow("archive directory sync failed after publication");

    const archivePath = join(root, `dvdmeta-${digest}.iso`);
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(`${archivePath}.failed`)).toEqual(content);
  });

  it("recopies a cross-request orphan instead of publishing unknown evidence", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "d".repeat(64);
    const sizeBytes = 2 * 2_048;
    const orphanImage = Buffer.alloc(sizeBytes, 14);
    const replacementImage = Buffer.alloc(sizeBytes, 15);
    const fingerprint = `dvdmeta-sha256:${digest}`;
    const first = await preserveDvdArchive({
      archiveRequestId: "archive-request:disc:orphan-owner",
      devicePath: "/dev/sr0",
      fingerprint,
      originalsLibraryPath,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, orphanImage);
          return createCleanDvdRecoveryResult(sizeBytes);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    });
    const replacementCopy = vi.fn(async ({ outputPath }) => {
      writeFileSync(outputPath, replacementImage);
      return createCleanDvdRecoveryResult(sizeBytes);
    });

    const recovered = await preserveDvdArchive({
      archiveRequestId: "archive-request:disc:orphan-successor",
      devicePath: "/dev/sr0",
      fingerprint,
      originalsLibraryPath,
      runner: {
        copy: replacementCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    });

    expect(replacementCopy).toHaveBeenCalledOnce();
    expect(recovered.integrityEvidence.integrity).toBe("clean_read");
    expect(readFileSync(recovered.archivePath)).toEqual(replacementImage);
    expect(readFileSync(`${first.archivePath}.failed`)).toEqual(orphanImage);
  });

  it("fences a stale claim at the rescue-map replacement", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId = "archive-request:disc:map-fence";
    const digest = "8".repeat(64);
    const sizeBytes = 2 * 2_048;
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          const damagedImage = Buffer.alloc(sizeBytes, 8);
          damagedImage.fill(0, 2_048);
          writeFileSync(outputPath, damagedImage);
          return damagedRecovery;
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue requires validation");

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const staleClaim = new Error("Stale Archive Job attempt at map commit");
    const authorizeMutation = vi.fn(() => {
      if (authorizeMutation.mock.calls.length === 4) {
        throw staleClaim;
      }
    });
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation,
      runner: {
        copy: vi.fn(async () => createCleanDvdRecoveryResult(sizeBytes)),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue state could not be updated");

    expect(authorizeMutation).toHaveBeenCalledTimes(4);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    expect(
      JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")).recoveryProtocol,
    ).toMatchObject({ badSectorCount: 1 });
  });

  it("fences a stale claim after rescue-map durability and before publication", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId = "archive-request:disc:publication-fence";
    const digest = "9".repeat(64);
    const sizeBytes = 2 * 2_048;
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          const damagedImage = Buffer.alloc(sizeBytes, 9);
          damagedImage.fill(0, 2_048);
          writeFileSync(outputPath, damagedImage);
          return damagedRecovery;
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue requires validation");

    const staleClaim = new Error("Stale Archive Job attempt before publication");
    const authorizeMutation = vi.fn(() => {
      if (authorizeMutation.mock.calls.length === 5) {
        throw staleClaim;
      }
    });
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation,
      runner: {
        copy: vi.fn(async () => createCleanDvdRecoveryResult(sizeBytes)),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    })).rejects.toBe(staleClaim);

    expect(authorizeMutation).toHaveBeenCalledTimes(5);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("checks rescue ownership before recovery policy compatibility", async () => {
    const fixture = await createInterruptedDamagedPublication(
      "archive-request:disc:invalid-state-fence",
      "a".repeat(64),
    );
    const map = JSON.parse(
      readFileSync(fixture.rescuePaths.mapPath, "utf8"),
    );
    map.fingerprint = `dvdmeta-sha256:${"b".repeat(64)}`;
    map.recoveryPolicyVersion = "retired-dvd-recovery-policy";
    writeFileSync(fixture.rescuePaths.mapPath, `${JSON.stringify(map)}\n`);
    const staleClaim = new Error("Stale Archive Job attempt before quarantine");
    const authorizeMutation = vi.fn(() => {
      if (authorizeMutation.mock.calls.length > 1) {
        throw staleClaim;
      }
    });

    await expect(preserveDvdArchive({
      ...fixture.baseOptions,
      authorizeMutation,
      runner: {
        copy: vi.fn(),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue state does not match the Archive Request");

    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(existsSync(fixture.interrupted.archivePath)).toBe(true);
    expect(existsSync(fixture.rescuePaths.imagePath)).toBe(true);
    expect(existsSync(fixture.rescuePaths.mapPath)).toBe(true);
    expect(
      readdirSync(fixture.root).some((name) => name.includes(".invalid-")),
    ).toBe(false);
  });

  it.each(["canonical", "retention"] as const)(
    "preserves an accepted boundary transaction when the %s map belongs to another Archive Request",
    async (mismatchedMap) => {
      const fixture = await createInterruptedDamagedPublication(
        "archive-request:boundary-transaction-owner",
        "2".repeat(64),
      );
      const retentionMapPath = `${fixture.rescuePaths.mapPath}.retaining`;
      const canonicalMap = JSON.parse(
        readFileSync(fixture.rescuePaths.mapPath, "utf8"),
      );
      const imageMetadata = lstatSync(
        fixture.rescuePaths.imagePath,
        { bigint: true },
      );
      const imageProof = {
        ctimeNs: imageMetadata.ctimeNs.toString(),
        mtimeNs: imageMetadata.mtimeNs.toString(),
      };
      const retentionMap = {
        ...canonicalMap,
        schemaVersion: 3,
        imageByteCount: fixture.rescuedImage.byteLength,
        boundaryFailureProtocol: createProvenBoundaryFailure(
          fixture.rescuedImage.byteLength,
          fixture.rescuedImage.byteLength / 2_048,
        ),
        boundaryAcceptanceImageProof: {
          source: imageProof,
          accepted: imageProof,
        },
      };
      const foreignArchiveRequestId =
        "archive-request:foreign-boundary-transaction-owner";
      if (mismatchedMap === "canonical") {
        canonicalMap.archiveRequestId = foreignArchiveRequestId;
      } else {
        retentionMap.archiveRequestId = foreignArchiveRequestId;
      }
      writeFileSync(
        fixture.rescuePaths.mapPath,
        `${JSON.stringify(canonicalMap)}\n`,
      );
      writeFileSync(
        retentionMapPath,
        `${JSON.stringify(retentionMap)}\n`,
      );
      const preservedImage = readFileSync(fixture.rescuePaths.imagePath);
      const preservedCanonicalMap = readFileSync(fixture.rescuePaths.mapPath);
      const preservedRetentionMap = readFileSync(retentionMapPath);
      const noCopy = vi.fn();

      await expect(preserveDvdArchive({
        ...fixture.baseOptions,
        runner: {
          copy: noCopy,
          isActive: () => false,
          withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
          waitForInactive: vi.fn(async () => undefined),
        },
        signal: new AbortController().signal,
      })).rejects.toThrow(
        "DVD rescue state does not match the Archive Request",
      );

      expect(noCopy).not.toHaveBeenCalled();
      expect(readFileSync(fixture.rescuePaths.imagePath)).toEqual(
        preservedImage,
      );
      expect(readFileSync(fixture.rescuePaths.mapPath)).toEqual(
        preservedCanonicalMap,
      );
      expect(readFileSync(retentionMapPath)).toEqual(preservedRetentionMap);
      expect(
        readdirSync(fixture.root).some((name) => name.includes(".invalid-")),
      ).toBe(false);
    },
  );

  it("recovers an accepted damaged publication after a worker restart", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId =
      "archive-request:disc:33333333-3333-4333-8333-333333333334";
    const digest = "c".repeat(64);
    const sizeBytes = 2 * 2_048;
    const rescuedImage = Buffer.alloc(sizeBytes, 6);
    rescuedImage.fill(0, 2_048);
    const recoveryResult = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const expectedTitleMap = {
      schemaVersion: 2 as const,
      contentId: `dvdmeta-sha256:${digest}`,
      titles: [{
        number: 1,
        durationSeconds: 3_600,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
    };
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap,
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const firstRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, rescuedImage);
        return recoveryResult;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const acceptedValidation = {
      badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
      outcome: "accepted" as const,
    };

    const interrupted = await preserveDvdArchive({
      ...baseOptions,
      runner: firstRunner,
      salvageValidator: {
        validate: vi.fn().mockResolvedValue(acceptedValidation),
      },
      signal: new AbortController().signal,
    });

    expect(readFileSync(interrupted.archivePath)).toEqual(rescuedImage);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);

    const retryCopy = vi.fn();
    const retrySalvageValidator = {
      validate: vi.fn().mockResolvedValue(acceptedValidation),
    };
    const recovered = await preserveDvdArchive({
      ...baseOptions,
      runner: {
        copy: retryCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      salvageValidator: retrySalvageValidator,
      signal: new AbortController().signal,
    });

    expect(retryCopy).not.toHaveBeenCalled();
    expect(retrySalvageValidator.validate).toHaveBeenCalledOnce();
    expect(recovered.integrityEvidence).toEqual({
      integrity: "watchable_salvage",
      policyVersion: "dvd-watchable-salvage-v2",
      badSectorCount: 1,
      badAreaCount: 1,
      badSectorRanges: [{ startLba: 1, sectorCount: 1 }],
      badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
    });
    await recovered.finalizePublication?.();
    expect(readFileSync(recovered.archivePath)).toEqual(rescuedImage);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("rejects an orphan salvage result when validation reads a replacement image", async () => {
    const fixture = await createInterruptedDamagedPublication(
      "33333333-3333-4333-8333-333333333335",
      "d".repeat(64),
    );
    const displacedRescuePath = `${fixture.rescuePaths.imagePath}.displaced`;
    const replacementImage = Buffer.alloc(fixture.rescuedImage.length, 9);

    await expect(preserveDvdArchive({
      ...fixture.baseOptions,
      runner: {
        copy: vi.fn(),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      salvageValidator: {
        validate: vi.fn(async () => {
          renameSync(fixture.rescuePaths.imagePath, displacedRescuePath);
          writeFileSync(fixture.rescuePaths.imagePath, replacementImage);
          return {
            badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
            outcome: "accepted" as const,
          };
        }),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("Existing DVD archive conflicts with rescue state");

    expect(existsSync(fixture.interrupted.archivePath)).toBe(false);
    expect(readFileSync(`${fixture.interrupted.archivePath}.failed`)).toEqual(
      fixture.rescuedImage,
    );
  });

  it("preserves a correlated rescue with mismatched map identity", async () => {
    const fixture = await createInterruptedDamagedPublication(
      "33333333-3333-4333-8333-333333333336",
      "e".repeat(64),
    );
    const map = JSON.parse(
      readFileSync(fixture.rescuePaths.mapPath, "utf8"),
    ) as { fingerprint: string };
    map.fingerprint = `dvdmeta-sha256:${"f".repeat(64)}`;
    writeFileSync(fixture.rescuePaths.mapPath, `${JSON.stringify(map)}\n`);
    const preservedImage = readFileSync(fixture.rescuePaths.imagePath);
    const preservedMap = readFileSync(fixture.rescuePaths.mapPath);
    const noCopy = vi.fn();

    await expect(preserveDvdArchive({
      ...fixture.baseOptions,
      runner: {
        copy: noCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
          outcome: "accepted",
        }),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue state does not match the Archive Request");

    expect(noCopy).not.toHaveBeenCalled();
    expect(readFileSync(fixture.interrupted.archivePath)).toEqual(
      fixture.rescuedImage,
    );
    expect(existsSync(`${fixture.interrupted.archivePath}.failed`)).toBe(false);
    expect(readFileSync(fixture.rescuePaths.imagePath)).toEqual(preservedImage);
    expect(readFileSync(fixture.rescuePaths.mapPath)).toEqual(preservedMap);
    expect(
      readdirSync(fixture.root).filter((name) => name.includes(".invalid-")),
    ).toHaveLength(0);
  });

  it("keeps clean rescue state valid when archive directory sync fails", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId = "33333333-3333-4333-8333-333333333333";
    const digest = "c".repeat(64);
    const sizeBytes = 2 * 2_048;
    const rescuedImage = Buffer.alloc(sizeBytes, 6);
    rescuedImage.fill(0, 2_048);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const firstRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, rescuedImage);
        return damagedRecovery;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: firstRunner,
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue requires validation");

    const rescueImageName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.iso"),
    );
    const rescueImagePath = join(root, rescueImageName!);
    const completionRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes: expectedSize }) => {
        const completedImage = Buffer.from(readFileSync(outputPath));
        completedImage.fill(6, 2_048);
        writeFileSync(outputPath, completedImage);
        return createCleanDvdRecoveryResult(expectedSize);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: completionRunner,
      signal: new AbortController().signal,
      sync: async (path) => {
        if (path === root) {
          throw new Error("directory sync failed");
        }
      },
    })).rejects.toThrow("directory sync failed");

    expect(existsSync(rescueImagePath)).toBe(true);
    expect(
      readdirSync(root).some((name) => name.endsWith(".rip-dvd-rescue.json")),
    ).toBe(true);
    const noCopyRunner: DvdCopyRunner = {
      copy: vi.fn(),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    const completed = await preserveDvdArchive({
      ...baseOptions,
      runner: noCopyRunner,
      signal: new AbortController().signal,
    });

    expect(noCopyRunner.copy).not.toHaveBeenCalled();
    expect(readFileSync(completed.archivePath)).toEqual(Buffer.alloc(sizeBytes, 6));
    await completed.finalizePublication?.();
    expect(existsSync(rescueImagePath)).toBe(false);
  });

  it("recovers an initial rescue transaction interrupted before image publication", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId = "44444444-4444-4444-8444-444444444444";
    const digest = "d".repeat(64);
    const sizeBytes = 2 * 2_048;
    const content = Buffer.alloc(sizeBytes, 8);
    const damagedRecovery = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
    ]);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const firstRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, content);
        return damagedRecovery;
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: firstRunner,
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue requires validation");

    const rescueImageName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.iso"),
    );
    const rescueMapName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.json"),
    );
    const rescueImagePath = join(root, rescueImageName!);
    const rescueMapPath = join(root, rescueMapName!);
    const preparedImageBasename =
      `.dvdmeta-${digest}.55555555-5555-4555-8555-555555555555` +
      ".iso.rip-dvd-partial";
    const preparedImagePath = join(root, preparedImageBasename);
    const rescueMap = JSON.parse(readFileSync(rescueMapPath, "utf8"));
    writeFileSync(
      rescueMapPath,
      `${JSON.stringify({ ...rescueMap, preparedImageBasename })}\n`,
    );
    renameSync(rescueImagePath, preparedImagePath);

    const staleClaim = new Error(
      "Stale Archive Job attempt before rescue transaction recovery",
    );
    const authorizeMutation = vi.fn(() => {
      if (authorizeMutation.mock.calls.length > 1) {
        throw staleClaim;
      }
    });
    const staleCopy = vi.fn();
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation,
      runner: {
        copy: staleCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue state could not be quarantined");

    expect(staleCopy).not.toHaveBeenCalled();
    expect(existsSync(preparedImagePath)).toBe(true);
    expect(existsSync(rescueImagePath)).toBe(false);
    expect(
      JSON.parse(readFileSync(rescueMapPath, "utf8")),
    ).toHaveProperty("preparedImageBasename", preparedImageBasename);

    const completionRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ continuation, outputPath, sizeBytes: expectedSize }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: damagedRecovery,
        });
        expect(existsSync(preparedImagePath)).toBe(false);
        expect(
          JSON.parse(readFileSync(rescueMapPath, "utf8")),
        ).not.toHaveProperty("preparedImageBasename");
        return createCleanDvdRecoveryResult(expectedSize);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    const completed = await preserveDvdArchive({
      ...baseOptions,
      runner: completionRunner,
      signal: new AbortController().signal,
    });

    expect(completionRunner.copy).toHaveBeenCalledOnce();
    await completed.finalizePublication?.();
    expect(existsSync(rescueImagePath)).toBe(false);
  });

  it("rejects a clean rescue image replaced during source authorization", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId = "66666666-6666-4666-8666-666666666666";
    const digest = "e".repeat(64);
    const sizeBytes = 2 * 2_048;
    const content = Buffer.alloc(sizeBytes, 10);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      sizeBytes,
      onProgress: () => undefined,
    };
    const firstRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, content);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: firstRunner,
      signal: new AbortController().signal,
      verifySource: async () => undefined,
    })).rejects.toThrow("DVD rescue requires validation");

    const rescueImageName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.iso"),
    );
    const rescueMapName = readdirSync(root).find((name) =>
      name.endsWith(".rip-dvd-rescue.json"),
    );
    const rescueImagePath = join(root, rescueImageName!);
    const rescueMapPath = join(root, rescueMapName!);
    const rescueMap = JSON.parse(readFileSync(rescueMapPath, "utf8"));
    rescueMap.recoveryProtocol = {
      protocolVersion: 1,
      declaredByteCount: sizeBytes,
      recoveredByteCount: sizeBytes,
      recoveryPolicyVersion: "dvd-recovery-v1",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorBitmapHex: "",
    };
    writeFileSync(rescueMapPath, `${JSON.stringify(rescueMap)}\n`);
    const replacementContent = Buffer.alloc(sizeBytes, 11);
    const replacementPath = `${rescueImagePath}.replacement`;
    writeFileSync(replacementPath, replacementContent);
    const noCopyRunner: DvdCopyRunner = {
      copy: vi.fn(),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: noCopyRunner,
      signal: new AbortController().signal,
      verifySource: async () => {
        renameSync(replacementPath, rescueImagePath);
      },
    })).rejects.toThrow("Existing DVD archive conflicts with rescue state");

    const archivePath = join(root, `dvdmeta-${digest}.iso`);
    expect(noCopyRunner.copy).not.toHaveBeenCalled();
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(`${archivePath}.failed`)).toEqual(replacementContent);
  });

  it("moves a failed partial image aside without publishing an archive", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const digest = "b".repeat(64);
    let copiedPartialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        copiedPartialPath = outputPath;
        writeFileSync(outputPath, "partial evidence");
        throw new Error("disc read failed");
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: 16,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("disc read failed");

    const root = realpathSync(originalsLibraryPath);
    expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
    expect(existsSync(join(root, `.${digest}.iso.rip-dvd-partial`))).toBe(false);
    expect(readFileSync(`${copiedPartialPath}.failed`, "utf8")).toBe(
      "partial evidence",
    );
  });

  it("retains a synchronized out-of-range prefix in the Archive Request workspace", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "4".repeat(64);
    const sizeBytes = 4 * 2_048;
    const prefix = Buffer.alloc(2 * 2_048, 17);
    const archiveRequestId = "out-of-range-prefix-request";
    const sync = vi.fn(async () => undefined);
    const revalidateReadFailure = vi.fn(async () => undefined);
    const salvageValidator = { validate: vi.fn() };
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, prefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    let failure: unknown;
    try {
      await preserveDvdArchive({
        archiveRequestId,
        devicePath: "/dev/sr0",
        fingerprint: `dvdmeta-sha256:${digest}`,
        originalsLibraryPath,
        revalidateReadFailure,
        runner,
        salvageValidator,
        signal: new AbortController().signal,
        sizeBytes,
        sync,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DvdArchiveReadFailureError);
    expect((failure as DvdArchiveReadFailureError).readFailure).toMatchObject({
      category: "out_of_range",
      declaredByteCount: sizeBytes,
      firstFailingLba: 2,
    });
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(prefix);
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      declaredByteCount: sizeBytes,
      imageByteCount: prefix.byteLength,
      recoveryProtocol: null,
      boundaryFailureProtocol: expect.objectContaining({
        category: "out_of_range",
        declaredByteCount: sizeBytes,
        firstFailingLba: 2,
      }),
    });
    expect(sync).toHaveBeenCalledWith(expect.stringContaining("rip-dvd-partial"));
    expect(revalidateReadFailure).toHaveBeenCalledTimes(3);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("does not publish when the claim is lost during completeness validation", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "9".repeat(64);
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 61);
    const archiveRequestId = "claim-lost-corrected-boundary";
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: reportedSizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, retainedPrefix);
        throw new DvdReadFailureError(boundaryFailure);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const claimLost = new Error("Archive Job claim was lost");
    let validationFinished = false;
    const authorizeMutation = vi.fn(() => {
      if (validationFinished) {
        throw claimLost;
      }
    });

    await expect(preserveDvdArchive({
      archiveRequestId,
      authorizeMutation,
      completenessProver: {
        async prove() {
          validationFinished = true;
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toBe(claimLost);

    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(retainedPrefix);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
  });

  it("does not overwrite a destination published during completeness validation", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "8".repeat(64);
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 67);
    const archiveRequestId = "concurrent-corrected-boundary";
    const archivePath = join(root, `dvdmeta-${digest}.iso`);
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: reportedSizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, retainedPrefix);
        throw new DvdReadFailureError(boundaryFailure);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      archiveRequestId,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          writeFileSync(archivePath, "concurrent publisher");
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ code: "EEXIST" });

    expect(readFileSync(archivePath, "utf8")).toBe("concurrent publisher");
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(retainedPrefix);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
  });

  it("resumes a corrected publication after a worker restart", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "7".repeat(64);
    const archiveRequestId = "restarted-corrected-boundary";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 71);
    const boundaryFailure = {
      ...createOutOfRangeDvdReadFailureResult({
        declaredByteCount: reportedSizeBytes,
        firstFailingLba: firstExcludedLba,
        requestedBlockCount: 1,
        requestedLba: firstExcludedLba,
      }),
      retryOrdinal: 1,
      boundaryProofVersion: "dvd-sector-boundary-proof-v1" as const,
      candidateConfirmationCount: 2 as const,
      precedingSectorLba: firstExcludedLba - 1,
    };
    const expectedTitleMap = {
      schemaVersion: 2 as const,
      contentId: `dvdmeta-sha256:${digest}`,
      titles: [],
    };
    const baseOptions = {
      archiveRequestId,
      authorizeMutation: () => undefined,
      devicePath: "/dev/sr0",
      expectedTitleMap,
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const first = await preserveDvdArchive({
      ...baseOptions,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, retainedPrefix);
          throw new DvdReadFailureError(boundaryFailure);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
    });
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(readFileSync(first.archivePath)).toEqual(retainedPrefix);
    expect(existsSync(rescuePaths.imagePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);

    const retryCopy = vi.fn();
    const retryProof = vi.fn(async () => ({
      maximumReferencedLba: firstExcludedLba - 1,
    }));
    const restarted = await preserveDvdArchive({
      ...baseOptions,
      completenessProver: { prove: retryProof },
      runner: {
        copy: retryCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
    });

    expect(retryCopy).not.toHaveBeenCalled();
    expect(retryProof).toHaveBeenCalledOnce();
    expect(restarted.archiveFilesystemIdentity)
      .toBe(first.archiveFilesystemIdentity);
    expect(restarted.correctedBoundaryEvidence).toMatchObject({
      reportedSizeBytes,
      publishedSizeBytes: retainedPrefix.byteLength,
      firstExcludedLba,
      maximumReferencedLba: firstExcludedLba - 1,
    });
    await restarted.finalizePublication?.();
    expect(readFileSync(restarted.archivePath)).toEqual(retainedPrefix);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("finishes an interrupted boundary trim transaction after restart", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "1".repeat(64);
    const archiveRequestId = "interrupted-corrected-boundary-trim";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const publishedSizeBytes = firstExcludedLba * 2_048;
    const fullImage = Buffer.alloc(reportedSizeBytes, 47);
    fullImage.fill(0, 1 * 2_048, 2 * 2_048);
    fullImage.fill(0, 7 * 2_048, 8 * 2_048);
    const priorDamage = createDamagedDvdRecoveryResult(
      reportedSizeBytes,
      [
        { startLba: 1, sectorCount: 1 },
        { startLba: 7, sectorCount: 1 },
      ],
    );
    const retainedDamage = createDamagedDvdRecoveryResult(
      reportedSizeBytes,
      [{ startLba: 1, sectorCount: 1 }],
    );
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    const expectedTitleMap = {
      schemaVersion: 2 as const,
      contentId: `dvdmeta-sha256:${digest}`,
      titles: [],
    };
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap,
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [],
          outcome: "accepted",
        }),
      },
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, fullImage);
        return priorDamage;
      })),
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          outcome: "rejected",
          reason: "referenced_content",
        }),
      },
    })).rejects.toThrow("DVD salvage rejected");

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const retentionMapPath = `${rescuePaths.mapPath}.retaining`;
    const interruptedBeforeTrim = new Error("worker stopped before image trim");
    let stoppedBeforeTrim = false;
    const authorizeBeforeTrim = vi.fn(() => {
      if (
        !stoppedBeforeTrim &&
        existsSync(retentionMapPath) &&
        JSON.parse(readFileSync(retentionMapPath, "utf8")).schemaVersion === 3 &&
        lstatSync(rescuePaths.imagePath).size === reportedSizeBytes
      ) {
        stoppedBeforeTrim = true;
        throw interruptedBeforeTrim;
      }
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: authorizeBeforeTrim,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      revalidateReadFailure: async () => undefined,
      runner: runner(vi.fn(async ({ continuation }) => {
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: priorDamage,
        });
        throw new DvdReadFailureError(boundaryFailure, retainedDamage);
      })),
    })).rejects.toBe(interruptedBeforeTrim);

    expect(stoppedBeforeTrim).toBe(true);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(fullImage);
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")))
      .toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(readFileSync(retentionMapPath, "utf8")))
      .toMatchObject({ schemaVersion: 3 });

    const interruptedAfterTrim = new Error("worker stopped after image trim");
    let stoppedAfterTrim = false;
    const retryCopy = vi.fn();
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: () => {
        const retentionMap = existsSync(retentionMapPath)
          ? JSON.parse(readFileSync(retentionMapPath, "utf8"))
          : null;
        if (
          !stoppedAfterTrim &&
          retentionMap?.schemaVersion === 3 &&
          retentionMap.boundaryAcceptanceImageProof?.accepted !== undefined &&
          lstatSync(rescuePaths.imagePath).size === publishedSizeBytes
        ) {
          stoppedAfterTrim = true;
          throw interruptedAfterTrim;
        }
      },
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      runner: runner(retryCopy),
    })).rejects.toBe(interruptedAfterTrim);

    expect(retryCopy).not.toHaveBeenCalled();
    expect(stoppedAfterTrim).toBe(true);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(
      fullImage.subarray(0, publishedSizeBytes),
    );
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")))
      .toMatchObject({ schemaVersion: 2 });
    expect(JSON.parse(readFileSync(retentionMapPath, "utf8")))
      .toMatchObject({
        schemaVersion: 3,
        imageByteCount: publishedSizeBytes,
        boundaryAcceptanceImageProof: {
          source: {
            ctimeNs: expect.any(String),
            mtimeNs: expect.any(String),
          },
          accepted: {
            ctimeNs: expect.any(String),
            mtimeNs: expect.any(String),
          },
        },
        recoveryProtocol: expect.objectContaining({ badSectorCount: 1 }),
      });

    const restartedCopy = vi.fn(async ({ continuation }) => {
      expect(continuation).toMatchObject({
        kind: "corrected",
        recoveryResult: createDamagedDvdRecoveryResult(
          publishedSizeBytes,
          [{ startLba: 1, sectorCount: 1 }],
        ),
      });
      return createDamagedDvdRecoveryResult(
        publishedSizeBytes,
        [{ startLba: 1, sectorCount: 1 }],
      );
    });
    const restarted = await preserveDvdArchive({
      ...baseOptions,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      runner: runner(restartedCopy),
    });

    expect(restartedCopy).toHaveBeenCalledOnce();
    expect(restarted.integrityEvidence.integrity).toBe("watchable_salvage");
    expect(readFileSync(restarted.archivePath)).toEqual(
      fullImage.subarray(0, publishedSizeBytes),
    );
    await restarted.finalizePublication?.();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(retentionMapPath)).toBe(false);
  });

  it("quarantines a same-size mutation after an interrupted boundary trim", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "6".repeat(64);
    const archiveRequestId = "mutated-interrupted-boundary-trim";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 47);
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    const expectedTitleMap = {
      schemaVersion: 2 as const,
      contentId: `dvdmeta-sha256:${digest}`,
      titles: [],
    };
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap,
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, retainedPrefix);
        throw new DvdReadFailureError(boundaryFailure);
      })),
    })).rejects.toThrow("DVD corrected-boundary validation is unavailable");

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const retentionMapPath = `${rescuePaths.mapPath}.retaining`;
    const interrupted = new Error("worker stopped after proof checkpoint");
    let checkpointObserved = false;
    const retryCopy = vi.fn();
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: () => {
        const retentionMap = existsSync(retentionMapPath)
          ? JSON.parse(readFileSync(retentionMapPath, "utf8"))
          : null;
        if (
          !checkpointObserved &&
          retentionMap?.boundaryAcceptanceImageProof?.accepted !== undefined
        ) {
          checkpointObserved = true;
          throw interrupted;
        }
      },
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      runner: runner(retryCopy),
    })).rejects.toBe(interrupted);

    expect(retryCopy).not.toHaveBeenCalled();
    expect(checkpointObserved).toBe(true);
    expect(JSON.parse(readFileSync(retentionMapPath, "utf8")))
      .toMatchObject({
        schemaVersion: 3,
        boundaryAcceptanceImageProof: {
          accepted: {
            ctimeNs: expect.any(String),
            mtimeNs: expect.any(String),
          },
        },
      });

    writeFileSync(
      rescuePaths.imagePath,
      Buffer.alloc(retainedPrefix.byteLength, 91),
    );
    const restartedCopy = vi.fn();
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      runner: runner(restartedCopy),
    })).rejects.toThrow(
      "DVD rescue image changed during transaction recovery",
    );

    expect(restartedCopy).not.toHaveBeenCalled();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(retentionMapPath)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("rejects boundary snapshots that introduce new rescue damage", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "8".repeat(64);
    const archiveRequestId = "invalid-boundary-recovery-snapshot";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const fullImage = Buffer.alloc(reportedSizeBytes, 53);
    fullImage.fill(0, 1 * 2_048, 2 * 2_048);
    const priorDamage = createDamagedDvdRecoveryResult(
      reportedSizeBytes,
      [{ startLba: 1, sectorCount: 1 }],
    );
    const inventedDamage = createDamagedDvdRecoveryResult(
      reportedSizeBytes,
      [{ startLba: 2, sectorCount: 1 }],
    );
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2 as const,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, fullImage);
        return priorDamage;
      })),
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          outcome: "rejected",
          reason: "referenced_content",
        }),
      },
    })).rejects.toThrow("DVD salvage rejected");

    const prove = vi.fn();
    await expect(preserveDvdArchive({
      ...baseOptions,
      completenessProver: { prove },
      revalidateReadFailure: async () => undefined,
      runner: runner(vi.fn(async () => {
        throw new DvdReadFailureError(boundaryFailure, inventedDamage);
      })),
    })).rejects.toThrow("Resumed DVD recovery result is invalid");

    expect(prove).not.toHaveBeenCalled();
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(fullImage);
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")))
      .toMatchObject({ schemaVersion: 1 });
  });

  it("retries only retained damaged sectors after accepting a boundary", async () => {
    const digest = "2".repeat(64);
    const archiveRequestId = "corrected-boundary-damage-retry";
    const {
      baseOptions,
      correctedDamage,
      firstExcludedLba,
      fullImage,
      publishedSizeBytes,
      reportedSizeBytes,
      rescuePaths,
      runner,
    } = await createCorrectedDamagedRetryWorkspace(
      archiveRequestId,
      digest,
    );

    const recoveredImage = Buffer.from(
      fullImage.subarray(0, publishedSizeBytes),
    );
    recoveredImage.fill(83, 1 * 2_048, 2 * 2_048);
    const retryCopy = vi.fn(async ({ continuation, outputPath }) => {
      expect(continuation).toEqual(expect.objectContaining({
        kind: "corrected",
        imageByteCount: publishedSizeBytes,
        recoveryResult: correctedDamage,
      }));
      expect(readFileSync(outputPath)).toEqual(
        fullImage.subarray(0, publishedSizeBytes),
      );
      writeFileSync(outputPath, recoveredImage);
      return createCleanDvdRecoveryResult(publishedSizeBytes);
    });
    const finalSalvageValidator = { validate: vi.fn() };
    const completed = await preserveDvdArchive({
      ...baseOptions,
      runner: runner(retryCopy),
      salvageValidator: finalSalvageValidator,
    });

    expect(retryCopy).toHaveBeenCalledOnce();
    expect(finalSalvageValidator.validate).not.toHaveBeenCalled();
    expect(completed.integrityEvidence.integrity).toBe("clean_read");
    expect(completed.correctedBoundaryEvidence).toMatchObject({
      reportedSizeBytes,
      publishedSizeBytes,
      firstExcludedLba,
    });
    expect(readFileSync(completed.archivePath)).toEqual(recoveredImage);
    await completed.finalizePublication?.();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("rejects a same-inode mutation of retained good sectors during corrected retry", async () => {
    const digest = "e".repeat(64);
    const archiveRequestId = "mutated-corrected-boundary-retry";
    const {
      baseOptions,
      correctedDamage,
      fullImage,
      publishedSizeBytes,
      rescuePaths,
      root,
      runner,
    } = await createCorrectedDamagedRetryWorkspace(
      archiveRequestId,
      digest,
    );
    const corruptedImage = Buffer.from(
      fullImage.subarray(0, publishedSizeBytes),
    );
    corruptedImage.fill(83, 1 * 2_048, 2 * 2_048);
    corruptedImage.fill(91, 2 * 2_048, 3 * 2_048);

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ continuation, outputPath }) => {
        expect(continuation).toEqual(expect.objectContaining({
          kind: "corrected",
          recoveryResult: correctedDamage,
        }));
        writeFileSync(outputPath, corruptedImage);
        return createCleanDvdRecoveryResult(publishedSizeBytes);
      })),
    })).rejects.toThrow(
      "DVD corrected-boundary retained sectors changed during recovery",
    );

    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(readdirSync(root).some((entry) =>
      entry.startsWith(`${basename(rescuePaths.imagePath)}.invalid-`)
    )).toBe(true);
  });

  it("preserves corrected retry progress when retained-sector proof is cancelled", async () => {
    const digest = "a".repeat(64);
    const archiveRequestId = "cancelled-corrected-boundary-retry-proof";
    const {
      baseOptions,
      rescuePaths,
      root,
      runner,
    } = await createCorrectedDamagedRetryWorkspace(
      archiveRequestId,
      digest,
    );
    const cancellation = new DOMException(
      "Corrected retry was cancelled",
      "AbortError",
    );
    const signal = new AbortController().signal;
    let cancelledDuringProof = false;
    vi.spyOn(signal, "throwIfAborted").mockImplementation(() => {
      if (new Error().stack?.includes("digestReadableRange")) {
        cancelledDuringProof = true;
        throw cancellation;
      }
    });
    const retryCopy = vi.fn();

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(retryCopy),
      signal,
    })).rejects.toBe(cancellation);

    expect(cancelledDuringProof).toBe(true);
    expect(retryCopy).not.toHaveBeenCalled();
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    expect(existsSync(rescuePaths.imagePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
    expect(readdirSync(root).some((entry) =>
      entry.startsWith(`${basename(rescuePaths.imagePath)}.invalid-`)
    )).toBe(false);
  });

  it("resumes corrected retry after post-helper proof cancellation", async () => {
    const digest = "b".repeat(64);
    const archiveRequestId = "post-helper-cancelled-corrected-retry-proof";
    const {
      baseOptions,
      correctedDamage,
      fullImage,
      publishedSizeBytes,
      rescuePaths,
      root,
      runner,
    } = await createCorrectedDamagedRetryWorkspace(
      archiveRequestId,
      digest,
    );
    const recoveredImage = Buffer.from(
      fullImage.subarray(0, publishedSizeBytes),
    );
    recoveredImage.fill(83, 1 * 2_048, 2 * 2_048);
    const cancellation = new DOMException(
      "Corrected retry was cancelled after helper completion",
      "AbortError",
    );
    const signal = new AbortController().signal;
    let helperCompleted = false;
    let cancelledDuringPostHelperProof = false;
    vi.spyOn(signal, "throwIfAborted").mockImplementation(() => {
      if (
        helperCompleted &&
        new Error().stack?.includes("digestReadableRange")
      ) {
        cancelledDuringPostHelperProof = true;
        throw cancellation;
      }
    });
    const cancelledRetry = vi.fn(async ({ outputPath }) => {
      writeFileSync(outputPath, recoveredImage);
      helperCompleted = true;
      return createCleanDvdRecoveryResult(publishedSizeBytes);
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(cancelledRetry),
      signal,
    })).rejects.toBe(cancellation);

    expect(cancelledRetry).toHaveBeenCalledOnce();
    expect(cancelledDuringPostHelperProof).toBe(true);
    expect(existsSync(rescuePaths.imagePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8")))
      .toMatchObject({
        correctedRetryRetainedSectorProof: {
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          proofVersion: "dvd-corrected-retry-retained-v1",
        },
      });

    const restartedRetry = vi.fn(async ({ continuation, outputPath }) => {
      expect(continuation).toEqual(expect.objectContaining({
        kind: "corrected",
        recoveryResult: correctedDamage,
      }));
      expect(readFileSync(outputPath)).toEqual(recoveredImage);
      return createCleanDvdRecoveryResult(publishedSizeBytes);
    });
    const completed = await preserveDvdArchive({
      ...baseOptions,
      runner: runner(restartedRetry),
    });

    expect(restartedRetry).toHaveBeenCalledOnce();
    expect(completed.integrityEvidence.integrity).toBe("clean_read");
    expect(readFileSync(completed.archivePath)).toEqual(recoveredImage);
    await completed.finalizePublication?.();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(readdirSync(root).some((entry) =>
      entry.startsWith(`${basename(rescuePaths.imagePath)}.invalid-`)
    )).toBe(false);
  });

  it("revalidates the source after corrected-boundary salvage", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "5".repeat(64);
    const archiveRequestId = "corrected-boundary-salvage-source-change";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 89);
    retainedPrefix.fill(0, 2_048, 2 * 2_048);
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    const retainedDamage = createDamagedDvdRecoveryResult(
      reportedSizeBytes,
      [{ startLba: 1, sectorCount: 1 }],
    );
    const sourceChanged = new Error(
      "Optical Drive source changed during salvage validation",
    );
    let salvageFinished = false;
    const verifySource = vi.fn(async () => {
      if (salvageFinished) {
        throw sourceChanged;
      }
    });
    const salvageValidator = {
      validate: vi.fn(async () => {
        salvageFinished = true;
        return {
          badSectorCountsByTitle: [{ badSectorCount: 1, titleNumber: 1 }],
          outcome: "accepted" as const,
        };
      }),
    };

    await expect(preserveDvdArchive({
      archiveRequestId,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, retainedPrefix);
          throw new DvdReadFailureError(boundaryFailure, retainedDamage);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      salvageValidator,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource,
      onProgress: () => undefined,
    })).rejects.toBe(sourceChanged);

    expect(salvageValidator.validate).toHaveBeenCalledOnce();
    expect(verifySource).toHaveBeenCalledTimes(4);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
  });

  it("quarantines a same-size mutation when completeness proof throws", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "3".repeat(64);
    const archiveRequestId = "mutated-failed-boundary-proof";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 73);
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2 as const,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, retainedPrefix);
        throw new DvdReadFailureError(boundaryFailure);
      })),
    })).rejects.toThrow("DVD corrected-boundary validation is unavailable");

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const unchangedProofFailure = new Error("unchanged completeness proof failed");
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          throw unchangedProofFailure;
        },
      },
      runner: runner(vi.fn()),
    })).rejects.toBe(unchangedProofFailure);

    expect(readFileSync(rescuePaths.imagePath)).toEqual(retainedPrefix);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);

    const proofFailure = new Error("completeness proof failed");
    const retryCopy = vi.fn();
    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          writeFileSync(
            rescuePaths.imagePath,
            Buffer.alloc(retainedPrefix.byteLength, 89),
          );
          throw proofFailure;
        },
      },
      runner: runner(retryCopy),
    })).rejects.toBe(proofFailure);

    expect(retryCopy).not.toHaveBeenCalled();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(`${rescuePaths.mapPath}.retaining`)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);

    const freshImage = Buffer.alloc(reportedSizeBytes, 97);
    const freshCopy = vi.fn(async ({ outputPath }) => {
      writeFileSync(outputPath, freshImage);
      return createCleanDvdRecoveryResult(reportedSizeBytes);
    });
    const restarted = await preserveDvdArchive({
      ...baseOptions,
      authorizeMutation: () => undefined,
      runner: runner(freshCopy),
    });

    expect(freshCopy).toHaveBeenCalledOnce();
    expect(restarted.correctedBoundaryEvidence).toBeUndefined();
    expect(readFileSync(restarted.archivePath)).toEqual(freshImage);
  });

  it("rejects a same-size image mutation after corrected-boundary proof", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "6".repeat(64);
    const archiveRequestId = "mutated-corrected-boundary";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 73);
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    let retainedImageSyncCount = 0;

    await expect(preserveDvdArchive({
      archiveRequestId,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, retainedPrefix);
          throw new DvdReadFailureError(boundaryFailure);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      sync: vi.fn(async (path) => {
        if (path.endsWith(".rip-dvd-rescue.iso")) {
          retainedImageSyncCount += 1;
          if (retainedImageSyncCount === 2) {
            writeFileSync(path, Buffer.alloc(retainedPrefix.byteLength, 79));
          }
        }
      }),
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toThrow(
      "DVD corrected-boundary image changed before publication",
    );

    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(true);
    expect(existsSync(rescuePaths.mapPath)).toBe(true);
  });

  it.each([
    { label: "before truncation", mutationAuthorizationCount: 2 },
    { label: "while checkpointing", mutationAuthorizationCount: 3 },
    { label: "before promotion", mutationAuthorizationCount: 4 },
    { label: "during promotion", mutationAuthorizationCount: 5 },
    {
      label: "with a rejected promotion fence",
      mutationAuthorizationCount: 4,
      throwAfterMutation: true,
    },
  ])(
    "rejects a same-inode mutation $label",
    async ({ mutationAuthorizationCount, throwAfterMutation = false }) => {
      const originalsLibraryPath = createOriginalsLibrary();
      const root = realpathSync(originalsLibraryPath);
      const digest = "7".repeat(64);
      const archiveRequestId =
        `mutated-during-boundary-acceptance-${mutationAuthorizationCount}-${
          throwAfterMutation ? "throw" : "return"
        }`;
      const reportedSizeBytes = 8 * 2_048;
      const firstExcludedLba = 6;
      const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 73);
      const boundaryFailure = createProvenBoundaryFailure(
        reportedSizeBytes,
        firstExcludedLba,
      );
      const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
      let proofFinished = false;
      let postProofAuthorizationCount = 0;

      await expect(preserveDvdArchive({
        archiveRequestId,
        authorizeMutation: () => {
          if (!proofFinished) {
            return;
          }
          postProofAuthorizationCount += 1;
          if (postProofAuthorizationCount === mutationAuthorizationCount) {
            writeFileSync(
              rescuePaths.imagePath,
              Buffer.alloc(retainedPrefix.byteLength, 79),
            );
            if (throwAfterMutation) {
              throw new Error("boundary promotion authorization rejected");
            }
          }
        },
        completenessProver: {
          async prove() {
            proofFinished = true;
            return { maximumReferencedLba: firstExcludedLba - 1 };
          },
        },
        devicePath: "/dev/sr0",
        expectedTitleMap: {
          schemaVersion: 2,
          contentId: `dvdmeta-sha256:${digest}`,
          titles: [],
        },
        fingerprint: `dvdmeta-sha256:${digest}`,
        originalsLibraryPath,
        revalidateReadFailure: async () => undefined,
        runner: {
          copy: vi.fn(async ({ outputPath }) => {
            writeFileSync(outputPath, retainedPrefix);
            throw new DvdReadFailureError(boundaryFailure);
          }),
          isActive: () => false,
          withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
          waitForInactive: vi.fn(async () => undefined),
        },
        signal: new AbortController().signal,
        sizeBytes: reportedSizeBytes,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      })).rejects.toThrow(
        throwAfterMutation
          ? "boundary promotion authorization rejected"
          : "DVD rescue image changed during boundary acceptance",
      );

      expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
      expect(existsSync(rescuePaths.imagePath)).toBe(false);
      expect(existsSync(rescuePaths.mapPath)).toBe(false);
      expect(existsSync(`${rescuePaths.mapPath}.retaining`)).toBe(false);

      const freshImage = Buffer.alloc(reportedSizeBytes, 97);
      const freshCopy = vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, freshImage);
        return createCleanDvdRecoveryResult(reportedSizeBytes);
      });
      const restarted = await preserveDvdArchive({
        archiveRequestId,
        authorizeMutation: () => undefined,
        completenessProver: {
          async prove() {
            return { maximumReferencedLba: firstExcludedLba - 1 };
          },
        },
        devicePath: "/dev/sr0",
        expectedTitleMap: {
          schemaVersion: 2,
          contentId: `dvdmeta-sha256:${digest}`,
          titles: [],
        },
        fingerprint: `dvdmeta-sha256:${digest}`,
        originalsLibraryPath,
        runner: {
          copy: freshCopy,
          isActive: () => false,
          withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
          waitForInactive: vi.fn(async () => undefined),
        },
        signal: new AbortController().signal,
        sizeBytes: reportedSizeBytes,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      });

      expect(freshCopy).toHaveBeenCalledOnce();
      expect(restarted.correctedBoundaryEvidence).toBeUndefined();
      expect(readFileSync(restarted.archivePath)).toEqual(freshImage);
    },
  );

  it("does not quarantine a destination substituted during proof-map update", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "4".repeat(64);
    const archiveRequestId = "concurrent-corrected-destination";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 61);
    const concurrentArchive = Buffer.alloc(reportedSizeBytes, 67);
    const archivePath = join(root, `dvdmeta-${digest}.iso`);
    let substituted = false;

    await expect(preserveDvdArchive({
      archiveRequestId,
      authorizeMutation: () => {
        if (existsSync(archivePath) && !substituted) {
          unlinkSync(archivePath);
          writeFileSync(archivePath, concurrentArchive);
          substituted = true;
        }
      },
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, retainedPrefix);
          throw new DvdReadFailureError(
            createProvenBoundaryFailure(
              reportedSizeBytes,
              firstExcludedLba,
            ),
          );
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toThrow("Published DVD archive changed before cleanup");

    expect(substituted).toBe(true);
    expect(readFileSync(archivePath)).toEqual(concurrentArchive);
    expect(existsSync(`${archivePath}.failed`)).toBe(false);
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("quarantines a crashed correction when restart is cancelled", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "5".repeat(64);
    const archiveRequestId = "cancelled-restarted-correction";
    const reportedSizeBytes = 8 * 2_048;
    const firstExcludedLba = 6;
    const retainedPrefix = Buffer.alloc(firstExcludedLba * 2_048, 83);
    const boundaryFailure = createProvenBoundaryFailure(
      reportedSizeBytes,
      firstExcludedLba,
    );
    const baseOptions = {
      archiveRequestId,
      authorizeMutation: () => undefined,
      completenessProver: {
        async prove() {
          return { maximumReferencedLba: firstExcludedLba - 1 };
        },
      },
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2 as const,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      signal: new AbortController().signal,
      sizeBytes: reportedSizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const first = await preserveDvdArchive({
      ...baseOptions,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, retainedPrefix);
          throw new DvdReadFailureError(boundaryFailure);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
    });
    const cancellation = new Error("Archive Request cancellation requested");

    await expect(preserveDvdArchive({
      ...baseOptions,
      authorizeCopy: () => {
        throw cancellation;
      },
      runner: {
        copy: vi.fn(),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
    })).rejects.toBe(cancellation);

    expect(existsSync(first.archivePath)).toBe(false);
    expect(readFileSync(`${first.archivePath}.failed`)).toEqual(retainedPrefix);
    const replacementImage = Buffer.alloc(reportedSizeBytes, 89);
    const replacement = await preserveDvdArchive({
      ...baseOptions,
      archiveRequestId: "replacement-after-cancelled-correction",
      completenessProver: undefined,
      revalidateReadFailure: undefined,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, replacementImage);
          return createCleanDvdRecoveryResult(reportedSizeBytes);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
    });

    expect(readFileSync(replacement.archivePath)).toEqual(replacementImage);
  });

  it("does not expose boundary rescue state before the final source fence", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "a".repeat(64);
    const archiveRequestId = "unfenced-boundary-prefix-request";
    const sizeBytes = 4 * 2_048;
    const mediaChanged = new Error("DVD medium changed during retention");
    const revalidateReadFailure = vi.fn(async () => {
      if (revalidateReadFailure.mock.calls.length === 3) {
        throw mediaChanged;
      }
    });
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, Buffer.alloc(2 * 2_048, 31));
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure,
      runner,
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toBe(mediaChanged);

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(`${rescuePaths.mapPath}.retaining`)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("quarantines an interrupted boundary retention transaction before resume", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "b".repeat(64);
    const archiveRequestId = "interrupted-boundary-retention-request";
    const sizeBytes = 4 * 2_048;
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const retentionMapPath = `${rescuePaths.mapPath}.retaining`;
    writeFileSync(rescuePaths.imagePath, Buffer.alloc(2 * 2_048, 43));
    writeFileSync(retentionMapPath, "staged but not source-fenced\n");
    const copy = vi.fn();

    await expect(preserveDvdArchive({
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner: {
        copy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toThrow("DVD rescue state is invalid");

    expect(copy).not.toHaveBeenCalled();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(retentionMapPath)).toBe(false);
    expect(
      readdirSync(root).filter((name) => name.includes(".invalid-")),
    ).toHaveLength(2);
  });

  it("keeps the prior rescue map when a resumed boundary fails its final source fence", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "c".repeat(64);
    const archiveRequestId = "unfenced-boundary-resume-request";
    const sizeBytes = 4 * 2_048;
    const firstPrefix = Buffer.alloc(2 * 2_048, 47);
    const extendedPrefix = Buffer.concat([firstPrefix, Buffer.alloc(2_048, 53)]);
    const options = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    });

    await expect(preserveDvdArchive({
      ...options,
      revalidateReadFailure: async () => undefined,
      runner: runner(vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, firstPrefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      })),
    })).rejects.toMatchObject({
      readFailure: expect.objectContaining({ category: "out_of_range" }),
    });

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const priorMap = readFileSync(rescuePaths.mapPath, "utf8");
    const mediaChanged = new Error("DVD medium changed during resumed retention");
    const revalidateReadFailure = vi.fn(async () => {
      if (revalidateReadFailure.mock.calls.length === 3) {
        throw mediaChanged;
      }
    });
    await expect(preserveDvdArchive({
      ...options,
      revalidateReadFailure,
      runner: runner(vi.fn(async ({ continuation, outputPath }) => {
        expect(continuation).toMatchObject({
          kind: "boundary",
          imageByteCount: firstPrefix.byteLength,
        });
        writeFileSync(outputPath, extendedPrefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 3,
          requestedBlockCount: 2,
          requestedLba: 2,
        });
      })),
    })).rejects.toBe(mediaChanged);

    expect(readFileSync(rescuePaths.mapPath, "utf8")).toBe(priorMap);
    expect(readFileSync(rescuePaths.imagePath)).toEqual(extendedPrefix);
    expect(existsSync(`${rescuePaths.mapPath}.retaining`)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("does not expose rescue state when boundary-prefix sync fails", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "d".repeat(64);
    const archiveRequestId = "failed-boundary-prefix-retention";
    const sizeBytes = 4 * 2_048;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, Buffer.alloc(2 * 2_048, 13));
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    const failure = await preserveDvdArchive({
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner,
      signal: new AbortController().signal,
      sizeBytes,
      sync: async () => {
        throw new Error("boundary prefix sync failed");
      },
      verifySource: async () => undefined,
      onProgress: () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DvdArchiveReadFailureError);
    expect(failure).toMatchObject({
      stage: "initial_copy",
      readFailure: expect.objectContaining({
        category: "out_of_range",
        firstFailingLba: 2,
      }),
      retentionError: expect.objectContaining({
        message: "boundary prefix sync failed",
      }),
    });

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("rejects a boundary prefix that does not match the retained length", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "7".repeat(64);
    const archiveRequestId = "mismatched-boundary-prefix-length";
    const sizeBytes = 4 * 2_048;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, Buffer.alloc(2 * 2_048, 13));
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
          retainedImageByteCount: 2_048,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    const failure = await preserveDvdArchive({
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner,
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DvdArchiveReadFailureError);
    expect(failure).toMatchObject({
      readFailure: expect.objectContaining({ category: "out_of_range" }),
      retentionError: expect.objectContaining({
        message: "DVD rescue boundary state could not be committed",
      }),
    });
    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("keeps structured boundary evidence when retention cleanup also fails", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "e".repeat(64);
    const archiveRequestId = "failed-boundary-retention-cleanup";
    const sizeBytes = 4 * 2_048;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, Buffer.alloc(2 * 2_048, 13));
        mkdirSync(`${outputPath}.failed`);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    const failure = await preserveDvdArchive({
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      runner,
      signal: new AbortController().signal,
      sizeBytes,
      sync: async () => {
        throw new Error("boundary prefix sync failed");
      },
      verifySource: async () => undefined,
      onProgress: () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DvdArchiveReadFailureError);
    expect(failure).toMatchObject({
      stage: "initial_copy",
      readFailure: expect.objectContaining({
        category: "out_of_range",
        firstFailingLba: 2,
      }),
      retentionError: expect.any(AggregateError),
    });
    expect(
      (failure as DvdArchiveReadFailureError).retentionError,
    ).toMatchObject({
      errors: [
        expect.objectContaining({ message: "boundary prefix sync failed" }),
        expect.objectContaining({
          message: "DVD archive failed path is not a regular file",
        }),
      ],
    });

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("continues from the retained boundary across another boundary failure", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "6".repeat(64);
    const sizeBytes = 4 * 2_048;
    const archiveRequestId = "continued-boundary-prefix-request";
    const firstPrefix = Buffer.alloc(2 * 2_048, 19);
    const secondPrefix = Buffer.concat([firstPrefix, Buffer.alloc(2_048, 29)]);
    const completeImage = Buffer.concat([secondPrefix, Buffer.alloc(2_048, 37)]);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure: async () => undefined,
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    const runner = (copy: DvdCopyRunner["copy"]): DvdCopyRunner => ({
      copy,
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    });

    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, firstPrefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 2,
        });
      })),
    })).rejects.toMatchObject({
      stage: "initial_copy",
      readFailure: expect.objectContaining({ firstFailingLba: 2 }),
    });

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({ continuation, outputPath }) => {
        expect(outputPath).toBe(rescuePaths.imagePath);
        expect(continuation).toMatchObject({
          kind: "boundary",
          imageByteCount: 2 * 2_048,
        });
        writeFileSync(outputPath, secondPrefix);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 3,
          requestedBlockCount: 2,
          requestedLba: 2,
        });
      })),
    })).rejects.toMatchObject({
      stage: "rescue_resume",
      readFailure: expect.objectContaining({ firstFailingLba: 3 }),
    });
    expect(JSON.parse(readFileSync(rescuePaths.mapPath, "utf8"))).toMatchObject({
      imageByteCount: 3 * 2_048,
      recoveryProtocol: null,
      boundaryFailureProtocol: expect.objectContaining({ firstFailingLba: 3 }),
    });

    const completed = await preserveDvdArchive({
      ...baseOptions,
      runner: runner(vi.fn(async ({
        continuation,
        outputPath,
        sizeBytes: expectedSize,
      }) => {
        expect(outputPath).toBe(rescuePaths.imagePath);
        expect(continuation).toMatchObject({
          kind: "boundary",
          imageByteCount: 3 * 2_048,
        });
        expect(readFileSync(outputPath)).toEqual(secondPrefix);
        writeFileSync(outputPath, completeImage);
        return createCleanDvdRecoveryResult(expectedSize);
      })),
    });

    expect(readFileSync(completed.archivePath)).toEqual(completeImage);
    expect(completed.integrityEvidence.integrity).toBe("clean_read");
    await completed.finalizePublication?.();
    expect(existsSync(rescuePaths.imagePath)).toBe(false);
    expect(existsSync(rescuePaths.mapPath)).toBe(false);
  });

  it("retains prior bad-sector evidence when rescue resume reaches out of range", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "5".repeat(64);
    const sizeBytes = 4 * 2_048;
    const archiveRequestId = "out-of-range-resume-request";
    const damaged = createDamagedDvdRecoveryResult(sizeBytes, [
      { startLba: 1, sectorCount: 1 },
      { startLba: 3, sectorCount: 1 },
    ]);
    const damagedImage = Buffer.alloc(sizeBytes, 23);
    damagedImage.fill(0, 1 * 2_048, 2 * 2_048);
    damagedImage.fill(0, 3 * 2_048, 4 * 2_048);
    const baseOptions = {
      archiveRequestId,
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2 as const,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      signal: new AbortController().signal,
      sizeBytes,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };
    await expect(preserveDvdArchive({
      ...baseOptions,
      runner: {
        copy: vi.fn(async ({ outputPath }) => {
          writeFileSync(outputPath, damagedImage);
          return damaged;
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          outcome: "rejected",
          reason: "referenced_content",
        }),
      },
    })).rejects.toThrow("DVD salvage rejected");

    const rescuePaths = dvdRescueWorkspacePaths(root, archiveRequestId);
    const priorMap = JSON.parse(readFileSync(rescuePaths.mapPath, "utf8"));
    const recoveredBeforeBoundary = Buffer.from(damagedImage);
    recoveredBeforeBoundary.fill(41, 1 * 2_048, 2 * 2_048);
    const revalidateReadFailure = vi.fn(async () => undefined);
    const salvageValidator = { validate: vi.fn() };
    const resumeRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ continuation, outputPath }) => {
        expect(continuation).toMatchObject({
          kind: "damaged",
          recoveryResult: damaged,
        });
        writeFileSync(outputPath, recoveredBeforeBoundary);
        throw createOutOfRangeDvdReadFailure({
          declaredByteCount: sizeBytes,
          firstFailingLba: 3,
          requestedBlockCount: 1,
          requestedLba: 3,
          retainedImageByteCount: sizeBytes,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      ...baseOptions,
      revalidateReadFailure,
      runner: resumeRunner,
      salvageValidator,
    })).rejects.toMatchObject({
      readFailure: expect.objectContaining({ category: "out_of_range" }),
      stage: "rescue_resume",
    });

    const retainedMap = JSON.parse(readFileSync(rescuePaths.mapPath, "utf8"));
    expect(retainedMap).toMatchObject({
      schemaVersion: 2,
      imageByteCount: sizeBytes,
      recoveryProtocol: priorMap.recoveryProtocol,
      boundaryFailureProtocol: expect.objectContaining({
        category: "out_of_range",
        firstFailingLba: 3,
      }),
    });
    expect(readFileSync(rescuePaths.imagePath)).toEqual(recoveredBeforeBoundary);
    expect(revalidateReadFailure).toHaveBeenCalledTimes(3);
    expect(salvageValidator.validate).not.toHaveBeenCalled();
    expect(existsSync(join(root, `dvdmeta-${digest}.iso`))).toBe(false);
  });

  it("revalidates a structured read failure before moving its partial image", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const digest = "3".repeat(64);
    const authorityLost = new Error("Archive Job authority expired");
    let copiedPartialPath: string | undefined;
    const revalidateReadFailure = vi.fn(() => {
      throw authorityLost;
    });
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        copiedPartialPath = outputPath;
        writeFileSync(outputPath, "uncommitted read failure");
        throw new DvdReadFailureError({
          protocolVersion: 1,
          classifierVersion: "scsi-read-classifier-v2",
          category: "unknown",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x70,
          senseKey: 5,
          asc: 32,
          ascq: 0,
          informationLba: 1,
          requestedLba: 0,
          requestedBlockCount: 4,
          retryOrdinal: 2,
        });
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      fingerprint: `sha256:${digest}`,
      originalsLibraryPath,
      revalidateReadFailure,
      runner,
      signal: new AbortController().signal,
      sizeBytes: 4 * 2_048,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    })).rejects.toBe(authorityLost);

    expect(revalidateReadFailure).toHaveBeenCalledOnce();
    expect(readFileSync(copiedPartialPath!, "utf8")).toBe(
      "uncommitted read failure",
    );
    expect(existsSync(`${copiedPartialPath}.failed`)).toBe(false);
  });

  it.runIf(supportsLinuxWriterOwnership)(
    "does not quarantine or retry a partial while its reader is active",
    async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const content = Buffer.from("dvd-image");
    const digest =
      "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    let partialPath: string | undefined;
    let active = false;
    let copyAttempts = 0;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          active = true;
          partialPath = outputPath;
          writeFileSync(outputPath, "live partial");
          throw new Error("DVD archive copy timed out");
        }
        writeFileSync(outputPath, content);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: vi.fn(() => active),
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const options = {
      devicePath: "/dev/sr0",
      fingerprint: `sha256:${digest}`,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
    };

    await expect(preserveDvdArchive(options)).rejects.toThrow(
      "DVD archive copy timed out",
    );
    expect(readFileSync(partialPath!, "utf8")).toBe("live partial");
    expect(existsSync(`${partialPath}.failed`)).toBe(false);

    await expect(preserveDvdArchive(options)).rejects.toThrow(
      "DVD archive copy is still active",
    );
    expect(runner.copy).toHaveBeenCalledOnce();
    expect(readFileSync(partialPath!, "utf8")).toBe("live partial");

    active = false;
    await expect(preserveDvdArchive(options)).resolves.toMatchObject({
      recovered: false,
    });
    expect(runner.copy).toHaveBeenCalledTimes(2);
    expect(existsSync(partialPath!)).toBe(false);
    expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe("live partial");
    },
  );

  it.runIf(supportsLinuxWriterOwnership)(
    "quarantines a stale partial image before retrying the copy",
    async () => {
      const originalsLibraryPath = createOriginalsLibrary();
      const root = realpathSync(originalsLibraryPath);
      const digest =
        "231552f40a93fbd25f6328825ddb49288b8076f1d42809b0852eaff66d9a4118";
      const partialPath = join(root, `.${digest}.iso.rip-dvd-partial`);
      writeFileSync(partialPath, "stale");
      const content = Buffer.from("fresh");
      const runner: DvdCopyRunner = {
        copy: vi.fn(async ({ outputPath, sizeBytes }) => {
          expect(existsSync(outputPath)).toBe(false);
          expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe("stale");
          writeFileSync(outputPath, content);
          return createCleanDvdRecoveryResult(sizeBytes);
        }),
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      };

      const result = await preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: content.byteLength,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      });

      expect(readFileSync(result.archivePath)).toEqual(content);
      expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe("stale");
    },
  );

  it("rejects a runner-created symbolic-link partial without publishing it", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "d".repeat(64);
    const outsidePath = join(root, "outside");
    writeFileSync(outsidePath, "outside");
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        symlinkSync(outsidePath, outputPath);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: 7,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("partial path is not a regular file");

    expect(readFileSync(outsidePath, "utf8")).toBe("outside");
    expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
  });

  it("recovers a complete-size final image without allowing the runner to overwrite it", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "e2cddf0cd7207e4492e0e3e66befe4b818247051391a48871d2d9a07eaa9524b";
    const archivePath = join(root, `${digest}.iso`);
    writeFileSync(archivePath, "complete");
    const runner: DvdCopyRunner = {
      copy: vi.fn(),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const sync = vi.fn(async (_path: string) => undefined);

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: 8,
        verifySource: async () => undefined,
        onProgress: () => undefined,
        sync,
      }),
    ).resolves.toEqual({
      archivePath,
      archiveFilesystemIdentity: expect.stringMatching(/^\d+:[1-9]\d*$/),
      integrityEvidence: {
        integrity: "unknown",
        policyVersion: null,
        badSectorCount: null,
        badAreaCount: null,
        badSectorRanges: null,
      },
      recovered: true,
      sizeBytes: 8,
    });
    expect(runner.copy).not.toHaveBeenCalled();
    expect(sync.mock.calls).toEqual([[archivePath], [root]]);
    expect(readFileSync(archivePath, "utf8")).toBe("complete");
  });

  it("does not overwrite an archive published concurrently with the copy", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest =
      "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const archivePath = join(root, `${digest}.iso`);
    const content = Buffer.from("dvd-image");
    let copiedPartialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        copiedPartialPath = outputPath;
        writeFileSync(outputPath, content);
        writeFileSync(archivePath, "other publisher");
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: content.byteLength,
        verifySource: async () => undefined,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(readFileSync(archivePath, "utf8")).toBe("other publisher");
    expect(readFileSync(`${copiedPartialPath}.failed`)).toEqual(content);
  });

  it("quarantines a published image when durable directory publication fails", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const content = Buffer.from("dvd-image");
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        writeFileSync(outputPath, content);
        return createCleanDvdRecoveryResult(sizeBytes);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const sync = vi
      .fn<(_path: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("directory fsync failed"));

    await expect(
      preserveDvdArchive({
        devicePath: "/dev/sr0",
        fingerprint: `sha256:${digest}`,
        originalsLibraryPath,
        runner,
        signal: new AbortController().signal,
        sizeBytes: content.byteLength,
        verifySource: async () => undefined,
        onProgress: () => undefined,
        sync,
      }),
    ).rejects.toThrow("directory fsync failed");

    const archivePath = join(root, `${digest}.iso`);
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(`${archivePath}.failed`)).toEqual(content);
  });

  it("quarantines an accepted salvage when durable publication fails", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "4".repeat(64);
    const content = Buffer.alloc(6 * 2_048, 0);
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, sizeBytes }) => {
        writeFileSync(outputPath, content);
        return createDamagedDvdRecoveryResult(sizeBytes, [
          { startLba: 1, sectorCount: 1 },
          { startLba: 3, sectorCount: 1 },
        ]);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const sync = vi
      .fn<(_path: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("salvage directory fsync failed"));

    await expect(preserveDvdArchive({
      devicePath: "/dev/sr0",
      expectedTitleMap: {
        schemaVersion: 2,
        contentId: `dvdmeta-sha256:${digest}`,
        titles: [{
          number: 1,
          durationSeconds: 3_600,
          chapters: 10,
          audioStreams: [],
          subtitles: [],
        }],
      },
      fingerprint: `dvdmeta-sha256:${digest}`,
      originalsLibraryPath,
      runner,
      salvageValidator: {
        validate: vi.fn().mockResolvedValue({
          badSectorCountsByTitle: [{
            badSectorCount: 2,
            titleNumber: 1,
          }],
          outcome: "accepted",
        }),
      },
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource: async () => undefined,
      onProgress: () => undefined,
      sync,
    })).rejects.toThrow("salvage directory fsync failed");

    const archivePath = join(root, `dvdmeta-${digest}.iso`);
    expect(existsSync(archivePath)).toBe(false);
    expect(readFileSync(`${archivePath}.failed`)).toEqual(content);
  });
});
