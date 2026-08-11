import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { readActionOverview } from "../../../lib/action-overview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function createActionOverviewRoute(
  getAccess: () => DataAccess = getDataAccess,
): Response {
  try {
    return Response.json(readActionOverview(getAccess()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Action overview is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export function GET(): Response {
  return createActionOverviewRoute();
}
