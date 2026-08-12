import { loadConfig } from "@rip-dvd/config";
import {
  type ArchiveRequestId,
  type DataAccess,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import {
  noStoreJsonResponse,
  runTrustedMutationRoute,
} from "../../../../../lib/server/trusted-mutation-route";

export async function createArchiveRequestRetryRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  return runTrustedMutationRoute(
    request,
    {
      getTrustedOrigin,
      method: "POST",
      notFoundError: "Archive Request not found",
      unavailableError: "Archive Request retry is unavailable",
    },
    () => {
      const archiveRequest = getAccess().archiveRequests.retry(
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createArchiveRequestRetryRoute(request, (await context.params).id);
}
