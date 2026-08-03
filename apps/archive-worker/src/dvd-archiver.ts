import { createHash, randomUUID } from "node:crypto";
import {
  type Stats,
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isDvdContentId } from "@rip-dvd/data-access/dvd-scan";

import { requireDvdContentSize } from "./dvd-content-policy.js";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";
import { optionalBoundedText } from "./bounded-text.js";
import {
  createBoundedSingleFlightCoordinator,
  type ActiveBoundedProcess,
} from "./bounded-child-process.js";

const MAX_ARCHIVE_PATH_BYTES = 4_096;
const MAX_DD_DIAGNOSTIC_BYTES = 65_536;
const MAX_PROC_ENTRIES = 4_096;
const MAX_PROC_FILE_DESCRIPTORS = 65_536;
const DD_TIMEOUT_MS = 12 * 60 * 60_000;
const FLOCK_CONFLICT_EXIT_CODE = 75;

export interface DvdCopyRequest {
  devicePath: string;
  outputPath: string;
  sizeBytes: number;
  signal: AbortSignal;
  onBytesCopied(bytes: number): void;
}

export interface DvdCopyRunner {
  copy(request: DvdCopyRequest): Promise<void>;
  isActive(devicePath: string, outputPath: string): boolean;
}

interface DvdCopyChildProcess {
  pid?: number;
  stderr: {
    destroy(): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
  };
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

type SpawnDvdCopyProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "pipe", number];
  },
) => DvdCopyChildProcess;

