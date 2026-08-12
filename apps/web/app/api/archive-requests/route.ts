import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  type DataAccess,
  type DetectedDiscId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function createArchiveRequestsRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = getTrustedOrigin();
  } catch {
    return response({ error: "Archive Request creation is unavailable" }, 503);
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    const detectedDiscId =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).detectedDiscId === "string"
        ? (body as Record<string, string>).detectedDiscId.trim()
        : "";
    if (detectedDiscId === "") {
      return response({ error: "Invalid Archive Request" }, 400);
    }
    const archiveRequest = getAccess().archiveRequests.create({
      detectedDiscId: detectedDiscId as DetectedDiscId,
    });
    return response(
      {
        archiveRequest: {
          id: archiveRequest.id,
          detectedDiscId: archiveRequest.detectedDiscId,
          status: archiveRequest.status,
          priority: archiveRequest.priority,
          createdAt: archiveRequest.createdAt.toISOString(),
          updatedAt: archiveRequest.updatedAt.toISOString(),
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Detected Disc not found" }, 404);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Archive Request creation is unavailable" }, 503);
  }
}

export function POST(request: Request): Promise<Response> {
  return createArchiveRequestsRoute(request);
}
