import { constants as fsConstants } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createNodeBoundedChildProcessLauncher,
  type ActiveBoundedChildProcess,
  type BoundedChildProcessLauncher,
} from "./bounded-child-process.js";
import { optionalBoundedText } from "./bounded-text.js";

const DEFAULT_OBSERVATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ACTIVE_PROBES = 32;
const MAX_DEVICE_PATH_LENGTH = 4_096;
const MAX_MEDIA_PROBE_OUTPUT_BYTES = 4_096;

export interface MediaGenerationObserver {
  observe(devicePath: string, signal: AbortSignal): Promise<string>;
}

/**
 * A probe has two independently observable lifecycles. `result` describes the
 * operation outcome. `closed` is the process-reaping authority and is the only
 * signal that permits its single-flight tombstone to be released.
 */
export interface ActiveMediaProbe extends ActiveBoundedChildProcess {}

export interface MediaGenerationProbeLauncher {
  start(
    devicePath: string,
    flags: number,
    generationPath: string,
  ): ActiveMediaProbe;
}

interface NodeMediaGenerationProbeLauncherOptions {
  scriptPath?: string;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

interface NodeMediaGenerationObserverOptions {
  maxActiveProbes?: number;
  observationTimeoutMs?: number;
  probeLauncher?: MediaGenerationProbeLauncher;
}

interface TrackedMediaProbe {
  probe: ActiveMediaProbe;
  cancellationRequested: boolean;
}

export function requireSafeOpticalDevicePath(value: unknown): string {
  const path = optionalBoundedText(value, MAX_DEVICE_PATH_LENGTH);
  if (
    path === undefined ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    !path.startsWith("/dev/") ||
    normalize(path) !== path
  ) {
    throw new Error("Optical Drive discovery returned an unsafe device path");
  }
  return path;
}

function requireMediaGeneration(value: unknown): string {
  const generation =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : optionalBoundedText(value, 32);
  if (generation === undefined || !/^\d+$/.test(generation)) {
    throw new Error("Optical Drive media generation is unavailable");
  }
  return generation;
}

export function createNodeMediaGenerationProbeLauncher(
  options: NodeMediaGenerationProbeLauncherOptions = {},
): MediaGenerationProbeLauncher {
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("./optical-media-probe.js", import.meta.url));
  const childLauncher: BoundedChildProcessLauncher =
    createNodeBoundedChildProcessLauncher({
      scriptPath,
      operationName: "Optical Drive media observation",
      maxOutputBytes: MAX_MEDIA_PROBE_OUTPUT_BYTES,
      ...(options.terminateProcess
        ? { terminateProcess: options.terminateProcess }
        : {}),
    });
  return {
    start(devicePath, flags, generationPath) {
      return childLauncher.start([
        devicePath,
        String(flags),
        generationPath,
      ]);
    },
  };
}

export const nodeMediaGenerationProbeLauncher =
  createNodeMediaGenerationProbeLauncher();

export function createNodeMediaGenerationObserver(
  options: NodeMediaGenerationObserverOptions = {},
): MediaGenerationObserver {
  const probeLauncher = options.probeLauncher ?? nodeMediaGenerationProbeLauncher;
  const observationTimeoutMs =
    options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
  const maxActiveProbes =
    options.maxActiveProbes ?? DEFAULT_MAX_ACTIVE_PROBES;
  if (!Number.isSafeInteger(observationTimeoutMs) || observationTimeoutMs <= 0) {
    throw new Error("Optical Drive media observation timeout is invalid");
  }
  if (!Number.isSafeInteger(maxActiveProbes) || maxActiveProbes <= 0) {
    throw new Error("Optical Drive media observation capacity is invalid");
  }

  const activeProbes = new Map<string, TrackedMediaProbe>();
  return {
    async observe(devicePath, signal) {
      const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
      signal.throwIfAborted();
      const generationPath = `/sys/class/block/${basename(safeDevicePath)}/diskseq`;
      // Opening the block device makes Linux run the optical driver's media
      // event check. Keep the handle open until the resulting disk sequence is
      // read so a passive sysfs value is never used as the cache authority.
      let trackedProbe = activeProbes.get(safeDevicePath);
      if (trackedProbe === undefined) {
        if (activeProbes.size >= maxActiveProbes) {
          throw new Error("Optical Drive media observation capacity is exhausted");
        }
        const probe = probeLauncher.start(
          safeDevicePath,
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
          generationPath,
        );
        trackedProbe = { cancellationRequested: false, probe };
        activeProbes.set(safeDevicePath, trackedProbe);
        const startedProbe = trackedProbe;
        void probe.closed.then(() => {
          if (activeProbes.get(safeDevicePath) === startedProbe) {
            activeProbes.delete(safeDevicePath);
          }
        });
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
      let observationTimeout: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        observationTimeout = setTimeout(
          () => reject(new Error("Optical Drive media observation timed out")),
          observationTimeoutMs,
        );
        observationTimeout.unref();
      });
      try {
        const value = await Promise.race([
          trackedProbe.probe.result,
          aborted,
          timedOut,
        ]);
        return requireMediaGeneration(value);
      } finally {
        clearTimeout(observationTimeout);
        removeAbortListener();
        if (!trackedProbe.cancellationRequested) {
          trackedProbe.cancellationRequested = true;
          trackedProbe.probe.cancel();
        }
      }
    },
  };
}

export const nodeMediaGenerationObserver =
  createNodeMediaGenerationObserver();
