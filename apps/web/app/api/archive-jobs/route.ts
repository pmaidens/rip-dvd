import type { DataAccess, DetectedDiscId } from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import {
  trustedMutationRequestProblem,
} from "../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";

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

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export async function createArchiveJobsRoute(
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
    return response({ error: "Archive Job approval is unavailable" }, 503);
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }

  try {
    const body = asRecord(await request.json().catch(() => null));
    const detectedDiscId = requiredString(body?.detectedDiscId);
    if (!body || !detectedDiscId) {
      return response({ error: "Invalid Detected Disc approval" }, 400);
    }
    const job = getAccess().archiveJobs.approve({
      detectedDiscId: detectedDiscId as DetectedDiscId,
    });
    return response(
      {
        job: {
          id: job.id,
          detectedDiscId: job.detectedDiscId,
          status: job.status,
          priority: job.priority,
          progressPercent: job.progressPercent,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Detected Disc not found" }, 404);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Archive Job approval is unavailable" }, 503);
  }
}

export function POST(request: Request): Promise<Response> {
  return createArchiveJobsRoute(request);
}
