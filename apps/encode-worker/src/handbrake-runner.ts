import { spawn } from "node:child_process";
import {
  lstatSync,
  opendirSync,
  readFileSync,
  statSync,
  type Stats,
} from "node:fs";
import type { Readable } from "node:stream";

import { ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH } from "@rip-dvd/data-access";

const HANDBRAKE_TIMEOUT_MS = 24 * 60 * 60_000;
const HANDBRAKE_TERMINATION_GRACE_MS = 10_000;
const MAX_DIAGNOSTIC_BYTES = 65_536;
const MAX_PROC_ENTRIES = 4_096;
const MAX_PROC_FILE_DESCRIPTORS = 65_536;
const MAX_PROC_COMMAND_BYTES = 65_536;

export interface HandBrakeRunRequest {
  arguments_: readonly string[];
  onOutput(text: string): void;
  outputPath: string;
  signal: AbortSignal;
}

export interface HandBrakeRunner {
  run(request: HandBrakeRunRequest): Promise<void>;
  isActive?(outputPath: string): boolean;
  requireInactive?(outputPath: string): void;
  whenInactive?(outputPath: string): Promise<void>;
}

export type HandBrakeCommandFailureEvidence =
  | { kind: "exit_status"; exitStatus: number }
  | { kind: "signal"; signal: NodeJS.Signals };

export class HandBrakeCommandError extends Error {
  override readonly name = "HandBrakeCommandError";
  readonly evidence: HandBrakeCommandFailureEvidence;
  readonly diagnostic: string | null;

  constructor(
    evidence: HandBrakeCommandFailureEvidence,
    diagnostic: string | null,
  ) {
    super(
      evidence.kind === "exit_status"
        ? `HandBrake failed with status ${evidence.exitStatus}`
        : `HandBrake failed with signal ${evidence.signal}`,
    );
    this.evidence = evidence;
    this.diagnostic = diagnostic;
  }
}

export class HandBrakeTimeoutError extends Error {
  override readonly name = "HandBrakeTimeoutError";
  readonly timeoutSeconds: number;
  readonly diagnostic: string | null;

  constructor(timeoutMs: number, diagnostic: string | null) {
    super("HandBrake timed out");
    this.timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    this.diagnostic = diagnostic;
  }
}

