import { fileURLToPath } from "node:url";

import { isDvdContentId } from "@rip-dvd/data-access/dvd-scan";

import {
  createBoundedSingleFlightCoordinator,
  createNodeBoundedChildProcessLauncher,
  createNodeBoundedCommandProcessLauncher,
  type ActiveBoundedChildProcess,
  type BoundedChildProcessLauncher,
  type BoundedCommandProcessLauncher,
} from "./bounded-child-process.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import { optionalBoundedText } from "./bounded-text.js";

const DEFAULT_CONTENT_HASH_TIMEOUT_MS = 8 * 60 * 60_000;
const DEFAULT_MAX_ACTIVE_HASHES = 32;
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
  commandLauncher?: BoundedCommandProcessLauncher;
  executablePath?: string;
}

interface NodeFileDiscContentProbeLauncherOptions {
  scriptPath?: string;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

interface NodeDiscContentReaderOptions {
  hashTimeoutMs?: number;
  maxActiveHashes?: number;
  probeLauncher?: DiscContentProbeLauncher;
}

interface DiscContentProcessRequest {
  devicePath: string;
  sizeBytes: number;
}

export function createNodeDiscContentProbeLauncher(
  options: NodeDiscContentProbeLauncherOptions = {},
): DiscContentProbeLauncher {
  const commandLauncher =
    options.commandLauncher ?? createNodeBoundedCommandProcessLauncher();
  const executablePath =
    options.executablePath ?? "rip-dvd-dvdcss-reader";
  return {
    start(devicePath, sizeBytes) {
      const activeProcess = commandLauncher.start(
        executablePath,
        ["hash", devicePath, String(sizeBytes)],
        MAX_CONTENT_HASH_OUTPUT_BYTES,
      );
      return {
        ...activeProcess,
        result: activeProcess.result.then(
          ({ exitCode, signal, stderr, stdout }) => {
            if (exitCode === 0) {
              return stdout;
            }
            const detail = optionalBoundedText(stderr, 500);
            throw new Error(
              `DVD content hashing failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${exitCode}`}`}`,
            );
          },
        ),
      };
    },
  };
}

export function createNodeFileDiscContentProbeLauncher(
  options: NodeFileDiscContentProbeLauncherOptions = {},
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
  const activeHashes = createBoundedSingleFlightCoordinator({
    maxActiveProcesses: maxActiveHashes,
    invalidCapacityError: "DVD content hashing capacity is invalid",
    exhaustedCapacityError: "DVD content hashing capacity is exhausted",
    start(request: DiscContentProcessRequest) {
      return probeLauncher.start(request.devicePath, request.sizeBytes);
    },
    validateReuse(activeRequest, requested) {
      if (activeRequest.sizeBytes !== requested.sizeBytes) {
        throw new Error("DVD content size changed while hashing was active");
      }
    },
  });
  return {
    async hash(devicePath, sizeBytes, signal) {
      const safeSize = requireDvdContentSize(sizeBytes);
      const contentId = await activeHashes.run(
        devicePath,
        { devicePath, sizeBytes: safeSize },
        {
          signal,
          timeoutError: "DVD content hashing timed out",
          timeoutMs: hashTimeoutMs,
        },
      );
      if (!isDvdContentId(contentId)) {
        throw new Error("DVD content probe returned an invalid content identity");
      }
      return contentId;
    },
  };
}

export const nodeDiscContentReader = createNodeDiscContentReader();