function openDeviceLock(devicePath: string): number {
  const descriptor = openSync(
    devicePath,
    fsConstants.O_RDONLY |
      fsConstants.O_NONBLOCK |
      fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(devicePath);
    if (
      (!opened.isBlockDevice() && !opened.isCharacterDevice()) ||
      (!linked.isBlockDevice() && !linked.isCharacterDevice()) ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error("DVD archive device lock is unsafe");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function createNodeDvdCopyRunner({
  spawnProcess = spawn as SpawnDvdCopyProcess,
  timeoutMs = DD_TIMEOUT_MS,
}: {
  spawnProcess?: SpawnDvdCopyProcess;
  timeoutMs?: number;
} = {}): DvdCopyRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DVD archive copy timeout is invalid");
  }
  const copyKey = (devicePath: string, outputPath: string) =>
    JSON.stringify([devicePath, outputPath]);
  const coordinator = createBoundedSingleFlightCoordinator<
    DvdCopyRequest,
    void
  >({
    exhaustedCapacityError: "A DVD archive copy is already active",
    invalidCapacityError: "DVD archive copy capacity is invalid",
    maxActiveProcesses: 1,
    validateReuse() {
      throw new Error("DVD archive copy is still active");
    },
    start(request): ActiveBoundedProcess<void> {
      const lockDescriptor = openDeviceLock(request.devicePath);
      let child: DvdCopyChildProcess;
      try {
        child = spawnProcess(
          "flock",
          [
            "--exclusive",
            "--nonblock",
            "--no-fork",
            "--conflict-exit-code",
            String(FLOCK_CONFLICT_EXIT_CODE),
            "/proc/self/fd/3",
            "dd",
            `if=${requireSafeOpticalDevicePath(request.devicePath)}`,
            `of=${request.outputPath}`,
            "bs=4M",
            "iflag=fullblock,count_bytes",
            `count=${requireDvdContentSize(request.sizeBytes)}`,
            "oflag=nofollow",
            "conv=excl,fsync",
            "status=progress",
          ],
          {
            shell: false,
            stdio: ["ignore", "ignore", "pipe", lockDescriptor],
          },
        );
      } finally {
        closeSync(lockDescriptor);
      }
      let operationSettled = false;
      let processClosed = false;
      let cancellationRequested = false;
      let progressBuffer = "";
      let diagnostics = "";
      let resolveResult!: () => void;
      let rejectResult!: (reason: unknown) => void;
      let resolveClosed!: () => void;
      const result = new Promise<void>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const rejectOperation = (error: unknown) => {
        if (!operationSettled) {
          operationSettled = true;
          rejectResult(error);
        }
      };
      const resolveOperation = () => {
        if (!operationSettled) {
          operationSettled = true;
          resolveResult();
        }
      };
      const confirmClosed = () => {
        if (!processClosed) {
          processClosed = true;
          resolveClosed();
        }
      };
      const cancel = () => {
        if (cancellationRequested || processClosed) {
          return;
        }
        cancellationRequested = true;
        child.stderr.destroy();
        try {
          child.kill("SIGKILL");
        } finally {
          // A device read can remain blocked in the kernel after SIGKILL. It
          // must not retain parent event-loop handles while its tombstone
          // continues to protect the live output path.
          child.unref();
        }
      };
      const parseProgress = (text: string, flush = false) => {
        progressBuffer += text;
        if (progressBuffer.length > MAX_DD_DIAGNOSTIC_BYTES) {
          progressBuffer = progressBuffer.slice(-MAX_DD_DIAGNOSTIC_BYTES);
        }
        const segments = progressBuffer.split(/[\r\n]/);
        progressBuffer = flush ? "" : (segments.pop() ?? "");
        for (const segment of segments) {
          const match = /^\s*(\d+)\s+bytes\b/.exec(segment);
          const bytes = match ? Number(match[1]) : Number.NaN;
          if (Number.isSafeInteger(bytes) && bytes >= 0) {
            request.onBytesCopied(bytes);
          }
        }
      };

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        diagnostics = `${diagnostics}${text}`.slice(-MAX_DD_DIAGNOSTIC_BYTES);
        if (operationSettled || cancellationRequested) {
          return;
        }
        try {
          parseProgress(text);
        } catch (error) {
          rejectOperation(error);
          cancel();
        }
      });
      child.once("error", (error) => {
        rejectOperation(error);
        // A spawn failure proves that there is no child left to reap. Other
        // process errors retain the tombstone until `close` is observed.
        if (child.pid === undefined) {
          confirmClosed();
        }
      });
      child.once("close", (code, signal) => {
        confirmClosed();
        if (cancellationRequested) {
          rejectOperation(new Error("DVD archive copy was cancelled"));
          return;
        }
        if (code === FLOCK_CONFLICT_EXIT_CODE) {
          rejectOperation(new Error("DVD archive device is still active"));
          return;
        }
        try {
          parseProgress("", true);
        } catch (error) {
          rejectOperation(error);
          return;
        }
        if (code === 0) {
          resolveOperation();
          return;
        }
        const detail = optionalBoundedText(diagnostics, 500);
        rejectOperation(
          new Error(
            `DVD archive copy failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${code}`}`}`,
          ),
        );
      });

      return { result, closed, cancel };
    },
  });

  return {
    copy(request) {
      const safeDevicePath = requireSafeOpticalDevicePath(request.devicePath);
      requireDeviceInactive(safeDevicePath);
      return coordinator.run(copyKey(safeDevicePath, request.outputPath), request, {
        signal: request.signal,
        timeoutError: "DVD archive copy timed out",
        timeoutMs,
      });
    },
    isActive(devicePath, outputPath) {
      return coordinator.isActive(
        copyKey(requireSafeOpticalDevicePath(devicePath), outputPath),
      );
    },
  };
}

function isVanishedProcEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function requireSameOwnerInodeInactive(
  target: Stats,
  ownerUid: number,
  activeError: string,
  ambiguousError: string,
): void {
  let processDirectory;
  try {
    processDirectory = opendirSync("/proc");
  } catch {
    throw new Error(ambiguousError);
  }

  let processCount = 0;
  let descriptorCount = 0;
  try {
    let processEntry;
    while ((processEntry = processDirectory.readSync()) !== null) {
      if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) {
        continue;
      }
      processCount += 1;
      if (processCount > MAX_PROC_ENTRIES) {
        throw new Error(ambiguousError);
      }
      let processMetadata;
      try {
        processMetadata = statSync(`/proc/${processEntry.name}`);
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        throw new Error(ambiguousError);
      }
      if (processMetadata.uid !== ownerUid) {
        continue;
      }
      let descriptorDirectory;
      try {
        descriptorDirectory = opendirSync(`/proc/${processEntry.name}/fd`);
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        throw new Error(ambiguousError);
      }
      try {
        let descriptorEntry;
        while ((descriptorEntry = descriptorDirectory.readSync()) !== null) {
          descriptorCount += 1;
          if (descriptorCount > MAX_PROC_FILE_DESCRIPTORS) {
            throw new Error(ambiguousError);
          }
          try {
            const opened = statSync(
              `/proc/${processEntry.name}/fd/${descriptorEntry.name}`,
            );
            if (opened.dev === target.dev && opened.ino === target.ino) {
              throw new Error(activeError);
            }
          } catch (error) {
            if (isVanishedProcEntry(error)) {
              continue;
            }
            if (
              error instanceof Error &&
              error.message === activeError
            ) {
              throw error;
            }
            throw new Error(ambiguousError);
          }
        }
      } finally {
        descriptorDirectory.closeSync();
      }
    }
  } finally {
    processDirectory.closeSync();
  }
}

function requireDeviceInactive(devicePath: string): void {
  const device = lstatSync(devicePath);
  if (
    device.isSymbolicLink() ||
    (!device.isBlockDevice() && !device.isCharacterDevice()) ||
    process.geteuid === undefined
  ) {
    throw new Error("DVD archive device path is unsafe");
  }
  requireSameOwnerInodeInactive(
    device,
    process.geteuid(),
    "DVD archive device is still active",
    "Could not prove the DVD archive device is inactive",
  );
}

function requireLegacyPartialInactive(partialPath: string): void {
  let partial;
  try {
    partial = lstatSync(partialPath);
  } catch (error) {
    if (isVanishedProcEntry(error)) {
      return;
    }
    throw error;
  }
  if (!partial.isFile() || partial.isSymbolicLink()) {
    throw new Error("Legacy DVD archive partial path is unsafe");
  }
  requireSameOwnerInodeInactive(
    partial,
    partial.uid,
    "DVD archive copy is still active",
    "Could not prove the legacy DVD archive partial is inactive",
  );
}

export const nodeDvdCopyRunner = createNodeDvdCopyRunner();

export interface PreserveDvdArchiveOptions {
  devicePath: string;
  fingerprint: string;
  originalsLibraryPath: string;
  runner: DvdCopyRunner;
  signal: AbortSignal;
  sizeBytes: number;
  sync?(path: string): Promise<void>;
  verifySource(): Promise<void>;
  onProgress(progressPercent: number): void;
}

