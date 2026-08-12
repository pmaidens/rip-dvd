import type {
  DataAccess,
  OriginalDiscArchiveListCursor,
} from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { DASHBOARD_ACTIVITY_HISTORY_LIMIT } from "../../../lib/dashboard-bounds";
import {
  type DashboardCatalogReviewFilters,
  parseDashboardCatalogReviewFilters,
  parseDashboardCatalogReviewCursor,
  readDashboardSnapshot,
} from "../../../lib/dashboard";

export const dynamic = "force-dynamic";

export function createDashboardResponse(
  access: DataAccess,
  catalogReviewCursor?: OriginalDiscArchiveListCursor,
  catalogReviewFilters: DashboardCatalogReviewFilters = {
    view: "needs_review",
  },
): Response {
  return Response.json(
    readDashboardSnapshot(access, {
      activityLimit: DASHBOARD_ACTIVITY_HISTORY_LIMIT,
      catalogReviewCursor,
      catalogReviewView: catalogReviewFilters.view,
      catalogReviewQuery: catalogReviewFilters.query,
      catalogReviewOutcome: catalogReviewFilters.outcome,
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
    const catalogReviewCursor = request
      ? parseDashboardCatalogReviewCursor(request)
      : undefined;
    if (catalogReviewCursor === null) {
      return Response.json(
        { error: "Invalid catalog review cursor" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const catalogReviewFilters = request
      ? parseDashboardCatalogReviewFilters(request)
      : { view: "needs_review" as const };
    if (catalogReviewFilters === null) {
      return Response.json(
        { error: "Invalid catalog review filters" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return createDashboardResponse(
      getAccess(),
      catalogReviewCursor,
      catalogReviewFilters,
    );
  } catch {
    return dashboardUnavailableResponse();
  }
}

export function GET(request: Request): Response {
  return createDashboardRoute(getDataAccess, request);
}
