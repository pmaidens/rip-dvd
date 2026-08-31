import {
  createBoundedSingleFlightCoordinator,
  createNodeBoundedCommandProcessLauncher,
  type BoundedCommandProcessLauncher,
} from "./bounded-child-process.js";

export const OPTICAL_DRIVE_COMMAND_TIMEOUT_MS = 90_000;
export const MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES = 1_048_576;

const DEFAULT_MAX_ACTIVE_COMMANDS = 32;

interface CommandOutput {
  stdout: string;
  stderr: string;
}

export type CommandResult = CommandOutput &
  (
    | { exitCode: number; signal?: null }
    | { exitCode: null; signal: NodeJS.Signals }
  );

export interface CommandRunnerOptions {
  maxBufferBytes: number;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface CommandRunner {
  run(
    executable: string,
    arguments_: readonly string[],
    options: CommandRunnerOptions,
  ): Promise<CommandResult>;
}

interface NodeCommandRunnerOptions {
  maxActiveCommands?: number;
  processLauncher?: BoundedCommandProcessLauncher;
}

interface CommandProcessRequest {
  arguments_: readonly string[];
  executable: string;
  maxOutputBytes: number;
}

export function createNodeCommandRunner(
  options: NodeCommandRunnerOptions = {},
): CommandRunner {
  const maxActiveCommands =
    options.maxActiveCommands ?? DEFAULT_MAX_ACTIVE_COMMANDS;
  const processLauncher =
    options.processLauncher ?? createNodeBoundedCommandProcessLauncher();
  const activeCommands = createBoundedSingleFlightCoordinator({
    maxActiveProcesses: maxActiveCommands,
    invalidCapacityError: "device command capacity is invalid",
    exhaustedCapacityError: "device command capacity is exhausted",
    start(request: CommandProcessRequest) {
      return processLauncher.start(
        request.executable,
        request.arguments_,
        request.maxOutputBytes,
      );
    },
    validateReuse(activeRequest, requested) {
      if (activeRequest.maxOutputBytes !== requested.maxOutputBytes) {
        throw new Error("device command output bound changed while active");
      }
    },
  });
  return {
    async run(executable, arguments_, commandOptions) {
      if (
        !Number.isSafeInteger(commandOptions.timeoutMs) ||
        commandOptions.timeoutMs <= 0
      ) {
        throw new Error("device command timeout is invalid");
      }
      if (
        !Number.isSafeInteger(commandOptions.maxBufferBytes) ||
        commandOptions.maxBufferBytes <= 0
      ) {
        throw new Error("device command output bound is invalid");
      }
      const commandKey = JSON.stringify([executable, ...arguments_]);
      const completion = await activeCommands.run(
        commandKey,
        {
          executable,
          arguments_,
          maxOutputBytes: commandOptions.maxBufferBytes,
        },
        {
          signal: commandOptions.signal,
          timeoutError: "device command timed out",
          timeoutMs: commandOptions.timeoutMs,
        },
      );
      if (completion.exitCode === null) {
        if (completion.signal === null) {
          throw new Error("device command ended without an exit status or signal");
        }
        return {
          exitCode: null,
          signal: completion.signal,
          stderr: completion.stderr,
          stdout: completion.stdout,
        };
      }
      return {
        exitCode: completion.exitCode,
        signal: null,
        stderr: completion.stderr,
        stdout: completion.stdout,
      };
    },
  };
}

export const nodeCommandRunner = createNodeCommandRunner();

export function textReportsNoMedium(value: string): boolean {
  return /\bENOMEDIUM\b|no medium found|medium not present/i.test(value);
}

export function reportsNoMedium(result: CommandResult): boolean {
  return textReportsNoMedium(
    `${result.stdout}\n${result.stderr}`,
  );
}

export function textReportsDriveUnavailable(value: string): boolean {
  return /\b(?:EACCES|EPERM|ENOENT|ENODEV)\b|permission denied|operation not permitted|access denied|not authorized|no such (?:file or directory|device(?: or address)?)/i.test(
    value,
  );
}

export function reportsDriveUnavailable(result: CommandResult): boolean {
  return textReportsDriveUnavailable(
    `${result.stdout}\n${result.stderr}`,
  );
}

export function commandFailure(tool: string, result: CommandResult): Error {
  const detail = (result.stderr || result.stdout)
    .replaceAll(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
  const outcome = result.exitCode === null
    ? `terminated by signal ${result.signal}`
    : `exited with status ${result.exitCode}`;
  return new Error(
    `${tool} ${outcome}${detail ? `: ${detail}` : ""}`,
  );
}
