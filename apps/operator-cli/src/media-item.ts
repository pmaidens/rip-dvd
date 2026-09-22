import {
  createApplicationOperations,
  InvalidMutationKeyError,
  parseCatalogReviewCommand,
  parseMutationKey,
  type MediaItemCommand,
} from "@rip-dvd/application";
import {
  MEDIA_ITEM_KINDS,
  type DataAccess,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  readStructuredObject,
  StructuredInputError,
  type StructuredInputIO,
} from "./structured-input.js";

interface MediaItemIO extends StructuredInputIO {
  openAccess(): DataAccess;
}

function withAccess<T>(openAccess: MediaItemIO["openAccess"], operation: (access: DataAccess) => T): T {
  const access = openAccess();
  try {
    return operation(access);
  } finally {
    access.close();
  }
}

function nonnegativeInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function mediaOptions(args: readonly string[]): Map<string, string> {
  if (args.length % 2 !== 0) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Media Item options require values.", 2);
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1]!;
    if (!name.startsWith("--") || value.startsWith("--") || options.has(name)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Media Item options.", 2);
    }
    options.set(name, value);
  }
  return options;
}

function mediaItemId(value: string | undefined): MediaItemId {
  if (!value || value.trim().length === 0 || value.length > 256) {
    throw new CommandFailure("INVALID_ARGUMENTS", "A valid Media Item ID is required.", 2);
  }
  return value as MediaItemId;
}

function mediaItemDocument(
  options: Map<string, string>,
  io: MediaItemIO,
): Record<string, unknown> {
  const structuredOptions = new Map(options);
  if (structuredOptions.get("--json") === "-") {
    structuredOptions.delete("--json");
    structuredOptions.set("--stdin", "true");
  }
  let document: unknown;
  try {
    document = readStructuredObject(structuredOptions, io) ?? {};
  } catch (error) {
    if (error instanceof StructuredInputError) {
      throw new CommandFailure(error.code, error.message, 2);
    }
    throw error;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new CommandFailure("INVALID_INPUT", "Media Item input must be a JSON object.", 2);
  }
  const fieldFlags = {
    "--kind": "kind",
    "--title": "title",
    "--parent-id": "parentId",
    "--year": "year",
    "--season-number": "seasonNumber",
    "--episode-number": "episodeNumber",
  } as const;
  const result = { ...document } as Record<string, unknown>;
  for (const [flag, field] of Object.entries(fieldFlags)) {
    const value = options.get(flag);
    if (value === undefined) continue;
    if (Object.hasOwn(result, field)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Duplicate Media Item input field.", 2);
    }
    result[field] = field === "year" || field === "seasonNumber" || field === "episodeNumber"
      ? /^(0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN
      : value;
  }
  const tmdbId = options.get("--tmdb-id");
  const tmdbType = options.get("--tmdb-type");
  if ((tmdbId === undefined) !== (tmdbType === undefined)) {
    throw new CommandFailure("INVALID_ARGUMENTS", "TMDB ID and type must be supplied together.", 2);
  }
  if (tmdbId !== undefined) {
    if (Object.hasOwn(result, "tmdbIdentity")) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Duplicate TMDB identity.", 2);
    }
    result.tmdbIdentity = { mediaType: tmdbType, tmdbId: Number(tmdbId) };
  }
  return result;
}

