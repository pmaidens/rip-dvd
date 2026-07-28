import type { DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../../lib/data-access";
import { readDashboardDetectedDiscDetails } from "../../../../../lib/dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function createDashboardDiscDetailResponse(
  access: DataAccess,
  id: string,
  detectedAt: string | null,
): Response {
  if (
    id.length === 0 ||
    id.length > 256 ||
    detectedAt === null ||
    detectedAt.length === 0 ||
    detectedAt.length > 64 ||
    !Number.isFinite(Date.parse(detectedAt))
  ) {
    return Response.json(
      { status: "error" },
      { headers: { "Cache-Control": "no-store" }, status: 400 },
    );
  }
  const details = readDashboardDetectedDiscDetails(access, id, detectedAt);
  if (details === null) {
    return Response.json(
      { status: "stale" },
      { headers: { "Cache-Control": "no-store" }, status: 409 },
    );
  }
  return Response.json(details, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    return createDashboardDiscDetailResponse(
      getDataAccess(),
      id,
      new URL(request.url).searchParams.get("detectedAt"),
    );
  } catch {
    return Response.json(
      { status: "error" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
