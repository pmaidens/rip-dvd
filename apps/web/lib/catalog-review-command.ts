import type {
  CompletedCatalogReviewOutcome,
  DiscSelectionSourceIdentityInput,
  EncodeJobId,
  EncodingProfileId,
  MediaItemKind,
} from "@rip-dvd/data-access";
import {
  MAX_DVD_SCAN_INTEGER,
  MAX_DVD_TITLES,
} from "@rip-dvd/data-access/dvd-scan";
import { createDiscSelectionSourceIdentity } from "@rip-dvd/data-access/disc-selection-source-identity";

export const CATALOG_REVIEW_COMMAND_ACTIONS = [
  "create_episodic_mapping_proposal",
  "create_mapping_proposal",
  "create_media_item",
  "update_media_item",
  "delete_media_item",
  "create_disc_selection",
  "update_disc_selection",
  "repair_disc_selection",
  "correct_disc_selection",
  "delete_disc_selection",
  "complete_review",
] as const;
export const MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES = 100;

export interface CatalogReviewCommandDomainValues {
  mediaItemKinds: readonly MediaItemKind[];
}

export interface CatalogReviewMediaItemInput {
  parentId?: string | null;
  kind: MediaItemKind;
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
  & { sourceIdentity: DiscSelectionSourceIdentityInput };

type CatalogReviewDiscSelectionChangeFields = {
  mediaItemId?: string;
  sourceIdentity?: DiscSelectionSourceIdentityInput;
  label?: string | null;
};

export type CatalogReviewDiscSelectionChanges =
  & CatalogReviewDiscSelectionChangeFields
  & (
    | { mediaItemId: string }
    | { sourceIdentity: DiscSelectionSourceIdentityInput }
    | { label: string | null }
  );

export interface CatalogReviewProposedDiscSelectionInput {
  sourceIdentity: DiscSelectionSourceIdentityInput;
  label?: string;
}

export type CatalogReviewMappingTarget =
  | {
    choice: "create_new";
    mediaItem: CatalogReviewMediaItemInput;
  }
  | {
    choice: "use_existing";
    mediaItemId: string;
  };

export type CatalogReviewEpisodicTvShowTarget =
  | {
    choice: "create_new";
    title: string;
    year?: number | null;
  }
  | {
    choice: "use_existing";
    mediaItemId: string;
  };

export type CatalogReviewEpisodicSeasonTarget =
  | {
    choice: "create_new";
    title: string;
    seasonNumber: number;
  }
  | {
    choice: "use_existing";
    mediaItemId: string;
  };

export interface CatalogReviewEpisodicEpisodeInput {
  titleNumber: number;
  title: string;
  episodeNumber: number;
  label?: string;
}

export interface CatalogReviewReplacementEncodeInput {
  predecessorEncodeJobId: EncodeJobId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
  priority?: number;
}

export type CatalogReviewCommand =
  | {
      action: "create_episodic_mapping_proposal";
      catalogRevision: string;
      tvShow: CatalogReviewEpisodicTvShowTarget;
      season: CatalogReviewEpisodicSeasonTarget;
      episodes: CatalogReviewEpisodicEpisodeInput[];
    }
  | {
      action: "create_mapping_proposal";
      catalogRevision: string;
      target: CatalogReviewMappingTarget;
      discSelection: CatalogReviewProposedDiscSelectionInput;
    }
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
      action: "delete_media_item";
      mediaItemId: string;
    }
  | {
      action: "create_disc_selection";
      selection: CatalogReviewDiscSelectionInput;
    }
  | {
      action: "update_disc_selection";
      discSelectionId: string;
      changes: CatalogReviewDiscSelectionChanges;
    }
  | {
      action: "repair_disc_selection";
      discSelectionId: string;
      selection: CatalogReviewDiscSelectionInput;
    }
  | {
      action: "correct_disc_selection";
      discSelectionId: string;
      catalogRevision: string;
      correctionReason?: string;
      selection: CatalogReviewDiscSelectionInput;
    }
  | {
      action: "delete_disc_selection";
      discSelectionId: string;
    }
  | {
      action: "complete_review";
      catalogRevision: string;
      outcome: CompletedCatalogReviewOutcome;
      replacementEncodes: CatalogReviewReplacementEncodeInput[];
    };

