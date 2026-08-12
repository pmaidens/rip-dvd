import {
  DomainInvariantError,
  type DataAccess,
  type MediaItem,
  type MediaItemId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { readMediaItemsWithAncestors } from "../../../lib/media-item-ancestor-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MEDIA_ITEM_SEARCH_PAGE_SIZE = 20;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function serializeMediaItem(item: MediaItem) {
  return {
    id: item.id,
    parentId: item.parentId,
    kind: item.kind,
    title: item.title,
    year: item.year,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
  };
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function recordOffset(parameters: URLSearchParams): number | null {
  const values = parameters.getAll("offset");
  if (values.length === 0) {
    return 0;
  }
  const value = values[0]!;
  if (
    values.length !== 1 ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 16
  ) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

export async function createMediaItemSearchRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
): Promise<Response> {
  if (request.method !== "GET") {
    return response({ error: "Method not allowed" }, 405);
  }
  const parameters = new URL(request.url).searchParams;
  const queryValues = parameters.getAll("query");
  const query = queryValues[0]?.trim() ?? "";
  const normalizedQuery = normalizeTitle(query);
  const offset = recordOffset(parameters);
  if (
    [...parameters.keys()].some((key) => key !== "query" && key !== "offset") ||
    queryValues.length !== 1 ||
    query.length === 0 ||
    query.length > 256 ||
    normalizedQuery.length === 0 ||
    offset === null
  ) {
    return response({ error: "Invalid Media Item search query" }, 400);
  }

  try {
    const result = getAccess().readConsistentSnapshot((snapshot) => {
      const matches = snapshot.catalog.searchMediaItems({
        query,
        limit: MEDIA_ITEM_SEARCH_PAGE_SIZE + 1,
        offset,
      });
      const hasNext = matches.length > MEDIA_ITEM_SEARCH_PAGE_SIZE;
      const page = matches.slice(0, MEDIA_ITEM_SEARCH_PAGE_SIZE);
      const context = readMediaItemsWithAncestors(
        snapshot.catalog,
        page.map((item) => item.id),
      );
      const mediaItemsById = new Map(context.map((item) => [item.id, item]));
      return {
        results: page.map((mediaItem) => {
          const ancestors: MediaItem[] = [];
          let parentId: MediaItemId | null = mediaItem.parentId;
          while (parentId !== null) {
            const parent = mediaItemsById.get(parentId);
            if (!parent) {
              break;
            }
            ancestors.unshift(parent);
            parentId = parent.parentId;
          }
          return {
            mediaItem: serializeMediaItem(mediaItem),
            ancestors: ancestors.map(serializeMediaItem),
            suggestion: mediaItem.title === query
              ? "exact"
              : normalizeTitle(mediaItem.title) === normalizedQuery
              ? "normalized"
              : null,
          };
        }),
        page: {
          offset,
          limit: MEDIA_ITEM_SEARCH_PAGE_SIZE,
          hasPrevious: offset > 0,
          hasNext,
        },
      };
    });
    return response(result);
  } catch (error) {
    return error instanceof DomainInvariantError
      ? response({ error: error.message }, 409)
      : response({ error: "Media Item search is unavailable" }, 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  return createMediaItemSearchRoute(request);
}
