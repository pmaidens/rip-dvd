import {
  createApplicationOperations,
  createTmdbCatalogLookup,
  generateMutationKey,
  InvalidMutationKeyError,
  parseMutationKey,
  tmdbCredentialFromEnvironment,
  type CatalogMetadataLookup,
  type CatalogMetadataSelection,
  type CatalogReviewPageCoordinates,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
  type OriginalDiscArchiveId,
  type DataAccess,
} from "@rip-dvd/data-access";

export type CommandExitCode = 0 | 1 | 2;

interface CommandIO {
  openAccess(): DataAccess;
  getLookup?(): CatalogMetadataLookup | null;
  stdout(text: string): void;
  stderr(text: string): void;
}

const commandDefinitions = [
  {
    name: "generate-key",
    description: "Generate a mutation key without submitting work.",
    usage: "rip-dvd-operator generate-key",
    inputs: { arguments: [], options: [] },
    example: "rip-dvd-operator generate-key",
  },
  {
    name: "submit-archive-request",
    description: "Submit an Archive Request for a Detected Disc.",
    usage: "rip-dvd-operator submit-archive-request --key <key> --detected-disc-id <id>",
    inputs: { arguments: [], options: ["--key", "--detected-disc-id"] },
    example: "rip-dvd-operator submit-archive-request --key 00000000-0000-4000-8000-000000000001 --detected-disc-id <id>",
  },
  {
    name: "catalog-review",
    description: "Inspect an archive's Catalog Review or discover metadata candidates.",
    usage: "rip-dvd-operator catalog-review <show|suggest> <archive-id> [options]",
    inputs: {
      arguments: ["show|suggest", "archive-id"],
      options: [
        "show: --selection-offset, --correction-offset, --correction-job-offset, --correction-output-offset, --replacement-offset, --replacement-profile-offset",
        "suggest: --tmdb-id <positive integer> --media-type <movie|tv_show> (together, optional)",
      ],
    },
    example: "rip-dvd-operator catalog-review show <archive-id>",
  },
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

function submissionInputs(args: readonly string[]): {
  mutationKey: string;
  detectedDiscId: string;
} {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== "--key" && name !== "--detected-disc-id") ||
      value === undefined ||
      value.startsWith("--") ||
      options.has(name)
    ) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Archive Request options.", 2);
    }
    options.set(name, value);
  }
  let mutationKey: string;
  try {
    mutationKey = parseMutationKey(options.get("--key"));
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    throw error;
  }
  const detectedDiscId = options.get("--detected-disc-id")?.trim();
  if (!detectedDiscId) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Detected Disc ID is required.", 2);
  }
  return { mutationKey, detectedDiscId };
}

function submitArchiveRequest(
  input: ReturnType<typeof submissionInputs>,
  openAccess: CommandIO["openAccess"],
) {
  let access: DataAccess | undefined;
  try {
    access = openAccess();
    return createApplicationOperations(access).submitArchiveRequest(input);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("DETECTED_DISC_NOT_FOUND", "Detected Disc not found.", 2);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      throw new CommandFailure(
        "ARCHIVE_REQUEST_REJECTED",
        "Archive Request is not eligible.",
        2,
      );
    }
    throw new CommandFailure(
      "ARCHIVE_REQUEST_UNAVAILABLE",
      "Archive Request submission is unavailable.",
      1,
    );
  } finally {
    access?.close();
  }
}

