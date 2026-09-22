import {
  applyMappingProposal,
  InvalidMutationKeyError,
  parseMutationKey,
  type MappingProposalCommand,
} from "@rip-dvd/application";
import { parseCatalogReviewCommand } from "@rip-dvd/application/catalog-review-command";
import {
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  MutationKeyConflictError,
  RecordNotFoundError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import { readStructuredObject, StructuredInputError, type StructuredInputIO } from "./structured-input.js";

interface MappingProposalIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

const inputOptions = new Set(["--key", "--json", "--stdin", "--file"]);

export function runMappingProposal(rest: readonly string[], io: MappingProposalIO): unknown {
  const [archiveId, ...args] = rest;
  if (!archiveId || archiveId.trim() !== archiveId || archiveId.length > 256 ||
      archiveId.startsWith("--")) {
    throw new CommandFailure("INVALID_ARGUMENTS", "A valid archive ID is required.", 2);
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!inputOptions.has(name) || options.has(name)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Mapping Proposal option.", 2);
    }
    if (name === "--stdin") {
      options.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new CommandFailure("INVALID_ARGUMENTS", `Option ${name} requires a value.`, 2);
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
    throw new CommandFailure("INVALID_ARGUMENTS", "A JSON proposal is required.", 2);
  }
  const parsed = parseCatalogReviewCommand(input, { mediaItemKinds: MEDIA_ITEM_KINDS });
  if (!parsed.ok) {
    throw new CommandFailure("INVALID_PROPOSAL", parsed.error, 2);
  }
  if (parsed.command.action !== "create_mapping_proposal" &&
      parsed.command.action !== "create_episodic_mapping_proposal") {
    throw new CommandFailure("INVALID_PROPOSAL", "Expected a movie or episodic Mapping Proposal.", 2);
  }
  let access: DataAccess | undefined;
  try {
    access = io.openAccess();
    if (access.catalog.listOriginalDiscArchives({
      ids: [archiveId as OriginalDiscArchiveId],
    }).length === 0) {
      throw new CommandFailure(
        "PROPOSAL_NOT_FOUND",
        "Original Disc Archive not found.",
        2,
      );
    }
    return applyMappingProposal(access, archiveId as OriginalDiscArchiveId,
      parsed.command as MappingProposalCommand, mutationKey);
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("PROPOSAL_REJECTED", error.message, 2);
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        error.message.includes("Catalog review changed;")
          ? "STALE_CATALOG_REVISION" : "PROPOSAL_REJECTED",
        error.message,
        2,
      );
    }
    throw new CommandFailure("PROPOSAL_UNAVAILABLE", "Mapping Proposal is unavailable.", 1);
  } finally {
    access?.close();
  }
}
