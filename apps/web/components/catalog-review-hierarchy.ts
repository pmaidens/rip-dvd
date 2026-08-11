import type { CatalogReviewMediaItem } from "./catalog-review-model";

export interface OrderedMediaItem {
  item: CatalogReviewMediaItem;
  depth: number;
}

export function orderMediaItemHierarchy(
  items: CatalogReviewMediaItem[],
): OrderedMediaItem[] {
  const byParent = new Map<string | null, CatalogReviewMediaItem[]>();
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId)
      ? item.parentId
      : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), item]);
  }
  const ordered: OrderedMediaItem[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const item of byParent.get(parentId) ?? []) {
      if (visited.has(item.id)) {
        continue;
      }
      visited.add(item.id);
      ordered.push({ item, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const item of items) {
    if (!visited.has(item.id)) {
      ordered.push({ item, depth: 0 });
    }
  }
  return ordered;
}