const reviewOffsets = {
  "--selection-offset": "discSelectionOffset",
  "--correction-offset": "correctionHistoryOffset",
  "--correction-job-offset": "correctionEncodeHistoryOffset",
  "--correction-output-offset": "correctionRetainedOutputHistoryOffset",
  "--replacement-offset": "replacementOffset",
  "--replacement-profile-offset": "replacementProfileOffset",
} as const;

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function nonnegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function reviewArguments(rest: readonly string[]):
  | { action: "show"; id: OriginalDiscArchiveId; coordinates: CatalogReviewPageCoordinates }
  | { action: "suggest"; id: OriginalDiscArchiveId; selection?: CatalogMetadataSelection } {
  const [action, id, ...options] = rest;
  if (action !== "show" && action !== "suggest") {
    throw new CommandFailure("INVALID_ARGUMENTS", "Expected catalog-review show or suggest.", 2);
  }
  if (!id || id.trim().length === 0 || id.length > 256) {
    throw new CommandFailure("INVALID_ARGUMENTS", "A valid archive ID is required.", 2);
  }
  if (options.length % 2 !== 0) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Catalog Review options require values.", 2);
  }
  const parsed = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]!;
    if (parsed.has(key)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Catalog Review options must be unique.", 2);
    }
    parsed.set(key, options[index + 1]!);
  }
  if (action === "show") {
    const coordinates: CatalogReviewPageCoordinates = {
      discSelectionOffset: 0,
      correctionHistoryOffset: 0,
      correctionEncodeHistoryOffset: 0,
      correctionRetainedOutputHistoryOffset: 0,
      replacementOffset: 0,
      replacementProfileOffset: 0,
    };
    for (const [key, value] of parsed) {
      const field = reviewOffsets[key as keyof typeof reviewOffsets];
      const offset = nonnegativeInteger(value);
      if (field === undefined || offset === null) {
        throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Catalog Review offset.", 2);
      }
      coordinates[field] = offset;
    }
    return { action, id: id as OriginalDiscArchiveId, coordinates };
  }
  if ([...parsed.keys()].some((key) => key !== "--tmdb-id" && key !== "--media-type")) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Catalog suggestion option.", 2);
  }
  const tmdbId = parsed.get("--tmdb-id");
  const mediaType = parsed.get("--media-type");
  if ((tmdbId === undefined) !== (mediaType === undefined)) {
    throw new CommandFailure("INVALID_ARGUMENTS", "TMDB ID and media type must be supplied together.", 2);
  }
  let selection: CatalogMetadataSelection | undefined;
  if (tmdbId !== undefined) {
    const number = positiveInteger(tmdbId);
    if (number === null || (mediaType !== "movie" && mediaType !== "tv_show")) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid TMDB selection.", 2);
    }
    selection = { id: number, kind: mediaType };
  }
  return { action, id: id as OriginalDiscArchiveId, selection };
}

async function runCatalogReview(rest: readonly string[], io: CommandIO) {
  const input = reviewArguments(rest);
  let access: DataAccess | undefined;
  try {
    access = io.openAccess();
    const operations = createApplicationOperations(access);
    const credential = tmdbCredentialFromEnvironment();
    const result = input.action === "show"
      ? operations.catalogReview(
        input.id,
        input.coordinates,
        credential !== null,
      )
      : await operations.catalogSuggestion(
        input.id,
        io.getLookup ? io.getLookup() : credential === null ? null : createTmdbCatalogLookup(credential),
        input.selection,
      );
    if (result === null) {
      throw new CommandFailure("REVIEW_NOT_FOUND", "Original Disc Archive not found.", 2);
    }
    return result;
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("CATALOG_REVIEW_UNAVAILABLE", "Catalog Review is unavailable.", 1);
  } finally {
    access?.close();
  }
}

export async function runCommand(args: readonly string[], io: CommandIO): Promise<CommandExitCode> {
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
    if (name === "generate-key") {
      if (rest.length > 0) {
        throw new CommandFailure("INVALID_ARGUMENTS", "generate-key takes no arguments.", 2);
      }
      emit(io.stdout, { mutationKey: generateMutationKey() });
      return 0;
    }
    if (name === "submit-archive-request") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, submitArchiveRequest(submissionInputs(rest), io.openAccess));
      return 0;
    }
    if (name === "catalog-review") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, await runCatalogReview(rest, io));
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
