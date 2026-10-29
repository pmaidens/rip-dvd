import { createApplicationOperations, type EncodeOutputMediaProbe } from "@rip-dvd/application";
import { browserRenditionConfig, loadConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";
import { authorizeBrowserRendition, renditionError, renditionResponse, type RenditionAccessConfig } from "../../../../../lib/server/browser-rendition-access";
import { trustedMutationRequestProblem } from "../../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function createEncodeOutputRenditionsRoute(request: Request, identity: string, options: {
  getAccess?: () => DataAccess; accessConfig?: RenditionAccessConfig; trustedOrigin?: string; probe?: EncodeOutputMediaProbe;
} = {}) {
  const config = options.accessConfig ?? browserRenditionConfig();
  const denied = authorizeBrowserRendition(request, config);
  if (denied) return denied;
  if (!["GET", "POST"].includes(request.method) || new URL(request.url).search !== "") return renditionResponse({ error: { code: "INVALID_ARGUMENTS" } }, 400);
  try {
    if (request.method === "POST") {
      const problem = trustedMutationRequestProblem(request, options.trustedOrigin ?? loadConfig().webTrustedOrigin);
      if (problem) return problem;
    }
    const operations = createApplicationOperations((options.getAccess ?? getDataAccess)(), { encodeOutputMediaProbe: options.probe, browserRenditionsEnabled: config.enabled });
    return renditionResponse(request.method === "GET" ? await operations.inspectEncodeOutputRenditionAvailability(identity)
      : await operations.requestEncodeOutputRendition(identity, await request.json().catch(() => null)));
  } catch (error) { return renditionError(error); }
}
export async function GET(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) {
  return createEncodeOutputRenditionsRoute(request, (await context.params).artifactIdentity);
}
export async function POST(request: Request, context: { params: Promise<{ artifactIdentity: string }> }) {
  return createEncodeOutputRenditionsRoute(request, (await context.params).artifactIdentity);
}
