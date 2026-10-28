import { loadConfig } from "@rip-dvd/config";
import { createApplicationOperations, DamagePreviewRejectedError, InvalidDamagePreviewInputError, InvalidMutationKeyError } from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function createDamagePreviewRoute(request: Request, id: string, getAccess: () => DataAccess = getDataAccess, getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin) {
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const operations = createApplicationOperations(getAccess());
    const query = new URL(request.url).searchParams;
    if (request.method === "GET") {
      if (query.size === 0) return response(await operations.inspectDamagePreview(id));
      if ([...query.keys()].some((key) => !["timeoutMs", "pollMs"].includes(key)) || query.getAll("timeoutMs").length !== 1 || query.getAll("pollMs").length > 1) throw new InvalidDamagePreviewInputError("Invalid preview wait options.");
      return response(await operations.waitDamagePreview(id, { timeoutMs: Number(query.get("timeoutMs")), ...(query.has("pollMs") ? { pollMs: Number(query.get("pollMs")) } : {}) }));
    }
    if (request.method !== "POST" && request.method !== "DELETE") return response({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
    if (query.size > 0) throw new InvalidDamagePreviewInputError("Unexpected preview query.");
    const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
    if (problem) return problem;
    let input: unknown;
    try { input = await request.json(); } catch { throw new InvalidDamagePreviewInputError("Invalid JSON input."); }
    if (request.method === "POST") return response(await operations.requestDamagePreview(id, input));
    if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some((key) => key !== "mutationKey")) throw new InvalidDamagePreviewInputError("Invalid cancellation input.");
    return response(operations.cancelDamagePreview(id, (input as Record<string, unknown>).mutationKey));
  } catch (error) {
    if (error instanceof InvalidDamagePreviewInputError || error instanceof InvalidMutationKeyError) return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    if (error instanceof RecordNotFoundError) return response({ error: { code: "NOT_FOUND", message: error.message } }, 404);
    if (error instanceof MutationKeyConflictError) return response({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
    if (error instanceof DamagePreviewRejectedError) return response({ error: { code: error.code, message: error.message, reasons: error.reasons, current: error.current } }, 409);
    return response({ error: { code: "DAMAGE_PREVIEW_UNAVAILABLE", message: "Damage Preview operation is unavailable." } }, 503);
  }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewRoute(request, (await context.params).id); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewRoute(request, (await context.params).id); }
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewRoute(request, (await context.params).id); }
