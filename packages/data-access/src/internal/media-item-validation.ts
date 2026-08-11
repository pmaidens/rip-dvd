import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-sqlite";

import {
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  MEDIA_ITEM_KINDS,
} from "../domain-values.js";
import { DomainInvariantError } from "../errors.js";
import type { MediaItemId, MediaItemKind } from "../types.js";
import { mediaItems } from "./schema.js";
import { requireRow } from "./persistence.js";
import { requireNonEmpty } from "./validation.js";

type MediaItemValidationSource = Pick<
  ReturnType<typeof drizzle>,
  "get" | "select"
>;

export interface MediaItemCandidate {
  id: MediaItemId;
  parentId?: unknown;
  kind: unknown;
  title: unknown;
  year?: unknown;
  seasonNumber?: unknown;
  episodeNumber?: unknown;
}

export interface ValidatedMediaItem {
  parentId: MediaItemId | null;
  kind: MediaItemKind;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface MediaItemValidationOptions {
  titleNormalization: "preserve" | "trim";
}

function mediaItemKind(value: unknown): MediaItemKind {
  if (
    typeof value !== "string" ||
    !MEDIA_ITEM_KINDS.includes(value as MediaItemKind)
  ) {
    throw new DomainInvariantError("Media Item kind is not supported");
  }
  return value as MediaItemKind;
}

function mediaItemParentId(value: unknown): MediaItemId | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainInvariantError("Media Item parent must be a valid ID");
  }
  return value as MediaItemId;
}

function mediaItemTitle(
  value: unknown,
  titleNormalization: MediaItemValidationOptions["titleNormalization"],
): string {
  if (typeof value !== "string") {
    throw new DomainInvariantError("title must not be empty");
  }
  const normalized = requireNonEmpty(value, "title");
  return titleNormalization === "trim" ? normalized : value;
}

function nullableSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new DomainInvariantError(
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requireAcyclicParent(
  itemId: MediaItemId,
  parentId: MediaItemId | null,
  source: MediaItemValidationSource,
): number {
  if (parentId === null) {
    return 1;
  }
  const visited = new Set<MediaItemId>([itemId]);
  let currentId: MediaItemId | null = parentId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new DomainInvariantError(
        "Media Item hierarchy cannot contain a cycle",
      );
    }
    if (visited.size >= MAX_MEDIA_ITEM_HIERARCHY_DEPTH) {
      throw new DomainInvariantError(
        "Media Item hierarchy exceeds the supported depth",
      );
    }
    visited.add(currentId);
    const current: { id: MediaItemId; parentId: MediaItemId | null } =
      requireRow(
        source
          .select({ id: mediaItems.id, parentId: mediaItems.parentId })
          .from(mediaItems)
          .where(eq(mediaItems.id, currentId))
          .get(),
        "media item",
        currentId,
      );
    currentId = current.parentId;
  }
  return visited.size;
}

function requireHierarchyWithinDepth(
  itemId: MediaItemId,
  parentId: MediaItemId | null,
  source: MediaItemValidationSource,
): void {
  const ancestorDepth = requireAcyclicParent(itemId, parentId, source);
  const descendantDepth = source.get<{ maximumDepth: number }>(sql`
    with recursive media_item_descendants(id, depth) as (
      select ${itemId}, 1
      union all
      select ${mediaItems.id}, media_item_descendants.depth + 1
      from ${mediaItems}
      inner join media_item_descendants
        on ${mediaItems.parentId} = media_item_descendants.id
      where media_item_descendants.depth <= ${MAX_MEDIA_ITEM_HIERARCHY_DEPTH}
    )
    select max(depth) as maximumDepth
    from media_item_descendants
  `).maximumDepth;
  if (
    ancestorDepth + descendantDepth - 1 > MAX_MEDIA_ITEM_HIERARCHY_DEPTH
  ) {
    throw new DomainInvariantError(
      "Media Item hierarchy exceeds the supported depth",
    );
  }
}

export function validateMediaItem(
  candidate: MediaItemCandidate,
  source: MediaItemValidationSource,
  options: MediaItemValidationOptions,
): ValidatedMediaItem {
  const validated = {
    parentId: mediaItemParentId(candidate.parentId),
    kind: mediaItemKind(candidate.kind),
    title: mediaItemTitle(candidate.title, options.titleNormalization),
    year: nullableSafeInteger(candidate.year, "year", 1800, 9999),
    seasonNumber: nullableSafeInteger(
      candidate.seasonNumber,
      "seasonNumber",
      0,
    ),
    episodeNumber: nullableSafeInteger(
      candidate.episodeNumber,
      "episodeNumber",
      1,
    ),
  };
  requireHierarchyWithinDepth(candidate.id, validated.parentId, source);
  return validated;
}
