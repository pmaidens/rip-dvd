import { spawn } from "node:child_process";

import { optionalBoundedText } from "./bounded-text.js";

export interface ActiveBoundedProcess<Result> {
  /** Operation outcome; it may settle before the operating system reaps the child. */
  result: Promise<Result>;
  /** Process-reaping authority and the only safe tombstone-release signal. */
  closed: Promise<void>;
  cancel(): void;
}

export interface ActiveBoundedChildProcess
  extends ActiveBoundedProcess<string> {}

export interface BoundedChildProcessLauncher {
  start(arguments_: readonly string[]): ActiveBoundedChildProcess;
}

export interface BoundedCommandProcessCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

export interface ActiveBoundedCommandProcess
  extends ActiveBoundedProcess<BoundedCommandProcessCompletion> {}

export interface BoundedCommandProcessLauncher {
  start(
    executable: string,
    arguments_: readonly string[],
    maxOutputBytes: number,
  ): ActiveBoundedCommandProcess;
}

interface NodeBoundedChildProcessLauncherOptions {
  maxOutputBytes: number;
  operationName: string;
  scriptPath: string;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

interface StartNodeBoundedChildProcessOptions {
  arguments_: readonly string[];
  executable: string;
  maxOutputBytes: number;
  operationName: string;
  terminateProcess: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

interface NodeBoundedCommandProcessLauncherOptions {
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

interface TrackedBoundedProcess<Request, Result> {
  cancellationRequested: boolean;
  process: ActiveBoundedProcess<Result>;
  request: Request;
}

interface BoundedSingleFlightCoordinatorOptions<Request, Result> {
  exhaustedCapacityError: string;
  invalidCapacityError: string;
  maxActiveProcesses: number;
  start(request: Request): ActiveBoundedProcess<Result>;
  validateReuse?(activeRequest: Request, requested: Request): void;
}

interface BoundedProcessWaitOptions {
  signal: AbortSignal;
  timeoutError: string;
  timeoutMs: number;
}

export interface BoundedSingleFlightCoordinator<Request, Result> {
  isActive(key: string): boolean;
  run(
    key: string,
    request: Request,
    waitOptions: BoundedProcessWaitOptions,
  ): Promise<Result>;
}

/**
 * Owns the safety-critical lifecycle shared by bounded helper processes. A
 * key remains admitted until the OS-level `closed` signal confirms that its
 * child has been reaped, even when the operation result settles first.
 */
export function createBoundedSingleFlightCoordinator<Request, Result>({
  exhaustedCapacityError,
  invalidCapacityError,
  maxActiveProcesses,
  start,
  validateReuse,
}: BoundedSingleFlightCoordinatorOptions<
  Request,
  Result
>): BoundedSingleFlightCoordinator<Request, Result> {
  if (!Number.isSafeInteger(maxActiveProcesses) || maxActiveProcesses <= 0) {
    throw new Error(invalidCapacityError);
  }
  const activeProcesses = new Map<
    string,
    TrackedBoundedProcess<Request, Result>
  >();

  return {
    isActive(key) {
      return activeProcesses.has(key);
    },
    async run(key, request, { signal, timeoutError, timeoutMs }) {
      signal.throwIfAborted();
      let trackedProcess = activeProcesses.get(key);
      if (trackedProcess === undefined) {
        if (activeProcesses.size >= maxActiveProcesses) {
          throw new Error(exhaustedCapacityError);
        }
        const process = start(request);
        trackedProcess = {
          cancellationRequested: false,
          process,
          request,
        };
        activeProcesses.set(key, trackedProcess);
        const startedProcess = trackedProcess;
        void process.closed.then(() => {
          if (activeProcesses.get(key) === startedProcess) {
            activeProcesses.delete(key);
          }
        });
      } else {
        validateReuse?.(trackedProcess.request, request);
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
      let timeout: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
        timeout.unref();
      });
      try {
        return await Promise.race([
          trackedProcess.process.result,
          aborted,
          timedOut,
        ]);
      } finally {
        clearTimeout(timeout);
        removeAbortListener();
        if (!trackedProcess.cancellationRequested) {
          trackedProcess.cancellationRequested = true;
          trackedProcess.process.cancel();
        }
      }
    },
  };
}

function startNodeBoundedChildProcess({
  arguments_,
  executable,
  maxOutputBytes,
  operationName,
  terminateProcess,
}: StartNodeBoundedChildProcessOptions): ActiveBoundedCommandProcess {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`${operationName} output bound is invalid`);
  }
  const child = spawn(executable, [...arguments_], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let operationSettled = false;
  let processClosed = false;
  let cancellationRequested = false;
  let resolveResult!: (value: BoundedCommandProcessCompletion) => void;
  let rejectResult!: (reason: unknown) => void;
  let resolveClosed!: () => void;
  const result = new Promise<BoundedCommandProcessCompletion>((resolve, reject) => {
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
  const resolveOperation = (value: BoundedCommandProcessCompletion) => {
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

  const capture = (
    chunks: Buffer[],
    currentBytes: number,
    chunk: Buffer,
  ): number => {
    const remainingBytes = maxOutputBytes + 1 - currentBytes;
    if (remainingBytes > 0) {
      chunks.push(Buffer.from(chunk.subarray(0, remainingBytes)));
    }
    return Math.min(maxOutputBytes + 1, currentBytes + chunk.byteLength);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
    if (stdoutBytes > maxOutputBytes) {
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes = capture(stderrChunks, stderrBytes, chunk);
    if (stderrBytes > maxOutputBytes) {
      child.kill("SIGKILL");
    }
  });
  child.once("error", (error) => {
    rejectOperation(error);
    // Only a spawn failure proves there is no child to reap. A later process
    // error can coexist with a still-live PID.
    if (child.pid === undefined) {
      confirmClosed();
    }
  });
  child.once("close", (code, signal) => {
    confirmClosed();
    if (cancellationRequested) {
      rejectOperation(new Error(`${operationName} was cancelled`));
      return;
    }
    if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
      rejectOperation(new Error(`${operationName} output exceeded its bound`));
      return;
    }
    resolveOperation({
      exitCode: code,
      signal,
      stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
      stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
    });
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
        // A helper blocked in kernel I/O may survive until Linux error recovery
        // completes, but must not retain parent event-loop handles.
        child.unref();
      }
    },
  };
}

export function createNodeBoundedChildProcessLauncher({
  maxOutputBytes,
  operationName,
  scriptPath,
  terminateProcess = (child) => void child.kill("SIGKILL"),
}: NodeBoundedChildProcessLauncherOptions): BoundedChildProcessLauncher {
  return {
    start(arguments_) {
      const activeProcess = startNodeBoundedChildProcess({
        executable: process.execPath,
        arguments_: [scriptPath, ...arguments_],
        maxOutputBytes,
        operationName,
        terminateProcess,
      });
      return {
        ...activeProcess,
        result: activeProcess.result.then(
          ({ exitCode, signal, stderr, stdout }) => {
            if (exitCode === 0) {
              return stdout;
            }
            const detail = optionalBoundedText(stderr, 500);
            throw new Error(
              `${operationName} failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${exitCode}`}`}`,
            );
          },
        ),
      };
    },
  };
}

export function createNodeBoundedCommandProcessLauncher(
  options: NodeBoundedCommandProcessLauncherOptions = {},
): BoundedCommandProcessLauncher {
  const terminateProcess =
    options.terminateProcess ?? ((child) => void child.kill("SIGKILL"));
  return {
    start(executable, arguments_, maxOutputBytes) {
      return startNodeBoundedChildProcess({
        executable,
        arguments_,
        maxOutputBytes,
        operationName: "device command",
        terminateProcess,
      });
    },
  };
}
