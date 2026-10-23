import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

export interface BoundedRawCommandProcessCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: Buffer;
  stdout: Buffer;
}

export interface StartNodeBoundedCommandProcessOptions {
  arguments_: readonly string[];
  executable: string;
  extraFileDescriptors?: readonly number[];
  maxOutputBytes: number;
  operationName: string;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
}

export interface StartNodeAuthorizedBoundedCommandProcessOptions
  extends StartNodeBoundedCommandProcessOptions {
  authorizationPayload: string;
  authorizationReadyMessage: string;
}

export interface ActiveAuthorizedBoundedCommandProcess
  extends ActiveBoundedProcess<BoundedRawCommandProcessCompletion> {
  /** Resolves only after the helper holds its inherited resources and is gated. */
  ready: Promise<void>;
  /** Releases the helper to begin the operation after durable admission. */
  authorize(): void;
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
  extraFileDescriptors?: readonly number[];
  maxOutputBytes: number;
  operationName: string;
  terminateProcess: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
  authorization?: {
    payload: string;
    readyMessage: string;
  };
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

type BoundedProcessWaitOptions = {
  signal: AbortSignal;
} & ({
  timeoutError: string;
  timeoutMs: number;
} | {
  timeoutError?: never;
  timeoutMs?: never;
});

export interface BoundedSingleFlightCoordinator<Request, Result> {
  isActive(key: string): boolean;
  /** Resolves only when the OS-level close signal releases the tombstone. */
  waitForInactive(key: string): Promise<void>;
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
    async waitForInactive(key) {
      await activeProcesses.get(key)?.process.closed;
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
        if (signal.aborted) onAbort();
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
      let timeout: NodeJS.Timeout | undefined;
      const outcomes = [trackedProcess.process.result, aborted];
      if (timeoutMs !== undefined) {
        outcomes.push(new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
          timeout.unref();
        }));
      }
      try {
        return await Promise.race(outcomes);
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
  authorization,
  arguments_,
  executable,
  extraFileDescriptors = [],
  maxOutputBytes,
  operationName,
  terminateProcess,
}: StartNodeBoundedChildProcessOptions): ActiveBoundedProcess<
  BoundedRawCommandProcessCompletion
