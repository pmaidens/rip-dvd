import { loadConfig } from "@rip-dvd/config";
import {
  type DataAccess,
  type DiscInspectionId,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import {
  noStoreJsonResponse,
  runTrustedMutationRoute,
} from "../../../../../lib/server/trusted-mutation-route";

export async function createDiscInspectionRetryRoute(
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
      notFoundError: "Disc Inspection not found",
      unavailableError: "Disc Inspection retry is unavailable",
    },
    () => {
      const retried = getAccess().discInspections.requestRetry(
        id as DiscInspectionId,
      );
      return noStoreJsonResponse({
        inspection: {
          id: retried.id,
          status: retried.status,
          phase: retried.phase,
        },
      });
    },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDiscInspectionRetryRoute(request, (await context.params).id);
}
