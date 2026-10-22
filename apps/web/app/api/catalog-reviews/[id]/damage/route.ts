import {
  createApplicationOperations,
  InvalidCatalogTitleDamageInputError,
  StaleCatalogTitleDamageCursorError,
} from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function createCatalogTitleDamageRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
): Response {
  const response = (body: unknown, status = 200) => Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
  const params = new URL(request.url).searchParams;
  if (
    request.method !== "GET" ||
    [...params.keys()].some((key) =>
      (key !== "limit" && key !== "cursor") ||
      params.getAll(key).length !== 1
    )
  ) {
    return response({ error: { code: "INVALID_ARGUMENTS" } }, 400);
  }
  try {
    return response(
      createApplicationOperations(getAccess()).inspectCatalogTitleDamage(id, {
        ...(params.has("limit")
          ? { limit: Number(params.get("limit")) }
          : {}),
        ...(params.has("cursor") ? { cursor: params.get("cursor")! } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof InvalidCatalogTitleDamageInputError) {
      return response({ error: { code: "INVALID_ARGUMENTS" } }, 400);
    }
    if (error instanceof StaleCatalogTitleDamageCursorError) {
      return response({
        error: { code: error.code, current: error.current },
      }, 409);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: { code: "NOT_FOUND" } }, 404);
    }
    return response({ error: { code: "INSPECTION_UNAVAILABLE" } }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createCatalogTitleDamageRoute(
    request,
    (await context.params).id,
  );
}
