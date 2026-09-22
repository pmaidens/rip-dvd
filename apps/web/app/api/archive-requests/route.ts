import {
  createApplicationOperations,
  InvalidMutationKeyError,
  parseMutationKey,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";

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
      const mutationKey =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).mutationKey
          : undefined;
      try {
        parseMutationKey(mutationKey);
      } catch (error) {
        if (error instanceof InvalidMutationKeyError) {
          return noStoreJsonResponse({ error: "Invalid mutation key" }, 400);
        }
        throw error;
      }
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
      return noStoreJsonResponse(
        createApplicationOperations(getAccess()).submitArchiveRequest({
          mutationKey,
          detectedDiscId,
        }),
        201,
      );
    },
  );
}

export function POST(request: Request): Promise<Response> {
  return createArchiveRequestsRoute(request);
}
