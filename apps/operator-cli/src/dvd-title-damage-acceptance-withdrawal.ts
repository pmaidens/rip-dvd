import {
  createApplicationOperations,
  InvalidDvdTitleDamageAcceptanceWithdrawalInputError,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleDvdTitleDamageAcceptanceWithdrawalError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

interface WithdrawalIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function archiveId(value: string | undefined) {
  const parsed = value?.trim();
  if (!parsed || parsed.length > 128) invalid("A valid archive ID is required.");
  return parsed as OriginalDiscArchiveId;
}

function previewArguments(rest: readonly string[]) {
  const [verb, rawArchiveId, ...options] = rest;
  if (verb !== "preview-withdrawal") {
    invalid("Expected catalog-review preview-withdrawal.");
  }
  if (
    options.length !== 2 || options[0] !== "--accepted-decision-id" ||
    options[1]?.trim() === ""
  ) {
    invalid("--accepted-decision-id is required.");
  }
  return {
    archiveId: archiveId(rawArchiveId),
    input: { acceptedDecisionId: options[1] },
  };
}

function withdrawalArguments(
  rest: readonly string[],
  io: WithdrawalIO,
) {
  const [verb, rawArchiveId, ...options] = rest;
  if (verb !== "withdraw-damage") {
    invalid("Expected catalog-review withdraw-damage.");
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
      if (structuredOptions.size > 0) {
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
      if (structuredOptions.size > 0) {
        invalid("Structured input options may not be repeated.");
      }
      structuredOptions.set(options[index]!, options[index + 1]!);
      index += 2;
      continue;
    }
    invalid("Invalid Title Damage Acceptance withdrawal options.");
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
    invalid("Title Damage Acceptance withdrawal requires structured JSON input.");
  }
  return {
    archiveId: archiveId(rawArchiveId),
    input: { ...(structured as Record<string, unknown>), mutationKey },
  };
}

function operationFailure(error: unknown): never {
  if (
    error instanceof InvalidDvdTitleDamageAcceptanceWithdrawalInputError ||
    error instanceof InvalidMutationKeyError
  ) {
    throw new CommandFailure("INVALID_ARGUMENTS", error.message, 2);
  }
  if (error instanceof RecordNotFoundError) {
    throw new CommandFailure("NOT_FOUND", error.message, 2);
  }
  if (error instanceof MutationKeyConflictError) {
    throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
  }
  if (error instanceof StaleDvdTitleDamageAcceptanceWithdrawalError) {
    throw new CommandFailure(error.code, error.message, 2, undefined, {
      current: error.current,
    });
  }
  if (error instanceof DomainInvariantError) {
    throw new CommandFailure(
      "TITLE_DAMAGE_ACCEPTANCE_WITHDRAWAL_REJECTED",
      error.message,
      2,
    );
  }
  throw new CommandFailure(
    "TITLE_DAMAGE_ACCEPTANCE_WITHDRAWAL_UNAVAILABLE",
    "Title Damage Acceptance withdrawal is unavailable.",
    1,
  );
}

export function runDvdTitleDamageAcceptanceWithdrawal(
  rest: readonly string[],
  io: WithdrawalIO,
): unknown {
  const parsed = rest[0] === "preview-withdrawal"
    ? previewArguments(rest)
    : withdrawalArguments(rest, io);
  const access = io.openAccess();
  try {
    const operations = createApplicationOperations(access);
    return rest[0] === "preview-withdrawal"
      ? operations.previewDvdTitleDamageAcceptanceWithdrawal(
        parsed.archiveId,
        parsed.input,
      )
      : operations.withdrawDvdTitleDamageAcceptance(
        parsed.archiveId,
        parsed.input,
      );
  } catch (error) {
    operationFailure(error);
  } finally {
    access.close();
  }
}
