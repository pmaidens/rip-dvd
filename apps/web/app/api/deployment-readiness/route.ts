import { createApplicationOperations } from "@rip-dvd/application";
import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

export function createDeploymentReadinessResponse(
  access: DataAccess,
): Response {
  return Response.json(createApplicationOperations(access).readiness(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export function GET(): Response {
  try {
    return createDeploymentReadinessResponse(getDataAccess());
  } catch {
    return Response.json(
      { status: "error" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
