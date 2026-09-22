import { createApplicationOperations } from "@rip-dvd/application";
import { MEDIA_ITEM_KINDS, RecordNotFoundError, type DataAccess, type MediaItemId } from "@rip-dvd/data-access";
import { parseCatalogReviewCommand } from "@rip-dvd/application";

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
      [...parameters.keys()].some((key) => key !== "action" && key !== "changes") ||
      id.trim().length === 0 || id.length > 256) {
    return Response.json({ error: "Invalid Media Item preview" }, { status: 400 });
  }
  let changes: Parameters<ReturnType<typeof createApplicationOperations>["previewMediaItemChange"]>[2];
  if (action === "update") {
    const values = parameters.getAll("changes");
    let candidate: unknown;
    try { candidate = JSON.parse(values[0] ?? ""); } catch { candidate = null; }
    const parsed = parseCatalogReviewCommand({ action: "update_media_item", mediaItemId: id,
      changes: candidate }, { mediaItemKinds: MEDIA_ITEM_KINDS });
    if (values.length !== 1 || !parsed.ok || parsed.command.action !== "update_media_item") {
      return Response.json({ error: "Invalid Media Item update preview" }, { status: 400 });
    }
    changes = parsed.command.changes;
  } else if (parameters.has("changes")) {
    return Response.json({ error: "Invalid Media Item preview" }, { status: 400 });
  }
  try {
    const operations = createApplicationOperations(getAccess());
    return Response.json(action === "show"
      ? operations.showMediaItem(id as MediaItemId)
      : operations.previewMediaItemChange(id as MediaItemId, action, changes),
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
