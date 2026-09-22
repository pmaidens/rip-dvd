import {
  createApplicationOperations,
  createTmdbCatalogLookup,
  generateMutationKey,
  InvalidMutationKeyError,
  InvalidProfileInputError,
  parseMutationKey,
  inspectOperations,
  isOperationKind,
  isWaitableKind,
  OPERATION_KINDS,
  validOperationLimit,
  waitForOperation,
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
import { runDiscSelection } from "./disc-selection.js";

export type CommandExitCode = 0 | 1 | 2 | 3;

interface CommandIO {
  openAccess(): DataAccess;
  getLookup?(): CatalogMetadataLookup | null;
  readStdin?(): string;
  readFile?(path: string): string;
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
    name: "disc-selection",
    description: "Inspect and change an eligible Disc Selection.",
    usage: "rip-dvd-operator disc-selection <show|preview|create|update|repair|correct|delete> [action] <archive-id> [selection-id] [options]",
    inputs: {
      arguments: ["action (required after preview)", "archive-id", "selection-id (except create)"],
      options: ["mutations: --key <key>", "mapping updates, repair, correct, delete: --revision <catalog-revision> --preview-token <token> --acknowledge",
        "selection input: flags or --json <object> or --stdin or --file <path>"],
    },
    example: "rip-dvd-operator disc-selection create <archive-id> --key <key> --media-item-id <id> --source-kind main_feature",
  },
  {
    name: "list-encoding-profiles",
    description: "List DVD video Encoding Profile versions and eligibility.",
    usage: "rip-dvd-operator list-encoding-profiles",
    inputs: { arguments: [], options: [] },
    example: "rip-dvd-operator list-encoding-profiles",
  },
  {
    name: "create-encoding-profile",
    description: "Create an active DVD video Encoding Profile.",
    usage: "rip-dvd-operator create-encoding-profile --key <key> --profile-key <name> --display-name <name> --preset <HandBrake preset>",
    inputs: { arguments: [], options: ["--key", "--profile-key", "--display-name", "--preset"] },
    example: "rip-dvd-operator create-encoding-profile --key 00000000-0000-4000-8000-000000000001 --profile-key dvd-example --display-name 'DVD example' --preset 'Fast 480p30'",
  },
  {
    name: "version-encoding-profile",
    description: "Create an inactive version of an Encoding Profile.",
    usage: "rip-dvd-operator version-encoding-profile --key <key> --source-profile-id <id> --preset <HandBrake preset>",
    inputs: { arguments: [], options: ["--key", "--source-profile-id", "--preset"] },
    example: "rip-dvd-operator version-encoding-profile --key 00000000-0000-4000-8000-000000000002 --source-profile-id <id> --preset 'HQ 480p30 Surround'",
  },
  {
    name: "preview-encoding-profile-state",
    description: "Preview activation or deactivation and obtain its revision.",
    usage: "rip-dvd-operator preview-encoding-profile-state --id <id> --active <true|false>",
    inputs: { arguments: [], options: ["--id", "--active"] },
    example: "rip-dvd-operator preview-encoding-profile-state --id <id> --active true",
  },
  {
    name: "activate-encoding-profile",
    description: "Activate a version using an acknowledged preview revision.",
    usage: "rip-dvd-operator activate-encoding-profile --key <key> --id <id> --revision <revision> --acknowledge",
    inputs: { arguments: [], options: ["--key", "--id", "--revision", "--acknowledge"] },
    example: "rip-dvd-operator activate-encoding-profile --key 00000000-0000-4000-8000-000000000003 --id <id> --revision <revision> --acknowledge",
  },
  {
    name: "deactivate-encoding-profile",
    description: "Deactivate a version using an acknowledged preview revision.",
    usage: "rip-dvd-operator deactivate-encoding-profile --key <key> --id <id> --revision <revision> --acknowledge",
    inputs: { arguments: [], options: ["--key", "--id", "--revision", "--acknowledge"] },
    example: "rip-dvd-operator deactivate-encoding-profile --key 00000000-0000-4000-8000-000000000004 --id <id> --revision <revision> --acknowledge",
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
    name: "inspect",
    description: "List operational records or inspect one record and its evidence.",
    usage: "rip-dvd-operator inspect <kind> [id] [--limit 1..100]",
    inputs: {
      arguments: [`kind: ${OPERATION_KINDS.join(", ")}`, "id (optional)"],
      options: ["--limit 1..100 (lists only; default 50)"],
    },
    example: "rip-dvd-operator inspect disc-inspections synthetic-id",
  },
  {
    name: "wait",
    description: "Wait for existing background work without changing it.",
    usage: "rip-dvd-operator wait <kind> <id> --timeout-ms <0..3600000> [--poll-ms 100..5000]",
    inputs: {
      arguments: ["kind", "id"],
      options: ["--timeout-ms 0..3600000 (required)", "--poll-ms 100..5000 (default 500)"],
    },
    example: "rip-dvd-operator wait archive-requests synthetic-id --timeout-ms 30000",
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
    const lookup = io.getLookup
      ? io.getLookup()
      : credential === null ? null : createTmdbCatalogLookup(credential);
    const result = input.action === "show"
      ? operations.catalogReview(
        input.id,
        input.coordinates,
        lookup !== null,
      )
      : await operations.catalogSuggestion(
        input.id,
        lookup,
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

function withAccess<T>(openAccess: CommandIO["openAccess"], read: (access: DataAccess) => T): T {
  const access = openAccess();
  try {
    return read(access);
  } finally {
    access.close();
  }
}

function numericOption(rest: readonly string[], flag: string): number | undefined {
  const index = rest.indexOf(flag);
  if (index === -1) return undefined;
  if (index !== rest.lastIndexOf(flag) || index === rest.length - 1 ||
    !/^\d+$/.test(rest[index + 1]!)) {
    throw new CommandFailure("INVALID_ARGUMENTS", `Invalid ${flag} option.`, 2);
  }
  return Number(rest[index + 1]);
}

function inspectCommand(rest: readonly string[], io: CommandIO) {
  const [kind, id] = rest;
  if (kind === undefined || !isOperationKind(kind)) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Unknown operation kind.", 2);
  }
  const optionIndex = rest.indexOf("--limit");
  const positional = optionIndex === -1 ? rest : rest.slice(0, optionIndex);
  const limit = numericOption(rest, "--limit");
  if (positional.length > 2 || (optionIndex !== -1 && optionIndex !== rest.length - 2) ||
    (limit !== undefined && (!validOperationLimit(limit) || positional.length === 2)) ||
    (kind === "activity" && positional.length === 2) ||
    (positional.length === 2 && (id === undefined || id.length === 0 ||
      id.length > 256 || id.startsWith("--")))) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid inspect arguments.", 2);
  }
  try {
    const result = withAccess(io.openAccess, (access) =>
      inspectOperations(access, kind, { ...(positional.length === 2 ? { id } : {}), limit }));
    if ("item" in result && result.item === null) {
      throw new CommandFailure("NOT_FOUND", "Operational record was not found.", 2);
    }
    return result;
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("INSPECTION_UNAVAILABLE", "Operational inspection is unavailable.", 1);
  }
}

function waitArguments(rest: readonly string[]) {
  const [kind, id] = rest;
  const timeoutMs = numericOption(rest, "--timeout-ms");
  const pollMs = numericOption(rest, "--poll-ms") ?? 500;
  const flags = rest.slice(2);
  const expectedCount = 2 + (flags.includes("--poll-ms") ? 2 : 0);
  if (kind === undefined || !isWaitableKind(kind) || !id || id.length > 256 ||
    timeoutMs === undefined || !Number.isSafeInteger(timeoutMs) || timeoutMs > 3_600_000 ||
    !Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 5_000 ||
    flags.length !== expectedCount ||
    !flags.includes("--timeout-ms") ||
    (flags.some((flag, index) => index % 2 === 0 &&
      flag !== "--timeout-ms" && flag !== "--poll-ms"))) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid wait arguments.", 2);
  }
  return { kind, id, timeoutMs, pollMs };
}

