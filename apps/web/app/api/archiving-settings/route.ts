import {
  createApplicationOperations,
  InvalidArchivingSettingsInputError,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import { MutationKeyConflictError, type DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import {
  noStoreJsonResponse,
  runTrustedMutationRoute,
} from "../../../lib/server/trusted-mutation-route";

export const dynamic = "force-dynamic";

const unavailableError = "Archiving settings are unavailable.";

export async function createArchivingSettingsRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method === "GET") {
    try {
      return noStoreJsonResponse(createApplicationOperations(getAccess()).readArchivingSettings());
    } catch {
      return noStoreJsonResponse({ error: unavailableError }, 503);
    }
  }
  return runTrustedMutationRoute(request, {
    method: "POST",
    getTrustedOrigin,
    notFoundError: unavailableError,
    unavailableError,
  }, async () => {
    const body: unknown = await request.json().catch(() => null);
    const input = typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    try {
      return noStoreJsonResponse(createApplicationOperations(getAccess()).setArchivingSettings({
        mutationKey: input.mutationKey,
        automaticallyArchiveInsertedDvds: input.automaticallyArchiveInsertedDvds,
      }));
    } catch (error) {
      if (error instanceof InvalidMutationKeyError) {
        return noStoreJsonResponse({ error: { code: "INVALID_MUTATION_KEY", message: error.message } }, 400);
      }
      if (error instanceof InvalidArchivingSettingsInputError) {
        return noStoreJsonResponse({ error: { code: "INVALID_ARGUMENTS", message: error.message } }, 400);
      }
      if (error instanceof MutationKeyConflictError) {
        return noStoreJsonResponse({ error: { code: "MUTATION_KEY_CONFLICT", message: error.message } }, 409);
      }
      throw error;
    }
  });
}

export function GET(request: Request): Promise<Response> {
  return createArchivingSettingsRoute(request);
}

export function POST(request: Request): Promise<Response> {
  return createArchivingSettingsRoute(request);
}
