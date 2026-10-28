import {
  createApplicationOperations,
  InvalidDvdTitleDamageAcceptancePreviewInputError,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  RecordNotFoundError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";

interface DvdTitleDamageAcceptancePreviewIO {
  openAccess(): DataAccess;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseArguments(rest: readonly string[]) {
  const [verb, rawArchiveId, ...options] = rest;
  if (verb !== "preview-title-damage-acceptance") {
    invalid("Expected catalog-review preview-title-damage-acceptance.");
  }
  const archiveId = rawArchiveId?.trim();
  if (!archiveId || archiveId.length > 128) {
    invalid("A valid archive ID is required.");
  }
  const excludedTitleIdentityIds: string[] = [];
  const mainFeatureResolutions: Array<{
    discSelectionId: string;
    titleIdentityId: string;
  }> = [];
  for (let index = 0; index < options.length;) {
    if (options[index] === "--exclude-title-identity" &&
        index + 1 < options.length) {
      excludedTitleIdentityIds.push(options[index + 1]!);
      index += 2;
      continue;
    }
    if (options[index] === "--resolve-main-feature" &&
        index + 2 < options.length) {
      mainFeatureResolutions.push({
        discSelectionId: options[index + 1]!,
        titleIdentityId: options[index + 2]!,
      });
      index += 3;
      continue;
    }
    invalid("Invalid Title Damage Acceptance preflight options.");
  }
  return {
    archiveId: archiveId as OriginalDiscArchiveId,
    excludedTitleIdentityIds,
    mainFeatureResolutions,
  };
}

export function runDvdTitleDamageAcceptancePreview(
  rest: readonly string[],
  io: DvdTitleDamageAcceptancePreviewIO,
): unknown {
  const input = parseArguments(rest);
  const access = io.openAccess();
  try {
    return createApplicationOperations(access).previewDvdTitleDamageAcceptance(
      input.archiveId,
      {
        excludedTitleIdentityIds: input.excludedTitleIdentityIds,
        mainFeatureResolutions: input.mainFeatureResolutions,
      },
    );
  } catch (error) {
    if (error instanceof InvalidDvdTitleDamageAcceptancePreviewInputError) {
      throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        "TITLE_DAMAGE_ACCEPTANCE_PREFLIGHT_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure(
      "TITLE_DAMAGE_ACCEPTANCE_PREFLIGHT_UNAVAILABLE",
      "Title Damage Acceptance preflight is unavailable.",
      1,
    );
  } finally {
    access.close();
  }
}
