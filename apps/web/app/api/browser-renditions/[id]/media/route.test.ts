import { afterEach, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { compatibleOutputProbe, requestSyntheticRendition } from "../../../../../../operator-cli/src/encode-output-rendition.test-support.js";
import { pollBrowserRenditions } from "../../../../../../encode-worker/src/browser-rendition-worker.js";
import { createBrowserRenditionMediaRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const config = { enabled: true, password: "synthetic-range-password" };
const Authorization = `Basic ${Buffer.from(`operator:${config.password}`).toString("base64")}`;
const bytes = "0123456789synthetic-mp4";
it("authenticates each full, HEAD and range access before any media lookup", async () => {
  for (const method of ["GET", "HEAD"]) for (const Range of ["bytes=0-1", "bytes=999999-"]) {
    const response = await createBrowserRenditionMediaRoute(new Request("http://localhost/api/browser-renditions/synthetic/media", { method, headers: { Range } }), "synthetic", () => { throw new Error("Must not access persistence"); }, config);
    expect(response.status).toBe(401); expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const disabled = await createBrowserRenditionMediaRoute(new Request("http://localhost/api/browser-renditions/synthetic/media", { headers: { Authorization } }), "synthetic", () => { throw new Error("Must not access persistence"); }, { enabled: false, password: config.password });
  expect(disabled.status).toBe(503);
});
it("serves exact authenticated ranges, suffixes, HEAD, If-Range and 416 failures with failed-source labels", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticRendition(fixture, true);
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true, generator: {
      probe: compatibleOutputProbe, version: async () => "ffmpeg synthetic-media", remux: async ({ destination }) => { await writeFile(destination, bytes); },
    } });
    const url = `http://localhost/api/browser-renditions/${seeded.request.id}/media`;
    const get = (Range?: string, method = "GET", extra = {}) => createBrowserRenditionMediaRoute(new Request(url, { method, headers: { Authorization, ...(Range ? { Range } : {}), ...extra } }), seeded.request.id, () => access, config);
    const whole = await get();
    expect(whole.status).toBe(200); expect(await whole.text()).toBe(bytes);
    expect(whole.headers.get("X-Encode-Output-State")).toBe("validation_failed");
    expect(whole.headers.get("X-Encode-Output-Validation")).toBe("failed");
    expect(whole.headers.get("Content-Type")).toBe("video/mp4");
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    for (const [range, expected] of [["bytes=0-1", "01"], ["bytes=10-", "synthetic-mp4"], ["bytes=-3", "mp4"], ["bytes=21-9999", "p4"]]) {
      const response = await get(range); expect(response.status).toBe(206); expect(await response.text()).toBe(expected);
      expect(response.headers.get("Content-Length")).toBe(String(expected.length)); expect(response.headers.get("Content-Range")).toMatch(/^bytes \d+-\d+\/23$/);
    }
    for (const range of ["bytes=23-", "bytes=3-2", "bytes=-0", "bytes=0-1,3-4", "bytes=9007199254740992-", "items=0-1", "bytes=-"]) {
      const response = await get(range); expect(response.status).toBe(416); expect(response.headers.get("Content-Range")).toBe("bytes */23"); expect(await response.text()).toBe("");
    }
    const head = await get(undefined, "HEAD"); expect(head.status).toBe(200); expect(head.headers.get("Content-Length")).toBe("23"); expect(await head.text()).toBe("");
    const changed = await get("bytes=0-1", "GET", { "If-Range": '"different-generation"' }); expect(changed.status).toBe(200); expect(await changed.text()).toBe(bytes);
    const match = await get("bytes=0-1", "GET", { "If-Range": whole.headers.get("ETag")! }); expect(match.status).toBe(206); expect(await match.text()).toBe("01");
    await writeFile(access.browserRenditions.find(seeded.request.id)!.media!.path, "synthetic changed media");
    expect((await get("bytes=0-1")).status).toBe(409);
  } finally { access.close(); }
});
