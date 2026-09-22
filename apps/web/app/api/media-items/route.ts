import { createApplicationOperations } from "@rip-dvd/application";
import { DomainInvariantError, normalizeMediaItemSearchTitle, type DataAccess, type OriginalDiscArchiveId } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function createMediaItemSearchRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
): Promise<Response> {
  if (request.method !== "GET") return response({ error: "Method not allowed" }, 405);
  const parameters = new URL(request.url).searchParams;
  const queries = parameters.getAll("query");
  const archiveIds = parameters.getAll("archiveId");
  const offsets = parameters.getAll("offset");
  const offsetText = offsets[0] ?? "0";
  const offset = Number(offsetText);
  const archiveId = archiveIds[0]?.trim();
  if ([...parameters.keys()].some((key) => !["query", "archiveId", "offset"].includes(key)) ||
      queries.length !== 1 || archiveIds.length > 1 || offsets.length > 1 ||
      queries[0]!.trim().length === 0 || queries[0]!.trim().length > 256 ||
      normalizeMediaItemSearchTitle(queries[0]!).length === 0 ||
      (archiveId !== undefined && (archiveId.length === 0 || archiveId.length > 256)) ||
      !/^(0|[1-9]\d*)$/.test(offsetText) || offsetText.length > 16 ||
      !Number.isSafeInteger(offset)) {
    return response({ error: "Invalid Media Item search query" }, 400);
  }
  try {
    return response(createApplicationOperations(getAccess()).searchMediaItems({
      query: queries[0]!,
      offset,
      ...(archiveId === undefined ? {} : { archiveId: archiveId as OriginalDiscArchiveId }),
    }));
  } catch (error) {
    return error instanceof DomainInvariantError
      ? response({ error: error.message }, error.message === "Invalid Media Item search query" ? 400 : 409)
      : response({ error: "Media Item search is unavailable" }, 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  return createMediaItemSearchRoute(request);
}
