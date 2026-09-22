import {
  executeDiscSelectionCommand,
  parseMutationKey,
  previewDiscSelection,
  previewDiscSelectionChange,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import {
  discSelectionCommandRequiresPreview,
  parseCatalogReviewCommand,
} from "@rip-dvd/application/catalog-review-command";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  MEDIA_ITEM_KINDS,
  type DataAccess,
  type DiscSelectionId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import { readStructuredObject, StructuredInputError, type StructuredInputIO } from "./structured-input.js";

interface SelectionIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

const mutations = {
  create: "create_disc_selection",
  update: "update_disc_selection",
  repair: "repair_disc_selection",
  correct: "correct_disc_selection",
  delete: "delete_disc_selection",
} as const;

const selectionOptions = new Set([
  "--key", "--revision", "--preview-token", "--acknowledge", "--json", "--stdin", "--file",
  "--media-item-id", "--source-kind", "--title-number", "--chapter-start",
  "--chapter-end", "--label", "--clear-label", "--reason",
]);

function invalid(message: string): never {
  throw new CommandFailure("INVALID_ARGUMENTS", message, 2);
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!selectionOptions.has(name) || options.has(name)) {
      invalid("Invalid or repeated Disc Selection option.");
    }
    if (name === "--acknowledge" || name === "--stdin" || name === "--clear-label") {
      options.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      invalid(`Disc Selection option ${name} requires a value.`);
    }
    options.set(name, value);
  }
  return options;
}

function requiredId(value: string | undefined, label: string): string {
  if (!value || value.trim() !== value || value.length > 256) {
    invalid(`A valid ${label} is required.`);
  }
  return value;
}

function revision(value: string | undefined): Date {
  if (!value) invalid("A preview catalog revision is required.");
  const date = new Date(value);
  if (!Number.isSafeInteger(date.getTime()) || date.toISOString() !== value) {
    invalid("Invalid Catalog Review revision.");
  }
  return date;
}

function sourceIdentity(options: Map<string, string>): Record<string, unknown> | undefined {
  const kind = options.get("--source-kind");
  const titleNumber = options.get("--title-number");
  const chapterStart = options.get("--chapter-start");
  const chapterEnd = options.get("--chapter-end");
  if ([kind, titleNumber, chapterStart, chapterEnd].every((value) => value === undefined)) {
    return undefined;
  }
  const numeric = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value)) invalid("Source numbers must be positive integers.");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) invalid("Source numbers must be safe integers.");
    return parsed;
  };
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(titleNumber === undefined ? {} : { titleNumber: numeric(titleNumber) }),
    ...(chapterStart === undefined ? {} : { chapterStart: numeric(chapterStart) }),
    ...(chapterEnd === undefined ? {} : { chapterEnd: numeric(chapterEnd) }),
  };
}

