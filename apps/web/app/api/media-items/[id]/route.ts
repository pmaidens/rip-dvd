import { createApplicationOperations } from "@rip-dvd/application";
import { RecordNotFoundError, type DataAccess, type MediaItemId } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../../lib/data-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function createMediaItemPreviewRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
): Promise<Response> {
  const parameters = new URL(request.url).searchParams;
  const action = parameters.get("action");
  if (request.method !== "GET" || parameters.getAll("action").length !== 1 ||
      (action !== "show" && action !== "update" && action !== "delete") ||
      id.trim().length === 0 || id.length > 256) {
    return Response.json({ error: "Invalid Media Item preview" }, { status: 400 });
  }
  try {
    const operations = createApplicationOperations(getAccess());
    return Response.json(action === "show"
      ? operations.showMediaItem(id as MediaItemId)
      : operations.previewMediaItemChange(id as MediaItemId, action),
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return error instanceof RecordNotFoundError
      ? Response.json({ error: "Media Item not found" }, { status: 404 })
      : Response.json({ error: "Media Item preview is unavailable" }, { status: 503 });
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createMediaItemPreviewRoute(request, id);
}
