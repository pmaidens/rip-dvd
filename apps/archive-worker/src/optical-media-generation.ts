import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

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
export interface ActiveMediaProbe {
  result: Promise<string>;
  closed: Promise<void>;
  cancel(): void;
}

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

function optionalText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : undefined;
}

export function requireSafeOpticalDevicePath(value: unknown): string {
  const path = optionalText(value, MAX_DEVICE_PATH_LENGTH);
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
      : optionalText(value, 32);
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
  const terminateProcess =
    options.terminateProcess ?? ((child) => void child.kill("SIGKILL"));
  return {
    start(devicePath, flags, generationPath) {
      const child = spawn(
        process.execPath,
        [scriptPath, devicePath, String(flags), generationPath],
        { shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let operationSettled = false;
      let processClosed = false;
      let cancellationRequested = false;
      let resolveResult!: (value: string) => void;
      let rejectResult!: (reason: unknown) => void;
      let resolveClosed!: () => void;
      const result = new Promise<string>((resolve, reject) => {
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
      const resolveOperation = (value: string) => {
        if (!operationSettled) {
          operationSettled = true;
          resolveResult(value);
        }
      };
      const confirmClosed = () => {
        if (!processClosed) {
          processClosed = true;
          resolveClosed();
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const capture = (current: string, chunk: string) =>
        `${current}${chunk}`.slice(0, MAX_MEDIA_PROBE_OUTPUT_BYTES + 1);
      child.stdout.on("data", (chunk: string) => {
        stdout = capture(stdout, chunk);
        if (stdout.length > MAX_MEDIA_PROBE_OUTPUT_BYTES) {
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = capture(stderr, chunk);
        if (stderr.length > MAX_MEDIA_PROBE_OUTPUT_BYTES) {
          child.kill("SIGKILL");
        }
      });
      child.once("error", (error) => {
        rejectOperation(error);
        // A spawn failure has no child process to reap. Errors after a PID was
        // assigned (including failed signal delivery) are operation failures,
        // not proof that the live child exited.
        if (child.pid === undefined) {
          confirmClosed();
        }
      });
      child.once("close", (code, signal) => {
        confirmClosed();
        if (cancellationRequested) {
          rejectOperation(
            new Error("Optical Drive media observation was cancelled"),
          );
          return;
        }
        if (stdout.length > MAX_MEDIA_PROBE_OUTPUT_BYTES) {
          rejectOperation(
            new Error("Optical Drive media observation output exceeded its bound"),
          );
          return;
        }
        if (code === 0) {
          resolveOperation(stdout);
          return;
        }
        const detail = optionalText(stderr, 500);
        rejectOperation(
          new Error(
            `Optical Drive media observation failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${code}`}`}`,
          ),
        );
      });

      return {
        result,
        closed,
        cancel() {
          if (cancellationRequested || processClosed) {
            return;
          }
          cancellationRequested = true;
          child.stdout.destroy();
          child.stderr.destroy();
          try {
            terminateProcess(child);
          } finally {
            // A helper stuck in an uninterruptible kernel open can survive
            // until Linux error recovery completes. It must not retain parent
            // event-loop handles while its tombstone remains authoritative.
            child.unref();
          }
        },
      };
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
