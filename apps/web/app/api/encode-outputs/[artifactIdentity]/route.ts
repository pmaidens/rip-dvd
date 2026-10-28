import {
  createApplicationOperations,
  InvalidEncodeOutputArtifactIdentityError,
  InvalidEncodeOutputAcknowledgementError,
  InvalidEncodeOutputInspectionInputError,
  InvalidMutationKeyError,
  EncodeOutputAcknowledgementRejectedError,
  type EncodeOutputMediaProbe,
} from "@rip-dvd/application";
import {
  RecordNotFoundError,
  MutationKeyConflictError,
  type DataAccess,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../lib/data-access";
import { loadConfig } from "@rip-dvd/config";
import { trustedMutationRequestProblem } from "../../../../lib/server/trusted-mutation-request";

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
  const parameters = new URL(request.url).searchParams;
  if (request.method !== "GET" || [...parameters.keys()].some((key) =>
    !["receipt-limit", "receipt-offset"].includes(key) || parameters.getAll(key).length !== 1 ||
    !/^\d+$/.test(parameters.get(key) ?? ""))) {
    return response({ error: "Invalid Encode Output inspection" }, 400);
  }
  try {
    const result = await createApplicationOperations(getAccess(), {
      ...(mediaProbe === undefined ? {} : { encodeOutputMediaProbe: mediaProbe }),
    }).inspectEncodeOutput(artifactIdentity, {
      ...(parameters.has("receipt-limit") ? { receiptLimit: Number(parameters.get("receipt-limit")) } : {}),
      ...(parameters.has("receipt-offset") ? { receiptOffset: Number(parameters.get("receipt-offset")) } : {}),
    });
    return response(result);
  } catch (error) {
    if (error instanceof InvalidEncodeOutputArtifactIdentityError || error instanceof InvalidEncodeOutputInspectionInputError) {
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

export async function createEncodeOutputAcknowledgementRoute(
  request: Request,
  artifactIdentity: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
  mediaProbe?: EncodeOutputMediaProbe,
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).search !== "") {
    return response({ error: { code: "INVALID_ARGUMENTS", message: "Invalid acknowledgement request." } }, 400);
  }
  try {
    const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
    if (problem !== null) return response({ error: {
      code: problem.status === 415 ? "JSON_CONTENT_TYPE_REQUIRED" : "CROSS_ORIGIN_MUTATION_REJECTED",
      message: problem.status === 415 ? "JSON content type required." : "Cross-origin mutation rejected.",
    } }, problem.status);
    const body: unknown = await request.json().catch(() => null);
    const result = await createApplicationOperations(getAccess(), {
      ...(mediaProbe === undefined ? {} : { encodeOutputMediaProbe: mediaProbe }),
    }).acknowledgeEncodeOutputInspection(artifactIdentity, body);
    return response(result);
  } catch (error) {
    if (error instanceof InvalidEncodeOutputArtifactIdentityError ||
        error instanceof InvalidEncodeOutputAcknowledgementError ||
        error instanceof InvalidMutationKeyError) {
      return response({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
    }
    if (error instanceof MutationKeyConflictError) {
      return response({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
    }
    if (error instanceof EncodeOutputAcknowledgementRejectedError) {
      return response({ error: { code: error.reasonCode, message: error.message, current: error.current, currentIdentity: error.currentIdentity } }, 409);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: { code: "ENCODE_OUTPUT_NOT_FOUND", message: "Encode Output not found." } }, 404);
    }
    return response({ error: { code: "ENCODE_OUTPUT_INSPECTION_UNAVAILABLE", message: "Encode Output inspection is unavailable." } }, 503);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ artifactIdentity: string }> },
): Promise<Response> {
  return createEncodeOutputAcknowledgementRoute(request, (await context.params).artifactIdentity);
}
