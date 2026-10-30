import { loadConfig } from "@rip-dvd/config";
import { createApplicationOperations, DamagePreviewRejectedError, InvalidDamagePreviewInputError, InvalidMutationKeyError } from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function createDamagePreviewRecreationRoute(request: Request, id: string, getAccess: () => DataAccess = getDataAccess, getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin) {
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    if (new URL(request.url).searchParams.size > 0) throw new InvalidDamagePreviewInputError("Unexpected recreation query.");
    const operations = createApplicationOperations(getAccess());
    if (request.method === "GET") return response(await operations.inspectDamagePreviewRecreation(id));
    if (request.method !== "POST") return response({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
    const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
    if (problem) return problem;
    let input: unknown;
    try { input = await request.json(); } catch { throw new InvalidDamagePreviewInputError("Invalid JSON input."); }
    if (typeof input === "object" && input !== null && !Array.isArray(input) && "mode" in input && input.mode === "review") {
      if (Object.keys(input).some((key) => !["mode", "selection"].includes(key))) throw new InvalidDamagePreviewInputError("Invalid recreation review input.");
      return response(await operations.inspectDamagePreviewRecreation(id, "selection" in input ? input.selection : undefined));
    }
    return response(await operations.recreateDamagePreview(id, input));
  } catch (error) {
    if (error instanceof InvalidDamagePreviewInputError || error instanceof InvalidMutationKeyError) return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    if (error instanceof RecordNotFoundError) return response({ error: { code: "NOT_FOUND", message: error.message } }, 404);
    if (error instanceof MutationKeyConflictError) return response({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
    if (error instanceof DamagePreviewRejectedError) return response({ error: { code: error.code, message: error.message, reasons: error.reasons, current: error.current } }, 409);
    return response({ error: { code: "DAMAGE_PREVIEW_UNAVAILABLE", message: "Damage Preview recreation is unavailable." } }, 503);
  }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewRecreationRoute(request, (await context.params).id); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewRecreationRoute(request, (await context.params).id); }