const profileCommands = [
  "list-encoding-profiles", "create-encoding-profile", "version-encoding-profile",
  "preview-encoding-profile-state", "activate-encoding-profile",
  "deactivate-encoding-profile",
] as const;

function profileOptions(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length;) {
    const name = args[index]!;
    if (!allowed.includes(name) || options.has(name)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Encoding Profile options.", 2);
    }
    if (name === "--acknowledge") {
      options.set(name, "true");
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Encoding Profile options.", 2);
    }
    options.set(name, value);
    index += 2;
  }
  return options;
}

function profileKey(options: Map<string, string>): string {
  try {
    return parseMutationKey(options.get("--key"));
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    throw error;
  }
}

function runProfileCommand(name: typeof profileCommands[number], args: readonly string[], openAccess: CommandIO["openAccess"]) {
  const allowed: Record<typeof profileCommands[number], readonly string[]> = {
    "list-encoding-profiles": [],
    "create-encoding-profile": ["--key", "--profile-key", "--display-name", "--preset"],
    "version-encoding-profile": ["--key", "--source-profile-id", "--preset"],
    "preview-encoding-profile-state": ["--id", "--active"],
    "activate-encoding-profile": ["--key", "--id", "--revision", "--acknowledge"],
    "deactivate-encoding-profile": ["--key", "--id", "--revision", "--acknowledge"],
  };
  const options = profileOptions(args, allowed[name]);
  const mutationKey = name === "create-encoding-profile" || name === "version-encoding-profile" ||
    name === "activate-encoding-profile" || name === "deactivate-encoding-profile"
    ? profileKey(options) : undefined;
  let access: DataAccess | undefined;
  try {
    access = openAccess();
    const operations = createApplicationOperations(access);
    if (name === "list-encoding-profiles") return operations.listEncodingProfiles();
    if (name === "create-encoding-profile") return operations.createEncodingProfile({
      mutationKey, key: options.get("--profile-key"), displayName: options.get("--display-name"),
      settings: { preset: options.get("--preset"), container: "mkv" },
    });
    if (name === "version-encoding-profile") return operations.createEncodingProfileVersion({
      mutationKey, sourceProfileId: options.get("--source-profile-id"),
      settings: { preset: options.get("--preset"), container: "mkv" },
    });
    if (name === "preview-encoding-profile-state") return operations.previewEncodingProfileState({
      id: options.get("--id"),
      isActive: options.get("--active") === "true" ? true :
        options.get("--active") === "false" ? false : undefined,
    });
    return operations.setEncodingProfileActive({
      mutationKey, id: options.get("--id"), isActive: name === "activate-encoding-profile",
      expectedRevision: options.get("--revision"),
      acknowledge: options.has("--acknowledge"),
    });
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("ENCODING_PROFILE_NOT_FOUND", "Encoding Profile not found.", 2);
    }
    if (error instanceof InvalidProfileInputError || error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_ENCODING_PROFILE", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        error.message.includes("stale") ? "STALE_PROFILE_PREVIEW" : "ENCODING_PROFILE_REJECTED",
        error.message, 2,
      );
    }
    throw new CommandFailure("ENCODING_PROFILE_UNAVAILABLE", "Encoding Profiles are unavailable.", 1);
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
    if (name === "inspect") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
      } else {
        emit(io.stdout, inspectCommand(rest, io));
      }
      return 0;
    }
    if (name === "wait") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      const { kind, id, timeoutMs, pollMs } = waitArguments(rest);
      let access: DataAccess | undefined;
      try {
        access = io.openAccess();
        const result = await waitForOperation(access, kind, id, timeoutMs, pollMs);
        if (result.outcome === "not_found") {
          throw new CommandFailure("NOT_FOUND", "Operational record was not found.", 2);
        }
        emit(io.stdout, result);
        return result.outcome === "timeout" ? 3 : 0;
      } catch (error) {
        if (error instanceof CommandFailure) throw error;
        throw new CommandFailure("WAIT_UNAVAILABLE", "Operational wait is unavailable.", 1);
      } finally {
        access?.close();
      }
    }
    if (name === "disc-selection") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, runDiscSelection(rest, io));
      return 0;
    }
    if (profileCommands.some((command) => command === name)) {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, runProfileCommand(name as typeof profileCommands[number], rest, io.openAccess));
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
