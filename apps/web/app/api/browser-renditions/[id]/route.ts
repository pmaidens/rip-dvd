import { createApplicationOperations } from "@rip-dvd/application";
import { browserRenditionConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../lib/data-access";
import { authorizeBrowserRendition, renditionError, renditionResponse, type RenditionAccessConfig } from "../../../../lib/server/browser-rendition-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function createBrowserRenditionInspectionRoute(request: Request, id: string, getAccess: () => DataAccess = getDataAccess, config: RenditionAccessConfig = browserRenditionConfig()) {
  const denied = authorizeBrowserRendition(request, config);
  if (denied) return denied;
  if (request.method !== "GET" || new URL(request.url).search !== "") return renditionResponse({ error: { code: "INVALID_ARGUMENTS" } }, 400);
  try { return renditionResponse(createApplicationOperations(getAccess()).inspectBrowserRendition(id)); }
  catch (error) { return renditionError(error); }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return createBrowserRenditionInspectionRoute(request, (await context.params).id);
}
