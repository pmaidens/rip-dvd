import {
  createApplicationOperations,
  InvalidMutationKeyError,
  InvalidDvdTitleDamageAcceptanceInputError,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleDvdTitleDamageDecisionError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

interface DvdTitleDamageAcceptanceIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseArguments(
  rest: readonly string[],
  io: DvdTitleDamageAcceptanceIO,
) {
  const [verb, rawArchiveId, ...options] = rest;
  if (verb !== "accept-damage") {
    invalid("Expected catalog-review accept-damage.");
  }
  const archiveId = rawArchiveId?.trim();
  if (!archiveId || archiveId.length > 128) {
    invalid("A valid archive ID is required.");
  }
  const structuredOptions = new Map<string, string>();
  let mutationKey: string | undefined;
  for (let index = 0; index < options.length;) {
    if (options[index] === "--key" && index + 1 < options.length) {
      if (mutationKey !== undefined) invalid("--key may not be repeated.");
      mutationKey = options[index + 1];
      index += 2;
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
    if ((options[index] === "--json" || options[index] === "--file") &&
        index + 1 < options.length) {
      const name = options[index]!;
      if (structuredOptions.has(name)) {
        invalid("Structured input options may not be repeated.");
      }
      structuredOptions.set(name, options[index + 1]!);
      index += 2;
      continue;
    }
    invalid("Invalid Title Damage Acceptance options.");
  }
  if (mutationKey === undefined) invalid("--key is required.");
  let structured: unknown;
  try {
    structured = readStructuredObject(structuredOptions, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (structured === undefined) {
    invalid("Title Damage Acceptance requires structured JSON input.");
  }
  return {
    archiveId: archiveId as OriginalDiscArchiveId,
    input: { ...(structured as Record<string, unknown>), mutationKey },
  };
}

export function runDvdTitleDamageAcceptance(
  rest: readonly string[],
  io: DvdTitleDamageAcceptanceIO,
): unknown {
  const parsed = parseArguments(rest, io);
  const access = io.openAccess();
  try {
    return createApplicationOperations(access).acceptDvdTitleDamage(
      parsed.archiveId,
      parsed.input,
    );
  } catch (error) {
    if (error instanceof InvalidDvdTitleDamageAcceptanceInputError ||
        error instanceof InvalidMutationKeyError) {
      throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("NOT_FOUND", error.message, 2);
    }
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof StaleDvdTitleDamageDecisionError) {
      throw new CommandFailure(error.code, error.message, 2, undefined, {
        current: error.currentIdentities,
      });
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        "TITLE_DAMAGE_ACCEPTANCE_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure(
      "TITLE_DAMAGE_ACCEPTANCE_UNAVAILABLE",
      "Title Damage Acceptance is unavailable.",
      1,
    );
  } finally {
    access.close();
  }
}
