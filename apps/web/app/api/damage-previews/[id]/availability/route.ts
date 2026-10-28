import { createApplicationOperations, InvalidDamagePreviewInputError } from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";
import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function createDamagePreviewAvailabilityRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET" && request.method !== "POST") return response({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  if (new URL(request.url).searchParams.size > 0) return response({ error: { code: "INVALID_ARGUMENTS" } }, 400);
  let input: unknown;
  if (request.method === "POST") {
    const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
    if (problem) return problem;
    try { input = await request.json(); }
    catch { return response({ error: { code: "INVALID_ARGUMENTS" } }, 400); }
  }
  try {
    return response(await createApplicationOperations(getAccess()).inspectDamagePreviewAvailability(id, input));
  } catch (error) {
    if (error instanceof InvalidDamagePreviewInputError) return response({ error: { code: "INVALID_ARGUMENTS" } }, 400);
    if (error instanceof RecordNotFoundError) return response({ error: { code: "NOT_FOUND" } }, 404);
    return response({ error: { code: "INSPECTION_UNAVAILABLE" } }, 503);
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return createDamagePreviewAvailabilityRoute(request, (await context.params).id);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return createDamagePreviewAvailabilityRoute(request, (await context.params).id);
}
