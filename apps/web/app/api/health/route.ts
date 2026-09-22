import { createApplicationOperations } from "@rip-dvd/application";
import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

export function createHealthResponse(access: DataAccess): Response {
  return Response.json(createApplicationOperations(access).health(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export function GET(): Response {
  try {
    return createHealthResponse(getDataAccess());
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
