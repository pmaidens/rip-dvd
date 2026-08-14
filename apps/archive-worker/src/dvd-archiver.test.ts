import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveJobProgress } from "@rip-dvd/data-access";

import {
  preserveDvdArchive,
  createNodeDvdCopyRunner,
  withCancelledDvdArchiveInactive,
  type DvdCopyRunner,
} from "./dvd-archiver.js";
import {
  createCleanDvdRecoveryResult,
  createDamagedDvdRecoveryResult,
  DVD_RECOVERY_RESULT_PREFIX,
} from "./dvd-recovery-contracts.js";
import { dvdRescueWorkspacePaths } from "./dvd-rescue-workspace.js";

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
}

function createOriginalsLibrary(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-"));
  temporaryDirectories.push(directory);
  return directory;
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
      validate: vi.fn().mockResolvedValue({ outcome: "accepted" }),
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
      resumeFrom: createDamagedDvdRecoveryResult(sizeBytes, [
        { startLba: 1, sectorCount: 1 },
        { startLba: 3, sectorCount: 1 },
      ]),
      resumeImageFilesystemIdentity: "1:2",
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
    const originalsLibraryPath = createOriginalsLibrary();
    const content = Buffer.from("dvd-image");
    const digest = "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const progress: ArchiveJobProgress[] = [];
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied, sizeBytes }) => {
        expect(basename(outputPath)).toMatch(/^\..+\.rip-dvd-partial$/);
        onBytesCopied(4);
        writeFileSync(outputPath, content);
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
      { phase: "copying", progressPercent: 44 },
      { phase: "copying", progressPercent: 99 },
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
      copy: vi.fn(async ({ outputPath, resumeFrom }) => {
        expect(resumeFrom).toEqual(damagedRecovery);
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
      copy: vi.fn(async ({ outputPath, resumeFrom, sizeBytes: expectedSize }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(resumeFrom).toEqual(damagedRecovery);
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

  it("recovers an accepted damaged publication after a worker restart", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const archiveRequestId = "33333333-3333-4333-8333-333333333334";
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
          return { outcome: "accepted" as const };
        }),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("Existing DVD archive conflicts with rescue state");

    expect(existsSync(fixture.interrupted.archivePath)).toBe(false);
    expect(readFileSync(`${fixture.interrupted.archivePath}.failed`)).toEqual(
      fixture.rescuedImage,
    );
  });

  it("quarantines a correlated orphan archive with invalid rescue state", async () => {
    const fixture = await createInterruptedDamagedPublication(
      "33333333-3333-4333-8333-333333333336",
      "e".repeat(64),
    );
    const map = JSON.parse(
      readFileSync(fixture.rescuePaths.mapPath, "utf8"),
    ) as { fingerprint: string };
    map.fingerprint = `dvdmeta-sha256:${"f".repeat(64)}`;
    writeFileSync(fixture.rescuePaths.mapPath, `${JSON.stringify(map)}\n`);
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
        validate: vi.fn().mockResolvedValue({ outcome: "accepted" }),
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("DVD rescue state does not match the Archive Request");

    expect(noCopy).not.toHaveBeenCalled();
    expect(existsSync(fixture.interrupted.archivePath)).toBe(false);
    expect(existsSync(fixture.rescuePaths.imagePath)).toBe(false);
    expect(existsSync(fixture.rescuePaths.mapPath)).toBe(false);
    expect(
      readdirSync(fixture.root).filter((name) => name.includes(".invalid-")),
    ).toHaveLength(3);

    const replacementCopy = vi.fn(async ({ outputPath, sizeBytes }) => {
      writeFileSync(outputPath, Buffer.alloc(sizeBytes, 7));
      return createCleanDvdRecoveryResult(sizeBytes);
    });
    const recovered = await preserveDvdArchive({
      ...fixture.baseOptions,
      runner: {
        copy: replacementCopy,
        isActive: () => false,
        withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
        waitForInactive: vi.fn(async () => undefined),
      },
      signal: new AbortController().signal,
    });

    expect(replacementCopy).toHaveBeenCalledOnce();
    expect(recovered.integrityEvidence.integrity).toBe("clean_read");
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

    const completionRunner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, resumeFrom, sizeBytes: expectedSize }) => {
        expect(outputPath).toBe(rescueImagePath);
        expect(resumeFrom).toEqual(damagedRecovery);
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
