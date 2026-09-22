import { readFileSync } from "node:fs";

import {
  executeDiscSelectionCommand,
  parseMutationKey,
  previewDiscSelection,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import { parseCatalogReviewCommand } from "@rip-dvd/application/catalog-review-command";
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

interface SelectionIO {
  openAccess(): DataAccess;
  readStdin?(): string;
  readFile?(path: string): string;
}

const mutations = {
  create: "create_disc_selection",
  update: "update_disc_selection",
  repair: "repair_disc_selection",
  correct: "correct_disc_selection",
  delete: "delete_disc_selection",
} as const;

const selectionOptions = new Set([
  "--key", "--revision", "--acknowledge", "--json", "--stdin", "--file",
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
  const forms = ["--json", "--stdin", "--file"].filter((name) => options.has(name));
  const fields = ["--media-item-id", "--source-kind", "--title-number", "--chapter-start",
    "--chapter-end", "--label", "--clear-label"];
  if (forms.length > 1 || (forms.length && fields.some((name) => options.has(name)))) {
    invalid("Choose one Disc Selection input form.");
  }
  if (options.has("--label") && options.has("--clear-label")) {
    invalid("Label options conflict.");
  }
  if (forms.length) {
    let text: string;
    try {
      text = options.get("--json") ?? (options.has("--stdin")
        ? (io.readStdin ?? (() => readFileSync(0, "utf8")))()
        : (io.readFile ?? ((path) => readFileSync(path, "utf8")))(options.get("--file")!));
    } catch {
      throw new CommandFailure("INVALID_INPUT", "Disc Selection input could not be read.", 2);
    }
    if (text.length > 1_000_000) invalid("Disc Selection input is too large.");
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        invalid("Disc Selection input must be a JSON object.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      invalid("Disc Selection input is not valid JSON.");
    }
  }
  if (action === "delete") return undefined;
  const source = sourceIdentity(options);
  return {
    ...(options.has("--media-item-id") ? { mediaItemId: options.get("--media-item-id") } : {}),
    ...(source ? { sourceIdentity: source } : {}),
    ...(options.has("--label") ? { label: options.get("--label") } : {}),
    ...(options.has("--clear-label") ? { label: null } : {}),
  };
}

export function runDiscSelection(rest: readonly string[], io: SelectionIO): unknown {
  const [action, archiveArg, ...tail] = rest;
  if (action !== "show" && action !== "preview" && !(action && action in mutations)) {
    invalid("Expected disc-selection show, preview, create, update, repair, correct, or delete.");
  }
  const archiveId = requiredId(archiveArg, "archive ID") as OriginalDiscArchiveId;
  const needsSelection = action !== "create";
  const selectionId = needsSelection ? requiredId(tail.shift(), "Disc Selection ID") as DiscSelectionId : undefined;
  const options = parseOptions(tail);
  if (action === "show" || action === "preview") {
    if (options.size !== 0) invalid("Read commands take no options.");
    let access: DataAccess | undefined;
    try {
      access = io.openAccess();
      return previewDiscSelection(access, archiveId, selectionId!);
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        throw new CommandFailure("SELECTION_NOT_FOUND", "Disc Selection not found.", 2);
      }
      throw new CommandFailure("SELECTION_UNAVAILABLE", "Disc Selection is unavailable.", 1);
    } finally {
      access?.close();
    }
  }
  const mutationAction = action as keyof typeof mutations;
  if (mutationAction === "delete" && ["--json", "--stdin", "--file", "--reason",
    "--media-item-id", "--source-kind", "--title-number", "--chapter-start",
    "--chapter-end", "--label", "--clear-label"].some((name) => options.has(name))) {
    invalid("Delete accepts no selection input.");
  }
  if (mutationAction !== "correct" && options.has("--reason")) {
    invalid("A correction reason applies only to correction.");
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
  const input = payload(mutationAction, options, io);
  const changes = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const consequential = mutationAction === "repair" || mutationAction === "correct" ||
    mutationAction === "delete" || (mutationAction === "update" &&
      ("mediaItemId" in changes || "sourceIdentity" in changes));
  if (consequential && !options.has("--acknowledge")) {
    invalid("Acknowledgement of a Disc Selection preview is required.");
  }
  if (!consequential && (options.has("--acknowledge") || options.has("--revision"))) {
    invalid("This Disc Selection change does not require a preview.");
  }
  const expectedCatalogRevision = consequential ? revision(options.get("--revision")) : undefined;
  const commandBody = {
    action: mutations[mutationAction],
    ...(selectionId ? { discSelectionId: selectionId } : {}),
    ...(mutationAction === "update" ? { changes: input } : {}),
    ...(mutationAction === "create" || mutationAction === "repair" || mutationAction === "correct"
      ? { selection: input } : {}),
    ...(mutationAction === "correct" ? { catalogRevision: expectedCatalogRevision!.toISOString(),
      ...(options.has("--reason") ? { correctionReason: options.get("--reason") } : {}) } : {}),
  };
  const parsed = parseCatalogReviewCommand(commandBody, { mediaItemKinds: MEDIA_ITEM_KINDS });
  if (!parsed.ok) {
    throw new CommandFailure("INVALID_SELECTION", parsed.error, 2);
  }
  if (!Object.values(mutations).includes(parsed.command.action as typeof mutations[keyof typeof mutations])) {
    invalid("Invalid Disc Selection action.");
  }
  let access: DataAccess | undefined;
  try {
    access = io.openAccess();
    return executeDiscSelectionCommand(access, archiveId, parsed.command as Parameters<typeof executeDiscSelectionCommand>[2], {
      mutationKey,
      ...(expectedCatalogRevision ? { expectedCatalogRevision } : {}),
    });
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
    throw new CommandFailure("SELECTION_UNAVAILABLE", "Disc Selection mutation is unavailable.", 1);
  } finally {
    access?.close();
  }
}
