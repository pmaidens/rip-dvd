import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

const HANDBRAKE_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 65_536;

export interface HandBrakeRunRequest {
  arguments_: readonly string[];
  onOutput(text: string): void;
  outputPath: string;
  signal: AbortSignal;
}

export interface HandBrakeRunner {
  run(request: HandBrakeRunRequest): Promise<void>;
  isActive?(outputPath: string): boolean;
  whenInactive?(outputPath: string): Promise<void>;
}

interface HandBrakeChildProcess {
  stderr: Readable;
  stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

type SpawnHandBrake = (
  executable: string,
  arguments_: readonly string[],
  options: { shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => HandBrakeChildProcess;

function boundedDiagnostic(value: string): string {
  return Buffer.from(value)
    .subarray(-MAX_DIAGNOSTIC_BYTES)
    .toString("utf8")
    .trim();
}

export function createNodeHandBrakeRunner({
  spawnProcess = spawn as SpawnHandBrake,
  timeoutMs = HANDBRAKE_TIMEOUT_MS,
}: {
  spawnProcess?: SpawnHandBrake;
  timeoutMs?: number;
} = {}): HandBrakeRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("HandBrake timeout is invalid");
  }
  const activeOutputs = new Set<string>();
  const inactiveWaiters = new Map<
    string,
    { promise: Promise<void>; resolve(): void }
  >();
  const activateOutput = (outputPath: string) => {
    let resolveInactive!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveInactive = resolve;
    });
    activeOutputs.add(outputPath);
    inactiveWaiters.set(outputPath, {
      promise,
      resolve: resolveInactive,
    });
  };
  const releaseOutput = (outputPath: string) => {
    activeOutputs.delete(outputPath);
    const waiter = inactiveWaiters.get(outputPath);
    inactiveWaiters.delete(outputPath);
    waiter?.resolve();
  };
  return {
    isActive(outputPath) {
      return activeOutputs.has(outputPath);
    },
    whenInactive(outputPath) {
      return inactiveWaiters.get(outputPath)?.promise ?? Promise.resolve();
    },
    run({ arguments_, onOutput, outputPath, signal }) {
      signal.throwIfAborted();
      if (activeOutputs.has(outputPath)) {
        return Promise.reject(new Error("HandBrake output is still active"));
      }
      activateOutput(outputPath);
      return new Promise<void>((resolveRun, rejectRun) => {
        let child: HandBrakeChildProcess;
        try {
          child = spawnProcess(
            "nice",
            [
              "-n",
              "19",
              "ionice",
              "-c",
              "3",
              "HandBrakeCLI",
              ...arguments_,
            ],
            { shell: false, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (error) {
          releaseOutput(outputPath);
          rejectRun(error);
          return;
        }
        let settled = false;
        let diagnostics = "";
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          error === undefined ? resolveRun() : rejectRun(error);
        };
        const cancel = (error: unknown) => {
          if (settled) {
            return;
          }
          try {
            child.kill("SIGKILL");
          } catch {
            // The original timeout, abort, or parser error remains authoritative.
          }
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(error);
        };
        const capture = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          diagnostics = boundedDiagnostic(`${diagnostics}${text}`);
          try {
            onOutput(text);
          } catch (error) {
            cancel(error);
          }
        };
        const abort = () => {
          cancel(signal.reason ?? new Error("HandBrake was interrupted"));
        };
        const timeout = setTimeout(() => {
          cancel(new Error("HandBrake timed out"));
        }, timeoutMs);
        timeout.unref();
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("error", (error) => finish(error));
        child.once("close", (code, closeSignal) => {
          releaseOutput(outputPath);
          if (settled) {
            return;
          }
          if (code === 0) {
            finish();
            return;
          }
          const detail = boundedDiagnostic(diagnostics).slice(0, 500);
          finish(
            new Error(
              `HandBrake failed${detail ? `: ${detail}` : ` with ${closeSignal ?? `status ${code}`}`}`,
            ),
          );
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    },
  };
}

export const nodeHandBrakeRunner = createNodeHandBrakeRunner();
