import { randomUUID } from "node:crypto";
import {
  type Stats,
  closeSync,
  constants as fsConstants,
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

import type {
  ArchiveJobProgress,
  CleanReadArchiveIntegrityEvidence,
} from "@rip-dvd/data-access";
import {
  isDvdFingerprint,
  isDvdMetadataFingerprint,
} from "@rip-dvd/data-access/dvd-scan";

import { requireDvdContentSize } from "./dvd-content-policy.js";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";
import { optionalBoundedText } from "./bounded-text.js";
import {
  createBoundedSingleFlightCoordinator,
  type ActiveBoundedProcess,
} from "./bounded-child-process.js";
import {
  createCleanDvdRecoveryResult,
  type DvdRecoveryResult,
  type DvdValidationResult,
  validateDvdRecoveryResult,
} from "./dvd-recovery-contracts.js";

const MAX_ARCHIVE_PATH_BYTES = 4_096;
const MAX_ARCHIVE_RECOVERY_ENTRIES = 4_096;
const MAX_COPY_DIAGNOSTIC_BYTES = 65_536;
const MAX_PROC_ENTRIES = 4_096;
const MAX_PROC_FILE_DESCRIPTORS = 65_536;
const COPY_TIMEOUT_MS = 12 * 60 * 60_000;
const COPY_AUTHORIZATION_TIMEOUT_MS = 5_000;
const DEVICE_RECOVERY_LOCK_TIMEOUT_MS = 5_000;
const FLOCK_CONFLICT_EXIT_CODE = 75;

function dvdArchiveStem(fingerprint: string): string {
  const digest = fingerprint.slice(fingerprint.lastIndexOf(":") + 1);
  return isDvdMetadataFingerprint(fingerprint) ? `dvdmeta-${digest}` : digest;
}

export interface DvdCopyRequest {
  authorizeStart?(): void;
  devicePath: string;
  outputPath: string;
  sizeBytes: number;
  signal: AbortSignal;
  onBytesCopied(bytes: number): void;
}

export interface DvdCopyRunner {
  copy(request: DvdCopyRequest): Promise<DvdRecoveryResult>;
  isActive(devicePath: string, outputPath: string): boolean;
  withDeviceInactive(
    devicePath: string,
    mutation: () => undefined,
  ): Promise<void>;
  waitForInactive(devicePath: string, outputPath: string): Promise<void>;
}

interface DvdCopyChildProcess {
  pid?: number;
  stdio: [
    null,
    null,
    DvdCopyReadablePipe,
    null,
    DvdCopyReadablePipe,
    DvdCopyWritablePipe,
  ];
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

interface DvdCopyReadablePipe {
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

interface DvdCopyWritablePipe {
  destroy(): void;
  end(chunk?: string): void;
}

type SpawnDvdCopyProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "pipe", number, "pipe", "pipe"];
  },
) => DvdCopyChildProcess;

