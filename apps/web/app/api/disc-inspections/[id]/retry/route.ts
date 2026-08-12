import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  type DataAccess,
  type DiscInspectionId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function createDiscInspectionRetryRoute(
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
    return response({ error: "Disc Inspection retry is unavailable" }, 503);
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }
  try {
    const access = getAccess();
    const inspection = access.discInspections.list({
      ids: [id as DiscInspectionId],
    })[0];
    if (inspection === undefined) {
      return response({ error: "Disc Inspection not found" }, 404);
    }
    const retried = access.discInspections.retry(
      inspection.id,
      inspection.mediaGeneration,
    );
    return response({
      inspection: {
        id: retried.id,
        status: retried.status,
        phase: retried.phase,
      },
    });
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Disc Inspection not found" }, 404);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Disc Inspection retry is unavailable" }, 503);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDiscInspectionRetryRoute(request, (await context.params).id);
}
