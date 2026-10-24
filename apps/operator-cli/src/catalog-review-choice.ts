import {
  CatalogReviewChoiceStaleError,
  CatalogReviewChoiceUnavailableError,
  createApplicationOperations,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import {
  MutationKeyConflictError,
  RecordNotFoundError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";

interface CatalogReviewChoiceIO {
  openAccess(): DataAccess;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function options(values: readonly string[]): Map<string, string> {
  if (values.length % 2 !== 0) {
    invalid("Catalog Review choice options require values.");
  }
  const allowed = new Set([
    "--key",
    "--revision",
    "--checkpoint-revision",
    "--checkpoint-digest",
  ]);
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]!;
    const value = values[index + 1]!;
    if (
      !allowed.has(name) || parsed.has(name) || value.startsWith("--")
    ) {
      invalid("Invalid Catalog Review choice options.");
    }
    parsed.set(name, value);
  }
  if (parsed.size !== allowed.size) {
    invalid(
      "Catalog Review choice requires --key, --revision, --checkpoint-revision, and --checkpoint-digest.",
    );
  }
  return parsed;
}

export function runCatalogReviewChoice(
  rest: readonly string[],
  io: CatalogReviewChoiceIO,
): unknown {
  const [verb, rawArchiveId, ...tail] = rest;
  if (verb !== "archive-only" && verb !== "reopen") {
    invalid("Expected catalog-review archive-only or reopen.");
  }
  const archiveId = rawArchiveId?.trim();
  if (!archiveId || archiveId.length > 256) {
    invalid("A valid archive ID is required.");
  }
  const parsed = options(tail);
  const checkpointRevision = Number(parsed.get("--checkpoint-revision"));
  if (!Number.isSafeInteger(checkpointRevision) || checkpointRevision < 1) {
    invalid("Checkpoint revision must be a positive integer.");
  }
  const catalogRevision = parsed.get("--revision")!;
  const revision = new Date(catalogRevision);
  if (
    !Number.isSafeInteger(revision.getTime()) ||
    revision.toISOString() !== catalogRevision
  ) {
    invalid("Catalog revision must be an ISO timestamp.");
  }
  const checkpointDigest = parsed.get("--checkpoint-digest")!.trim();
  if (!/^[0-9a-f]{64}$/.test(checkpointDigest)) {
    invalid("Checkpoint digest is invalid.");
  }

  const access = io.openAccess();
  try {
    return createApplicationOperations(access)
      .recordCatalogReviewEvidenceChoice(
        archiveId as OriginalDiscArchiveId,
        {
          action: verb === "archive-only" ? "archive_only" : "reopen",
          catalogRevision,
          checkpointRevision,
          checkpointDigest,
        },
        parsed.get("--key"),
      );
  } catch (error) {
    if (
      error instanceof CatalogReviewChoiceUnavailableError ||
      error instanceof CatalogReviewChoiceStaleError
    ) {
      throw new CommandFailure(
        error.code,
        error.message,
        2,
        undefined,
        { reasons: error.blockingReasons, current: error.current },
      );
    }
    if (error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
    }
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    throw new CommandFailure(
      "CATALOG_REVIEW_CHOICE_UNAVAILABLE",
      "Catalog Review choice is unavailable.",
      1,
    );
  } finally {
    access.close();
  }
}
