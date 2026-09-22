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
  recoveryMutationResponse,
  runTrustedMutationRoute,
} from "../../../lib/server/trusted-mutation-route";

export const dynamic = "force-dynamic";

export async function createRearchiveRequestsRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  return runTrustedMutationRoute(
    request,
    {
      getTrustedOrigin,
      method: "POST",
      notFoundError: "Original Disc Archive not found",
      unavailableError: "Re-archive Request creation is unavailable",
    },
    async () => {
      const body = (await request.json().catch(() => null)) as unknown;
      const record =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? body as Record<string, unknown>
          : null;
      try {
        parseMutationKey(record?.mutationKey);
      } catch (error) {
        if (error instanceof InvalidMutationKeyError) {
          return noStoreJsonResponse({ error: "Invalid mutation key" }, 400);
        }
        throw error;
      }
      const sourceArchiveId =
        typeof record?.sourceArchiveId === "string"
          ? record.sourceArchiveId.trim()
          : "";
      if (sourceArchiveId === "") {
        return noStoreJsonResponse({ error: "Invalid Re-archive Request" }, 400);
      }
      return recoveryMutationResponse(
        () => createApplicationOperations(getAccess()).submitRearchiveRequest({
          mutationKey: record?.mutationKey,
          sourceArchiveId,
        }),
        201,
      );
    },
  );
}

export function POST(request: Request): Promise<Response> {
  return createRearchiveRequestsRoute(request);
}
