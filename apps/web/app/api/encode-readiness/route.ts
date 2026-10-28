import { loadConfig } from "@rip-dvd/config";
import { createApplicationOperations, InvalidEncodingReadinessInputError } from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import type { ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function createEncodingReadinessRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getConfig: () => { originalsLibraryPath: string } = loadConfig,
  ownership?: ArchiveImageOwnership,
): Promise<Response> {
  const response = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
  if (request.method !== "GET") return response({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("archiveId");
    const offset = params.get("offset") ?? "0";
    if ([...params.keys()].some((key) => !["archiveId", "offset"].includes(key)) ||
        params.getAll("archiveId").length > 1 || params.getAll("offset").length > 1 ||
        (id !== null && (params.has("offset") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) ||
        !/^(0|[1-9][0-9]{0,14})$/.test(offset)) {
      throw new InvalidEncodingReadinessInputError();
    }
    const operations = createApplicationOperations(getAccess(), { archiveImageOwnership: ownership });
    return response(id === null ? operations.listEncodingReadinessArchives(Number(offset))
      : await operations.inspectEncodingReadiness(id, getConfig().originalsLibraryPath));
  } catch (error) {
    if (error instanceof InvalidEncodingReadinessInputError) return response({ error: { code: "INVALID_ARGUMENTS" } }, 400);
    if (error instanceof RecordNotFoundError) return response({ error: { code: "NOT_FOUND" } }, 404);
    return response({ error: { code: "ENCODING_READINESS_UNAVAILABLE" } }, 503);
  }
}

export function GET(request: Request): Promise<Response> {
  return createEncodingReadinessRoute(request);
}
