import {
  createApplicationOperations,
  InvalidMutationKeyError,
  parseMutationKey,
} from "@rip-dvd/application";
import { parseCatalogReviewCommand } from "@rip-dvd/application/catalog-review-command";
import {
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  MutationKeyConflictError,
  RecordNotFoundError,
  type DataAccess,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

interface RearchiveMappingProposalIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

const inputOptions = new Set(["--key", "--json", "--stdin", "--file"]);

export function runRearchiveMappingProposal(
  action: "preview" | "save",
  rest: readonly string[],
  io: RearchiveMappingProposalIO,
): unknown {
  const [archiveId, ...args] = rest;
  if (!archiveId || archiveId.trim() !== archiveId || archiveId.length > 256 ||
      archiveId.startsWith("--")) {
    throw new CommandFailure(
      "INVALID_ARGUMENTS",
      "A valid archive ID is required.",
      2,
    );
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!inputOptions.has(name) || options.has(name) ||
        (action === "preview" && name === "--key")) {
      throw new CommandFailure(
        "INVALID_ARGUMENTS",
        "Invalid Re-archive Mapping Proposal option.",
        2,
      );
    }
    if (name === "--stdin") {
      options.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new CommandFailure(
        "INVALID_ARGUMENTS",
        `Option ${name} requires a value.`,
        2,
      );
    }
    options.set(name, value);
  }
  let mutationKey: string | undefined;
  if (action === "save") {
    try {
      mutationKey = parseMutationKey(options.get("--key"));
    } catch (error) {
      if (error instanceof InvalidMutationKeyError) {
        throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
      }
      throw error;
    }
  }
  let input: unknown;
  try {
    input = readStructuredObject(options, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (input === undefined) {
    throw new CommandFailure(
      "INVALID_ARGUMENTS",
      "A JSON Re-archive Mapping Proposal is required.",
      2,
    );
  }
  const parsed = parseCatalogReviewCommand(input, {
    mediaItemKinds: MEDIA_ITEM_KINDS,
  });
  const expectedAction = action === "preview"
    ? "preview_rearchive_mapping_proposal"
    : "save_rearchive_mapping_proposal";
  if (!parsed.ok || parsed.command.action !== expectedAction) {
    throw new CommandFailure(
      "INVALID_REARCHIVE_PROPOSAL",
      parsed.ok
        ? `Expected ${expectedAction}.`
        : parsed.error,
      2,
    );
  }

  let access: DataAccess | undefined;
  try {
    access = io.openAccess();
    const operations = createApplicationOperations(access);
    const operationInput = {
      originalDiscArchiveId: archiveId,
      catalogRevision: parsed.command.catalogRevision,
      sourceCatalogRevision: parsed.command.sourceCatalogRevision,
      mappings: parsed.command.mappings,
    };
    return action === "preview"
      ? operations.previewRearchiveMappingProposal(operationInput)
      : operations.saveRearchiveMappingProposal({
          ...operationInput,
          mutationKey,
        });
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("REARCHIVE_PROPOSAL_NOT_FOUND", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      const state = ["stale", "incomplete", "incompatible"].find(
        (candidate) => error.message.endsWith(candidate),
      );
      throw new CommandFailure(
        state === "stale"
          ? "STALE_CATALOG_REVISION"
          : state === "incomplete"
            ? "REARCHIVE_PROPOSAL_INCOMPLETE"
            : state === "incompatible"
              ? "REARCHIVE_PROPOSAL_INCOMPATIBLE"
              : "REARCHIVE_PROPOSAL_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure(
      "REARCHIVE_PROPOSAL_UNAVAILABLE",
      "Re-archive Mapping Proposal is unavailable.",
      1,
    );
  } finally {
    access?.close();
  }
}
