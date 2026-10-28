import {
  createApplicationOperations,
  InvalidDvdTitleDamageAcceptancePreviewInputError,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  RecordNotFoundError,
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

function errorResponse(code: string, message: string, status: number) {
  return response({ error: { code, message } }, status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function createDvdTitleDamageAcceptancePreviewRoute(
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
      "TITLE_DAMAGE_ACCEPTANCE_PREFLIGHT_UNAVAILABLE",
      "Title Damage Acceptance preflight is unavailable.",
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
  const body = asRecord(await request.json().catch(() => null));
  if (body === null || Object.keys(body).some((key) =>
    key !== "excludedTitleIdentityIds"
  )) {
    return errorResponse(
      "INVALID_ARGUMENTS",
      "Title Damage Acceptance preflight requires a JSON exclusions object.",
      400,
    );
  }
  try {
    return response(createApplicationOperations(getAccess())
      .previewDvdTitleDamageAcceptance(id as OriginalDiscArchiveId, {
        excludedTitleIdentityIds: body.excludedTitleIdentityIds,
      }));
  } catch (error) {
    if (error instanceof InvalidDvdTitleDamageAcceptancePreviewInputError) {
      return errorResponse("INVALID_ARGUMENTS", error.message, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return errorResponse("NOT_FOUND", error.message, 404);
    }
    if (error instanceof DomainInvariantError) {
      return errorResponse(
        "TITLE_DAMAGE_ACCEPTANCE_PREFLIGHT_REJECTED",
        error.message,
        409,
      );
    }
    return errorResponse(
      "TITLE_DAMAGE_ACCEPTANCE_PREFLIGHT_UNAVAILABLE",
      "Title Damage Acceptance preflight is unavailable.",
      503,
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return createDvdTitleDamageAcceptancePreviewRoute(
    request,
    (await context.params).id,
  );
}
