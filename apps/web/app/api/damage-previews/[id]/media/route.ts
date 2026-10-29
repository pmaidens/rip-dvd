import { loadConfig } from "@rip-dvd/config";
import { createApplicationOperations, DamagePreviewRejectedError, InvalidDamagePreviewInputError, InvalidMutationKeyError } from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function createDamagePreviewMediaRemovalRoute(request: Request, id: string, getAccess: () => DataAccess = getDataAccess, getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin) {
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "DELETE" && request.method !== "POST") return response({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
  if (problem) return problem;
  try {
    if (new URL(request.url).search !== "") throw new InvalidDamagePreviewInputError("Unexpected media removal query.");
    let input: unknown;
    try { input = await request.json(); } catch { throw new InvalidDamagePreviewInputError("Invalid JSON input."); }
    const operations = createApplicationOperations(getAccess());
    const accepted = request.method === "DELETE" ? operations.deleteDamagePreviewMedia(id, input) : operations.cleanupDamagePreviewMedia(id, input);
    return response(accepted, accepted.media.removal?.state === "pending" ? 202 : 200);
  } catch (error) {
    if (error instanceof InvalidDamagePreviewInputError || error instanceof InvalidMutationKeyError) return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    if (error instanceof RecordNotFoundError) return response({ error: { code: "NOT_FOUND", message: error.message } }, 404);
    if (error instanceof MutationKeyConflictError) return response({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
    if (error instanceof DamagePreviewRejectedError) return response({ error: { code: error.code, message: error.message, reasons: error.reasons, current: error.current } }, 409);
    return response({ error: { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", message: "Preview media removal is unavailable." } }, 503);
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewMediaRemovalRoute(request, (await context.params).id); }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return createDamagePreviewMediaRemovalRoute(request, (await context.params).id); }