interface HandBrakeChildProcess {
  stderr: Readable;
  stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
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

function failureDiagnostic(value: string): string | null {
  return (
    boundedDiagnostic(value).slice(
      0,
      ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
    ) || null
  );
}

function isVanishedProcEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function optionalOutputMetadata(outputPath: string): Stats | null {
  try {
    return lstatSync(outputPath);
  } catch (error) {
    if (isVanishedProcEntry(error)) {
      return null;
    }
    throw error;
  }
}

function requireLinuxOutputInactive(outputPath: string): void {
  const target = optionalOutputMetadata(outputPath);
  if (target !== null && (!target.isFile() || target.isSymbolicLink())) {
    throw new Error("HandBrake output path is unsafe");
  }
  const ownerUid = target?.uid ?? process.geteuid?.();
  if (ownerUid === undefined) {
    throw new Error("Could not prove the HandBrake process is inactive");
  }
  let processDirectory;
  try {
    processDirectory = opendirSync("/proc");
  } catch {
    throw new Error("Could not prove the HandBrake process is inactive");
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
        throw new Error("Could not prove the HandBrake process is inactive");
      }
      const processPath = `/proc/${processEntry.name}`;
      let processMetadata;
      try {
        processMetadata = statSync(processPath);
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        throw new Error("Could not prove the HandBrake process is inactive");
      }
      if (processMetadata.uid !== ownerUid) {
        continue;
      }
      try {
        const command = readFileSync(`${processPath}/cmdline`);
        if (command.byteLength > MAX_PROC_COMMAND_BYTES) {
          throw new Error("Could not prove the HandBrake process is inactive");
        }
        if (
          command
            .toString("utf8")
            .split("\0")
            .some((argument) => argument === outputPath)
        ) {
          throw new Error("HandBrake output is still active");
        }
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        if (
          error instanceof Error &&
          (error.message === "HandBrake output is still active" ||
            error.message ===
              "Could not prove the HandBrake process is inactive")
        ) {
          throw error;
        }
        throw new Error("Could not prove the HandBrake process is inactive");
      }
      if (target === null) {
        continue;
      }
      let descriptorDirectory;
      try {
        descriptorDirectory = opendirSync(`${processPath}/fd`);
      } catch (error) {
        if (isVanishedProcEntry(error)) {
          continue;
        }
        throw new Error("Could not prove the HandBrake process is inactive");
      }
      try {
        let descriptorEntry;
        while ((descriptorEntry = descriptorDirectory.readSync()) !== null) {
          descriptorCount += 1;
          if (descriptorCount > MAX_PROC_FILE_DESCRIPTORS) {
            throw new Error("Could not prove the HandBrake process is inactive");
          }
          try {
            const opened = statSync(
              `${processPath}/fd/${descriptorEntry.name}`,
            );
            if (opened.dev === target.dev && opened.ino === target.ino) {
              throw new Error("HandBrake output is still active");
            }
          } catch (error) {
            if (isVanishedProcEntry(error)) {
              continue;
            }
            if (
              error instanceof Error &&
              error.message === "HandBrake output is still active"
            ) {
              throw error;
            }
            throw new Error("Could not prove the HandBrake process is inactive");
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

export function createNodeHandBrakeRunner({
  spawnProcess = spawn as SpawnHandBrake,
  terminationGraceMs = HANDBRAKE_TERMINATION_GRACE_MS,
  timeoutMs = HANDBRAKE_TIMEOUT_MS,
}: {
  spawnProcess?: SpawnHandBrake;
  terminationGraceMs?: number;
  timeoutMs?: number;
} = {}): HandBrakeRunner {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("HandBrake timeout is invalid");
  }
  if (
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs <= 0
  ) {
    throw new Error("HandBrake termination grace is invalid");
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
    requireInactive(outputPath) {
      if (activeOutputs.has(outputPath)) {
        throw new Error("HandBrake output is still active");
      }
      requireLinuxOutputInactive(outputPath);
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
              "rip-dvd-handbrake",
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
        let terminationTimeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          error === undefined ? resolveRun() : rejectRun(error);
        };
        const cancel = (
          error: unknown,
          killSignal: NodeJS.Signals = "SIGKILL",
        ) => {
          if (settled) {
            return;
          }
          try {
            child.kill(killSignal);
          } catch {
            // The original timeout, abort, or parser error remains authoritative.
          }
          child.stdout.destroy();
          child.stderr.destroy();
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
          cancel(
            signal.reason ?? new Error("HandBrake was interrupted"),
            "SIGTERM",
          );
          terminationTimeout = setTimeout(() => {
            if (!activeOutputs.has(outputPath)) {
              return;
            }
            try {
              child.kill("SIGKILL");
            } catch {
              // Process closure remains the ownership boundary.
            }
          }, terminationGraceMs);
        };
        const timeout = setTimeout(() => {
          cancel(
            new HandBrakeTimeoutError(
              timeoutMs,
              failureDiagnostic(diagnostics),
            ),
          );
        }, timeoutMs);
        timeout.unref();
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        child.once("error", (error) => finish(error));
        child.once("close", (code, closeSignal) => {
          if (terminationTimeout !== undefined) {
            clearTimeout(terminationTimeout);
          }
          releaseOutput(outputPath);
          if (settled) {
            return;
          }
          if (code === 0) {
            finish();
            return;
          }
          const diagnostic = failureDiagnostic(diagnostics);
          if (code !== null && code >= 1 && code <= 255) {
            finish(
              new HandBrakeCommandError(
                { kind: "exit_status", exitStatus: code },
                diagnostic,
              ),
            );
            return;
          }
          if (closeSignal !== null) {
            finish(
              new HandBrakeCommandError(
                { kind: "signal", signal: closeSignal },
                diagnostic,
              ),
            );
            return;
          }
          finish(new Error("HandBrake failed without an exit status or signal"));
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
