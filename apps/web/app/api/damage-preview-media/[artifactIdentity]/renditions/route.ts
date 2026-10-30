import { createBrowserRenditionsRoute } from "../../../../../lib/server/browser-rendition-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function createDamagePreviewRenditionsRoute(request: Request, identity: string, options: Parameters<typeof createBrowserRenditionsRoute>[2] = {}) {
  return createBrowserRenditionsRoute(request, identity, { ...options, sourceKind: "damage_preview" });
}
export async function GET(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) {
  return createDamagePreviewRenditionsRoute(request, (await context.params).artifactIdentity);
}
export async function POST(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) {
  return createDamagePreviewRenditionsRoute(request, (await context.params).artifactIdentity);
}
