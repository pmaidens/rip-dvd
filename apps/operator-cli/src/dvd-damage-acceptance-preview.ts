import {
  createApplicationOperations,
  InvalidDvdDamageAcceptancePreviewInputError,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  RecordNotFoundError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";

interface DvdDamageAcceptancePreviewIO {
  openAccess(): DataAccess;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseArguments(rest: readonly string[]) {
  const [verb, rawArchiveId, ...options] = rest;
  if (verb !== "preview-damage-acceptance") {
    invalid("Expected catalog-review preview-damage-acceptance.");
  }
  const archiveId = rawArchiveId?.trim();
  if (!archiveId || archiveId.length > 128) {
    invalid("A valid archive ID is required.");
  }
  const excludedTitleIdentityIds: string[] = [];
  for (let index = 0; index < options.length; index += 2) {
    if (
      options[index] !== "--exclude-title-identity" ||
      index + 1 >= options.length
    ) {
      invalid("Invalid damage acceptance preflight options.");
    }
    excludedTitleIdentityIds.push(options[index + 1]!);
  }
  return {
    archiveId: archiveId as OriginalDiscArchiveId,
    excludedTitleIdentityIds,
  };
}

export function runDvdDamageAcceptancePreview(
  rest: readonly string[],
  io: DvdDamageAcceptancePreviewIO,
): unknown {
  const input = parseArguments(rest);
  const access = io.openAccess();
  try {
    return createApplicationOperations(access).previewDvdDamageAcceptance(
      input.archiveId,
      { excludedTitleIdentityIds: input.excludedTitleIdentityIds },
    );
  } catch (error) {
    if (error instanceof InvalidDvdDamageAcceptancePreviewInputError) {
      throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        "DAMAGE_ACCEPTANCE_PREFLIGHT_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure(
      "DAMAGE_ACCEPTANCE_PREFLIGHT_UNAVAILABLE",
      "Damage acceptance preflight is unavailable.",
      1,
    );
  } finally {
    access.close();
  }
}
