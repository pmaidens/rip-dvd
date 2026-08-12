import { loadConfig } from "@rip-dvd/config";
import {
  type DataAccess,
  type DetectedDiscId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import {
  noStoreJsonResponse,
  runTrustedMutationRoute,
} from "../../../lib/server/trusted-mutation-route";

export const dynamic = "force-dynamic";

export async function createArchiveRequestsRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  return runTrustedMutationRoute(
    request,
    {
      getTrustedOrigin,
      method: "POST",
      notFoundError: "Detected Disc not found",
      unavailableError: "Archive Request creation is unavailable",
    },
    async () => {
      const body = (await request.json().catch(() => null)) as unknown;
      const detectedDiscId =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        typeof (body as Record<string, unknown>).detectedDiscId === "string"
          ? (body as Record<string, string>).detectedDiscId.trim()
          : "";
      if (detectedDiscId === "") {
        return noStoreJsonResponse({ error: "Invalid Archive Request" }, 400);
      }
      const archiveRequest = getAccess().archiveRequests.create({
        detectedDiscId: detectedDiscId as DetectedDiscId,
      });
      return noStoreJsonResponse(
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
    },
  );
}

export function POST(request: Request): Promise<Response> {
  return createArchiveRequestsRoute(request);
}