function payload(action: keyof typeof mutations, options: Map<string, string>, io: SelectionIO): unknown {
  const fields = ["--media-item-id", "--source-kind", "--title-number", "--chapter-start",
    "--chapter-end", "--label", "--clear-label"];
  if (["--json", "--stdin", "--file"].some((name) => options.has(name)) &&
      fields.some((name) => options.has(name))) {
    invalid("Choose one Disc Selection input form.");
  }
  if (options.has("--label") && options.has("--clear-label")) {
    invalid("Label options conflict.");
  }
  let structured: unknown;
  try {
    structured = readStructuredObject(options, io);
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (structured !== undefined) return structured;
  if (action === "delete") return undefined;
  const source = sourceIdentity(options);
  return {
    ...(options.has("--media-item-id") ? { mediaItemId: options.get("--media-item-id") } : {}),
    ...(source ? { sourceIdentity: source } : {}),
    ...(options.has("--label") ? { label: options.get("--label") } : {}),
    ...(options.has("--clear-label") ? { label: null } : {}),
  };
}

function parsedCommand(
  action: keyof typeof mutations,
  selectionId: DiscSelectionId | undefined,
  input: unknown,
  catalogRevision: string | undefined,
  correctionReason: string | undefined,
): Parameters<typeof executeDiscSelectionCommand>[2] {
  const body = {
    action: mutations[action],
    ...(selectionId ? { discSelectionId: selectionId } : {}),
    ...(action === "update" ? { changes: input } : {}),
    ...(action === "create" || action === "repair" || action === "correct"
      ? { selection: input } : {}),
    ...(action === "correct" ? { catalogRevision, ...(correctionReason ? { correctionReason } : {}) } : {}),
  };
  const parsed = parseCatalogReviewCommand(body, { mediaItemKinds: MEDIA_ITEM_KINDS });
  if (!parsed.ok) {
    throw new CommandFailure("INVALID_SELECTION", parsed.error, 2);
  }
  if (!Object.values(mutations).includes(parsed.command.action as typeof mutations[keyof typeof mutations])) {
    invalid("Invalid Disc Selection action.");
  }
  return parsed.command as Parameters<typeof executeDiscSelectionCommand>[2];
}

function withSelectionAccess<T>(io: SelectionIO, operation: (access: DataAccess) => T): T {
  let access: DataAccess | undefined;
  try {
    access = io.openAccess();
    return operation(access);
  } catch (error) {
    if (error instanceof MutationKeyConflictError) {
      throw new CommandFailure("MUTATION_KEY_CONFLICT", error.message, 2);
    }
    if (error instanceof RecordNotFoundError) {
      throw new CommandFailure("SELECTION_NOT_FOUND", "Disc Selection or its source was not found.", 2);
    }
    if (error instanceof DomainInvariantError) {
      throw new CommandFailure(
        error.message === "Catalog review revision is stale" ? "STALE_CATALOG_REVISION" : "SELECTION_REJECTED",
        error.message, 2,
      );
    }
    throw new CommandFailure("SELECTION_UNAVAILABLE", "Disc Selection operation is unavailable.", 1);
  } finally {
    access?.close();
  }
}

export function runDiscSelection(rest: readonly string[], io: SelectionIO): unknown {
  const [verb] = rest;
  if (verb === "show") {
    const archiveId = requiredId(rest[1], "archive ID") as OriginalDiscArchiveId;
    const selectionId = requiredId(rest[2], "Disc Selection ID") as DiscSelectionId;
    if (rest.length !== 3) invalid("Show takes no options.");
    return withSelectionAccess(io, (access) => previewDiscSelection(access, archiveId, selectionId));
  }
  const isPreview = verb === "preview";
  const action = (isPreview ? rest[1] : verb) as keyof typeof mutations | undefined;
  if (!action || !(action in mutations) || (isPreview && action === "create")) {
    invalid("Expected a Disc Selection action: create, update, repair, correct, or delete.");
  }
  const archiveId = requiredId(rest[isPreview ? 2 : 1], "archive ID") as OriginalDiscArchiveId;
  const tail = rest.slice(isPreview ? 3 : 2);
  const selectionId = action === "create" ? undefined
    : requiredId(tail.shift(), "Disc Selection ID") as DiscSelectionId;
  const options = parseOptions(tail);
  if (action === "delete" && ["--json", "--stdin", "--file", "--reason",
    "--media-item-id", "--source-kind", "--title-number", "--chapter-start",
    "--chapter-end", "--label", "--clear-label"].some((name) => options.has(name))) {
    invalid("Delete accepts no selection input.");
  }
  if (action !== "correct" && options.has("--reason")) {
    invalid("A correction reason applies only to correction.");
  }
  let mutationKey: string | undefined;
  if (isPreview) {
    if (["--key", "--revision", "--preview-token", "--acknowledge"].some((name) => options.has(name))) {
      invalid("Preview takes proposal input without a key or acknowledgement.");
    }
  } else {
    try {
      mutationKey = parseMutationKey(options.get("--key"));
    } catch (error) {
      if (error instanceof InvalidMutationKeyError) {
        throw new CommandFailure("INVALID_MUTATION_KEY", error.message, 2);
      }
      throw error;
    }
  }
  const input = payload(action, options, io);
  if (isPreview) {
    return withSelectionAccess(io, (access) => {
      const current = previewDiscSelection(access, archiveId, selectionId!);
      const command = parsedCommand(action, selectionId, input, current.catalogRevision, options.get("--reason"));
      return previewDiscSelectionChange(access, archiveId, command);
    });
  }
  const command = parsedCommand(
    action, selectionId, input, options.get("--revision"), options.get("--reason"),
  );
  const consequential = discSelectionCommandRequiresPreview(command);
  if (consequential && !options.has("--acknowledge")) {
    invalid("Acknowledgement of a Disc Selection preview is required.");
  }
  if (!consequential && ["--acknowledge", "--revision", "--preview-token"].some((name) => options.has(name))) {
    invalid("This Disc Selection change does not require a preview.");
  }
  const expectedCatalogRevision = consequential ? revision(options.get("--revision")) : undefined;
  const previewToken = options.get("--preview-token");
  if (consequential && (!previewToken || previewToken.length > 4_096 ||
      !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(previewToken))) {
    invalid("A matching Disc Selection preview token is required.");
  }
  return withSelectionAccess(io, (access) => executeDiscSelectionCommand(access, archiveId, command, {
    mutationKey,
    ...(expectedCatalogRevision ? { expectedCatalogRevision } : {}),
    ...(previewToken ? { previewToken } : {}),
    ...(options.has("--acknowledge") ? { acknowledged: true } : {}),
  }));
}