export async function runMediaItem(rest: readonly string[], io: MediaItemIO) {
  const [action, ...argumentsAndOptions] = rest;
  if (action === "search") {
    const options = mediaOptions(argumentsAndOptions);
    if ([...options.keys()].some((key) => !["--query", "--offset", "--archive-id"].includes(key))) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Media Item search option.", 2);
    }
    const query = options.get("--query") ?? "";
    const offset = nonnegativeInteger(options.get("--offset") ?? "0");
    if (offset === null) throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Media Item offset.", 2);
    const archiveId = options.get("--archive-id");
    if (archiveId !== undefined && (archiveId.trim().length === 0 || archiveId.length > 256)) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Original Disc Archive ID.", 2);
    }
    return withAccess(io.openAccess, (access) =>
      createApplicationOperations(access).searchMediaItems({
        query,
        offset,
        ...(archiveId === undefined ? {} : { archiveId: archiveId as OriginalDiscArchiveId }),
      }));
  }
  if (action === "show") {
    if (argumentsAndOptions.length !== 1) {
      throw new CommandFailure("INVALID_ARGUMENTS", "Expected media-item show <id>.", 2);
    }
    return withAccess(io.openAccess, (access) =>
      createApplicationOperations(access).showMediaItem(mediaItemId(argumentsAndOptions[0])));
  }
  if (action === "preview") {
    const [kind, id, ...extra] = argumentsAndOptions;
    if (kind !== "update" && kind !== "delete") {
      throw new CommandFailure("INVALID_ARGUMENTS", "Expected media-item preview <update|delete> <id>.", 2);
    }
    let changes: Extract<MediaItemCommand, { action: "update_media_item" }>["changes"] | undefined;
    if (kind === "delete") {
      if (extra.length > 0) throw new CommandFailure("INVALID_ARGUMENTS", "Delete preview takes no changes.", 2);
    } else {
      const options = mediaOptions(extra);
      const allowed = ["--json", "--file", "--kind", "--title", "--parent-id", "--year", "--season-number", "--episode-number"];
      if ([...options.keys()].some((key) => !allowed.includes(key))) {
        throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Media Item preview option.", 2);
      }
      const document = mediaItemDocument(options, io);
      const parsed = parseCatalogReviewCommand({ action: "update_media_item", mediaItemId: id,
        changes: document }, { mediaItemKinds: MEDIA_ITEM_KINDS });
      if (!parsed.ok || parsed.command.action !== "update_media_item") {
        throw new CommandFailure("INVALID_INPUT", parsed.ok ? "Invalid Media Item update." : parsed.error, 2);
      }
      changes = parsed.command.changes;
    }
    return withAccess(io.openAccess, (access) =>
      createApplicationOperations(access).previewMediaItemChange(mediaItemId(id), kind, changes));
  }
  if (action !== "create" && action !== "update" && action !== "delete") {
    throw new CommandFailure("INVALID_ARGUMENTS", "Unknown Media Item action.", 2);
  }
  const id = action === "create" ? undefined : mediaItemId(argumentsAndOptions[0]);
  const options = mediaOptions(action === "create" ? argumentsAndOptions : argumentsAndOptions.slice(1));
  const allowed = action === "delete"
    ? ["--key", "--acknowledge"]
    : action === "create"
    ? ["--key", "--json", "--file", "--kind", "--title", "--parent-id", "--year", "--season-number", "--episode-number", "--tmdb-id", "--tmdb-type"]
    : ["--key", "--acknowledge", "--json", "--file", "--kind", "--title", "--parent-id", "--year", "--season-number", "--episode-number"];
  if ([...options.keys()].some((key) => !allowed.includes(key))) {
    throw new CommandFailure("INVALID_ARGUMENTS", "Invalid Media Item mutation option.", 2);
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
  let command: MediaItemCommand;
  if (action === "delete") {
    command = { action: "delete_media_item", mediaItemId: id! };
  } else {
    const document = mediaItemDocument(options, io);
    const parsed = parseCatalogReviewCommand(
      action === "create"
        ? { action: "create_media_item", mediaItem: document }
        : { action: "update_media_item", mediaItemId: id, changes: document },
      { mediaItemKinds: MEDIA_ITEM_KINDS },
    );
    if (!parsed.ok || (parsed.command.action !== "create_media_item" &&
        parsed.command.action !== "update_media_item")) {
      throw new CommandFailure("INVALID_INPUT", parsed.ok ? "Invalid Media Item action." : parsed.error, 2);
    }
    command = parsed.command;
  }
  return withAccess(io.openAccess, (access) =>
    createApplicationOperations(access).mutateMediaItem({
      mutationKey,
      command,
      ...(options.has("--acknowledge") ? { acknowledgedRevision: options.get("--acknowledge") } : {}),
    }));
}
