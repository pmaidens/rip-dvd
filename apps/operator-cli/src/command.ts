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
  InvalidEncodeJobInputError,
  serializeJob,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
  validateEncodeQueueSearchQuery,
  type OriginalDiscArchiveId,
  type FilesystemVerificationTarget,
  type DataAccess,
  type DiscSelectionId,
  type EncodingProfileId,
} from "@rip-dvd/data-access";
import { runDiscSelection } from "./disc-selection.js";
import { runMediaItem } from "./media-item.js";
import { runMappingProposal } from "./mapping-proposal.js";

export type CommandExitCode = 0 | 1 | 2 | 3;

interface CommandIO {
  openAccess(): DataAccess;
  mediaLibraryPath?(): string;
  getLookup?(): CatalogMetadataLookup | null;
  readStdin?(): string;
  readFile?(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

type RecoveryOperations = ReturnType<typeof createApplicationOperations>;
type RecoveryCommandSpec = {
  description: string;
  targetFlag: "--archive-request-id" | "--disc-inspection-id";
  run(operations: RecoveryOperations, mutationKey: string, id: string): unknown;
};

const recoveryCommands = {
  "cancel-archive-request": {
    description: "Cancel an Archive Request.",
    targetFlag: "--archive-request-id",
    run: (operations, mutationKey, id) =>
      operations.cancelArchiveRequest({ mutationKey, archiveRequestId: id }),
  },
  "retry-archive-request": {
    description: "Retry an Archive Request needing attention.",
    targetFlag: "--archive-request-id",
    run: (operations, mutationKey, id) =>
      operations.retryArchiveRequest({ mutationKey, archiveRequestId: id }),
  },
  "retry-disc-inspection": {
    description: "Request a Disc Inspection retry.",
    targetFlag: "--disc-inspection-id",
    run: (operations, mutationKey, id) =>
      operations.retryDiscInspection({ mutationKey, discInspectionId: id }),
  },
} satisfies Record<string, RecoveryCommandSpec>;

type RecoveryCommand = keyof typeof recoveryCommands;

function isRecoveryCommand(name: string): name is RecoveryCommand {
  return Object.hasOwn(recoveryCommands, name);
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
  ...Object.entries(recoveryCommands)
    .map(([name, command]) => ({
      name,
      description: command.description,
      usage: `rip-dvd-operator ${name} --key <key> ${command.targetFlag} <id>`,
      inputs: { arguments: [], options: ["--key", command.targetFlag] },
      example: `rip-dvd-operator ${name} --key 00000000-0000-4000-8000-000000000001 ${command.targetFlag} <id>`,
    })),
  {
    name: "submit-filesystem-verification",
    description: "Queue accessibility verification for an archive or Encode Job output.",
    usage: "rip-dvd-operator submit-filesystem-verification --key <key> --target <original_disc_archive|encode_job_output> --id <id>",
    inputs: { arguments: [], options: ["--key", "--target", "--id"] },
    example: "rip-dvd-operator submit-filesystem-verification --key 00000000-0000-4000-8000-000000000001 --target original_disc_archive --id <id>",
  },
  {
    name: "submit-archive-audit",
    description: "Queue a bounded, read-only Original Disc Archive audit.",
    usage: "rip-dvd-operator submit-archive-audit --key <key> [--limit 1..1000] [--concurrency 1..8] [--file-timeout-ms 1..30000] [--runtime-timeout-ms 1..600000]",
    inputs: {
      arguments: [],
      options: ["--key", "--limit", "--concurrency", "--file-timeout-ms", "--runtime-timeout-ms"],
    },
    example: "rip-dvd-operator submit-archive-audit --key 00000000-0000-4000-8000-000000000001 --limit 100",
  },
  {
    name: "encode-queue",
    description: "Read Encode Job options and paged history.",
    usage: "rip-dvd-operator encode-queue [--history-group not_encoded|re_encode] [--query <text>] [--encoding-profile-id <id>] [--selection-offset <n>] [--profile-offset <n>]",
    inputs: { arguments: [], options: ["--history-group", "--query", "--encoding-profile-id", "--selection-offset", "--profile-offset"] },
    example: "rip-dvd-operator encode-queue --history-group re_encode",
  },
  {
    name: "encode-resolve",
    description: "Resolve selected Disc Selections against one Encoding Profile.",
    usage: "rip-dvd-operator encode-resolve --encoding-profile-id <id> --disc-selection-id <id> [--disc-selection-id <id> ...]",
    inputs: { arguments: [], options: ["--encoding-profile-id", "--disc-selection-id (repeat up to 100)"] },
    example: "rip-dvd-operator encode-resolve --encoding-profile-id <id> --disc-selection-id <id>",
  },
  {
    name: "encode-enqueue",
    description: "Enqueue an Encode Job, deduplicating the initial logical job.",
    usage: "rip-dvd-operator encode-enqueue --key <key> --disc-selection-id <id> --encoding-profile-id <id> --output-path <absolute .mkv path> [--priority <integer>]",
    inputs: { arguments: [], options: ["--key", "--disc-selection-id", "--encoding-profile-id", "--output-path", "--priority"] },
    example: "rip-dvd-operator encode-enqueue --key 00000000-0000-4000-8000-000000000001 --disc-selection-id <id> --encoding-profile-id <id> --output-path /media/movies/example.mkv",
  },
  {
    name: "encode-requeue-preview",
    description: "Preview the current consequences of requeueing an Encode Job.",
    usage: "rip-dvd-operator encode-requeue-preview --encode-job-id <id>",
    inputs: { arguments: [], options: ["--encode-job-id"] },
    example: "rip-dvd-operator encode-requeue-preview --encode-job-id <id>",
  },
  {
    name: "encode-requeue",
    description: "Explicitly requeue a terminal Encode Job, optionally resolving a failed output conflict.",
    usage: "rip-dvd-operator encode-requeue --key <key> --encode-job-id <id> [--output-path <absolute .mkv path>] [--priority <integer>] [--revision <preview-revision> --acknowledge]",
    inputs: { arguments: [], options: ["--key", "--encode-job-id", "--output-path", "--priority", "--revision", "--acknowledge"] },
    example: "rip-dvd-operator encode-requeue --key 00000000-0000-4000-8000-000000000001 --encode-job-id <id>",
  },
  {
    name: "encode-cancel",
    description: "Cancel queued work or request cooperative cancellation of running work.",
    usage: "rip-dvd-operator encode-cancel --key <key> --encode-job-id <id>",
    inputs: { arguments: [], options: ["--key", "--encode-job-id"] },
    example: "rip-dvd-operator encode-cancel --key 00000000-0000-4000-8000-000000000001 --encode-job-id <id>",
  },
  {
    name: "catalog-review",
    description: "Inspect a Catalog Review, discover candidates, or apply a complete Mapping Proposal.",
    usage: "rip-dvd-operator catalog-review <show|suggest|apply-proposal> <archive-id> [options]",
    inputs: {
      arguments: ["show|suggest|apply-proposal", "archive-id"],
      options: [
        "show: --selection-offset, --correction-offset, --correction-job-offset, --correction-output-offset, --replacement-offset, --replacement-profile-offset",
        "suggest: --tmdb-id <positive integer> --media-type <movie|tv_show> (together, optional)",
        "apply-proposal: --key <key> and exactly one of --json <object>, --stdin, --file <path>",
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
    category: "encoding_profile",
    description: "List DVD video Encoding Profile versions and eligibility.",
    usage: "rip-dvd-operator list-encoding-profiles",
    inputs: { arguments: [], options: [] },
    example: "rip-dvd-operator list-encoding-profiles",
  },
  {
    name: "create-encoding-profile",
    category: "encoding_profile",
    description: "Create an active DVD video Encoding Profile.",
    usage: "rip-dvd-operator create-encoding-profile --key <key> --profile-key <name> --display-name <name> --preset <HandBrake preset>",
    inputs: { arguments: [], options: ["--key", "--profile-key", "--display-name", "--preset"] },
    example: "rip-dvd-operator create-encoding-profile --key 00000000-0000-4000-8000-000000000001 --profile-key dvd-example --display-name 'DVD example' --preset 'Fast 480p30'",
  },
  {
    name: "version-encoding-profile",
    category: "encoding_profile",
    description: "Create an inactive version of an Encoding Profile.",
    usage: "rip-dvd-operator version-encoding-profile --key <key> --source-profile-id <id> --preset <HandBrake preset>",
    inputs: { arguments: [], options: ["--key", "--source-profile-id", "--preset"] },
    example: "rip-dvd-operator version-encoding-profile --key 00000000-0000-4000-8000-000000000002 --source-profile-id <id> --preset 'HQ 480p30 Surround'",
  },
  {
    name: "preview-encoding-profile-state",
    category: "encoding_profile",
    description: "Preview activation or deactivation and obtain its revision.",
    usage: "rip-dvd-operator preview-encoding-profile-state --id <id> --active <true|false>",
    inputs: { arguments: [], options: ["--id", "--active"] },
    example: "rip-dvd-operator preview-encoding-profile-state --id <id> --active true",
  },
  {
    name: "activate-encoding-profile",
    category: "encoding_profile",
    description: "Activate a version using an acknowledged preview revision.",
    usage: "rip-dvd-operator activate-encoding-profile --key <key> --id <id> --revision <revision> --acknowledge",
    inputs: { arguments: [], options: ["--key", "--id", "--revision", "--acknowledge"] },
    example: "rip-dvd-operator activate-encoding-profile --key 00000000-0000-4000-8000-000000000003 --id <id> --revision <revision> --acknowledge",
  },
  {
    name: "deactivate-encoding-profile",
    category: "encoding_profile",
    description: "Deactivate a version using an acknowledged preview revision.",
    usage: "rip-dvd-operator deactivate-encoding-profile --key <key> --id <id> --revision <revision> --acknowledge",
    inputs: { arguments: [], options: ["--key", "--id", "--revision", "--acknowledge"] },
    example: "rip-dvd-operator deactivate-encoding-profile --key 00000000-0000-4000-8000-000000000004 --id <id> --revision <revision> --acknowledge",
  },
  {
    name: "media-item",
    description: "Search and maintain Media Items with keyed changes.",
    usage: "rip-dvd-operator media-item <search|show|preview|create|update|delete> [options]",
    inputs: {
      arguments: ["action", "media-item-id for show, preview, update, and delete"],
      options: [
        "search: --query <text> [--offset <number>] [--archive-id <id>]",
        "preview: <update|delete> <media-item-id>; update also requires change flags or structured input",
        "create: --key <key> --kind <kind> --title <title> [--parent-id, --year, --season-number, --episode-number, --tmdb-id, --tmdb-type]",
        "create/update: --json <object or -> or --file <path> for structured input",
        "update: <id> --key <key> plus change flags or structured input; use --acknowledge for affected changes",
        "delete: <id> --key <key> --acknowledge <preview revision>",
      ],
    },
    example: "rip-dvd-operator media-item create --key 00000000-0000-4000-8000-000000000001 --kind movie --title 'Example Film'",
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
    readonly blockingReasons?: readonly { code: string; message: string }[],
  ) {
    super(message);
  }
}

function recoveryInputs(name: RecoveryCommand, args: readonly string[]) {
  const idFlag = recoveryCommands[name].targetFlag;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if ((option !== "--key" && option !== idFlag) || !value ||
      value.startsWith("--") || options.has(option)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid recovery action options.", 2);
    }
    options.set(option, value);
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
  const id = options.get(idFlag)?.trim();
  if (options.size !== 2 || !id || id.length > 256) {
    throw new CommandFailure("INVALID_ARGUMENTS", `${idFlag} is required.`, 2);
  }
  return { mutationKey, id };
}

function runRecoveryCommand(name: RecoveryCommand, input: ReturnType<typeof recoveryInputs>, io: CommandIO) {
  try {
    return withAccess(io.openAccess, (access) => {
      const operations = createApplicationOperations(access);
      return recoveryCommands[name].run(operations, input.mutationKey, input.id);
    });
  } catch (error) {
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", "Recovery target was not found.", 2);
    }
    if (error instanceof InvalidStatusTransitionError || error instanceof DomainInvariantError) {
      throw new CommandFailure("ACTION_BLOCKED", error.message, 2,
        [{ code: "INVALID_TRANSITION", message: error.message }]);
    }
    throw new CommandFailure("RECOVERY_UNAVAILABLE", "Recovery action is unavailable.", 1);
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

function mutationOptions(
  args: readonly string[],
  allowed: readonly string[],
  invalidOptionsMessage: string,
): { options: Map<string, string>; mutationKey: string } {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !allowed.includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      options.has(name)
    ) {
      throw new CommandFailure("INVALID_ARGUMENTS", invalidOptionsMessage, 2);
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
  return { options, mutationKey };
}

function submissionInputs(args: readonly string[]): {
  mutationKey: string;
  detectedDiscId: string;
} {
  const { options, mutationKey } = mutationOptions(
    args, ["--key", "--detected-disc-id"], "Invalid Archive Request options.",
  );
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

function verificationInputs(args: readonly string[]) {
  const { options, mutationKey } = mutationOptions(
    args, ["--key", "--target", "--id"], "Invalid verification options.",
  );
  const target = options.get("--target");
  const targetId = options.get("--id")?.trim();
  if ((target !== "original_disc_archive" && target !== "encode_job_output") ||
    !targetId || targetId.length > 256) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid verification target.", 2);
  }
  return { mutationKey, target: target as FilesystemVerificationTarget, targetId };
}

function submitFilesystemVerification(
  input: ReturnType<typeof verificationInputs>,
  openAccess: CommandIO["openAccess"],
) {
  let access: DataAccess | undefined;
  try {
    access = openAccess();
    return createApplicationOperations(access).submitFilesystemVerification(input);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("VERIFICATION_TARGET_NOT_FOUND", "Verification target not found.", 2);
    }
    throw new CommandFailure("VERIFICATION_UNAVAILABLE", "Verification submission is unavailable.", 1);
  } finally {
    access?.close();
  }
}

function archiveAuditInputs(args: readonly string[]) {
  const { options, mutationKey } = mutationOptions(
    args,
    ["--key", "--limit", "--concurrency", "--file-timeout-ms", "--runtime-timeout-ms"],
    "Invalid archive audit options.",
  );
  const bounded = (name: string, fallback: number, maximum: number) => {
    const raw = options.get(name);
    if (raw === undefined) return fallback;
    const value = positiveInteger(raw);
    if (value === null || value > maximum) {
      throw new CommandFailure("INVALID_ARGUMENTS", `Invalid ${name} value.`, 2);
    }
    return value;
  };
  return {
    mutationKey,
    bounds: {
      recordLimit: bounded("--limit", 100, 1_000),
      concurrency: bounded("--concurrency", 2, 8),
      fileTimeoutMs: bounded("--file-timeout-ms", 5_000, 30_000),
      runtimeTimeoutMs: bounded("--runtime-timeout-ms", 120_000, 600_000),
    },
  };
}

function submitArchiveAudit(
  input: ReturnType<typeof archiveAuditInputs>,
  openAccess: CommandIO["openAccess"],
) {
  let access: DataAccess | undefined;
  try {
    access = openAccess();
    return createApplicationOperations(access).submitArchiveAudit(input);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    throw new CommandFailure(
      "ARCHIVE_AUDIT_UNAVAILABLE",
      "Archive audit submission is unavailable.",
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



const profileCommands = commandDefinitions.filter(
  (definition) => "category" in definition && definition.category === "encoding_profile",
);

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

function mutationKeyFromOptions(options: Map<string, string>): string {
  try {
    return parseMutationKey(options.get("--key"));
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    throw error;
  }
}

function runProfileCommand(name: string, args: readonly string[], openAccess: CommandIO["openAccess"]) {
  const definition = profileCommands.find((item) => item.name === name);
  if (!definition) {
    throw new CommandFailure("UNKNOWN_COMMAND", "Unknown command.", 2);
  }
  const allowedOptions: readonly string[] = definition.inputs.options;
  const options = profileOptions(args, allowedOptions);
  const mutationKey = allowedOptions.includes("--key")
    ? mutationKeyFromOptions(options) : undefined;
  let access: DataAccess | undefined;
  try {
    access = openAccess();
    const operations = createApplicationOperations(access);
    switch (name) {
      case "list-encoding-profiles":
        return operations.listEncodingProfiles();
      case "create-encoding-profile":
        return operations.createEncodingProfile({
          mutationKey, key: options.get("--profile-key"),
          displayName: options.get("--display-name"),
          settings: { preset: options.get("--preset"), container: "mkv" },
        });
      case "version-encoding-profile":
        return operations.createEncodingProfileVersion({
          mutationKey, sourceProfileId: options.get("--source-profile-id"),
          settings: { preset: options.get("--preset"), container: "mkv" },
        });
      case "preview-encoding-profile-state":
        return operations.previewEncodingProfileState({
          id: options.get("--id"),
          isActive: options.get("--active") === "true" ? true :
            options.get("--active") === "false" ? false : undefined,
        });
      case "activate-encoding-profile":
      case "deactivate-encoding-profile":
        return operations.setEncodingProfileActive({
          mutationKey, id: options.get("--id"),
          isActive: name === "activate-encoding-profile",
          expectedRevision: options.get("--revision"),
          acknowledge: options.has("--acknowledge"),
        });
      default:
        throw new CommandFailure("UNKNOWN_COMMAND", "Unknown command.", 2);
    }
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

function encodeOptions(
  rest: readonly string[],
  repeatable?: string,
  booleanOptions: readonly string[] = [],
): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (let index = 0; index < rest.length;) {
    const name = rest[index]!;
    if (!name.startsWith("--") || (options.has(name) && name !== repeatable)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Encode options.", 2);
    }
    if (booleanOptions.includes(name)) {
      options.set(name, ["true"]);
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Encode options require values.", 2);
    }
    options.set(name, [...(options.get(name) ?? []), value]);
    index += 2;
  }
  return options;
}

function onlyEncodeOptions(options: Map<string, string[]>, allowed: readonly string[]): void {
  if ([...options.keys()].some((name) => !allowed.includes(name))) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Unknown Encode option.", 2);
  }
}

function encodeId(options: Map<string, string[]>, name: string): string {
  const value = options.get(name)?.[0]?.trim();
  if (!value || value.length > 256) {
    throw new CommandFailure("INVALID_ARGUMENTS", `${name} requires an ID.`, 2);
  }
  return value;
}

function encodeKey(options: Map<string, string[]>): string {
  try {
    return parseMutationKey(options.get("--key")?.[0]);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    throw error;
  }
}

function encodeOffset(options: Map<string, string[]>, name: string): number {
  const value = options.get(name)?.[0];
  const parsed = value === undefined ? 0 : nonnegativeInteger(value);
  if (parsed === null) {
    throw new CommandFailure("INVALID_ARGUMENTS", `${name} requires a nonnegative integer.`, 2);
  }
  return parsed;
}

function encodePriority(options: Map<string, string[]>): number | undefined {
  const value = options.get("--priority")?.[0];
  if (value === undefined) return undefined;
  if (!/^-?(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Encode priority.", 2);
  }
  return Number(value);
}

function encodeMediaLibraryPath(io: CommandIO): string {
  try {
    return io.mediaLibraryPath?.() ?? loadConfig().mediaLibraryPath;
  } catch {
    throw new CommandFailure("CONFIGURATION_ERROR", "Media library configuration is unavailable.", 1);
  }
}

function runEncodeCommand(name: string, rest: readonly string[], io: CommandIO) {
  const options = encodeOptions(
    rest,
    name === "encode-resolve" ? "--disc-selection-id" : undefined,
    name === "encode-requeue" ? ["--acknowledge"] : [],
  );
  const permitted: Record<string, string[]> = {
    "encode-queue": ["--history-group", "--query", "--encoding-profile-id", "--selection-offset", "--profile-offset"],
    "encode-resolve": ["--encoding-profile-id", "--disc-selection-id"],
    "encode-enqueue": ["--key", "--disc-selection-id", "--encoding-profile-id", "--output-path", "--priority"],
    "encode-requeue-preview": ["--encode-job-id"],
    "encode-requeue": ["--key", "--encode-job-id", "--output-path", "--priority", "--revision", "--acknowledge"],
    "encode-cancel": ["--key", "--encode-job-id"],
  };
  onlyEncodeOptions(options, permitted[name]!);
  let mutationKey: string | undefined;
  if (["encode-enqueue", "encode-requeue", "encode-cancel"].includes(name)) {
    mutationKey = encodeKey(options);
  }
  const mediaLibraryPath = name === "encode-cancel" || name === "encode-resolve" ||
    name === "encode-requeue-preview"
    ? undefined : encodeMediaLibraryPath(io);
  const priority = encodePriority(options);
  const rawQuery = options.get("--query")?.[0];
  const queryValidation = rawQuery === undefined ? undefined : validateEncodeQueueSearchQuery(rawQuery);
  if (queryValidation !== undefined && !queryValidation.valid) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Disc Selection search query.", 2);
  }
  const query = queryValidation?.valid ? queryValidation.query : undefined;
  const historyGroup = options.get("--history-group")?.[0] ?? "not_encoded";
  if (historyGroup !== "not_encoded" && historyGroup !== "re_encode") {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Encode Job history group.", 2);
  }
  const selectionIds = options.get("--disc-selection-id");
  if (name === "encode-resolve" &&
    (!selectionIds?.length || selectionIds.length > 100 ||
      selectionIds.some((id) => id.trim().length === 0 || id.length > 256))) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Expected 1 to 100 Disc Selection IDs.", 2);
  }
  try {
    return withAccess(io.openAccess, (access) => {
      const operations = createApplicationOperations(access);
      if (name === "encode-queue") {
        return operations.encodeQueueOptions({
          mediaLibraryPath: mediaLibraryPath!,
          selectionOffset: encodeOffset(options, "--selection-offset"),
          profileOffset: encodeOffset(options, "--profile-offset"),
          historyGroup, query,
          encodingProfileId: options.has("--encoding-profile-id")
            ? encodeId(options, "--encoding-profile-id") as EncodingProfileId
            : undefined,
        });
      }
      if (name === "encode-resolve") {
        return {
          resolvedDiscSelections: operations.resolveEncodeQueue({
            encodingProfileId: encodeId(options, "--encoding-profile-id") as EncodingProfileId,
            discSelectionIds: selectionIds!.map((id) => id.trim()) as DiscSelectionId[],
          }),
        };
      }
      if (name === "encode-requeue-preview") {
        return operations.previewEncodeRequeue({
          encodeJobId: encodeId(options, "--encode-job-id"),
        });
      }
      const job = name === "encode-enqueue"
        ? operations.enqueueEncodeJob({
          mutationKey,
          discSelectionId: encodeId(options, "--disc-selection-id"),
          encodingProfileId: encodeId(options, "--encoding-profile-id"),
          outputPath: options.get("--output-path")?.[0], priority,
          mediaLibraryPath: mediaLibraryPath!,
        })
        : name === "encode-requeue"
          ? operations.requeueEncodeJob({
            mutationKey, encodeJobId: encodeId(options, "--encode-job-id"),
            outputPath: options.get("--output-path")?.[0], priority,
            expectedRevision: options.get("--revision")?.[0],
            acknowledgeReplacement: options.has("--acknowledge"),
            mediaLibraryPath: mediaLibraryPath!,
          })
          : operations.cancelEncodeJob({
            mutationKey, encodeJobId: encodeId(options, "--encode-job-id"),
          });
      return { job: serializeJob(job), work: { kind: "encode-jobs", id: job.id } };
    });
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof InvalidEncodeJobInputError) {
      throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    }
    if (error instanceof DomainInvariantError && error.message.includes("preview is stale")) {
      throw new CommandFailure("STALE_ENCODE_PREVIEW", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    if (error instanceof DomainInvariantError || error instanceof InvalidStatusTransitionError) {
      throw new CommandFailure("ENCODE_JOB_REJECTED", error.message, 2);
    }
    throw new CommandFailure("ENCODE_JOB_UNAVAILABLE", "Encode Job operation is unavailable.", 1);
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
    if (isRecoveryCommand(name)) {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, runRecoveryCommand(name, recoveryInputs(name, rest), io));
      return 0;
    }
    if (name === "submit-filesystem-verification") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, submitFilesystemVerification(verificationInputs(rest), io.openAccess));
      return 0;
    }
    if (name === "submit-archive-audit") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, submitArchiveAudit(archiveAuditInputs(rest), io.openAccess));
      return 0;
    }
    if (name === "catalog-review") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, rest[0] === "apply-proposal"
        ? runMappingProposal(rest.slice(1), io)
        : await runCatalogReview(rest, io));
      return 0;
    }
    if (["encode-queue", "encode-resolve", "encode-enqueue", "encode-requeue-preview", "encode-requeue", "encode-cancel"].includes(name)) {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
      } else {
        emit(io.stdout, runEncodeCommand(name, rest, io));
      }
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
    if (name === "media-item") {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      try {
        emit(io.stdout, await runMediaItem(rest, io));
      } catch (error) {
        if (error instanceof CommandFailure) throw error;
        if (error instanceof MutationKeyConflictError) {
          throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
        }
        if (error instanceof RecordNotFoundError) {
          throw new CommandFailure("MEDIA_ITEM_NOT_FOUND", "Media Item not found.", 2);
        }
        if (error instanceof DomainInvariantError) {
          throw new CommandFailure(
            error.message.includes("changed; preview") ? "STALE_MEDIA_ITEM_REVISION" : "MEDIA_ITEM_ACTION_REJECTED",
            error.message,
            2,
          );
        }
        throw new CommandFailure("MEDIA_ITEM_UNAVAILABLE", "Media Item operation is unavailable.", 1);
      }
      return 0;
    }
    if (profileCommands.some((command) => command.name === name)) {
      if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
        emit(io.stdout, help(name));
        return 0;
      }
      emit(io.stdout, runProfileCommand(name, rest, io.openAccess));
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
      emit(io.stdout, { error: { code: error.code, message: error.message,
        ...(error.blockingReasons ? { blockingReasons: error.blockingReasons } : {}) } });
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
