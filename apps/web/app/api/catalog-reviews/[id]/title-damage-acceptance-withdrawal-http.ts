import {
  InvalidDvdTitleDamageAcceptanceWithdrawalInputError,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleDvdTitleDamageAcceptanceWithdrawalError,
} from "@rip-dvd/data-access";

import { trustedMutationRequestProblem } from
  "../../../../lib/server/trusted-mutation-request";

export function titleDamageAcceptanceWithdrawalResponse(
  body: unknown,
  status = 200,
): Response {
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
): Response {
  return titleDamageAcceptanceWithdrawalResponse(
    { error: { code, message, ...details } },
    status,
  );
}

export async function prepareTitleDamageAcceptanceWithdrawalRequest(
  request: Request,
  getTrustedOrigin: () => string,
): Promise<
  | { body: unknown; response: null }
  | { body: null; response: Response }
> {
  if (request.method !== "POST") {
    return {
      body: null,
      response: errorResponse("METHOD_NOT_ALLOWED", "Method not allowed.", 405),
    };
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = getTrustedOrigin();
  } catch {
    return {
      body: null,
      response: errorResponse(
        "TITLE_DAMAGE_ACCEPTANCE_WITHDRAWAL_UNAVAILABLE",
        "Title Damage Acceptance withdrawal is unavailable.",
        503,
      ),
    };
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem !== null) {
    return {
      body: null,
      response: problem.status === 415
        ? errorResponse(
          "JSON_CONTENT_TYPE_REQUIRED",
          "JSON content type required.",
          problem.status,
        )
        : errorResponse(
          "CROSS_ORIGIN_MUTATION_REJECTED",
          "Cross-origin mutation rejected.",
          problem.status,
        ),
    };
  }
  return {
    body: await request.json().catch(() => null),
    response: null,
  };
}

export function titleDamageAcceptanceWithdrawalErrorResponse(
  error: unknown,
): Response {
  if (
    error instanceof InvalidDvdTitleDamageAcceptanceWithdrawalInputError ||
    error instanceof InvalidMutationKeyError
  ) {
    return errorResponse("INVALID_ARGUMENTS", error.message, 400);
  }
  if (error instanceof RecordNotFoundError) {
    return errorResponse("NOT_FOUND", error.message, 404);
  }
  if (error instanceof MutationKeyConflictError) {
    return errorResponse("MUTATION_KEY_CONFLICT", error.message, 409);
  }
  if (error instanceof StaleDvdTitleDamageAcceptanceWithdrawalError) {
    return errorResponse(error.code, error.message, 409, {
      current: error.current,
    });
  }
  if (error instanceof DomainInvariantError) {
    return errorResponse(
      "TITLE_DAMAGE_ACCEPTANCE_WITHDRAWAL_REJECTED",
      error.message,
      409,
    );
  }
  return errorResponse(
    "TITLE_DAMAGE_ACCEPTANCE_WITHDRAWAL_UNAVAILABLE",
    "Title Damage Acceptance withdrawal is unavailable.",
    503,
  );
}
