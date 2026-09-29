import {
  createApplicationOperations,
  InvalidEncodeOutputArtifactIdentityError,
  type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import {
  RecordNotFoundError,
  type DataAccess,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function createEncodeOutputInspectionRoute(
  request: Request,
  artifactIdentity: string,
  getAccess: () => DataAccess = getDataAccess,
  mediaProbe?: EncodeOutputMediaProbe,
): Promise<Response> {
  if (request.method !== "GET" || new URL(request.url).search !== "") {
    return response({ error: "Invalid Encode Output inspection" }, 400);
  }
  try {
    const result = await createApplicationOperations(getAccess(), {
      ...(mediaProbe === undefined ? {} : { encodeOutputMediaProbe: mediaProbe }),
    }).inspectEncodeOutput(artifactIdentity);
    return response(result);
  } catch (error) {
    if (error instanceof InvalidEncodeOutputArtifactIdentityError) {
      return response({ error: error.message }, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Encode Output not found" }, 404);
    }
    return response({ error: "Encode Output inspection is unavailable" }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactIdentity: string }> },
): Promise<Response> {
  return createEncodeOutputInspectionRoute(
    request,
    (await context.params).artifactIdentity,
  );
}