> & Partial<Pick<ActiveAuthorizedBoundedCommandProcess, "authorize" | "ready">> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`${operationName} output bound is invalid`);
  }
  const child = spawn(executable, [...arguments_], {
    shell: false,
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      ...extraFileDescriptors,
      ...(authorization === undefined ? [] : ["pipe", "pipe"] as const),
    ],
  });
  if (child.stdout === null || child.stderr === null) {
    child.kill("SIGKILL");
    throw new Error(`${operationName} pipes are unavailable`);
  }
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const authorizationReadyPipe = authorization === undefined
    ? undefined
    : child.stdio[3 + extraFileDescriptors.length] as Readable | null;
  const authorizationInputPipe = authorization === undefined
    ? undefined
    : child.stdio[4 + extraFileDescriptors.length] as Writable | null;
  if (
    authorization !== undefined &&
    (authorizationReadyPipe == null || authorizationInputPipe == null)
  ) {
    child.kill("SIGKILL");
    throw new Error(`${operationName} authorization pipes are unavailable`);
  }
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let operationSettled = false;
  let processClosed = false;
  let cancellationRequested = false;
  let authorizationGranted = false;
  let authorizationReadySettled = false;
  let authorizationReadyAccepted = false;
  let authorizationReadyBuffer = "";
  let resolveResult!: (value: BoundedRawCommandProcessCompletion) => void;
  let rejectResult!: (reason: unknown) => void;
  let resolveClosed!: () => void;
  const result = new Promise<BoundedRawCommandProcessCompletion>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = authorization === undefined
    ? undefined
    : new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
  const rejectAuthorizationReady = (error: unknown) => {
    if (authorization !== undefined && !authorizationReadySettled) {
      authorizationReadySettled = true;
      rejectReady(error);
    }
  };
  const rejectOperation = (error: unknown) => {
    if (!operationSettled) {
      operationSettled = true;
      rejectResult(error);
    }
  };
  const resolveOperation = (value: BoundedRawCommandProcessCompletion) => {
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
  const rejectAuthorization = (error: unknown) => {
    rejectAuthorizationReady(error);
    rejectOperation(error);
    if (!processClosed) child.kill("SIGKILL");
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
  childStdout.on("data", (chunk: Buffer) => {
    stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
    if (stdoutBytes > maxOutputBytes) {
      child.kill("SIGKILL");
    }
  });
  childStderr.on("data", (chunk: Buffer) => {
    stderrBytes = capture(stderrChunks, stderrBytes, chunk);
    if (stderrBytes > maxOutputBytes) {
      child.kill("SIGKILL");
    }
  });
  authorizationReadyPipe?.on("data", (chunk: Buffer) => {
    if (authorizationReadySettled) return;
    authorizationReadyBuffer += chunk.toString("utf8");
    if (
      authorizationReadyBuffer.length > authorization!.readyMessage.length ||
      !authorization!.readyMessage.startsWith(authorizationReadyBuffer)
    ) {
      rejectAuthorizationReady(
        new Error(`${operationName} authorization readiness is malformed`),
      );
      child.kill("SIGKILL");
      return;
    }
    if (authorizationReadyBuffer === authorization!.readyMessage) {
      authorizationReadySettled = true;
      authorizationReadyAccepted = true;
      resolveReady();
    }
  });
  authorizationReadyPipe?.on("error", rejectAuthorization);
  authorizationInputPipe?.on("error", rejectAuthorization);
  child.once("error", (error) => {
    rejectOperation(error);
    rejectAuthorizationReady(error);
    // Only a spawn failure proves there is no child to reap. A later process
    // error can coexist with a still-live PID.
    if (child.pid === undefined) {
      confirmClosed();
    }
  });
  child.once("close", (code, signal) => {
    confirmClosed();
    rejectAuthorizationReady(
      new Error(`${operationName} closed before authorization`),
    );
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
      stderr: Buffer.concat(stderrChunks, stderrBytes),
      stdout: Buffer.concat(stdoutChunks, stdoutBytes),
    });
  });

  const active: ActiveBoundedProcess<BoundedRawCommandProcessCompletion> &
    Partial<Pick<ActiveAuthorizedBoundedCommandProcess, "authorize" | "ready">> = {
    result,
    closed,
    cancel() {
      if (cancellationRequested || processClosed) {
        return;
      }
      cancellationRequested = true;
      childStdout.destroy();
      childStderr.destroy();
      authorizationReadyPipe?.destroy();
      authorizationInputPipe?.destroy();
      rejectAuthorizationReady(
        new Error(`${operationName} was cancelled before authorization`),
      );
      try {
        terminateProcess(child);
      } finally {
        // A helper blocked in kernel I/O may survive until Linux error recovery
        // completes, but must not retain parent event-loop handles.
        child.unref();
      }
    },
  };
  if (authorization !== undefined && ready !== undefined) {
    active.ready = ready;
    active.authorize = () => {
      if (
        !authorizationReadySettled ||
        !authorizationReadyAccepted ||
        authorizationGranted ||
        cancellationRequested ||
        processClosed
      ) {
        throw new Error(`${operationName} authorization is unavailable`);
      }
      authorizationGranted = true;
      authorizationInputPipe!.end(authorization.payload);
    };
  }
  return active;
}

export function startNodeBoundedCommandProcess({
  terminateProcess = (child) => void child.kill("SIGKILL"),
  ...options
}: StartNodeBoundedCommandProcessOptions): ActiveBoundedProcess<
  BoundedRawCommandProcessCompletion
> {
  return startNodeBoundedChildProcess({ ...options, terminateProcess });
}

export function startNodeAuthorizedBoundedCommandProcess({
  authorizationPayload,
  authorizationReadyMessage,
  terminateProcess = (child) => void child.kill("SIGKILL"),
  ...options
}: StartNodeAuthorizedBoundedCommandProcessOptions):
  ActiveAuthorizedBoundedCommandProcess {
  if (authorizationReadyMessage.length === 0) {
    throw new Error(`${options.operationName} authorization message is invalid`);
  }
  const active = startNodeBoundedChildProcess({
    ...options,
    authorization: {
      payload: authorizationPayload,
      readyMessage: authorizationReadyMessage,
    },
    terminateProcess,
  });
  if (active.ready === undefined || active.authorize === undefined) {
    throw new Error(`${options.operationName} authorization is unavailable`);
  }
  return active as ActiveAuthorizedBoundedCommandProcess;
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
              return stdout.toString("utf8");
            }
            const detail = optionalBoundedText(stderr.toString("utf8"), 500);
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
      const activeProcess = startNodeBoundedCommandProcess({
        executable,
        arguments_,
        maxOutputBytes,
        operationName: "device command",
        terminateProcess,
      });
      return {
        ...activeProcess,
        result: activeProcess.result.then(
          ({ exitCode, signal, stderr, stdout }) => ({
            exitCode,
            signal,
            stderr: stderr.toString("utf8"),
            stdout: stdout.toString("utf8"),
          }),
        ),
      };
    },
  };
}
