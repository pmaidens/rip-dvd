import type { DataAccess, OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { createApplicationOperations } from "@rip-dvd/application";

import {
  type CatalogMetadataLookup,
  type CatalogMetadataSelection,
} from "../../../../../lib/catalog-automation";
import { getDataAccess } from "../../../../../lib/data-access";
import {
  createTmdbCatalogLookup,
  tmdbCredentialFromEnvironment,
} from "../../../../../lib/server/tmdb-catalog-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function defaultLookup(): CatalogMetadataLookup | null {
  const credential = tmdbCredentialFromEnvironment();
  return credential === null ? null : createTmdbCatalogLookup(credential);
}

function metadataSelectionFromParameters(
  parameters: URLSearchParams,
): CatalogMetadataSelection | undefined | null {
  if ([...parameters.keys()].length === 0) return undefined;
  if (
    [...parameters.keys()].some((key) =>
      key !== "tmdbId" && key !== "mediaType"
    ) ||
    parameters.getAll("tmdbId").length !== 1 ||
    parameters.getAll("mediaType").length !== 1
  ) {
    return null;
  }
  const tmdbIdText = parameters.get("tmdbId") ?? "";
  const mediaType = parameters.get("mediaType");
  const tmdbId = Number(tmdbIdText);
  return /^(?:[1-9]\d*)$/.test(tmdbIdText) &&
      Number.isSafeInteger(tmdbId) &&
      (mediaType === "movie" || mediaType === "tv_show")
    ? { id: tmdbId, kind: mediaType }
    : null;
}

export async function createCatalogSuggestionRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getLookup: () => CatalogMetadataLookup | null = defaultLookup,
): Promise<Response> {
  if (request.method !== "GET") {
    return response({ error: "Method not allowed" }, 405);
  }
  const parameters = new URL(request.url).searchParams;
  const metadataSelection = metadataSelectionFromParameters(parameters);
  if (
    metadataSelection === null ||
    id.trim().length === 0 || id.length > 256
  ) {
    return response({ error: "Invalid Catalog suggestion request" }, 400);
  }
  try {
    const suggestion = await createApplicationOperations(getAccess()).catalogSuggestion(
      id as OriginalDiscArchiveId,
      getLookup(),
      metadataSelection,
    );
    return suggestion === null
      ? response({ error: "Original Disc Archive not found" }, 404)
      : response(suggestion);
  } catch {
    return response({
      status: "needs_review",
      reason: "metadata_unavailable",
      message:
        "Automatic cataloging is unavailable. The archived disc is safe, and the manual tools still work.",
    }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createCatalogSuggestionRoute(request, id);
}
