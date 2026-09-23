import {
  createApplicationOperations,
  InvalidMutationKeyError,
  parseCatalogReviewCommand,
  type RearchiveAcceptanceCommand,
} from "@rip-dvd/application";
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

interface AcceptanceIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

const acceptanceOptions = new Set([
  "--key",
  "--revision",
  "--source-revision",
  "--preview-token",
  "--acknowledge",
  "--json",
  "--stdin",
  "--file",
]);

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function options(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!acceptanceOptions.has(name) || parsed.has(name)) {
      invalid("Invalid or repeated Re-archive Acceptance option.");
    }
    if (name === "--acknowledge" || name === "--stdin") {
      parsed.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      invalid(`Re-archive Acceptance option ${name} requires a value.`);
    }
    parsed.set(name, value);
  }
  return parsed;
}

function command(
  parsedOptions: Map<string, string>,
  io: AcceptanceIO,
): RearchiveAcceptanceCommand {
  let value: unknown;
  try {
    value = readStructuredObject(parsedOptions, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (value === undefined) {
    invalid("Re-archive Acceptance requires JSON input.");
  }
  const result = parseCatalogReviewCommand(value, {
    mediaItemKinds: MEDIA_ITEM_KINDS,
  });
  if (!result.ok || result.command.action !== "accept_rearchive") {
    throw new CommandFailure(
      "INVALID_REARCHIVE_ACCEPTANCE",
      result.ok ? "Expected an accept_rearchive command." : result.error,
      2,
    );
  }
  return result.command;
}

export function runRearchiveAcceptance(
  rest: readonly string[],
  io: AcceptanceIO,
): unknown {
  const [verb, archiveId, ...tail] = rest;
  if (
    verb !== "preview-rearchive-acceptance" &&
    verb !== "accept-rearchive"
  ) {
    invalid("Expected preview-rearchive-acceptance or accept-rearchive.");
  }
  if (
    !archiveId || archiveId.trim() !== archiveId || archiveId.length > 256 ||
    archiveId.startsWith("--")
  ) {
    invalid("A valid Original Disc Archive ID is required.");
  }
  const parsedOptions = options(tail);
  const acceptance = command(parsedOptions, io);
  if (verb === "preview-rearchive-acceptance") {
    if ([
      "--key",
      "--revision",
      "--source-revision",
      "--preview-token",
      "--acknowledge",
    ].some((name) => parsedOptions.has(name))) {
      invalid("Acceptance preview does not take a key or acknowledgement.");
    }
  } else if (!parsedOptions.has("--acknowledge")) {
    invalid("Acknowledgement of a Re-archive Acceptance preview is required.");
  }

  let access: DataAccess | undefined;
  try {
    access = io.openAccess();
    const operations = createApplicationOperations(access);
    return verb === "preview-rearchive-acceptance"
      ? operations.previewRearchiveAcceptance(
          archiveId as OriginalDiscArchiveId,
          acceptance,
        )
      : operations.acceptRearchive(
          archiveId as OriginalDiscArchiveId,
          acceptance,
          {
            mutationKey: parsedOptions.get("--key"),
            acknowledgedRevision: parsedOptions.get("--revision"),
            acknowledgedSourceRevision:
              parsedOptions.get("--source-revision"),
            previewToken: parsedOptions.get("--preview-token"),
            acknowledge: true,
          },
        );
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
        error.message.includes("preview is stale")
          ? "STALE_REARCHIVE_ACCEPTANCE_PREVIEW"
          : "REARCHIVE_ACCEPTANCE_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure(
      "REARCHIVE_ACCEPTANCE_UNAVAILABLE",
      "Re-archive Acceptance is unavailable.",
      1,
    );
  } finally {
    access?.close();
  }
}
