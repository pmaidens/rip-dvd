import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { DASHBOARD_ACTIVITY_HISTORY_LIMIT } from "../../../lib/dashboard-bounds";
import {
  parseDashboardCatalogReviewOffset,
  readDashboardSnapshot,
} from "../../../lib/dashboard";

export const dynamic = "force-dynamic";

export function createDashboardResponse(
  access: DataAccess,
  catalogReviewOffset = 0,
): Response {
  return Response.json(
    readDashboardSnapshot(access, {
      activityLimit: DASHBOARD_ACTIVITY_HISTORY_LIMIT,
      catalogReviewOffset,
    }),
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function dashboardUnavailableResponse(): Response {
  return Response.json(
    { status: "error" },
    {
      headers: { "Cache-Control": "no-store" },
      status: 503,
    },
  );
}

export function createDashboardRoute(
  getAccess: () => DataAccess = getDataAccess,
  request?: Request,
): Response {
  try {
    const catalogReviewOffset = request
      ? parseDashboardCatalogReviewOffset(request)
      : 0;
    if (catalogReviewOffset === null) {
      return Response.json(
        { error: "Invalid catalog review offset" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return createDashboardResponse(getAccess(), catalogReviewOffset);
  } catch {
    return dashboardUnavailableResponse();
  }
}

export function GET(request: Request): Response {
  return createDashboardRoute(getDataAccess, request);
}
