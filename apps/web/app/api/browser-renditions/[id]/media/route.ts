import { Readable } from "node:stream";
import { openBrowserRendition } from "@rip-dvd/application";
import { browserRenditionConfig } from "@rip-dvd/config";
import type { DataAccess } from "@rip-dvd/data-access";
import { getDataAccess } from "../../../../../lib/data-access";
import { authorizeBrowserRendition, renditionError, renditionResponse, type RenditionAccessConfig } from "../../../../../lib/server/browser-rendition-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function byteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const first = Number(suffix ? match[2] : match[1]);
  const last = match[2] && !suffix ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < 0 || (suffix && first === 0)) return null;
  const start = suffix ? Math.max(0, size - first) : first;
  const end = suffix ? size - 1 : Math.min(size - 1, last);
  return start >= size || end < start ? null : { start, end };
}
export async function createBrowserRenditionMediaRoute(request: Request, id: string, getAccess: () => DataAccess = getDataAccess, config: RenditionAccessConfig = browserRenditionConfig()) {
  const denied = authorizeBrowserRendition(request, config);
  if (denied) return denied;
  if (!["GET", "HEAD"].includes(request.method) || new URL(request.url).search !== "") return renditionResponse({ error: { code: "INVALID_ARGUMENTS" } }, 400);
  try {
    const { file, rendition, sizeBytes } = await openBrowserRendition(getAccess(), id, config.enabled);
    try {
      const headers = new Headers({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "ETag": `"${rendition.media!.identity}"` });
      if (rendition.previewCondition) {
        headers.set("X-Damage-Preview-State", rendition.previewCondition.status);
        headers.set("X-Damage-Preview-Generation", rendition.previewCondition.generationStatus);
        headers.set("X-Damage-Preview-Outdated", String(rendition.previewCondition.outdated));
      } else if ("validation" in rendition.source) {
        headers.set("X-Encode-Output-State", rendition.source.state);
        headers.set("X-Encode-Output-Validation", rendition.source.validation.result);
      }
      const rangeValue = request.headers.get("Range");
      const ifRange = request.headers.get("If-Range");
      const useRange = request.method === "GET" && rangeValue !== null && (ifRange === null || ifRange === headers.get("ETag"));
      const range = useRange ? byteRange(rangeValue, sizeBytes) : { start: 0, end: sizeBytes - 1 };
      if (range === null) {
        await file.close(); headers.set("Content-Range", `bytes */${sizeBytes}`); headers.set("Content-Length", "0");
        return new Response(null, { status: 416, headers });
      }
      headers.set("Content-Length", String(range.end - range.start + 1));
      if (useRange) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${sizeBytes}`);
      if (request.method === "HEAD") { await file.close(); return new Response(null, { headers }); }
      const stream = file.createReadStream({ ...range, autoClose: true });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: useRange ? 206 : 200, headers });
    } catch (error) { await file.close().catch(() => {}); throw error; }
  } catch (error) { return renditionError(error); }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return createBrowserRenditionMediaRoute(request, (await context.params).id); }
export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) { return createBrowserRenditionMediaRoute(request, (await context.params).id); }
