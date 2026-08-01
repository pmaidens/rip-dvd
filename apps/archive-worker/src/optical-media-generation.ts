import { constants as fsConstants } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBoundedSingleFlightCoordinator,
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
  const activeProbes = createBoundedSingleFlightCoordinator({
    maxActiveProcesses: maxActiveProbes,
    invalidCapacityError: "Optical Drive media observation capacity is invalid",
    exhaustedCapacityError:
      "Optical Drive media observation capacity is exhausted",
    start(devicePath: string) {
      const generationPath = `/sys/class/block/${basename(devicePath)}/diskseq`;
      return probeLauncher.start(
        devicePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
        generationPath,
      );
    },
  });
  return {
    async observe(devicePath, signal) {
      const safeDevicePath = requireSafeOpticalDevicePath(devicePath);
      // Opening the block device makes Linux run the optical driver's media
      // event check. Keep the handle open until the resulting disk sequence is
      // read so a passive sysfs value is never used as the cache authority.
      const value = await activeProbes.run(safeDevicePath, safeDevicePath, {
        signal,
        timeoutError: "Optical Drive media observation timed out",
        timeoutMs: observationTimeoutMs,
      });
      return requireMediaGeneration(value);
    },
  };
}

export const nodeMediaGenerationObserver =
  createNodeMediaGenerationObserver();
