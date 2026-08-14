import {
  DomainInvariantError,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  type MediaItem,
  type MediaItemId,
  type SnapshotCatalogAccess,
} from "@rip-dvd/data-access";

const MEDIA_ITEM_ANCESTOR_LOOKUP_BATCH_SIZE = 100;

export function readMediaItemsWithAncestors(
  catalog: Pick<SnapshotCatalogAccess, "listMediaItems">,
  seedIds: readonly MediaItemId[],
): MediaItem[] {
  const mediaItemsById = new Map<MediaItemId, MediaItem>();
  const processedDepths = new Map<MediaItemId, number>();
  let pendingDepths = new Map(seedIds.map((itemId) => [itemId, 1]));

  while (pendingDepths.size > 0) {
    const currentDepths = pendingDepths;
    pendingDepths = new Map();
    const missingIds = [...currentDepths.keys()].filter(
      (itemId) => !mediaItemsById.has(itemId),
    );
    const contextItems: MediaItem[] = [];
    for (
      let offset = 0;
      offset < missingIds.length;
      offset += MEDIA_ITEM_ANCESTOR_LOOKUP_BATCH_SIZE
    ) {
      contextItems.push(...catalog.listMediaItems({
        ids: missingIds.slice(
          offset,
          offset + MEDIA_ITEM_ANCESTOR_LOOKUP_BATCH_SIZE,
        ),
      }));
    }
    for (const item of contextItems) {
      mediaItemsById.set(item.id, item);
    }
    for (const [itemId, depth] of currentDepths) {
      if ((processedDepths.get(itemId) ?? 0) >= depth) {
        continue;
      }
      processedDepths.set(itemId, depth);
      const item = mediaItemsById.get(itemId);
      if (item?.parentId !== null && item?.parentId !== undefined) {
        const parentDepth = depth + 1;
        if (parentDepth > MAX_MEDIA_ITEM_HIERARCHY_DEPTH) {
          throw new DomainInvariantError(
            "Media Item hierarchy exceeds the supported depth",
          );
        }
        if (
          (processedDepths.get(item.parentId) ?? 0) < parentDepth &&
          (pendingDepths.get(item.parentId) ?? 0) < parentDepth
        ) {
          pendingDepths.set(item.parentId, parentDepth);
        }
      }
    }
  }

  return [...mediaItemsById.values()];
}
