import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";
import { readDashboardSnapshot } from "../../../lib/dashboard";

export const dynamic = "force-dynamic";

export function createDashboardResponse(access: DataAccess): Response {
  try {
    return Response.json(readDashboardSnapshot(access), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { status: "error" },
      {
        headers: { "Cache-Control": "no-store" },
        status: 503,
      },
    );
  }
}

export function GET(): Response {
  try {
    return createDashboardResponse(getDataAccess());
  } catch {
    return Response.json(
      { status: "error" },
      {
        headers: { "Cache-Control": "no-store" },
        status: 503,
      },
    );
  }
}
