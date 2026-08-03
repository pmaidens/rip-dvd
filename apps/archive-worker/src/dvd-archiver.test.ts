import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preserveDvdArchive,
  createNodeDvdCopyRunner,
  type DvdCopyRunner,
} from "./dvd-archiver.js";

const temporaryDirectories: string[] = [];

function createOriginalsLibrary(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-archive-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("DVD archive publication", () => {
  it("runs bounded GNU dd arguments and streams byte progress", async () => {
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stderr,
      kill: vi.fn(() => true),
    });
    const spawnProcess = vi.fn(() => child);
    const runner = createNodeDvdCopyRunner({ spawnProcess });
    const copied: number[] = [];

    const completion = runner.copy({
      devicePath: "/dev/sr0",
      outputPath: "/media/originals/.disc.iso.rip-dvd-partial",
      sizeBytes: 9,
      signal: new AbortController().signal,
      onBytesCopied: (bytes) => copied.push(bytes),
    });
    stderr.emit("data", Buffer.from("4 bytes copied, 1 s\r9 bytes copied, 2 s\n"));
    child.emit("close", 0, null);
    await completion;

    expect(spawnProcess).toHaveBeenCalledWith(
      "dd",
      [
        "if=/dev/sr0",
        "of=/media/originals/.disc.iso.rip-dvd-partial",
        "bs=4M",
        "iflag=fullblock,count_bytes",
        "count=9",
        "oflag=excl,nofollow",
        "conv=fsync",
        "status=progress",
      ],
      { shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    expect(copied).toEqual([4, 9]);
  });

  it("waits for a timed-out dd child to close before rejecting", async () => {
    vi.useFakeTimers();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stderr,
      kill: vi.fn(() => true),
    });
    const runner = createNodeDvdCopyRunner({
      spawnProcess: vi.fn(() => child),
      timeoutMs: 10,
    });
    let settled = false;
    const completion = runner
      .copy({
        devicePath: "/dev/sr0",
        outputPath: "/media/originals/.disc.iso.rip-dvd-partial",
        sizeBytes: 9,
        signal: new AbortController().signal,
        onBytesCopied: () => undefined,
      })
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(completion).rejects.toThrow("DVD archive copy timed out");
  });

  it("contains progress callback failures and waits for dd to close", async () => {
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stderr,
      kill: vi.fn(() => true),
    });
    const runner = createNodeDvdCopyRunner({
      spawnProcess: vi.fn(() => child),
    });
    let settled = false;
    const completion = runner
      .copy({
        devicePath: "/dev/sr0",
        outputPath: "/media/originals/.disc.iso.rip-dvd-partial",
        sizeBytes: 9,
        signal: new AbortController().signal,
        onBytesCopied: () => {
          throw new Error("progress persistence failed");
        },
      })
      .finally(() => {
        settled = true;
      });

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
    const progress: number[] = [];
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath, onBytesCopied }) => {
        expect(basename(outputPath)).toMatch(/^\..+\.rip-dvd-partial$/);
        onBytesCopied(4);
        writeFileSync(outputPath, content);
        onBytesCopied(content.byteLength);
      }),
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
    expect(progress).toEqual([44, 99]);
    expect(verifySource).toHaveBeenCalledOnce();
  });

  it("moves a failed partial image aside without publishing an archive", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const digest = "b".repeat(64);
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, "partial evidence");
        throw new Error("dd read failed");
      }),
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
    ).rejects.toThrow("dd read failed");

    const root = realpathSync(originalsLibraryPath);
    expect(existsSync(join(root, `${digest}.iso`))).toBe(false);
    expect(existsSync(join(root, `.${digest}.iso.rip-dvd-partial`))).toBe(false);
    expect(
      readFileSync(join(root, `.${digest}.iso.rip-dvd-partial.failed`), "utf8"),
    ).toBe("partial evidence");
  });

  it("quarantines a stale partial image before retrying the copy", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "231552f40a93fbd25f6328825ddb49288b8076f1d42809b0852eaff66d9a4118";
    const partialPath = join(root, `.${digest}.iso.rip-dvd-partial`);
    writeFileSync(partialPath, "stale");
    const content = Buffer.from("fresh");
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        expect(existsSync(outputPath)).toBe(false);
        expect(readFileSync(`${outputPath}.failed`, "utf8")).toBe("stale");
        writeFileSync(outputPath, content);
      }),
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
  });

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
    const runner: DvdCopyRunner = { copy: vi.fn() };

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
      }),
    ).resolves.toEqual({ archivePath, recovered: true, sizeBytes: 8 });
    expect(runner.copy).not.toHaveBeenCalled();
    expect(readFileSync(archivePath, "utf8")).toBe("complete");
  });

  it("does not overwrite an archive published concurrently with the copy", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest =
      "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const archivePath = join(root, `${digest}.iso`);
    const content = Buffer.from("dvd-image");
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => {
        writeFileSync(outputPath, content);
        writeFileSync(archivePath, "other publisher");
      }),
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
    expect(
      readFileSync(
        join(root, `.${digest}.iso.rip-dvd-partial.failed`),
      ),
    ).toEqual(content);
  });

  it("quarantines a published image when durable directory publication fails", async () => {
    const originalsLibraryPath = createOriginalsLibrary();
    const root = realpathSync(originalsLibraryPath);
    const digest = "e5cbeaa2965a33da9559ec142f30f4046ff91d1788a8d2f6ba22490b095f1c61";
    const content = Buffer.from("dvd-image");
    const runner: DvdCopyRunner = {
      copy: vi.fn(async ({ outputPath }) => writeFileSync(outputPath, content)),
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