export interface PreservedDvdArchive {
  archivePath: string;
  recovered: boolean;
  sizeBytes: number;
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function movePartialAside(partialPath: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(partialPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("DVD archive partial path is not a regular file");
  }
  const failedPath = `${partialPath}.failed`;
  try {
    const failedMetadata = await lstat(failedPath);
    if (!failedMetadata.isFile() || failedMetadata.isSymbolicLink()) {
      throw new Error("DVD archive failed path is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await rename(partialPath, failedPath);
}

export async function quarantinePublishedArchive(
  archivePath: string,
): Promise<void> {
  const metadata = await optionalMetadata(archivePath);
  if (metadata === null) {
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Published DVD archive path is not a regular file");
  }
  const failedPath = `${archivePath}.failed`;
  const failedMetadata = await optionalMetadata(failedPath);
  if (
    failedMetadata !== null &&
    (!failedMetadata.isFile() || failedMetadata.isSymbolicLink())
  ) {
    throw new Error("Published DVD archive failed path is not a regular file");
  }
  await rename(archivePath, failedPath);
  await syncPath(dirname(archivePath));
}

async function optionalMetadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fingerprintArchiveFile(
  path: string,
  sizeBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("rip-dvd-content-v2\0");
  hash.update(String(sizeBytes));
  for await (const chunk of createReadStream(path, { signal })) {
    signal.throwIfAborted();
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function requireSafeArchiveRoot(path: string): Promise<string> {
  const resolved = resolve(path);
  if (Buffer.byteLength(resolved) > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error("Originals library path exceeds the safety limit");
  }
  await mkdir(resolved, { recursive: true, mode: 0o750 });
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Originals library must be a real directory");
  }
  const canonical = await realpath(resolved);
  return canonical;
}

export async function preserveDvdArchive({
  devicePath,
  fingerprint,
  originalsLibraryPath,
  runner,
  signal,
  sizeBytes,
  sync = syncPath,
  verifySource,
  onProgress,
}: PreserveDvdArchiveOptions): Promise<PreservedDvdArchive> {
  signal.throwIfAborted();
  const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
  const safeSizeBytes = requireDvdContentSize(sizeBytes);
  if (!isDvdContentId(fingerprint)) {
    throw new Error("Detected Disc fingerprint is invalid");
  }
  const root = await requireSafeArchiveRoot(originalsLibraryPath);
  const digest = fingerprint.slice("sha256:".length);
  const archivePath = join(root, `${digest}.iso`);
  const legacyPartialPath = join(root, `.${digest}.iso.rip-dvd-partial`);
  const partialPath = join(
    root,
    `.${digest}.${randomUUID()}.iso.rip-dvd-partial`,
  );
  if (
    dirname(archivePath) !== root ||
    dirname(legacyPartialPath) !== root ||
    dirname(partialPath) !== root ||
    Buffer.byteLength(archivePath) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(legacyPartialPath) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(partialPath) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(`${archivePath}.failed`) > MAX_ARCHIVE_PATH_BYTES ||
    Buffer.byteLength(`${partialPath}.failed`) > MAX_ARCHIVE_PATH_BYTES
  ) {
    throw new Error("Archive path escaped the originals library");
  }
  requireLegacyPartialInactive(legacyPartialPath);
  await movePartialAside(legacyPartialPath);

  const existingArchive = await optionalMetadata(archivePath);
  if (existingArchive) {
    if (!existingArchive.isFile() || existingArchive.isSymbolicLink()) {
      throw new Error("Existing DVD archive path is not a regular file");
    }
    if (
      existingArchive.size !== safeSizeBytes ||
      (await fingerprintArchiveFile(archivePath, safeSizeBytes, signal)) !==
        fingerprint
    ) {
      throw new Error("Existing DVD archive does not match the Detected Disc");
    }
    await verifySource();
    signal.throwIfAborted();
    await sync(archivePath);
    signal.throwIfAborted();
    await sync(root);
    signal.throwIfAborted();
    onProgress(99);
    return { archivePath, recovered: true, sizeBytes: safeSizeBytes };
  }

  if (runner.isActive(safeDevicePath, partialPath)) {
    throw new Error("DVD archive copy is still active");
  }
  await movePartialAside(partialPath);
  let finalPublished = false;
  try {
    await runner.copy({
      devicePath: safeDevicePath,
      outputPath: partialPath,
      sizeBytes: safeSizeBytes,
      signal,
      onBytesCopied(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          return;
        }
        onProgress(Math.min(99, Math.floor((bytes * 100) / safeSizeBytes)));
      },
    });
    signal.throwIfAborted();
    const partialMetadata = await lstat(partialPath);
    if (
      !partialMetadata.isFile() ||
      partialMetadata.isSymbolicLink() ||
      partialMetadata.size !== safeSizeBytes
    ) {
      throw new Error("DVD archive copy did not produce the expected complete image");
    }
    await verifySource();
    signal.throwIfAborted();
    if (
      (await fingerprintArchiveFile(partialPath, safeSizeBytes, signal)) !==
      fingerprint
    ) {
      throw new Error("DVD archive copy fingerprint does not match the Detected Disc");
    }
    await sync(partialPath);
    // A hard link publishes the fully-synced inode without the overwrite
    // behavior of POSIX rename. Both paths are in the same bounded directory.
    await link(partialPath, archivePath);
    finalPublished = true;
    await unlink(partialPath);
    await sync(root);
  } catch (error) {
    if (finalPublished) {
      await quarantinePublishedArchive(archivePath);
      await movePartialAside(partialPath);
    } else if (!runner.isActive(safeDevicePath, partialPath)) {
      await movePartialAside(partialPath);
    }
    throw error;
  }
  return { archivePath, recovered: false, sizeBytes: safeSizeBytes };
}
