import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { readDashboardSnapshot } from "../../../lib/dashboard";

export const dynamic = "force-dynamic";
const DASHBOARD_HISTORY_LIMIT = 20;

export function createDashboardResponse(access: DataAccess): Response {
  return Response.json(
    readDashboardSnapshot(access, { activityLimit: DASHBOARD_HISTORY_LIMIT }),
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
): Response {
  try {
    return createDashboardResponse(getAccess());
  } catch {
    return dashboardUnavailableResponse();
  }
}

export function GET(): Response {
  return createDashboardRoute();
}
