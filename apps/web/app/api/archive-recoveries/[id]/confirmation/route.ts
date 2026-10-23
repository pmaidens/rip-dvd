import {
  createApplicationOperations,
  DvdDiscVerificationUnavailableError,
  InvalidMutationKeyError,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  DvdRecoveryStorageUnavailableError,
  EncodeWorkConflictError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleDvdDiscConfirmationError,
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

function errorResponse(code: string, message: string, status: number): Response {
  return response({ error: { code, message } }, status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function createDvdDiscConfirmationPreviewRoute(
  id: string,
  getAccess: () => DataAccess = getDataAccess,
): Promise<Response> {
  try {
    return response(
      await createApplicationOperations(getAccess()).previewDvdDiscConfirmation(
        id,
      ),
    );
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return errorResponse(
        "NOT_FOUND",
        "DVD Disc Confirmation target was not found.",
        404,
      );
    }
    return errorResponse(
      "DISC_CONFIRMATION_UNAVAILABLE",
      "DVD Disc Confirmation is unavailable.",
      503,
    );
  }
}

export async function createDvdDiscConfirmationRoute(
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
      "DISC_CONFIRMATION_UNAVAILABLE",
      "DVD Disc Confirmation is unavailable.",
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
        "DVD Disc Confirmation requires the exact preview inputs.",
        400,
      );
    }
    return response(await createApplicationOperations(getAccess()).confirmDisc({
      mutationKey: body.mutationKey,
      archiveRecoveryId: id,
      originalDiscArchiveId: body.originalDiscArchiveId,
      archiveRecoveryAttemptId: body.archiveRecoveryAttemptId,
      discInspectionId: body.discInspectionId,
      detectedDiscId: body.detectedDiscId,
      mediaGeneration: body.mediaGeneration,
      verificationId: body.verificationId,
      verificationWorkerExecutionId: body.verificationWorkerExecutionId,
      verificationOutcome: body.verificationOutcome,
      verificationResultDigest: body.verificationResultDigest,
      checkpointRevision: body.checkpointRevision,
      checkpointDigest: body.checkpointDigest,
      acknowledgeMixedSource: body.acknowledgeMixedSource,
    }), 201);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      return errorResponse("INVALID_MUTATION_KEY", error.message, 400);
    }
    if (error instanceof RangeError) {
      return errorResponse(
        "INVALID_ARGUMENTS",
        "DVD Disc Confirmation requires the exact preview inputs.",
        400,
      );
    }
    if (error instanceof RecordNotFoundError) {
      return errorResponse(
        "NOT_FOUND",
        "DVD Disc Confirmation target was not found.",
        404,
      );
    }
    if (error instanceof MutationKeyConflictError) {
      return errorResponse("MUTATION_KEY_CONFLICT", error.message, 409);
    }
    if (error instanceof StaleDvdDiscConfirmationError) {
      return response({
        error: {
          code: error.code,
          message: error.message,
          reasons: error.reasons,
          currentIdentities: error.currentIdentities,
        },
      }, 409);
    }
    if (error instanceof DvdDiscVerificationUnavailableError) {
      return response({
        error: {
          code: error.code,
          message: error.message,
          blockingReasons: [{ code: error.code, message: error.message }],
        },
      }, 409);
    }
    if (error instanceof DvdRecoveryStorageUnavailableError) {
      return response({
        error: {
          code: error.code,
          message: error.message,
          blockingReasons: error.blockingReasons,
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
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return errorResponse("DISC_CONFIRMATION_REJECTED", error.message, 409);
    }
    return errorResponse(
      "DISC_CONFIRMATION_UNAVAILABLE",
      "DVD Disc Confirmation is unavailable.",
      503,
    );
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDvdDiscConfirmationPreviewRoute((await context.params).id);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDvdDiscConfirmationRoute(request, (await context.params).id);
}
