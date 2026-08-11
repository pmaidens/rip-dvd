export const CATALOG_REVIEW_COMMAND_ACTIONS = [
  "create_media_item",
  "update_media_item",
  "create_disc_selection",
  "repair_disc_selection",
  "delete_disc_selection",
  "complete_review",
] as const;

export const CATALOG_REVIEW_MEDIA_ITEM_KINDS = [
  "movie",
  "tv_show",
  "season",
  "episode",
  "trailer",
  "bonus_feature",
  "other",
] as const;

export const CATALOG_REVIEW_DISC_SELECTION_KINDS = [
  "main_feature",
  "dvd_title",
  "dvd_chapters",
] as const;

type CatalogReviewMediaItemKind =
  (typeof CATALOG_REVIEW_MEDIA_ITEM_KINDS)[number];

export interface CatalogReviewMediaItemInput {
  parentId?: string | null;
  kind: CatalogReviewMediaItemKind;
  title: string;
  year?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

type AtLeastOne<T> = {
  [Key in keyof T]-?: Required<Pick<T, Key>> & Partial<Omit<T, Key>>;
}[keyof T];

export type CatalogReviewMediaItemChanges = AtLeastOne<
  CatalogReviewMediaItemInput
>;

interface CatalogReviewDiscSelectionBase {
  mediaItemId: string;
  label?: string;
}

export type CatalogReviewDiscSelectionInput =
  & CatalogReviewDiscSelectionBase
  & (
    | { kind: "main_feature" }
    | { kind: "dvd_title"; titleNumber: number }
    | {
        kind: "dvd_chapters";
        titleNumber: number;
        chapterStart: number;
        chapterEnd: number;
      }
  );

export type CatalogReviewCommand =
  | {
      action: "create_media_item";
      mediaItem: CatalogReviewMediaItemInput;
    }
  | {
      action: "update_media_item";
      mediaItemId: string;
      changes: CatalogReviewMediaItemChanges;
    }
  | {
      action: "create_disc_selection";
      selection: CatalogReviewDiscSelectionInput;
    }
  | {
      action: "repair_disc_selection";
      discSelectionId: string;
      selection: CatalogReviewDiscSelectionInput;
    }
  | {
      action: "delete_disc_selection";
      discSelectionId: string;
    }
  | { action: "complete_review" };

export type CatalogReviewCommandValidationError =
  | "Invalid catalog review mutation"
  | "Unknown catalog review mutation"
  | "Invalid Media Item"
  | "Invalid Media Item update"
  | "Invalid Media Item parent"
  | "Invalid Media Item kind"
  | "Invalid Media Item title"
  | "Invalid Media Item year"
  | "Invalid Media Item seasonNumber"
  | "Invalid Media Item episodeNumber"
  | "Invalid Disc Selection"
  | "Invalid DVD title number"
  | "Invalid DVD chapter range";

export type CatalogReviewCommandParseResult =
  | { ok: true; command: CatalogReviewCommand }
  | { ok: false; error: CatalogReviewCommandValidationError };

const MEDIA_ITEM_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "parentId",
  "kind",
  "title",
  "year",
  "seasonNumber",
  "episodeNumber",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return Number.isSafeInteger(value) &&
      (value as number) >= minimum &&
      (value as number) <= maximum
    ? value as number
    : undefined;
}

function invalid(
  error: CatalogReviewCommandValidationError,
): CatalogReviewCommandParseResult {
  return { ok: false, error };
}

function parseMediaItemInput(
  value: unknown,
): CatalogReviewMediaItemInput | null {
  const input = asRecord(value);
  const kind = boundedString(input?.kind, 32);
  const title = boundedString(input?.title);
  const parentId = input?.parentId === undefined || input.parentId === null
    ? input?.parentId
    : boundedString(input.parentId);
  const year = optionalInteger(input?.year, 1800, 9999);
  const seasonNumber = optionalInteger(input?.seasonNumber, 0);
  const episodeNumber = optionalInteger(input?.episodeNumber, 1);
  if (
    !input ||
    !kind ||
    !CATALOG_REVIEW_MEDIA_ITEM_KINDS.includes(
      kind as CatalogReviewMediaItemKind,
    ) ||
    !title ||
    (input.parentId !== undefined && input.parentId !== null && !parentId) ||
    (input.year !== undefined && year === undefined) ||
    (input.seasonNumber !== undefined && seasonNumber === undefined) ||
    (input.episodeNumber !== undefined && episodeNumber === undefined)
  ) {
    return null;
  }
  return {
    ...(input.parentId === undefined ? {} : { parentId: parentId ?? null }),
    kind: kind as CatalogReviewMediaItemKind,
    title,
    ...(input.year === undefined ? {} : { year: year ?? null }),
    ...(input.seasonNumber === undefined
      ? {}
      : { seasonNumber: seasonNumber ?? null }),
    ...(input.episodeNumber === undefined
      ? {}
      : { episodeNumber: episodeNumber ?? null }),
  };
}