export type CatalogReviewCommandValidationError =
  | "Invalid catalog review mutation"
  | "Unknown catalog review mutation"
  | "Invalid Episodic Mapping Proposal"
  | "Invalid Mapping Proposal"
  | "Invalid Media Item"
  | "Invalid Media Item update"
  | "Invalid Media Item parent"
  | "Invalid Media Item kind"
  | "Invalid Media Item title"
  | "Invalid Media Item year"
  | "Invalid Media Item seasonNumber"
  | "Invalid Media Item episodeNumber"
  | "Invalid Disc Selection"
  | "Invalid Disc Selection update"
  | "Invalid Disc Selection Correction"
  | "Invalid corrected Encode replacement plan"
  | "Invalid catalog review revision"
  | "Invalid catalog review outcome";

export type CatalogReviewCommandParseResult =
  | { ok: true; command: CatalogReviewCommand }
  | {
      ok: false;
      error: CatalogReviewCommandValidationError;
      targetedDiscSelectionId?: string;
    };

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

function catalogRevision(value: unknown): string | null {
  const serialized = boundedString(value, 64);
  if (!serialized) {
    return null;
  }
  const revision = new Date(serialized);
  return Number.isSafeInteger(revision.getTime()) &&
      revision.toISOString() === serialized
    ? serialized
    : null;
}

function completedCatalogReviewOutcome(
  value: unknown,
): CompletedCatalogReviewOutcome | null {
  return value === "reviewed_with_selections" || value === "archive_only"
    ? value
    : null;
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
  targetedDiscSelectionId?: string,
): CatalogReviewCommandParseResult {
  return targetedDiscSelectionId === undefined
    ? { ok: false, error }
    : { ok: false, error, targetedDiscSelectionId };
}

function parseMediaItemInput(
  value: unknown,
  domainValues: CatalogReviewCommandDomainValues,
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
    !domainValues.mediaItemKinds.includes(kind as MediaItemKind) ||
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
    kind: kind as MediaItemKind,
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
  domainValues: CatalogReviewCommandDomainValues,
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
      !domainValues.mediaItemKinds.includes(kind as MediaItemKind)
    ) {
      return { ok: false, error: "Invalid Media Item kind" };
    }
    changes.kind = kind as MediaItemKind;
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

function parseProposedDiscSelectionInput(
  value: unknown,
): CatalogReviewProposedDiscSelectionInput | null {
  const input = asRecord(value);
  const sourceIdentityInput = asRecord(input?.sourceIdentity);
  const label = input?.label === undefined
    ? undefined
    : boundedString(input.label);
  if (
    !input ||
    !sourceIdentityInput ||
    (input.label !== undefined && !label)
  ) {
    return null;
  }

  try {
    return {
      sourceIdentity: createDiscSelectionSourceIdentity(
        sourceIdentityInput as unknown as DiscSelectionSourceIdentityInput,
      ),
      ...(label ? { label } : {}),
    };
  } catch {
    return null;
  }
}

function parseMappingTarget(
  value: unknown,
  domainValues: CatalogReviewCommandDomainValues,
): CatalogReviewMappingTarget | null {
  const target = asRecord(value);
  const choice = boundedString(target?.choice, 32);
  if (!target || choice === null) {
    return null;
  }
  if (choice === "create_new") {
    const mediaItem = parseMediaItemInput(target.mediaItem, domainValues);
    return mediaItem &&
        Object.keys(target).every((field) =>
          field === "choice" || field === "mediaItem"
        )
      ? { choice, mediaItem }
      : null;
  }
  if (choice === "use_existing") {
    const mediaItemId = boundedString(target.mediaItemId);
    return mediaItemId &&
        Object.keys(target).every((field) =>
          field === "choice" || field === "mediaItemId"
        )
      ? { choice, mediaItemId }
      : null;
  }
  return null;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const allowed = new Set(fields);
  return Object.keys(value).every((field) => allowed.has(field));
}

function parseEpisodicTvShowTarget(
  value: unknown,
): CatalogReviewEpisodicTvShowTarget | null {
  const target = asRecord(value);
  const choice = boundedString(target?.choice, 32);
  if (!target || !choice) {
    return null;
  }
  if (choice === "create_new") {
    const title = boundedString(target.title);
    const year = optionalInteger(target.year, 1800, 9999);
    return title &&
        (target.year === undefined || year !== undefined) &&
        hasOnlyFields(target, ["choice", "title", "year"])
      ? {
          choice,
          title,
          ...(target.year === undefined ? {} : { year: year ?? null }),
        }
      : null;
  }
  if (choice === "use_existing") {
    const mediaItemId = boundedString(target.mediaItemId);
    return mediaItemId &&
        hasOnlyFields(target, ["choice", "mediaItemId"])
      ? { choice, mediaItemId }
      : null;
  }
  return null;
}

