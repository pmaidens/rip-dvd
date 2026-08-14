import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { optionalBoundedText } from "./bounded-text.js";
import {
  MAX_ARCHIVE_PATH_BYTES,
  requireSafeArchiveRoot,
} from "./archive-root.js";
import { dvdRescueWorkspacePaths } from "./dvd-rescue-workspace.js";

const FLOCK_CONFLICT_EXIT_CODE = 75;

export interface DvdRescueWorkspaceLock {
  withLock<Result>(options: {
    archiveRequestId: string;
    originalsLibraryPath: string;
    signal: AbortSignal;
    task(): Promise<Result>;
  }): Promise<Result>;
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

async function acquireWorkspaceLock(descriptor: number): Promise<void> {
  const child = spawn(
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
    child.kill("SIGKILL");
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
    const settle = (
      result:
        | { error: Error }
        | { code: number | null; signal: NodeJS.Signals | null },
    ) => {
      if (!settled) {
        settled = true;
        resolveOutcome(result);
      }
    };
    child.once("error", (error) => settle({ error }));
    child.once("close", (code, signal) => settle({ code, signal }));
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

export function createNodeDvdRescueWorkspaceLock(): DvdRescueWorkspaceLock {
  return {
    async withLock({
      archiveRequestId,
      originalsLibraryPath,
      signal,
      task,
    }) {
      signal.throwIfAborted();
      const root = await requireSafeArchiveRoot(originalsLibraryPath);
      const lockPath = `${dvdRescueWorkspacePaths(root, archiveRequestId).mapPath}.lock`;
      const descriptor = openWorkspaceLock(lockPath);
      try {
        await acquireWorkspaceLock(descriptor);
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
      archiveRequestId,
      originalsLibraryPath,
      signal,
      task,
    }) {
      signal.throwIfAborted();
      const root = await requireSafeArchiveRoot(originalsLibraryPath);
      const lockPath = `${dvdRescueWorkspacePaths(root, archiveRequestId).mapPath}.lock`;
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
