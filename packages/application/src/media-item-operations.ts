import {
  DomainInvariantError,
  normalizeMediaItemSearchTitle,
  RecordNotFoundError,
  type CreateMediaItemInput,
  type DataAccess,
  type MediaItem,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { parseMutationKey } from "./mutation-key.js";
import { serializeMediaItem } from "./catalog-review-read.js";
import type { CatalogReviewCommand, CatalogReviewMediaItemInput } from "./catalog-review-command.js";
import { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";

export type MediaItemCommand = Extract<CatalogReviewCommand, {
  action: "create_media_item" | "update_media_item" | "delete_media_item";
}>;

function createInput(input: CatalogReviewMediaItemInput): CreateMediaItemInput {
  return {
    ...(input.parentId ? { parentId: input.parentId as MediaItemId } : {}),
    kind: input.kind,
    title: input.title,
    ...(typeof input.year === "number" ? { year: input.year } : {}),
    ...(typeof input.seasonNumber === "number" ? { seasonNumber: input.seasonNumber } : {}),
    ...(typeof input.episodeNumber === "number" ? { episodeNumber: input.episodeNumber } : {}),
    ...(input.tmdbIdentity === undefined ? {} : { tmdbIdentity: input.tmdbIdentity }),
  };
}

function updateInput(changes: Extract<MediaItemCommand, { action: "update_media_item" }>["changes"]):
  Parameters<DataAccess["catalog"]["updateMediaItem"]>[1] {
  return {
    ...(changes.parentId === undefined ? {} : { parentId: changes.parentId as MediaItemId | null }),
    ...(changes.kind === undefined ? {} : { kind: changes.kind }),
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.year === undefined ? {} : { year: changes.year }),
    ...(changes.seasonNumber === undefined ? {} : { seasonNumber: changes.seasonNumber }),
    ...(changes.episodeNumber === undefined ? {} : { episodeNumber: changes.episodeNumber }),
  };
}

export function searchMediaItems(
  access: DataAccess,
  input: { query: string; offset: number; archiveId?: OriginalDiscArchiveId },
) {
  const query = input.query.trim();
  const normalizedQuery = normalizeMediaItemSearchTitle(query);
  if (query.length === 0 || query.length > 256 || normalizedQuery.length === 0 ||
      !Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new DomainInvariantError("Invalid Media Item search query");
  }
  const limit = 20;
  return access.readConsistentSnapshot((snapshot) => {
    const matches = snapshot.catalog.searchMediaItems({ query, limit: limit + 1, offset: input.offset });
    const page = matches.slice(0, limit);
    const context = readMediaItemsWithAncestors(snapshot.catalog, page.map((item) => item.id));
    const byId = new Map(context.map((item) => [item.id, item]));
    const maintenance = new Map(snapshot.catalog.listMediaItemMaintenance({
      ids: page.map((item) => item.id),
      ...(input.archiveId === undefined ? {} : { currentArchiveId: input.archiveId }),
    }).map((item) => [item.mediaItemId, item]));
    return {
      results: page.map((item) => {
        const ancestors: MediaItem[] = [];
        let parentId = item.parentId;
        while (parentId !== null) {
          const parent = byId.get(parentId);
          if (!parent) break;
          ancestors.unshift(parent);
          parentId = parent.parentId;
        }
        const state = maintenance.get(item.id);
        if (!state) throw new DomainInvariantError(`Media Item ${item.id} is missing maintenance state`);
        const { mediaItemId: _mediaItemId, ...maintenanceState } = state;
        return {
          mediaItem: serializeMediaItem(item),
          ancestors: ancestors.map((ancestor) => serializeMediaItem(ancestor)),
          maintenance: maintenanceState,
          suggestion: item.title === query ? "exact" as const
            : normalizeMediaItemSearchTitle(item.title) === normalizedQuery ? "normalized" as const : null,
        };
      }),
      page: { offset: input.offset, limit, hasPrevious: input.offset > 0, hasNext: matches.length > limit },
    };
  });
}

export function previewMediaItemChange(
  access: DataAccess,
  id: MediaItemId,
  action: "update" | "delete",
) {
  return access.readConsistentSnapshot((snapshot) => {
    const item = snapshot.catalog.listMediaItems({ ids: [id] })[0];
    if (!item) throw new RecordNotFoundError("media item", id);
    const maintenance = snapshot.catalog.listMediaItemMaintenance({ ids: [id] })[0];
    if (!maintenance) throw new DomainInvariantError(`Media Item ${id} is missing maintenance state`);
    return {
      action,
      mediaItem: serializeMediaItem(item),
      tmdbIdentity: snapshot.catalog.findTmdbIdentityByMediaItemId(id),
      revision: item.updatedAt.toISOString(),
      maintenance,
      consequence: action === "delete"
        ? "This Media Item and its metadata identity will be removed."
        : "Changes to this Media Item affect every referencing Original Disc Archive.",
      availability: action === "delete" ? maintenance.deletionAvailability
        : { state: "available" as const, reason: null },
    };
  });
}

export function showMediaItem(access: DataAccess, id: MediaItemId) {
  return access.readConsistentSnapshot((snapshot) => {
    const item = snapshot.catalog.listMediaItems({ ids: [id] })[0];
    if (!item) throw new RecordNotFoundError("media item", id);
    const maintenance = snapshot.catalog.listMediaItemMaintenance({ ids: [id] })[0];
    if (!maintenance) throw new DomainInvariantError(`Media Item ${id} is missing maintenance state`);
    return {
      mediaItem: serializeMediaItem(item),
      tmdbIdentity: snapshot.catalog.findTmdbIdentityByMediaItemId(id),
      revision: item.updatedAt.toISOString(),
      maintenance,
    };
  });
}

export function mutateMediaItem(
  access: DataAccess,
  input: { mutationKey: unknown; command: MediaItemCommand; acknowledgedRevision?: string },
) {
  const mutationKey = parseMutationKey(input.mutationKey);
  const command = input.command;
  if (command.action === "create_media_item") {
    const item = access.catalog.createMediaItem(createInput(command.mediaItem), { mutationKey });
    return { message: "Media Item created", mediaItem: serializeMediaItem(item) };
  }
  const revision = typeof input.acknowledgedRevision === "string"
    ? new Date(input.acknowledgedRevision) : null;
  if (revision === null || !Number.isSafeInteger(revision.getTime()) ||
      revision.toISOString() !== input.acknowledgedRevision) {
    throw new DomainInvariantError("Preview and acknowledge the current Media Item revision");
  }
  const expectedUpdatedAt = revision;
  if (command.action === "update_media_item") {
    const item = access.catalog.updateMediaItem(
      command.mediaItemId as MediaItemId,
      updateInput(command.changes),
      { mutationKey, expectedUpdatedAt },
    );
    return { message: "Metadata saved", mediaItem: serializeMediaItem(item) };
  }
  const item = access.catalog.deleteMediaItem(command.mediaItemId as MediaItemId, {
    mutationKey,
    expectedUpdatedAt,
  });
  return { message: "Media Item deleted", mediaItem: serializeMediaItem(item) };
}