function parseEpisodicSeasonTarget(
  value: unknown,
): CatalogReviewEpisodicSeasonTarget | null {
  const target = asRecord(value);
  const choice = boundedString(target?.choice, 32);
  if (!target || !choice) {
    return null;
  }
  if (choice === "create_new") {
    const title = boundedString(target.title);
    const seasonNumber = optionalInteger(target.seasonNumber, 0);
    return title && typeof seasonNumber === "number" &&
        hasOnlyFields(target, ["choice", "title", "seasonNumber"])
      ? { choice, title, seasonNumber }
      : null;
  }
  if (choice === "use_existing") {
    const mediaItemId = boundedString(target.mediaItemId);
    return mediaItemId &&
        hasOnlyFields(target, ["choice", "mediaItemId"])
      ? { choice, mediaItemId }
      : null;
  }
  return null;
}

function parseEpisodicEpisodes(
  value: unknown,
): CatalogReviewEpisodicEpisodeInput[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DVD_TITLES
  ) {
    return null;
  }
  const episodes: CatalogReviewEpisodicEpisodeInput[] = [];
  const selectedTitleNumbers = new Set<number>();
  for (const valueEntry of value) {
    const entry = asRecord(valueEntry);
    const titleNumber = optionalInteger(
      entry?.titleNumber,
      1,
      MAX_DVD_SCAN_INTEGER,
    );
    const title = boundedString(entry?.title);
    const episodeNumber = optionalInteger(entry?.episodeNumber, 1);
    const label = entry?.label === undefined
      ? undefined
      : boundedString(entry.label);
    if (
      !entry ||
      typeof titleNumber !== "number" ||
      !title ||
      typeof episodeNumber !== "number" ||
      (entry.label !== undefined && !label) ||
      selectedTitleNumbers.has(titleNumber) ||
      !hasOnlyFields(entry, [
        "titleNumber",
        "title",
        "episodeNumber",
        "label",
      ])
    ) {
      return null;
    }
    selectedTitleNumbers.add(titleNumber);
    episodes.push({
      titleNumber,
      title,
      episodeNumber,
      ...(label ? { label } : {}),
    });
  }
  return episodes;
}

function parseDiscSelectionInput(
  value: unknown,
):
  | { ok: true; selection: CatalogReviewDiscSelectionInput }
  | { ok: false; error: CatalogReviewCommandValidationError } {
  const input = asRecord(value);
  const mediaItemId = boundedString(input?.mediaItemId);
  const proposedSelection = parseProposedDiscSelectionInput(value);
  if (!mediaItemId || !proposedSelection) {
    return {
      ok: false,
      error: "Invalid Disc Selection",
    };
  }
  return {
    ok: true,
    selection: { mediaItemId, ...proposedSelection },
  };
}

function parseDiscSelectionChanges(
  value: unknown,
): CatalogReviewDiscSelectionChanges | null {
  const input = asRecord(value);
  if (
    !input ||
    Object.keys(input).length === 0 ||
    !hasOnlyFields(input, ["mediaItemId", "sourceIdentity", "label"])
  ) {
    return null;
  }
  const changes: CatalogReviewDiscSelectionChangeFields = {};
  if ("mediaItemId" in input) {
    const mediaItemId = boundedString(input.mediaItemId);
    if (!mediaItemId) {
      return null;
    }
    changes.mediaItemId = mediaItemId;
  }
  if ("sourceIdentity" in input) {
    const sourceIdentity = asRecord(input.sourceIdentity);
    if (!sourceIdentity) {
      return null;
    }
    try {
      changes.sourceIdentity = createDiscSelectionSourceIdentity(
        sourceIdentity as unknown as DiscSelectionSourceIdentityInput,
      );
    } catch {
      return null;
    }
  }
  if ("label" in input) {
    if (input.label === null) {
      changes.label = null;
    } else {
      const label = boundedString(input.label);
      if (!label) {
        return null;
      }
      changes.label = label;
    }
  }
  return changes as CatalogReviewDiscSelectionChanges;
}

function parseReplacementEncodes(
  value: unknown,
): CatalogReviewReplacementEncodeInput[] | null {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES
  ) {
    return null;
  }
  const predecessorIds = new Set<string>();
  const replacements: CatalogReviewReplacementEncodeInput[] = [];
  for (const valueEntry of value) {
    const entry = asRecord(valueEntry);
    const predecessorEncodeJobId = boundedString(
      entry?.predecessorEncodeJobId,
    );
    const encodingProfileId = boundedString(entry?.encodingProfileId);
    const outputPath = boundedString(entry?.outputPath, 4_096);
    const priority = optionalInteger(
      entry?.priority,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      !entry ||
      !predecessorEncodeJobId ||
      !encodingProfileId ||
      !outputPath ||
      (entry.priority !== undefined && priority === undefined) ||
      predecessorIds.has(predecessorEncodeJobId) ||
      !hasOnlyFields(entry, [
        "predecessorEncodeJobId",
        "encodingProfileId",
        "outputPath",
        "priority",
      ])
    ) {
      return null;
    }
    predecessorIds.add(predecessorEncodeJobId);
    replacements.push({
      predecessorEncodeJobId:
        predecessorEncodeJobId as EncodeJobId,
      encodingProfileId: encodingProfileId as EncodingProfileId,
      outputPath,
      ...(typeof priority === "number" ? { priority } : {}),
    });
  }
  return replacements;
}