function parseMediaItemChanges(
  value: unknown,
):
  | { ok: true; changes: CatalogReviewMediaItemChanges }
  | { ok: false; error: CatalogReviewCommandValidationError } {
  const input = asRecord(value);
  const fields = input === null ? [] : Object.keys(input);
  if (
    !input ||
    fields.length === 0 ||
    fields.some((field) => !MEDIA_ITEM_UPDATE_FIELDS.has(field))
  ) {
    return { ok: false, error: "Invalid Media Item update" };
  }

  const changes: Partial<CatalogReviewMediaItemInput> = {};
  if ("parentId" in input) {
    if (input.parentId === null) {
      changes.parentId = null;
    } else {
      const parentId = boundedString(input.parentId);
      if (!parentId) {
        return { ok: false, error: "Invalid Media Item parent" };
      }
      changes.parentId = parentId;
    }
  }
  if ("kind" in input) {
    const kind = boundedString(input.kind, 32);
    if (
      !kind ||
      !CATALOG_REVIEW_MEDIA_ITEM_KINDS.includes(
        kind as CatalogReviewMediaItemKind,
      )
    ) {
      return { ok: false, error: "Invalid Media Item kind" };
    }
    changes.kind = kind as CatalogReviewMediaItemKind;
  }
  if ("title" in input) {
    const title = boundedString(input.title);
    if (!title) {
      return { ok: false, error: "Invalid Media Item title" };
    }
    changes.title = title;
  }
  if ("year" in input) {
    const year = optionalInteger(input.year, 1800, 9999);
    if (year === undefined) {
      return { ok: false, error: "Invalid Media Item year" };
    }
    changes.year = year;
  }
  if ("seasonNumber" in input) {
    const seasonNumber = optionalInteger(input.seasonNumber, 0);
    if (seasonNumber === undefined) {
      return { ok: false, error: "Invalid Media Item seasonNumber" };
    }
    changes.seasonNumber = seasonNumber;
  }
  if ("episodeNumber" in input) {
    const episodeNumber = optionalInteger(input.episodeNumber, 1);
    if (episodeNumber === undefined) {
      return { ok: false, error: "Invalid Media Item episodeNumber" };
    }
    changes.episodeNumber = episodeNumber;
  }
  return { ok: true, changes: changes as CatalogReviewMediaItemChanges };
}

function parseDiscSelectionInput(
  value: unknown,
):
  | { ok: true; selection: CatalogReviewDiscSelectionInput }
  | { ok: false; error: CatalogReviewCommandValidationError } {
  const input = asRecord(value);
  const mediaItemId = boundedString(input?.mediaItemId);
  const kind = boundedString(input?.kind, 32);
  const label = input?.label === undefined
    ? undefined
    : boundedString(input.label);
  if (
    !input ||
    !mediaItemId ||
    !kind ||
    !CATALOG_REVIEW_DISC_SELECTION_KINDS.includes(
      kind as (typeof CATALOG_REVIEW_DISC_SELECTION_KINDS)[number],
    ) ||
    (input.label !== undefined && !label)
  ) {
    return { ok: false, error: "Invalid Disc Selection" };
  }

  const common = {
    mediaItemId,
    ...(label ? { label } : {}),
  };
  if (kind === "main_feature") {
    return { ok: true, selection: { ...common, kind } };
  }

  const titleNumber = optionalInteger(input.titleNumber, 1);
  if (titleNumber === null || titleNumber === undefined) {
    return { ok: false, error: "Invalid DVD title number" };
  }
  if (kind === "dvd_title") {
    return {
      ok: true,
      selection: { ...common, kind, titleNumber },
    };
  }

  const chapterStart = optionalInteger(input.chapterStart, 1);
  const chapterEnd = optionalInteger(input.chapterEnd, 1);
  if (
    chapterStart === null ||
    chapterStart === undefined ||
    chapterEnd === null ||
    chapterEnd === undefined
  ) {
    return { ok: false, error: "Invalid DVD chapter range" };
  }
  return {
    ok: true,
    selection: {
      ...common,
      kind: "dvd_chapters",
      titleNumber,
      chapterStart,
      chapterEnd,
    },
  };
}

export function parseCatalogReviewCommand(
  value: unknown,
): CatalogReviewCommandParseResult {
  const body = asRecord(value);
  const action = boundedString(body?.action, 64);
  if (!body || !action) {
    return invalid("Invalid catalog review mutation");
  }

  switch (action) {
    case "create_media_item": {
      const mediaItem = parseMediaItemInput(body.mediaItem);
      return mediaItem
        ? { ok: true, command: { action, mediaItem } }
        : invalid("Invalid Media Item");
    }
    case "update_media_item": {
      const mediaItemId = boundedString(body.mediaItemId);
      const parsedChanges = parseMediaItemChanges(body.changes);
      if (!mediaItemId) {
        return invalid("Invalid Media Item update");
      }
      return parsedChanges.ok
        ? {
            ok: true,
            command: { action, mediaItemId, changes: parsedChanges.changes },
          }
        : invalid(parsedChanges.error);
    }
    case "create_disc_selection": {
      const parsedSelection = parseDiscSelectionInput(body.selection);
      return parsedSelection.ok
        ? {
            ok: true,
            command: { action, selection: parsedSelection.selection },
          }
        : invalid(parsedSelection.error);
    }
    case "repair_disc_selection": {
      const discSelectionId = boundedString(body.discSelectionId);
      if (!discSelectionId) {
        return invalid("Invalid Disc Selection");
      }
      const parsedSelection = parseDiscSelectionInput(body.selection);
      return parsedSelection.ok
        ? {
            ok: true,
            command: {
              action,
              discSelectionId,
              selection: parsedSelection.selection,
            },
          }
        : invalid(parsedSelection.error);
    }
    case "delete_disc_selection": {
      const discSelectionId = boundedString(body.discSelectionId);
      return discSelectionId
        ? { ok: true, command: { action, discSelectionId } }
        : invalid("Invalid Disc Selection");
    }
    case "complete_review":
      return { ok: true, command: { action } };
    default:
      return invalid("Unknown catalog review mutation");
  }
}