interface DvdDeviceLockChildProcess {
  stderr: DvdCopyReadablePipe | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

type SpawnDvdDeviceLockProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "pipe", number];
  },
) => DvdDeviceLockChildProcess;

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
  deviceLockTimeoutMs = DEVICE_RECOVERY_LOCK_TIMEOUT_MS,
  maxActiveCopies = 1,
  requireInactive = requireDeviceInactive,
  spawnLockProcess = spawn as unknown as SpawnDvdDeviceLockProcess,
  spawnProcess = spawn as unknown as SpawnDvdCopyProcess,
  timeoutMs = COPY_TIMEOUT_MS,
}: {
  deviceLockTimeoutMs?: number;
  maxActiveCopies?: number;
  requireInactive?: (devicePath: string) => void;
  spawnLockProcess?: SpawnDvdDeviceLockProcess;
  spawnProcess?: SpawnDvdCopyProcess;
  timeoutMs?: number;
} = {}): DvdCopyRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DVD archive copy timeout is invalid");
  }
  if (
    !Number.isSafeInteger(deviceLockTimeoutMs) ||
    deviceLockTimeoutMs <= 0
  ) {
    throw new Error("DVD archive recovery lock timeout is invalid");
  }
  const copyKey = (devicePath: string, outputPath: string) =>
    JSON.stringify([devicePath, outputPath]);
  const activeCopiesByDevicePath = new Map<string, number>();
  const coordinator = createBoundedSingleFlightCoordinator<
    DvdCopyRequest,
    DvdRecoveryResult
  >({
    exhaustedCapacityError: "A DVD archive copy is already active",
    invalidCapacityError: "DVD archive copy capacity is invalid",
    maxActiveProcesses: maxActiveCopies,
    validateReuse() {
      throw new Error("DVD archive copy is still active");
    },
    start(request): ActiveBoundedProcess<DvdRecoveryResult> {
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
            "rip-dvd-dvdcss-reader",
            "copy-authorized",
            requireSafeOpticalDevicePath(request.devicePath),
            request.outputPath,
            String(requireDvdContentSize(request.sizeBytes)),
          ],
          {
            shell: false,
            stdio: [
              "ignore",
              "ignore",
              "pipe",
              lockDescriptor,
              "pipe",
              "pipe",
            ],
          },
        );
      } finally {
        closeSync(lockDescriptor);
      }
      let operationSettled = false;
      let processClosed = false;
      let cancellationRequested = false;
      let authorizationSettled = false;
      let authorizationBuffer = "";
      let progressBuffer = "";
      let diagnostics = "";
      let resolveResult!: (result: DvdRecoveryResult) => void;
      let rejectResult!: (reason: unknown) => void;
      let resolveClosed!: () => void;
      const result = new Promise<DvdRecoveryResult>((resolve, reject) => {
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
      const resolveOperation = (recoveryResult: DvdRecoveryResult) => {
        if (!operationSettled) {
          operationSettled = true;
          resolveResult(recoveryResult);
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
        child.stdio[4].destroy();
        child.stdio[5].destroy();
        try {
          child.kill("SIGKILL");
        } finally {
          // A device read can remain blocked in the kernel after SIGKILL. It
          // must not retain parent event-loop handles while its tombstone
          // continues to protect the live output path.
          child.unref();
        }
      };
      const authorizationTimeout = setTimeout(() => {
        if (!authorizationSettled) {
          authorizationSettled = true;
          rejectOperation(new Error("DVD archive copy authorization timed out"));
          cancel();
        }
      }, COPY_AUTHORIZATION_TIMEOUT_MS);
      authorizationTimeout.unref();
      child.stdio[4].on("data", (chunk) => {
        if (authorizationSettled || cancellationRequested) {
          return;
        }
        authorizationBuffer = `${authorizationBuffer}${chunk.toString("utf8")}`
          .slice(-128);
        if (!authorizationBuffer.includes("rip-dvd-copy-authorization-ready\n")) {
          return;
        }
        authorizationSettled = true;
        clearTimeout(authorizationTimeout);
        try {
          request.authorizeStart?.();
          child.stdio[5].end("1");
        } catch (error) {
          rejectOperation(error);
          cancel();
        }
      });
      const appendDiagnostic = (text: string) => {
        const diagnostic = text.trim();
        if (diagnostic.length === 0) {
          return;
        }
        diagnostics = `${diagnostics}${diagnostics ? "\n" : ""}${diagnostic}`.slice(
          -MAX_COPY_DIAGNOSTIC_BYTES,
        );
      };
      const parseCopyOutput = (text: string, flush = false) => {
        progressBuffer += text;
        if (progressBuffer.length > MAX_COPY_DIAGNOSTIC_BYTES) {
          progressBuffer = progressBuffer.slice(-MAX_COPY_DIAGNOSTIC_BYTES);
        }
        const segments = progressBuffer.split(/[\r\n]/);
        progressBuffer = flush ? "" : (segments.pop() ?? "");
        for (const segment of segments) {
          const match = /^\s*(\d+)\s+bytes\b/.exec(segment);
          const bytes = match ? Number(match[1]) : Number.NaN;
          if (Number.isSafeInteger(bytes) && bytes >= 0) {
            request.onBytesCopied(bytes);
          } else {
            appendDiagnostic(segment);
          }
        }
      };

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (operationSettled || cancellationRequested) {
          return;
        }
        try {
          parseCopyOutput(text);
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
        clearTimeout(authorizationTimeout);
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
          parseCopyOutput("", true);
        } catch (error) {
          rejectOperation(error);
          return;
        }
        if (code === 0) {
          resolveOperation(createCleanDvdRecoveryResult(request.sizeBytes));
          return;
        }
        const detail = optionalBoundedText(diagnostics, 500);
        rejectOperation(
          new Error(
            `DVD archive copy failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${code}`}`}`,
          ),
        );
      });

      const activeCopies = activeCopiesByDevicePath.get(request.devicePath) ?? 0;
      activeCopiesByDevicePath.set(request.devicePath, activeCopies + 1);
      void closed.then(() => {
        const remainingCopies =
          (activeCopiesByDevicePath.get(request.devicePath) ?? 1) - 1;
        if (remainingCopies === 0) {
          activeCopiesByDevicePath.delete(request.devicePath);
        } else {
          activeCopiesByDevicePath.set(request.devicePath, remainingCopies);
        }
      });

      return { result, closed, cancel };
    },
  });

  return {
    copy(request) {
      const safeDevicePath = requireSafeOpticalDevicePath(request.devicePath);
      requireInactive(safeDevicePath);
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
    withDeviceInactive(devicePath, mutation) {
      const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
      if (activeCopiesByDevicePath.has(safeDevicePath)) {
        throw new Error("DVD archive copy is still active");
      }
      return withExclusiveDeviceInactivity(
        safeDevicePath,
        mutation,
        requireInactive,
        spawnLockProcess,
        deviceLockTimeoutMs,
      );
    },
    waitForInactive(devicePath, outputPath) {
      return coordinator.waitForInactive(
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

async function withExclusiveDeviceInactivity(
  devicePath: string,
  mutation: () => undefined,
  requireInactive: (devicePath: string) => void,
  spawnLockProcess: SpawnDvdDeviceLockProcess,
  timeoutMs: number,
): Promise<void> {
  // The scan catches pre-lock and pre-upgrade readers. Acquiring the same
  // inode flock used by copy then closes the gap through the mutation.
  requireInactive(devicePath);
  const lockDescriptor = openDeviceLock(devicePath);
  let child: DvdDeviceLockChildProcess;
  try {
    child = spawnLockProcess(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONFLICT_EXIT_CODE),
        "3",
      ],
      {
        shell: false,
        stdio: ["ignore", "ignore", "pipe", lockDescriptor] as const,
      },
    );
  } catch (error) {
    closeSync(lockDescriptor);
    throw error;
  }
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClosed) => {
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  const childDiagnostics = child.stderr;
  if (childDiagnostics === null) {
    child.kill("SIGKILL");
    child.unref();
    closeSync(lockDescriptor);
    throw new Error("DVD archive device lock streams are unavailable");
  }
  let stderr = "";
  let spawnError: unknown;
  child.once("error", (error) => {
    spawnError = error;
  });
  childDiagnostics.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_024);
  });
  let acquisitionTimedOut = false;
  let acquisitionTimeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    closed,
    new Promise<undefined>((resolveTimeout) => {
      acquisitionTimeout = setTimeout(() => {
        acquisitionTimedOut = true;
        child.kill("SIGKILL");
        resolveTimeout(undefined);
      }, timeoutMs);
      acquisitionTimeout.unref();
    }),
  ]);
  clearTimeout(acquisitionTimeout);
  if (acquisitionTimedOut || outcome === undefined) {
    childDiagnostics.destroy();
    child.unref();
    closeSync(lockDescriptor);
    throw new Error("DVD archive device lock timed out");
  }
  if (spawnError !== undefined || outcome.code !== 0) {
    closeSync(lockDescriptor);
    if (outcome.code === FLOCK_CONFLICT_EXIT_CODE) {
      throw new Error("DVD archive device is still active");
    }
    if (spawnError !== undefined) {
      throw spawnError;
    }
    const detail = optionalBoundedText(stderr, 500);
    throw new Error(
      `DVD archive device lock failed${
        detail
          ? `: ${detail}`
          : ` with ${outcome.signal ?? `status ${outcome.code}`}`
      }`,
    );
  }
  try {
    mutation();
  } finally {
    // Descriptor-mode `flock(1)` locks the inherited open-file description.
    // Retaining the parent's descriptor after that short process exits keeps
    // exclusion authoritative for the whole synchronous mutation.
    closeSync(lockDescriptor);
  }
}

