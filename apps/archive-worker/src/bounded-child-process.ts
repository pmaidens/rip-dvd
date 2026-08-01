import { spawn } from "node:child_process";

import { optionalBoundedText } from "./bounded-text.js";

export interface ActiveBoundedChildProcess {
  /** Operation outcome; it may settle before the operating system reaps the child. */
  result: Promise<string>;
  /** Process-reaping authority and the only safe tombstone-release signal. */
  closed: Promise<void>;
  cancel(): void;
}

export interface BoundedChildProcessLauncher {
  start(arguments_: readonly string[]): ActiveBoundedChildProcess;
}

export interface BoundedCommandProcessCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

export interface ActiveBoundedCommandProcess {
  result: Promise<BoundedCommandProcessCompletion>;
  closed: Promise<void>;
  cancel(): void;
}

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
  let stdout = "";
  let stderr = "";
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

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const capture = (current: string, chunk: string) =>
    `${current}${chunk}`.slice(0, maxOutputBytes + 1);
  child.stdout.on("data", (chunk: string) => {
    stdout = capture(stdout, chunk);
    if (stdout.length > maxOutputBytes) {
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = capture(stderr, chunk);
    if (stderr.length > maxOutputBytes) {
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
    if (stdout.length > maxOutputBytes || stderr.length > maxOutputBytes) {
      rejectOperation(new Error(`${operationName} output exceeded its bound`));
      return;
    }
    resolveOperation({ exitCode: code, signal, stderr, stdout });
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
