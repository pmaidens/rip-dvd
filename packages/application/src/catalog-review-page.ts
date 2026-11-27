import type {
  CatalogReviewArchiveListCursor,
  CatalogReviewArchiveView,
  CompletedCatalogReviewOutcome,
  ConsistentReadAccess,
  OriginalDiscArchive,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

interface CatalogReviewPageOptions {
  view: CatalogReviewArchiveView;
  cursor?: CatalogReviewArchiveListCursor;
  limit?: number;
  query?: string;
  outcome?: CompletedCatalogReviewOutcome;
}

export const CATALOG_REVIEW_PAGE_LIMIT = 20;

const CATALOG_REVIEW_CURSOR_PATTERN =
  /^v1\.(newer|older)(-inclusive)?\.(\d{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function encodeCatalogReviewCursor(
  direction: CatalogReviewArchiveListCursor["direction"],
  archive: Pick<OriginalDiscArchive, "archivedAt" | "id">,
  inclusive: boolean,
): string {
  return `v1.${direction}${inclusive ? "-inclusive" : ""}.${archive.archivedAt.getTime()}.${archive.id}`;
}

export function parseCatalogReviewCursor(
  value: string | null,
): CatalogReviewArchiveListCursor | null | undefined {
  if (value === null) return undefined;
  const match = CATALOG_REVIEW_CURSOR_PATTERN.exec(value);
  if (!match) return null;

  const archivedAtMilliseconds = Number(match[3]);
  const archivedAt = new Date(archivedAtMilliseconds);
  if (
    !Number.isSafeInteger(archivedAtMilliseconds) ||
    Number.isNaN(archivedAt.getTime())
  ) {
    return null;
  }
  return {
    direction: match[1]!.toLowerCase() as CatalogReviewArchiveListCursor["direction"],
    archivedAt,
    id: match[4]!.toLowerCase() as OriginalDiscArchiveId,
    ...(match[2] === undefined ? {} : { inclusive: true }),
  };
}

export function readCatalogReviewPage(
  access: ConsistentReadAccess,
  { limit, ...options }: CatalogReviewPageOptions,
) {
  const { cursor, view } = options;
  const rows = access.catalog.listCatalogReviewArchives({
    ...options,
    limit: limit === undefined ? 100 : limit + 1,
  });
  const readsNewer = cursor?.direction === "newer";
  const items = limit === undefined
    ? rows
    : readsNewer ? rows.slice(0, limit) : rows.slice(-limit);
  // Persistence returns the selected rows in ascending key order in both directions.
  const newest = items.at(-1);
  const oldest = items[0];
  if (view === "needs_review") items.reverse();

  if (limit === undefined) return { items };
  const hasMore = rows.length > limit;
  if (view === "needs_review" && cursor === undefined && !hasMore) return { items };

  const previousBoundary = newest ?? (readsNewer ? undefined : cursor);
  const nextBoundary = oldest ?? (readsNewer ? cursor : undefined);
  return {
    items,
    page: {
      limit,
      previousCursor: (readsNewer ? hasMore : cursor !== undefined) && previousBoundary
        ? encodeCatalogReviewCursor("newer", previousBoundary, items.length === 0)
        : null,
      nextCursor: (readsNewer ? cursor !== undefined : hasMore) && nextBoundary
        ? encodeCatalogReviewCursor("older", nextBoundary, items.length === 0)
        : null,
    },
  };
}
