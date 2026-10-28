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
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

interface DvdTitleDamageAcceptancePreviewIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseArguments(
  rest: readonly string[],
  io: DvdTitleDamageAcceptancePreviewIO,
) {
  const [verb, rawArchiveId, ...options] = rest;
  if (
    verb !== "preview-damage-acceptance" &&
    verb !== "preview-title-damage-acceptance"
  ) {
    invalid("Expected catalog-review preview-damage-acceptance.");
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
  const structuredOptions = new Map<string, string>();
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
    if (options[index] === "--stdin") {
      if (structuredOptions.has("--stdin")) {
        invalid("Structured input options may not be repeated.");
      }
      structuredOptions.set("--stdin", "true");
      index += 1;
      continue;
    }
    if (
      (options[index] === "--json" || options[index] === "--file") &&
      index + 1 < options.length
    ) {
      const name = options[index]!;
      if (structuredOptions.has(name)) {
        invalid("Structured input options may not be repeated.");
      }
      structuredOptions.set(name, options[index + 1]!);
      index += 2;
      continue;
    }
    invalid("Invalid Title Damage Acceptance preflight options.");
  }
  let structuredInput: unknown;
  try {
    structuredInput = readStructuredObject(structuredOptions, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (
    structuredInput !== undefined &&
    (excludedTitleIdentityIds.length > 0 || mainFeatureResolutions.length > 0)
  ) {
    invalid("Choose flags or one structured input form, not both.");
  }
  return {
    archiveId: archiveId as OriginalDiscArchiveId,
    input: structuredInput ?? {
      excludedTitleIdentityIds,
      mainFeatureResolutions,
    },
  };
}

export function runDvdTitleDamageAcceptancePreview(
  rest: readonly string[],
  io: DvdTitleDamageAcceptancePreviewIO,
): unknown {
  const input = parseArguments(rest, io);
  const access = io.openAccess();
  try {
    return createApplicationOperations(access).previewDvdTitleDamageAcceptance(
      input.archiveId,
      input.input,
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
