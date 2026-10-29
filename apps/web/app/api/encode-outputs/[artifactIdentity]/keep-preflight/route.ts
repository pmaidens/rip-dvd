import {
  createApplicationOperations,
  InvalidEncodeOutputArtifactIdentityError,
  InvalidEncodeOutputKeepPreflightInputError,
  type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function createEncodeOutputKeepPreflightRoute(
  request: Request,
  artifactIdentity: string,
  getAccess: () => DataAccess = getDataAccess,
  mediaProbe?: EncodeOutputMediaProbe,
): Promise<Response> {
  try {
    const parameters = new URL(request.url).searchParams;
    if (request.method !== "GET" || [...parameters.keys()].some((key) => key !== "preview-token") ||
        parameters.getAll("preview-token").length > 1) {
      throw new InvalidEncodeOutputKeepPreflightInputError();
    }
    const input = parameters.has("preview-token")
      ? { previewToken: parameters.get("preview-token") }
      : undefined;
    return response(await createApplicationOperations(getAccess(), {
      ...(mediaProbe === undefined ? {} : { encodeOutputMediaProbe: mediaProbe }),
    }).previewEncodeOutputKeep(artifactIdentity, input));
  } catch (error) {
    if (error instanceof InvalidEncodeOutputArtifactIdentityError || error instanceof InvalidEncodeOutputKeepPreflightInputError) {
      return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: { code: "ENCODE_OUTPUT_NOT_FOUND", message: "Encode Output not found." } }, 404);
    }
    return response({ error: { code: "ENCODE_OUTPUT_KEEP_PREFLIGHT_UNAVAILABLE", message: "Encode Output Keep preflight is unavailable." } }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactIdentity: string }> },
): Promise<Response> {
  return createEncodeOutputKeepPreflightRoute(request, (await context.params).artifactIdentity);
}
