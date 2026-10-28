import {
  createApplicationOperations,
  InvalidMutationKeyError,
  InvalidDvdTitleDamageAcceptanceInputError,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleDvdTitleDamageDecisionError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from
  "../../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  details: Record<string, unknown> = {},
) {
  return response({ error: { code, message, ...details } }, status);
}

export async function createDvdTitleDamageAcceptanceRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = getTrustedOrigin();
  } catch {
    return errorResponse(
      "TITLE_DAMAGE_ACCEPTANCE_UNAVAILABLE",
      "Title Damage Acceptance is unavailable.",
      503,
    );
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem !== null) {
    return problem.status === 415
      ? errorResponse(
          "JSON_CONTENT_TYPE_REQUIRED",
          "JSON content type required.",
          problem.status,
        )
      : errorResponse(
          "CROSS_ORIGIN_MUTATION_REJECTED",
          "Cross-origin mutation rejected.",
          problem.status,
        );
  }
  const body = await request.json().catch(() => null);
  try {
    return response(createApplicationOperations(getAccess())
      .acceptDvdTitleDamage(id as OriginalDiscArchiveId, body));
  } catch (error) {
    if (error instanceof InvalidDvdTitleDamageAcceptanceInputError ||
        error instanceof InvalidMutationKeyError) {
      return errorResponse("INVALID_ARGUMENTS", error.message, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return errorResponse("NOT_FOUND", error.message, 404);
    }
    if (error instanceof MutationKeyConflictError) {
      return errorResponse("MUTATION_KEY_CONFLICT", error.message, 409);
    }
    if (error instanceof StaleDvdTitleDamageDecisionError) {
      return errorResponse(error.code, error.message, 409, {
        current: error.currentIdentities,
      });
    }
    if (error instanceof DomainInvariantError) {
      return errorResponse(
        "TITLE_DAMAGE_ACCEPTANCE_REJECTED",
        error.message,
        409,
      );
    }
    return errorResponse(
      "TITLE_DAMAGE_ACCEPTANCE_UNAVAILABLE",
      "Title Damage Acceptance is unavailable.",
      503,
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return createDvdTitleDamageAcceptanceRoute(
    request,
    (await context.params).id,
  );
}
