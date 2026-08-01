import { fileURLToPath } from "node:url";

import { isDvdContentId } from "@rip-dvd/data-access/dvd-scan";

import {
  createNodeBoundedChildProcessLauncher,
  type ActiveBoundedChildProcess,
  type BoundedChildProcessLauncher,
} from "./bounded-child-process.js";

const DEFAULT_CONTENT_HASH_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_ACTIVE_HASHES = 32;
const MAX_DVD_CONTENT_BYTES = 9_000_000_000;
const MAX_CONTENT_HASH_OUTPUT_BYTES = 128;

export interface DiscContentReader {
  hash(
    devicePath: string,
    sizeBytes: number,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface ActiveDiscContentProbe extends ActiveBoundedChildProcess {}

export interface DiscContentProbeLauncher {
  start(devicePath: string, sizeBytes: number): ActiveDiscContentProbe;
}

interface NodeDiscContentProbeLauncherOptions {
  scriptPath?: string;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

interface NodeDiscContentReaderOptions {
  hashTimeoutMs?: number;
  maxActiveHashes?: number;
  probeLauncher?: DiscContentProbeLauncher;
}

interface TrackedDiscContentProbe {
  probe: ActiveDiscContentProbe;
  cancellationRequested: boolean;
  sizeBytes: number;
}

function requireContentSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_DVD_CONTENT_BYTES
  ) {
    throw new Error("DVD content size is invalid");
  }
  return value;
}

export function createNodeDiscContentProbeLauncher(
  options: NodeDiscContentProbeLauncherOptions = {},
): DiscContentProbeLauncher {
  const childLauncher: BoundedChildProcessLauncher =
    createNodeBoundedChildProcessLauncher({
      scriptPath:
        options.scriptPath ??
        fileURLToPath(new URL("./optical-disc-content-probe.js", import.meta.url)),
      operationName: "DVD content hashing",
      maxOutputBytes: MAX_CONTENT_HASH_OUTPUT_BYTES,
      ...(options.terminateProcess
        ? { terminateProcess: options.terminateProcess }
        : {}),
    });
  return {
    start(devicePath, sizeBytes) {
      return childLauncher.start([devicePath, String(sizeBytes)]);
    },
  };
}

export const nodeDiscContentProbeLauncher =
  createNodeDiscContentProbeLauncher();

export function createNodeDiscContentReader(
  options: NodeDiscContentReaderOptions = {},
): DiscContentReader {
  const probeLauncher =
    options.probeLauncher ?? nodeDiscContentProbeLauncher;
  const hashTimeoutMs =
    options.hashTimeoutMs ?? DEFAULT_CONTENT_HASH_TIMEOUT_MS;
  const maxActiveHashes =
    options.maxActiveHashes ?? DEFAULT_MAX_ACTIVE_HASHES;
  if (!Number.isSafeInteger(hashTimeoutMs) || hashTimeoutMs <= 0) {
    throw new Error("DVD content hashing timeout is invalid");
  }
  if (!Number.isSafeInteger(maxActiveHashes) || maxActiveHashes <= 0) {
    throw new Error("DVD content hashing capacity is invalid");
  }

  const activeHashes = new Map<string, TrackedDiscContentProbe>();
  return {
    async hash(devicePath, sizeBytes, signal) {
      const safeSize = requireContentSize(sizeBytes);
      signal.throwIfAborted();
      let trackedProbe = activeHashes.get(devicePath);
      if (trackedProbe === undefined) {
        if (activeHashes.size >= maxActiveHashes) {
          throw new Error("DVD content hashing capacity is exhausted");
        }
        const probe = probeLauncher.start(devicePath, safeSize);
        trackedProbe = {
          cancellationRequested: false,
          probe,
          sizeBytes: safeSize,
        };
        activeHashes.set(devicePath, trackedProbe);
        const startedProbe = trackedProbe;
        void probe.closed.then(() => {
          if (activeHashes.get(devicePath) === startedProbe) {
            activeHashes.delete(devicePath);
          }
        });
      } else if (trackedProbe.sizeBytes !== safeSize) {
        throw new Error("DVD content size changed while hashing was active");
      }

      let removeAbortListener = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          try {
            signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
      let hashTimeout: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        hashTimeout = setTimeout(
          () => reject(new Error("DVD content hashing timed out")),
          hashTimeoutMs,
        );
        hashTimeout.unref();
      });
      try {
        const contentId = await Promise.race([
          trackedProbe.probe.result,
          aborted,
          timedOut,
        ]);
        if (!isDvdContentId(contentId)) {
          throw new Error("DVD content probe returned an invalid content identity");
        }
        return contentId;
      } finally {
        clearTimeout(hashTimeout);
        removeAbortListener();
        if (!trackedProbe.cancellationRequested) {
          trackedProbe.cancellationRequested = true;
          trackedProbe.probe.cancel();
        }
      }
    },
  };
}

export const nodeDiscContentReader = createNodeDiscContentReader();
