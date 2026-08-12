import { loadConfig } from "@rip-dvd/config";
import {
  type ArchiveRequestId,
  type DataAccess,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../lib/data-access";
import {
  noStoreJsonResponse,
  runTrustedMutationRoute,
} from "../../../../lib/server/trusted-mutation-route";

export async function createArchiveRequestCancellationRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  return runTrustedMutationRoute(
    request,
    {
      getTrustedOrigin,
      method: "DELETE",
      notFoundError: "Archive Request not found",
      unavailableError: "Archive Request cancellation is unavailable",
    },
    () => {
      const archiveRequest = getAccess().archiveRequests.cancel(
        id as ArchiveRequestId,
      );
      return noStoreJsonResponse({
        archiveRequest: {
          id: archiveRequest.id,
          status: archiveRequest.status,
        },
      });
    },
  );
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
