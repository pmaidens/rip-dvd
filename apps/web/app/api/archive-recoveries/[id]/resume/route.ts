import {
  createApplicationOperations,
  DvdRecoveryResumeUnavailableError,
  InvalidMutationKeyError,
  InvalidProfileInputError,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  DvdRecoveryStorageUnavailableError,
  EncodeWorkConflictError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleArchiveRecoveryAttemptError,
  StaleArchiveRecoveryCheckpointError,
  type DataAccess,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

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

export async function createDvdRecoveryResumeRoute(
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
      "RECOVERY_RESUME_UNAVAILABLE",
      "Archive Recovery Resume is unavailable.",
      503,
    );
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
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

  try {
    const body = asRecord(await request.json().catch(() => null));
    if (body === null) {
      return errorResponse(
        "INVALID_ARGUMENTS",
        "Archive Recovery Resume requires current attempt and checkpoint identities plus a speed mode.",
        400,
      );
    }
    return response(await createApplicationOperations(getAccess())
      .resumeDvdRecovery({
        mutationKey: body.mutationKey,
        archiveRecoveryId: id,
        attemptId: body.attemptId,
        checkpointRevision: body.checkpointRevision,
        checkpointDigest: body.checkpointDigest,
        speedMode: body.speedMode,
      }), 202);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      return errorResponse("INVALID_MUTATION_KEY", error.message, 400);
    }
    if (
      error instanceof InvalidProfileInputError || error instanceof RangeError
    ) {
      return errorResponse(
        "INVALID_ARGUMENTS",
        "Archive Recovery Resume requires current attempt and checkpoint identities plus a speed mode.",
        400,
      );
    }
    if (error instanceof RecordNotFoundError) {
      return errorResponse(
        "NOT_FOUND",
        "Archive Recovery Resume target was not found.",
        404,
      );
    }
    if (error instanceof MutationKeyConflictError) {
      return errorResponse("MUTATION_KEY_CONFLICT", error.message, 409);
    }
    if (
      error instanceof StaleArchiveRecoveryAttemptError ||
      error instanceof StaleArchiveRecoveryCheckpointError
    ) {
      return response({
        error: {
          code: error.code,
          message: error.message,
          currentIdentities: error.currentIdentities,
        },
      }, 409);
    }
    if (error instanceof EncodeWorkConflictError) {
      return response({
        error: {
          code: error.code,
          message: error.message,
          blockingReasons: error.blockingReasons,
          current: error.current,
        },
      }, 409);
    }
    if (
      error instanceof DvdRecoveryStorageUnavailableError ||
      error instanceof DvdRecoveryResumeUnavailableError
    ) {
      return response({
        error: {
          code: error.code,
          message: error.message,
          blockingReasons: error.blockingReasons,
        },
      }, 409);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return errorResponse("RECOVERY_RESUME_REJECTED", error.message, 409);
    }
    return errorResponse(
      "RECOVERY_RESUME_UNAVAILABLE",
      "Archive Recovery Resume is unavailable.",
      503,
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return createDvdRecoveryResumeRoute(request, (await context.params).id);
}
