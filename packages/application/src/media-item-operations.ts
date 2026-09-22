import {
  DomainInvariantError,
  normalizeMediaItemSearchTitle,
  RecordNotFoundError,
  type CreateMediaItemInput,
  type DataAccess,
  type MediaItem,
  type MediaItemId,
  type OriginalDiscArchiveId,
  type SnapshotCatalogAccess,
} from "@rip-dvd/data-access";

import { parseMutationKey } from "./mutation-key.js";
import { serializeMediaItem } from "./catalog-review-read.js";
import type { CatalogReviewCommand, CatalogReviewMediaItemChanges, CatalogReviewMediaItemInput } from "./catalog-review-command.js";
import { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";

export type MediaItemCommand = Extract<CatalogReviewCommand, {
  action: "create_media_item" | "update_media_item" | "delete_media_item";
}>;

export function catalogReviewMediaItemInput(
  input: CatalogReviewMediaItemInput,
): CreateMediaItemInput {
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
  changes?: CatalogReviewMediaItemChanges,
) {
  if (action === "update" && changes === undefined) {
    throw new DomainInvariantError("Proposed Media Item changes are required for update preview");
  }
  return access.readConsistentSnapshot((snapshot) => {
    const state = readMediaItemState(snapshot.catalog, id);
    const proposedInput = changes === undefined ? null : updateInput(changes);
    let proposedMediaItem = null;
    let availability: { state: "available" | "unavailable"; reason: string | null } =
      action === "delete" ? state.maintenance.deletionAvailability
      : { state: "available", reason: null };
    if (proposedInput !== null) {
      try {
        proposedMediaItem = serializeMediaItem(snapshot.catalog.previewMediaItemUpdate(id, proposedInput));
      } catch (error) {
        if (!(error instanceof DomainInvariantError || error instanceof RecordNotFoundError)) throw error;
        availability = { state: "unavailable", reason: error.message };
      }
    }
    const requiresAcknowledgement = action === "delete" ||
      state.impact.affectedArchiveCount > 0 ||
      (proposedInput?.parentId !== undefined && proposedInput.parentId !== state.mediaItem.parentId) ||
      (proposedInput?.kind !== undefined && proposedInput.kind !== state.mediaItem.kind);
    return {
      action,
      ...state,
      proposedMediaItem,
      requiresAcknowledgement,
      revision: JSON.stringify({ updatedAt: state.revision,
        referencedArchiveCount: state.maintenance.referencedArchiveCount,
        childCount: state.maintenance.childCount,
        impactRevision: state.impact.revision, changes: proposedInput }),
      consequence: action === "delete"
        ? "This Media Item and its metadata identity will be removed."
        : `${Object.keys(proposedInput ?? {}).join(", ")} will change for this Media Item` +
          (state.impact.affectedArchiveCount > 0
            ? ` and ${state.impact.affectedArchiveCount} affected archive(s)` : "") + ".",
      availability,
    };
  });
}

function readMediaItemState(catalog: SnapshotCatalogAccess, id: MediaItemId) {
  const item = catalog.listMediaItems({ ids: [id] })[0];
  if (!item) throw new RecordNotFoundError("media item", id);
  const maintenance = catalog.listMediaItemMaintenance({ ids: [id] })[0];
  if (!maintenance) throw new DomainInvariantError(`Media Item ${id} is missing maintenance state`);
  return { mediaItem: serializeMediaItem(item), tmdbIdentity: catalog.findTmdbIdentityByMediaItemId(id),
    revision: item.updatedAt.toISOString(), maintenance, impact: catalog.inspectMediaItemImpact(id) };
}

export function showMediaItem(access: DataAccess, id: MediaItemId) {
  return access.readConsistentSnapshot((snapshot) => readMediaItemState(snapshot.catalog, id));
}

export function mutateMediaItem(
  access: DataAccess,
  input: { mutationKey: unknown; command: MediaItemCommand; acknowledgedRevision?: string },
) {
  const mutationKey = parseMutationKey(input.mutationKey);
  const command = input.command;
  if (command.action === "create_media_item") {
    const item = access.catalog.createMediaItem(
      catalogReviewMediaItemInput(command.mediaItem),
      { mutationKey },
    );
    return { message: "Media Item created", mediaItem: serializeMediaItem(item) };
  }
  const proposedInput = command.action === "update_media_item" ? updateInput(command.changes) : null;
  const acknowledged = parseAcknowledgedRevision(input.acknowledgedRevision, proposedInput);
  if (command.action === "delete_media_item" && acknowledged === null) {
    throw new DomainInvariantError("Preview and acknowledge the current Media Item revision");
  }
  const options = { mutationKey, requirePreviewIfAffected: true,
    ...(acknowledged === null ? {} : { expectedUpdatedAt: new Date(acknowledged.updatedAt),
      expectedReferencedArchiveCount: acknowledged.referencedArchiveCount,
      expectedChildCount: acknowledged.childCount,
      expectedImpactRevision: acknowledged.impactRevision }) };
  if (command.action === "update_media_item") {
    const item = access.catalog.updateMediaItem(
      command.mediaItemId as MediaItemId,
      proposedInput!, options,
    );
    return { message: "Metadata saved", mediaItem: serializeMediaItem(item) };
  }
  const item = access.catalog.deleteMediaItem(command.mediaItemId as MediaItemId, options);
  return { message: "Media Item deleted", mediaItem: serializeMediaItem(item) };
}

function parseAcknowledgedRevision(value: string | undefined, changes: object | null):
  { updatedAt: string; referencedArchiveCount: number; childCount: number; impactRevision: string } | null {
  if (value === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object") {
    throw new DomainInvariantError("Preview and acknowledge the current Media Item revision");
  }
  const state = parsed as Record<string, unknown>;
  const updatedAt = state.updatedAt;
  if (typeof updatedAt !== "string" || !Number.isFinite(new Date(updatedAt).getTime()) ||
      new Date(updatedAt).toISOString() !== updatedAt ||
      !Number.isSafeInteger(state.referencedArchiveCount) ||
      !Number.isSafeInteger(state.childCount) ||
      typeof state.impactRevision !== "string" || !/^[0-9a-f]{64}$/.test(state.impactRevision) ||
      JSON.stringify(state.changes) !== JSON.stringify(changes)) {
    throw new DomainInvariantError("Preview and acknowledge the proposed Media Item change");
  }
  return { updatedAt, referencedArchiveCount: state.referencedArchiveCount as number,
    childCount: state.childCount as number, impactRevision: state.impactRevision as string };
}
