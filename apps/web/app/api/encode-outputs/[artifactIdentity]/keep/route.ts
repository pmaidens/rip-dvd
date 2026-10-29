import {
  createApplicationOperations, EncodeOutputKeepRejectedError, InvalidEncodeOutputArtifactIdentityError,
  InvalidEncodeOutputKeepInputError, InvalidMutationKeyError, type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import { MutationKeyConflictError, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";
import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function createEncodeOutputKeepRoute(
  request: Request, artifactIdentity: string, getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin, mediaProbe?: EncodeOutputMediaProbe,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).search !== "") {
    return response({ error: { code: "INVALID_ARGUMENTS", message: "Invalid Keep request." } }, 400);
  }
  try {
    const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
    if (problem !== null) return response({ error: {
      code: problem.status === 415 ? "JSON_CONTENT_TYPE_REQUIRED" : "CROSS_ORIGIN_MUTATION_REJECTED",
      message: problem.status === 415 ? "JSON content type required." : "Cross-origin mutation rejected.",
    } }, problem.status);
    const body: unknown = await request.json().catch(() => null);
    return response(await createApplicationOperations(getAccess(), {
      ...(mediaProbe === undefined ? {} : { encodeOutputMediaProbe: mediaProbe }),
    }).keepFailedEncodeOutput(artifactIdentity, body));
  } catch (error) {
    if (error instanceof InvalidEncodeOutputArtifactIdentityError || error instanceof InvalidEncodeOutputKeepInputError ||
        error instanceof InvalidMutationKeyError) {
      return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    }
    if (error instanceof MutationKeyConflictError) return response({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
    if (error instanceof EncodeOutputKeepRejectedError) {
      return response({ error: { code: error.reasonCode, message: error.message, current: error.current } }, 409);
    }
    if (error instanceof RecordNotFoundError) return response({ error: { code: "ENCODE_OUTPUT_NOT_FOUND", message: "Encode Output not found." } }, 404);
    return response({ error: { code: "ENCODE_OUTPUT_KEEP_UNAVAILABLE", message: "Encode Output Keep is unavailable." } }, 503);
  }
}

export async function POST(request: Request, context: { params: Promise<{ artifactIdentity: string }> }): Promise<Response> {
  return createEncodeOutputKeepRoute(request, (await context.params).artifactIdentity);
}
