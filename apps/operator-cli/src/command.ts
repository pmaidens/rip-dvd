import { createApplicationOperations } from "@rip-dvd/application";
import type { DataAccess } from "@rip-dvd/data-access";

export type CommandExitCode = 0 | 1 | 2;

interface CommandIO {
  openAccess(): DataAccess;
  stdout(text: string): void;
  stderr(text: string): void;
}

const commandDefinitions = [
  {
    name: "health",
    description: "Check application database health.",
    usage: "rip-dvd-operator health",
    inputs: { arguments: [], options: [] },
    example: "rip-dvd-operator health",
  },
  {
    name: "readiness",
    description: "Inspect active work and Optical Drives for deployment readiness.",
    usage: "rip-dvd-operator readiness",
    inputs: { arguments: [], options: [] },
    example: "rip-dvd-operator readiness",
  },
  {
    name: "commands",
    description: "List supported command names.",
    usage: "rip-dvd-operator commands",
    inputs: { arguments: [], options: [] },
    example: "rip-dvd-operator commands",
  },
  {
    name: "help",
    description: "Show command usage and examples.",
    usage: "rip-dvd-operator help [command]",
    inputs: { arguments: ["command (optional)"], options: [] },
    example: "rip-dvd-operator help health",
  },
] as const;

export class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: CommandExitCode,
  ) {
    super(message);
  }
}

function emit(stdout: CommandIO["stdout"], value: unknown): void {
  stdout(`${JSON.stringify(value)}\n`);
}

function help(command?: string) {
  if (command === undefined) {
    return {
      schemaVersion: 1,
      usage: "rip-dvd-operator <command>",
      commands: commandDefinitions,
      help: "rip-dvd-operator help <command>",
    };
  }
  const definition = commandDefinitions.find((item) => item.name === command);
  if (!definition) {
    throw new CommandFailure("UNKNOWN_COMMAND", "Unknown command.", 2);
  }
  return { schemaVersion: 1, command: definition };
}

function runOperation(
  name: "health" | "readiness",
  openAccess: CommandIO["openAccess"],
) {
  let access: DataAccess | undefined;
  try {
    access = openAccess();
    const operations = createApplicationOperations(access);
    return operations[name]();
  } catch (error) {
    if (error instanceof CommandFailure) {
      throw error;
    }
    throw new CommandFailure(
      name === "health" ? "HEALTH_UNAVAILABLE" : "READINESS_UNAVAILABLE",
      name === "health"
        ? "Application health is unavailable."
        : "Application readiness is unavailable.",
      1,
    );
  } finally {
    access?.close();
  }
}

export function runCommand(args: readonly string[], io: CommandIO): CommandExitCode {
  try {
    const [name, ...rest] = args;
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      if (rest.length > 1 || ((name === "--help" || name === "-h") && rest.length > 0)) {
        throw new CommandFailure("INVALID_ARGUMENTS", "Too many arguments.", 2);
      }
      emit(io.stdout, help(rest[0]));
      return 0;
    }
    if (name === "commands") {
      if (rest.length > 0) {
        throw new CommandFailure("INVALID_ARGUMENTS", "The commands command takes no arguments.", 2);
      }
      emit(io.stdout, {
        schemaVersion: 1,
        commands: commandDefinitions.map(({ name }) => name),
      });
      return 0;
    }
    if (name !== "health" && name !== "readiness") {
      throw new CommandFailure("UNKNOWN_COMMAND", "Unknown command.", 2);
    }
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      emit(io.stdout, help(name));
      return 0;
    }
    if (rest.length > 0) {
      throw new CommandFailure("INVALID_ARGUMENTS", `${name} takes no arguments.`, 2);
    }
    emit(io.stdout, runOperation(name, io.openAccess));
    return 0;
  } catch (error) {
    if (error instanceof CommandFailure) {
      emit(io.stdout, { error: { code: error.code, message: error.message } });
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    emit(io.stdout, {
      error: { code: "INTERNAL_ERROR", message: "The command could not complete." },
    });
    io.stderr("The command could not complete.\n");
    return 1;
  }
}
