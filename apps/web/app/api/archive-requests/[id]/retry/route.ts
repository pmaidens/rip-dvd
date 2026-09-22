import { createApplicationOperations } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import {
  recoveryMutationResponse,
  requiredMutationKey,
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
    async () => {
      const mutationKey = await requiredMutationKey(request);
      if (mutationKey instanceof Response) return mutationKey;
      return recoveryMutationResponse(() =>
        createApplicationOperations(getAccess()).retryArchiveRequest({ mutationKey, archiveRequestId: id }));
    },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createArchiveRequestRetryRoute(request, (await context.params).id);
}
