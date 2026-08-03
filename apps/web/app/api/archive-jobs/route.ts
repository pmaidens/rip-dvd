import type { DataAccess, DetectedDiscId } from "@rip-dvd/data-access";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function mutationRequestProblem(request: Request): Response | null {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return response({ error: "JSON content type required" }, 415);
  }

  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (
    (origin !== null && origin !== requestOrigin) ||
    (fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    return response({ error: "Cross-origin mutation rejected" }, 403);
  }
  return null;
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
): Promise<Response> {
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  const problem = mutationRequestProblem(request);
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