function requirePartialInactive(partialPath: string): void {
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
    throw new Error("DVD archive partial path is unsafe");
  }
  requireSameOwnerInodeInactive(
    partial,
    partial.uid,
    "DVD archive copy is still active",
    "Could not prove the DVD archive partial is inactive",
  );
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function discoverAttemptPartialPaths(root: string, digest: string): string[] {
  const prefix = `.${digest}.`;
  const suffix = ".iso.rip-dvd-partial";
  const partialPaths: string[] = [];
  let directory;
  try {
    directory = opendirSync(root);
  } catch {
    throw new Error("Could not safely discover DVD archive partials");
  }
  let entryCount = 0;
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_RECOVERY_ENTRIES) {
        throw new Error("DVD archive partial recovery exceeds the safety limit");
      }
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) {
        continue;
      }
      const attemptId = entry.name.slice(prefix.length, -suffix.length);
      if (UUID_V4_PATTERN.test(attemptId)) {
        partialPaths.push(join(root, entry.name));
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "DVD archive partial recovery exceeds the safety limit"
    ) {
      throw error;
    }
    throw new Error("Could not safely discover DVD archive partials");
  } finally {
    directory.closeSync();
  }
  return partialPaths.sort();
}

export async function withCancelledDvdArchiveInactive({
  devicePath,
  fingerprint,
  mutation,
  originalsLibraryPath,
  runner,
}: {
  devicePath: string;
  fingerprint: string;
  mutation: () => undefined;
  originalsLibraryPath: string;
  runner: DvdCopyRunner;
}): Promise<void> {
  const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
  if (!isDvdFingerprint(fingerprint)) {
    throw new Error("Detected Disc fingerprint is invalid");
  }
  const root = await requireSafeArchiveRoot(originalsLibraryPath);
  const digest = dvdArchiveStem(fingerprint);
  return runner.withDeviceInactive(safeDevicePath, () => {
    const partialPaths = [
      join(root, `.${digest}.iso.rip-dvd-partial`),
      ...discoverAttemptPartialPaths(root, digest),
    ];
    for (const partialPath of partialPaths) {
      if (runner.isActive(safeDevicePath, partialPath)) {
        throw new Error("DVD archive copy is still active");
      }
      requirePartialInactive(partialPath);
    }
    mutation();
    return undefined;
  });
}