export function parseCatalogReviewCommand(
  value: unknown,
  domainValues: CatalogReviewCommandDomainValues,
): CatalogReviewCommandParseResult {
  const body = asRecord(value);
  const action = boundedString(body?.action, 64);
  if (!body || !action) {
    return invalid("Invalid catalog review mutation");
  }

  switch (action) {
    case "create_episodic_mapping_proposal": {
      const revision = catalogRevision(body.catalogRevision);
      const tvShow = parseEpisodicTvShowTarget(body.tvShow);
      const season = parseEpisodicSeasonTarget(body.season);
      const episodes = parseEpisodicEpisodes(body.episodes);
      return revision && tvShow && season && episodes
        ? {
            ok: true,
            command: {
              action,
              catalogRevision: revision,
              tvShow,
              season,
              episodes,
            },
          }
        : invalid("Invalid Episodic Mapping Proposal");
    }
    case "create_mapping_proposal": {
      const revision = catalogRevision(body.catalogRevision);
      const target = parseMappingTarget(body.target, domainValues);
      const discSelection = parseProposedDiscSelectionInput(
        body.discSelection,
      );
      return revision && target && discSelection
        ? {
            ok: true,
            command: {
              action,
              catalogRevision: revision,
              target,
              discSelection,
            },
          }
        : invalid("Invalid Mapping Proposal");
    }
    case "create_media_item": {
      const mediaItem = parseMediaItemInput(body.mediaItem, domainValues);
      return mediaItem
        ? { ok: true, command: { action, mediaItem } }
        : invalid("Invalid Media Item");
    }
    case "update_media_item": {
      const mediaItemId = boundedString(body.mediaItemId);
      const parsedChanges = parseMediaItemChanges(body.changes, domainValues);
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
    case "delete_media_item": {
      const mediaItemId = boundedString(body.mediaItemId);
      return mediaItemId
        ? { ok: true, command: { action, mediaItemId } }
        : invalid("Invalid Media Item");
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
    case "update_disc_selection": {
      const discSelectionId = boundedString(body.discSelectionId);
      const changes = parseDiscSelectionChanges(body.changes);
      return discSelectionId && changes
        ? {
            ok: true,
            command: { action, discSelectionId, changes },
          }
        : invalid(
          "Invalid Disc Selection update",
          discSelectionId ?? undefined,
        );
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
        : invalid(parsedSelection.error, discSelectionId);
    }
    case "correct_disc_selection": {
      const discSelectionId = boundedString(body.discSelectionId);
      const revision = catalogRevision(body.catalogRevision);
      const correctionReason = body.correctionReason === undefined
        ? undefined
        : boundedString(body.correctionReason, 1_000);
      const parsedSelection = parseDiscSelectionInput(body.selection);
      return discSelectionId && revision &&
          (body.correctionReason === undefined || correctionReason) &&
          parsedSelection.ok
        ? {
            ok: true,
            command: {
              action,
              discSelectionId,
              catalogRevision: revision,
              ...(typeof correctionReason === "string"
                ? { correctionReason }
                : {}),
              selection: parsedSelection.selection,
            },
          }
        : invalid("Invalid Disc Selection Correction");
    }
    case "delete_disc_selection": {
      const discSelectionId = boundedString(body.discSelectionId);
      return discSelectionId
        ? { ok: true, command: { action, discSelectionId } }
        : invalid("Invalid Disc Selection");
    }
    case "complete_review": {
      const revision = catalogRevision(body.catalogRevision);
      if (!revision) {
        return invalid("Invalid catalog review revision");
      }
      const outcome = completedCatalogReviewOutcome(body.outcome);
      const replacementEncodes = parseReplacementEncodes(
        body.replacementEncodes,
      );
      return outcome && replacementEncodes
        ? {
            ok: true,
            command: {
              action,
              catalogRevision: revision,
              outcome,
              replacementEncodes,
            },
          }
        : invalid(
          outcome
            ? "Invalid corrected Encode replacement plan"
            : "Invalid catalog review outcome",
        );
    }
    default:
      return invalid("Unknown catalog review mutation");
  }
}
