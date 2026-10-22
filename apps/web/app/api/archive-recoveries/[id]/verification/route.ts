import { createApplicationOperations, InvalidMutationKeyError } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleDvdDiscVerificationError,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createDvdDiscVerificationInspectionRoute(
  id: string,
  getAccess: () => DataAccess = getDataAccess,
): Response {
  try {
    return response(
      createApplicationOperations(getAccess()).inspectDvdDiscVerification(id),
    );
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Archive Recovery not found" }, 404);
    }
    return response({ error: "DVD disc verification is unavailable" }, 503);
  }
}

export async function createDvdDiscVerificationRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = getTrustedOrigin();
  } catch {
    return response({ error: "DVD disc verification is unavailable" }, 503);
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) return problem;

  try {
    const body = asRecord(await request.json().catch(() => null));
    if (body === null) {
      return response({ error: "Invalid DVD disc verification" }, 400);
    }
    return response(createApplicationOperations(getAccess()).verifyDisc({
      mutationKey: body.mutationKey,
      archiveRecoveryId: id,
      discInspectionId: body.discInspectionId,
      checkpointRevision: body.checkpointRevision,
      checkpointDigest: body.checkpointDigest,
    }), 201);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError || error instanceof RangeError) {
      return response({ error: "Invalid DVD disc verification" }, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: "DVD disc verification target not found" }, 404);
    }
    if (error instanceof MutationKeyConflictError) {
      return response({ error: error.message }, 409);
    }
    if (
      error instanceof StaleDvdDiscVerificationError ||
      error instanceof DomainInvariantError &&
        (error.message === "DISC_INSERTION_CHANGED" ||
          error.message === "DISC_CHECKPOINT_CHANGED")
    ) {
      return response({ error: { code: error.message, message: error.message } }, 409);
    }
    if (error instanceof DomainInvariantError) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "DVD disc verification is unavailable" }, 503);
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDvdDiscVerificationInspectionRoute((await context.params).id);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDvdDiscVerificationRoute(request, (await context.params).id);
}
