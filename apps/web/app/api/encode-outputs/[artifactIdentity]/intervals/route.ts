import {
  createApplicationOperations, InvalidEncodeOutputArtifactIdentityError,
  InvalidEncodeOutputIntervalInputError, type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function createEncodeOutputIntervalsRoute(
  request: Request, artifactIdentity: string,
  getAccess: () => DataAccess = getDataAccess, mediaProbe?: EncodeOutputMediaProbe,
): Promise<Response> {
  try {
    const parameters = new URL(request.url).searchParams;
    if (request.method !== "GET" || [...parameters.keys()].some((key) => key !== "query") ||
        parameters.getAll("query").length !== 1 || (parameters.get("query")?.length ?? 0) > 16_384) {
      throw new InvalidEncodeOutputIntervalInputError();
    }
    let input: unknown;
    try { input = JSON.parse(parameters.get("query")!); }
    catch { throw new InvalidEncodeOutputIntervalInputError(); }
    return response(await createApplicationOperations(getAccess(), {
      ...(mediaProbe === undefined ? {} : { encodeOutputMediaProbe: mediaProbe }),
    }).inspectEncodeOutputIntervals(artifactIdentity, input));
  } catch (error) {
    if (error instanceof InvalidEncodeOutputIntervalInputError || error instanceof InvalidEncodeOutputArtifactIdentityError) {
      return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: { code: "ENCODE_OUTPUT_NOT_FOUND", message: "Encode Output not found." } }, 404);
    }
    return response({ error: { code: "ENCODE_OUTPUT_INSPECTION_UNAVAILABLE", message: "Encode Output inspection is unavailable." } }, 503);
  }
}

export async function GET(
  request: Request, context: { params: Promise<{ artifactIdentity: string }> },
): Promise<Response> {
  return createEncodeOutputIntervalsRoute(request, (await context.params).artifactIdentity);
}
