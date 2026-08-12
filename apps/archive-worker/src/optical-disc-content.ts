import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isDvdContentId } from "@rip-dvd/data-access/dvd-scan";

import {
  createBoundedSingleFlightCoordinator,
  createNodeBoundedChildProcessLauncher,
  type ActiveBoundedChildProcess,
  type BoundedChildProcessLauncher,
} from "./bounded-child-process.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import { optionalBoundedText } from "./bounded-text.js";

const DEFAULT_CONTENT_HASH_TIMEOUT_MS = 8 * 60 * 60_000;
const DEFAULT_MAX_ACTIVE_HASHES = 32;
const MAX_CONTENT_HASH_OUTPUT_BYTES = 128;
const MAX_CONTENT_HASH_DIAGNOSTIC_BYTES = 65_536;

export interface DiscContentReader {
  hash(
    devicePath: string,
    sizeBytes: number,
    signal: AbortSignal,
    onBytesHashed?: (bytes: number) => void,
  ): Promise<string>;
}

export interface ActiveDiscContentProbe extends ActiveBoundedChildProcess {}

export interface DiscContentProbeLauncher {
  start(
    devicePath: string,
    sizeBytes: number,
    onBytesHashed?: (bytes: number) => void,
  ): ActiveDiscContentProbe;
}

interface DiscContentHashChildProcess {
  pid?: number;
  stderr: {
    destroy(): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
  };
  stdout: {
    destroy(): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
  };
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

type SpawnDiscContentHashProcess = (
  executable: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => DiscContentHashChildProcess;

interface NodeDiscContentProbeLauncherOptions {
  executablePath?: string;
  spawnProcess?: SpawnDiscContentHashProcess;
  terminateProcess?: (child: { kill(signal: NodeJS.Signals): boolean }) => void;
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
  onBytesHashed?: (bytes: number) => void;
  sizeBytes: number;
}

export interface HashProgressParser {
  diagnostics(): string;
  finish(): void;
  push(text: string): void;
}

export function createHashProgressParser(
  totalBytes: number,
  onBytesHashed: (bytes: number) => void,
): HashProgressParser {
  const safeTotalBytes = requireDvdContentSize(totalBytes);
  let buffer = "";
  let diagnosticText = "";
  let latestBytes = -1;
  const parseLine = (line: string) => {
    const match = /^\s*(\d+)\s+bytes hashed\s*$/.exec(line);
    if (match === null) {
      if (line.trim() !== "") {
        diagnosticText = `${diagnosticText}${line}\n`.slice(
          -MAX_CONTENT_HASH_DIAGNOSTIC_BYTES,
        );
      }
      return;
    }
    const bytes = Number(match[1]);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > safeTotalBytes ||
      bytes < latestBytes
    ) {
      throw new Error("DVD content hash progress returned an invalid byte count");
    }
    if (bytes > latestBytes) {
      latestBytes = bytes;
      onBytesHashed(bytes);
    }
  };
  const consume = (flush: boolean) => {
    const lines = buffer.split(/[\r\n]/);
    buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      parseLine(line);
    }
    if (flush && buffer !== "") {
      parseLine(buffer);
      buffer = "";
    }
  };
  return {
    diagnostics() {
      return diagnosticText;
    },
    finish() {
      if (buffer !== "") {
        const trailing = buffer;
        buffer = "";
        parseLine(trailing);
      }
    },
    push(text) {
      buffer += text;
      if (buffer.length > MAX_CONTENT_HASH_DIAGNOSTIC_BYTES) {
        throw new Error("DVD content hash progress line exceeded its bound");
      }
      consume(false);
    },
  };
}

export function createNodeDiscContentProbeLauncher(
  options: NodeDiscContentProbeLauncherOptions = {},
): DiscContentProbeLauncher {
  const executablePath =
    options.executablePath ?? "rip-dvd-dvdcss-reader";
  const spawnProcess = options.spawnProcess ?? (spawn as SpawnDiscContentHashProcess);
  const terminateProcess =
    options.terminateProcess ?? ((child) => void child.kill("SIGKILL"));
  return {
    start(devicePath, sizeBytes, onBytesHashed = () => {}) {
      const safeSizeBytes = requireDvdContentSize(sizeBytes);
      const child = spawnProcess(
        executablePath,
        ["hash", devicePath, String(safeSizeBytes)],
        { shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      const parser = createHashProgressParser(safeSizeBytes, onBytesHashed);
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
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
      const confirmClosed = () => {
        if (!processClosed) {
          processClosed = true;
          resolveClosed();
        }
      };
      const cancel = () => {
        if (cancellationRequested || processClosed) {
          return;
        }
        cancellationRequested = true;
        child.stdout.destroy();
        child.stderr.destroy();
        try {
          terminateProcess(child);
        } finally {
          child.unref();
        }
      };
      child.stdout.on("data", (chunk) => {
        const remaining = MAX_CONTENT_HASH_OUTPUT_BYTES + 1 - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(Buffer.from(chunk.subarray(0, remaining)));
        }
        stdoutBytes = Math.min(
          MAX_CONTENT_HASH_OUTPUT_BYTES + 1,
          stdoutBytes + chunk.byteLength,
        );
        if (stdoutBytes > MAX_CONTENT_HASH_OUTPUT_BYTES) {
          rejectOperation(new Error("DVD content hashing output exceeded its bound"));
          cancel();
        }
      });
      child.stderr.on("data", (chunk) => {
        if (operationSettled || cancellationRequested) {
          return;
        }
        try {
          parser.push(chunk.toString("utf8"));
        } catch (error) {
          rejectOperation(error);
          cancel();
        }
      });
      child.once("error", (error) => {
        rejectOperation(error);
        if (child.pid === undefined) {
          confirmClosed();
        }
      });
      child.once("close", (exitCode, signal) => {
        confirmClosed();
        if (cancellationRequested) {
          rejectOperation(new Error("DVD content hashing was cancelled"));
          return;
        }
        try {
          parser.finish();
        } catch (error) {
          rejectOperation(error);
          return;
        }
        if (exitCode !== 0) {
          const detail = optionalBoundedText(parser.diagnostics(), 500);
          rejectOperation(new Error(
            `DVD content hashing failed${detail ? `: ${detail}` : ` with ${signal ?? `status ${exitCode}`}`}`,
          ));
          return;
        }
        if (!operationSettled) {
          operationSettled = true;
          resolveResult(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"));
        }
      });
      return {
        cancel,
        closed,
        result,
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
    start(devicePath, sizeBytes, onBytesHashed) {
      const active = childLauncher.start([devicePath, String(sizeBytes)]);
      return {
        ...active,
        result: active.result.then((contentId) => {
          onBytesHashed?.(sizeBytes);
          return contentId;
        }),
      };
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
      return probeLauncher.start(
        request.devicePath,
        request.sizeBytes,
        request.onBytesHashed,
      );
    },
    validateReuse(activeRequest, requested) {
      if (activeRequest.sizeBytes !== requested.sizeBytes) {
        throw new Error("DVD content size changed while hashing was active");
      }
      throw new Error("DVD content hashing is still active");
    },
  });
  return {
    async hash(devicePath, sizeBytes, signal, onBytesHashed) {
      const safeSize = requireDvdContentSize(sizeBytes);
      const contentId = await activeHashes.run(
        devicePath,
        { devicePath, sizeBytes: safeSize, onBytesHashed },
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
