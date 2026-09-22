import { createApplicationOperations, InvalidMutationKeyError, InvalidProfileInputError } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  type DataAccess,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export async function createEncodingProfilesRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  try {
    if (request.method === "GET") {
      const operations = createApplicationOperations(getAccess());
      const url = new URL(request.url);
      const previewId = url.searchParams.get("preview-profile-id");
      if (previewId !== null) {
        const isActive = url.searchParams.get("is-active");
        if (isActive !== "true" && isActive !== "false") {
          return response({ error: "Invalid Encoding Profile state" }, 400);
        }
        return response(operations.previewEncodingProfileState({
          id: previewId, isActive: isActive === "true",
        }));
      }
      return response(operations.listEncodingProfiles());
    }

    if (request.method !== "POST" && request.method !== "PATCH") {
      return response({ error: "Method not allowed" }, 405);
    }
    const problem = trustedMutationRequestProblem(request, getTrustedOrigin());
    if (problem) return problem;
    const body = asRecord(await request.json().catch(() => null));
    if (!body) return response({ error: "Invalid Encoding Profile" }, 400);
    const operations = createApplicationOperations(getAccess());
    if (request.method === "POST") {
      const created = body.sourceProfileId === undefined
        ? operations.createEncodingProfile({
            mutationKey: body.mutationKey,
            key: body.key,
            displayName: body.displayName,
            settings: body.settings,
          })
        : operations.createEncodingProfileVersion({
            mutationKey: body.mutationKey,
            sourceProfileId: body.sourceProfileId,
            settings: body.settings,
          });
      return response(created, 201);
    }
    return response(operations.setEncodingProfileActive({
      mutationKey: body.mutationKey,
      id: body.id,
      isActive: body.isActive,
      expectedRevision: body.expectedRevision,
      acknowledge: body.acknowledge,
    }));
  } catch (error) {
    if (error instanceof InvalidProfileInputError ||
        error instanceof InvalidMutationKeyError ||
        error instanceof MutationKeyConflictError ||
        error instanceof DomainInvariantError) {
      return response({ error: error.message }, error.message.includes("stale") ? 409 : 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Encoding Profile not found" }, 404);
    }
    return response({ error: "Encoding Profiles are unavailable" }, 503);
  }
}

export function GET(request: Request): Promise<Response> {
  return createEncodingProfilesRoute(request);
}
export function POST(request: Request): Promise<Response> {
  return createEncodingProfilesRoute(request);
}
export function PATCH(request: Request): Promise<Response> {
  return createEncodingProfilesRoute(request);
}
