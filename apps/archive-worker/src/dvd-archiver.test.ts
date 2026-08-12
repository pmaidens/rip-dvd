import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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

const temporaryDirectories: string[] = [];
const orphanedWriterPids: number[] = [];
const supportsLinuxWriterOwnership =
  existsSync("/proc/self/fd") &&
  spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

function createOriginalsLibrary(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-"));
  temporaryDirectories.push(directory);
  return directory;
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
        copy: vi.fn(async ({ outputPath }) => writeFileSync(outputPath, content)),
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
    children[1]!.emit("close", 0, null);
    await expect(retry).resolves.toBeUndefined();
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
      copy: vi.fn(async ({ outputPath, onBytesCopied }) => {
        expect(basename(outputPath)).toMatch(/^\..+\.rip-dvd-partial$/);
        onBytesCopied(4);
        writeFileSync(outputPath, content);
        onBytesCopied(content.byteLength);
      }),
      isActive: () => false,
      withDeviceInactive: vi.fn(async (_path, mutation) => mutation()),
      waitForInactive: vi.fn(async () => undefined),
    };
    const verifySource = vi.fn(async () => undefined);

    const result = await preserveDvdArchive({
      devicePath: "/dev/sr0",
      fingerprint: `sha256:${digest}`,
      originalsLibraryPath,
      runner,
      signal: new AbortController().signal,
      sizeBytes: content.byteLength,
      verifySource,
      onProgress: (value) => progress.push(value),
    });

    expect(result).toEqual({
      archivePath: join(realpathSync(originalsLibraryPath), `${digest}.iso`),
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
      { phase: "verifying", progressPercent: 99 },
      { phase: "finalizing", progressPercent: 99 },
    ]);
    expect(verifySource).toHaveBeenCalledOnce();
  });

  it("moves a failed partial image aside without publishing an archive", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const digest = "b".repeat(64);
    let copiedPartialPath: string | undefined;
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
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
      copy: vi.fn(async ({ outputPath }) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          active = true;
          partialPath = outputPath;
          writeFileSync(outputPath, "live partial");
          throw new Error("DVD archive copy timed out");
        }
        writeFileSync(outputPath, content);
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
        copy: vi.fn(async ({ outputPath }) => {
          expect(existsSync(outputPath)).toBe(false);
          expect(readFileSync(`${partialPath}.failed`, "utf8")).toBe("stale");
          writeFileSync(outputPath, content);
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
      copy: vi.fn(async ({ outputPath }) => {
        symlinkSync(outsidePath, outputPath);
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

  it("recovers a verified final image without allowing the runner to overwrite it", async () => {
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
    ).resolves.toEqual({ archivePath, recovered: true, sizeBytes: 8 });
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
      copy: vi.fn(async ({ outputPath }) => {
        copiedPartialPath = outputPath;
        writeFileSync(outputPath, content);
        writeFileSync(archivePath, "other publisher");
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
      copy: vi.fn(async ({ outputPath }) => writeFileSync(outputPath, content)),
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
});