export interface PreserveDvdArchiveOptions {
  authorizeCopy?(): void;
  devicePath: string;
  fingerprint: string;
  originalsLibraryPath: string;
  runner: DvdCopyRunner;
  signal: AbortSignal;
  sizeBytes: number;
  sync?(path: string): Promise<void>;
  verifySource(): Promise<void>;
  onProgress(progress: ArchiveJobProgress): void;
}

export interface PreservedDvdArchive {
  archivePath: string;
  integrityEvidence: CleanReadArchiveIntegrityEvidence;
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
  authorizeCopy,
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
  onProgress({ phase: "preparing", progressPercent: 0 });
  const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
  const safeSizeBytes = requireDvdContentSize(sizeBytes);
  if (!isDvdFingerprint(fingerprint)) {
    throw new Error("Detected Disc fingerprint is invalid");
  }
  const root = await requireSafeArchiveRoot(originalsLibraryPath);
  const digest = dvdArchiveStem(fingerprint);
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
  const recoveryPaths = [
    legacyPartialPath,
    ...discoverAttemptPartialPaths(root, digest),
  ];
  for (const recoveryPath of recoveryPaths) {
    if (runner.isActive(safeDevicePath, recoveryPath)) {
      throw new Error("DVD archive copy is still active");
    }
    requirePartialInactive(recoveryPath);
  }
  for (const recoveryPath of recoveryPaths) {
    await movePartialAside(recoveryPath);
  }

  const existingArchive = await optionalMetadata(archivePath);
  if (existingArchive) {
    if (!existingArchive.isFile() || existingArchive.isSymbolicLink()) {
      throw new Error("Existing DVD archive path is not a regular file");
    }
    if (existingArchive.size !== safeSizeBytes) {
      throw new Error("Existing DVD archive does not match the Detected Disc");
    }
    await verifySource();
    signal.throwIfAborted();
    onProgress({ phase: "finalizing", progressPercent: 99 });
    await sync(archivePath);
    signal.throwIfAborted();
    await sync(root);
    signal.throwIfAborted();
    const validation = validateDvdRecoveryResult(
      createCleanDvdRecoveryResult(safeSizeBytes),
      safeSizeBytes,
    );
    return {
      archivePath,
      integrityEvidence: validation.integrityEvidence,
      recovered: true,
      sizeBytes: safeSizeBytes,
    };
  }

  if (runner.isActive(safeDevicePath, partialPath)) {
    throw new Error("DVD archive copy is still active");
  }
  await movePartialAside(partialPath);
  let finalPublished = false;
  let validation: DvdValidationResult | undefined;
  try {
    onProgress({ phase: "copying", progressPercent: 0 });
    const recoveryResult = await runner.copy({
      authorizeStart: authorizeCopy,
      devicePath: safeDevicePath,
      outputPath: partialPath,
      sizeBytes: safeSizeBytes,
      signal,
      onBytesCopied(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          return;
        }
        onProgress({
          phase: "copying",
          progressPercent: Math.min(
            99,
            Math.floor((bytes * 100) / safeSizeBytes),
          ),
        });
      },
    });
    validation = validateDvdRecoveryResult(
      recoveryResult,
      safeSizeBytes,
    );
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
    onProgress({ phase: "finalizing", progressPercent: 99 });
    await sync(partialPath);
    // A hard link publishes the fully-synced inode without the overwrite
    // behavior of POSIX rename. Both paths are in the same bounded directory.
    await link(partialPath, archivePath);
    finalPublished = true;
    await unlink(partialPath);
    await sync(root);
  } catch (error) {
    // A rejected operation is not proof that the helper exited. Do not return
    // control until OS-level closure releases the copy tombstone.
    await runner.waitForInactive(safeDevicePath, partialPath);
    if (finalPublished) {
      await quarantinePublishedArchive(archivePath);
      await movePartialAside(partialPath);
    } else if (!runner.isActive(safeDevicePath, partialPath)) {
      await movePartialAside(partialPath);
    }
    throw error;
  }
  if (validation === undefined) {
    throw new Error("DVD recovery result was not validated");
  }
  return {
    archivePath,
    integrityEvidence: validation.integrityEvidence,
    recovered: false,
    sizeBytes: safeSizeBytes,
  };
}
