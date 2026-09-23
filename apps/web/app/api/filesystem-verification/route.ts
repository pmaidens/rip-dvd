import { loadConfig } from "@rip-dvd/config";
import { createApplicationOperations, InvalidMutationKeyError } from "@rip-dvd/application";
import {
  DomainInvariantError,
  MutationKeyConflictError,
  RecordNotFoundError,
  type DataAccess,
  type FilesystemVerificationTarget,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import {
  trustedMutationRequestProblem,
} from "../../../lib/server/trusted-mutation-request";

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
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null;
}

function verificationTarget(
  value: unknown,
): FilesystemVerificationTarget | null {
  return value === "original_disc_archive" || value === "encode_job_output"
    ? value
    : null;
}

function inventoryOffset(request: Request): number | null {
  const value = new URL(request.url).searchParams.get("offset");
  if (value === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

export function createFilesystemVerificationInventoryRoute(
  request: Request,
  getAccess: () => DataAccess = getDataAccess,
): Response {
  const target = verificationTarget(
    new URL(request.url).searchParams.get("target"),
  );
  const offset = inventoryOffset(request);
  if (target === null || offset === null) {
    return response({ error: "Invalid filesystem verification inventory" }, 400);
  }
  try {
    return response(
      createApplicationOperations(getAccess())
        .filesystemVerificationInventory({ target, offset }),
    );
  } catch {
    return response({ error: "Filesystem verification is unavailable" }, 503);
  }
}

export async function createFilesystemVerificationRoute(
  request: Request,
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
    return response({ error: "Filesystem verification is unavailable" }, 503);
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }

  try {
    const body = asRecord(await request.json().catch(() => null));
    const target = verificationTarget(body?.target);
    const id = boundedString(body?.id);
    if (!body || !target || !id) {
      return response({ error: "Invalid filesystem verification" }, 400);
    }
    return response(createApplicationOperations(getAccess()).submitFilesystemVerification({
      mutationKey: body.mutationKey,
      target,
      targetId: id,
    }), 201);
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      return response({ error: "Invalid mutation key" }, 400);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Verification target not found" }, 404);
    }
    if (error instanceof DomainInvariantError || error instanceof MutationKeyConflictError) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Filesystem verification is unavailable" }, 503);
  }
}

export function POST(request: Request): Promise<Response> {
  return createFilesystemVerificationRoute(request);
}

export function GET(request: Request): Response {
  return createFilesystemVerificationInventoryRoute(request);
}
