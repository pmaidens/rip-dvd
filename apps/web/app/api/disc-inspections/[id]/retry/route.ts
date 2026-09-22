import { createApplicationOperations } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import {
  recoveryMutationResponse,
  requiredMutationKey,
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
    async () => {
      const mutationKey = await requiredMutationKey(request);
      if (mutationKey instanceof Response) return mutationKey;
      return recoveryMutationResponse(() =>
        createApplicationOperations(getAccess()).retryDiscInspection({ mutationKey, discInspectionId: id }));
    },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createDiscInspectionRetryRoute(request, (await context.params).id);
}
