import { createBrowserRenditionsRoute } from "../../../../../lib/server/browser-rendition-route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function createEncodeOutputRenditionsRoute(request: Request, identity: string, options: Omit<NonNullable<Parameters<typeof createBrowserRenditionsRoute>[2]>, "sourceKind"> = {}) {
  return createBrowserRenditionsRoute(request, identity, options);
}
export async function GET(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) {
  return createEncodeOutputRenditionsRoute(request, (await context.params).artifactIdentity);
}
export async function POST(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) {
  return createEncodeOutputRenditionsRoute(request, (await context.params).artifactIdentity);
}
