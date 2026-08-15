import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { isDvdFingerprint } from "@rip-dvd/data-access/dvd-scan";

import { optionalBoundedText } from "./bounded-text.js";
import {
  MAX_ARCHIVE_PATH_BYTES,
  requireSafeArchiveRoot,
} from "./archive-root.js";

const FLOCK_CONFLICT_EXIT_CODE = 75;
const WORKSPACE_LOCK_ACQUISITION_TIMEOUT_MS = 5_000;
export const DVD_RESCUE_WORKSPACE_LOCK_DIRECTORY_NAME =
  ".rip-dvd-rescue-locks";

interface WorkspaceLockReadablePipe {
  destroy(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

interface WorkspaceLockChildProcess {
  stderr: WorkspaceLockReadablePipe | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

type SpawnWorkspaceLockProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "pipe", number];
  },
) => WorkspaceLockChildProcess;

export interface DvdRescueWorkspaceLock {
  withLock<Result>(options: {
    fingerprint: string;
    originalsLibraryPath: string;
    signal: AbortSignal;
    task(): Promise<Result>;
  }): Promise<Result>;
}

function fingerprintLockName(fingerprint: string): string {
  if (!isDvdFingerprint(fingerprint)) {
    throw new Error("Detected Disc fingerprint is invalid");
  }
  const key = createHash("sha256").update(fingerprint, "utf8").digest("hex");
  return `.${key}.rip-dvd-fingerprint.lock`;
}

async function requireSafeWorkspaceLockDirectory(root: string): Promise<string> {
  const path = join(root, DVD_RESCUE_WORKSPACE_LOCK_DIRECTORY_NAME);
  if (Buffer.byteLength(path) > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error("DVD rescue workspace lock directory path is too long");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  const effectiveUserId = process.geteuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    effectiveUserId === undefined ||
    metadata.uid !== effectiveUserId
  ) {
    throw new Error("DVD rescue workspace lock directory is unsafe");
  }
  const canonical = await realpath(path);
  const revalidated = await lstat(canonical);
  if (
    canonical !== path ||
    revalidated.dev !== metadata.dev ||
    revalidated.ino !== metadata.ino
  ) {
    throw new Error("DVD rescue workspace lock directory changed");
  }
  return canonical;
}

function openWorkspaceLock(path: string): number {
  if (Buffer.byteLength(path) > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error("DVD rescue workspace lock path is too long");
  }
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_RDWR |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(path);
    const effectiveUserId = process.geteuid?.();
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      effectiveUserId === undefined ||
      opened.uid !== effectiveUserId
    ) {
      throw new Error("DVD rescue workspace lock is unsafe");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

async function acquireWorkspaceLock(
  descriptor: number,
  signal: AbortSignal,
  timeoutMs: number,
  spawnLockProcess: SpawnWorkspaceLockProcess,
): Promise<void> {
  signal.throwIfAborted();
  const child = spawnLockProcess(
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
      stdio: ["ignore", "ignore", "pipe", descriptor],
    },
  );
  let diagnostics = "";
  const childDiagnostics = child.stderr;
  if (childDiagnostics === null) {
    try {
      child.kill("SIGKILL");
    } finally {
      child.unref();
    }
    throw new Error("DVD rescue workspace lock streams are unavailable");
  }
  childDiagnostics.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-1_024);
  });
  const outcome = await new Promise<
    | { error: Error }
    | { code: number | null; signal: NodeJS.Signals | null }
  >((resolveOutcome) => {
    let settled = false;
    let acquisitionTimeout: NodeJS.Timeout | undefined;
    const stopHelper = () => {
      childDiagnostics.destroy();
      try {
        child.kill("SIGKILL");
      } finally {
        child.unref();
      }
    };
    const removeAbortListener = () =>
      signal.removeEventListener("abort", onAbort);
    const settle = (
      result:
        | { error: Error }
        | { code: number | null; signal: NodeJS.Signals | null },
    ) => {
      if (!settled) {
        settled = true;
        clearTimeout(acquisitionTimeout);
        removeAbortListener();
        resolveOutcome(result);
      }
    };
    const onAbort = () => {
      let interruption: Error;
      try {
        signal.throwIfAborted();
        interruption = new Error("DVD rescue workspace lock was cancelled");
      } catch (error) {
        interruption =
          error instanceof Error
            ? error
            : new Error("DVD rescue workspace lock was cancelled");
      }
      settle({ error: interruption });
      stopHelper();
    };
    child.once("error", (error) => settle({ error }));
    child.once("close", (code, signal) => settle({ code, signal }));
    signal.addEventListener("abort", onAbort, { once: true });
    acquisitionTimeout = setTimeout(() => {
      settle({ error: new Error("DVD rescue workspace lock timed out") });
      stopHelper();
    }, timeoutMs);
    acquisitionTimeout.unref();
    if (signal.aborted) {
      onAbort();
    }
  });
  if ("error" in outcome) {
    throw outcome.error;
  }
  if (outcome.code === FLOCK_CONFLICT_EXIT_CODE) {
    throw new Error("DVD rescue workspace is already active");
  }
  if (outcome.code !== 0) {
    const detail = optionalBoundedText(diagnostics, 500);
    throw new Error(
      `DVD rescue workspace lock failed${
        detail
          ? `: ${detail}`
          : ` with ${outcome.signal ?? `status ${outcome.code}`}`
      }`,
    );
  }
}

export function createNodeDvdRescueWorkspaceLock({
  acquisitionTimeoutMs = WORKSPACE_LOCK_ACQUISITION_TIMEOUT_MS,
  spawnLockProcess = spawn as unknown as SpawnWorkspaceLockProcess,
}: {
  acquisitionTimeoutMs?: number;
  spawnLockProcess?: SpawnWorkspaceLockProcess;
} = {}): DvdRescueWorkspaceLock {
  if (
    !Number.isSafeInteger(acquisitionTimeoutMs) ||
    acquisitionTimeoutMs <= 0
  ) {
    throw new Error("DVD rescue workspace lock timeout is invalid");
  }
  return {
    async withLock({
      fingerprint,
      originalsLibraryPath,
      signal,
      task,
    }) {
      signal.throwIfAborted();
      const root = await requireSafeArchiveRoot(originalsLibraryPath);
      const lockDirectory = await requireSafeWorkspaceLockDirectory(root);
      const lockPath = join(lockDirectory, fingerprintLockName(fingerprint));
      const descriptor = openWorkspaceLock(lockPath);
      try {
        await acquireWorkspaceLock(
          descriptor,
          signal,
          acquisitionTimeoutMs,
          spawnLockProcess,
        );
        signal.throwIfAborted();
        return await task();
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

export function createInProcessDvdRescueWorkspaceLock(): DvdRescueWorkspaceLock {
  const activeLocks = new Set<string>();
  return {
    async withLock({
      fingerprint,
      originalsLibraryPath,
      signal,
      task,
    }) {
      signal.throwIfAborted();
      const root = await requireSafeArchiveRoot(originalsLibraryPath);
      const lockPath = join(root, fingerprintLockName(fingerprint));
      if (activeLocks.has(lockPath)) {
        throw new Error("DVD rescue workspace is already active");
      }
      activeLocks.add(lockPath);
      try {
        signal.throwIfAborted();
        return await task();
      } finally {
        activeLocks.delete(lockPath);
      }
    },
  };
}

export const defaultDvdRescueWorkspaceLock =
  createNodeDvdRescueWorkspaceLock();
