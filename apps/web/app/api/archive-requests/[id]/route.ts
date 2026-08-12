import { loadConfig } from "@rip-dvd/config";
import {
  DomainInvariantError,
  InvalidStatusTransitionError,
  RecordNotFoundError,
  type ArchiveRequestId,
  type DataAccess,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../lib/data-access";
import { trustedMutationRequestProblem } from "../../../../lib/server/trusted-mutation-request";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function createArchiveRequestCancellationRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  if (request.method !== "DELETE") {
    return response({ error: "Method not allowed" }, 405);
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = getTrustedOrigin();
  } catch {
    return response({ error: "Archive Request cancellation is unavailable" }, 503);
  }
  const problem = trustedMutationRequestProblem(request, trustedOrigin);
  if (problem) {
    return problem;
  }
  try {
    const archiveRequest = getAccess().archiveRequests.cancel(
      id as ArchiveRequestId,
    );
    return response({
      archiveRequest: {
        id: archiveRequest.id,
        status: archiveRequest.status,
      },
    });
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return response({ error: "Archive Request not found" }, 404);
    }
    if (
      error instanceof DomainInvariantError ||
      error instanceof InvalidStatusTransitionError
    ) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Archive Request cancellation is unavailable" }, 503);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createArchiveRequestCancellationRoute(
    request,
    (await context.params).id,
  );
}
