import { spawn } from "node:child_process";

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

interface NodeBoundedChildProcessLauncherOptions {
  maxOutputBytes: number;
  operationName: string;
  scriptPath: string;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
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

export function createNodeBoundedChildProcessLauncher({
  maxOutputBytes,
  operationName,
  scriptPath,
  terminateProcess = (child) => void child.kill("SIGKILL"),
}: NodeBoundedChildProcessLauncherOptions): BoundedChildProcessLauncher {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`${operationName} output bound is invalid`);
  }
  return {
    start(arguments_) {
      const child = spawn(process.execPath, [scriptPath, ...arguments_], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        // Only a spawn failure proves there is no child to reap. A later
        // process error can coexist with a still-live PID.
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
        if (stdout.length > maxOutputBytes) {
          rejectOperation(new Error(`${operationName} output exceeded its bound`));
          return;
        }
        if (code === 0) {
          resolveOperation(stdout);
          return;
        }
        const detail = optionalText(stderr, 500);
        rejectOperation(
          new Error(
            `${operationName} failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${code}`}`}`,
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
            // A helper blocked in kernel I/O may survive until Linux error
            // recovery completes, but must not retain parent event-loop handles.
            child.unref();
          }
        },
      };
    },
  };
}
