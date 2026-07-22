import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json(getDataAccess().checkHealth(), {
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
