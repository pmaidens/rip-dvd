import { createApplicationOperations } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import {
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { getDataAccess } from
  "../../../../../lib/data-access";
import { runTitleDamageAcceptanceWithdrawalRoute } from
  "../title-damage-acceptance-withdrawal-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function createDvdTitleDamageAcceptanceWithdrawalPreviewRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
): Promise<Response> {
  return runTitleDamageAcceptanceWithdrawalRoute(
    request,
    getTrustedOrigin,
    (body) =>
      createApplicationOperations(getAccess())
        .previewDvdTitleDamageAcceptanceWithdrawal(
          id as OriginalDiscArchiveId,
          body,
        ),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return createDvdTitleDamageAcceptanceWithdrawalPreviewRoute(
    request,
    (await context.params).id,
  );
}
