import {
  createApplicationOperations,
  InvalidMutationKeyError,
  parseCatalogReviewCommand,
  type CatalogReviewCompletionCommand,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleCatalogRevisionError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

interface CompletionIO extends StructuredInputIO {
  openAccess(): DataAccess;
  mediaLibraryPath?(): string;
}

const completionOptions = new Set([
  "--key",
  "--revision",
  "--preview-token",
  "--acknowledge",
  "--json",
  "--stdin",
  "--file",
]);

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!completionOptions.has(name) || options.has(name)) {
      invalid("Invalid or repeated Catalog Review completion option.");
    }
    if (name === "--acknowledge" || name === "--stdin") {
      options.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      invalid(`Catalog Review completion option ${name} requires a value.`);
    }
    options.set(name, value);
  }
  return options;
}

function requiredId(value: string | undefined): OriginalDiscArchiveId {
  if (!value || value.trim() !== value || value.length > 256) {
    invalid("A valid Original Disc Archive ID is required.");
  }
  return value as OriginalDiscArchiveId;
}

function completionCommand(
  options: Map<string, string>,
  io: CompletionIO,
): CatalogReviewCompletionCommand {
  let value: unknown;
  try {
    value = readStructuredObject(options, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (value === undefined) {
    invalid("Catalog Review completion requires JSON input.");
  }
  const parsed = parseCatalogReviewCommand(value, {
    mediaItemKinds: MEDIA_ITEM_KINDS,
  });
  if (!parsed.ok || parsed.command.action !== "complete_review") {
    throw new CommandFailure(
      "INVALID_COMPLETION_PLAN",
      parsed.ok ? "Expected a complete_review command." : parsed.error,
      2,
    );
  }
  return parsed.command;
}

function mediaLibraryPath(io: CompletionIO): string {
  try {
    return io.mediaLibraryPath?.() ?? loadConfig().mediaLibraryPath;
  } catch {
    throw new CommandFailure(
      "CONFIGURATION_ERROR",
      "Media library configuration is unavailable.",
      1,
    );
  }
}

function withCompletionAccess<T>(
  io: CompletionIO,
  operation: (access: DataAccess, mediaPath: string) => T,
): T {
  let access: DataAccess | undefined;
  try {
    const configuredMediaPath = mediaLibraryPath(io);
    access = io.openAccess();
    return operation(access, configuredMediaPath);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    if (error instanceof StaleCatalogRevisionError) {
      throw new CommandFailure("STALE_CATALOG_REVISION", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        "REVIEW_COMPLETION_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure(
      "REVIEW_COMPLETION_UNAVAILABLE",
      "Catalog Review completion is unavailable.",
      1,
    );
  } finally {
    access?.close();
  }
}

export function runCatalogReviewCompletion(
  rest: readonly string[],
  io: CompletionIO,
): unknown {
  const [verb, rawArchiveId, ...tail] = rest;
  if (verb !== "preview-completion" && verb !== "complete") {
    invalid("Expected preview-completion or complete.");
  }
  const archiveId = requiredId(rawArchiveId);
  const options = parseOptions(tail);
  const command = completionCommand(options, io);
  if (verb === "preview-completion") {
    if (["--key", "--revision", "--preview-token", "--acknowledge"].some(
      (name) => options.has(name),
    )) {
      invalid("Completion preview does not take a key or acknowledgement.");
    }
    return withCompletionAccess(io, (access, configuredMediaPath) =>
      createApplicationOperations(access).previewCatalogReviewCompletion(
        archiveId,
        command,
        configuredMediaPath,
      )
    );
  }
  if (!options.has("--acknowledge")) {
    invalid("Acknowledgement of a Catalog Review completion preview is required.");
  }
  return withCompletionAccess(io, (access, configuredMediaPath) =>
    createApplicationOperations(access).completeCatalogReview(
      archiveId,
      command,
      {
        mediaLibraryPath: configuredMediaPath,
        mutationKey: options.get("--key"),
        acknowledgedRevision: options.get("--revision"),
        previewToken: options.get("--preview-token"),
        acknowledge: true,
      },
    )
  );
}
