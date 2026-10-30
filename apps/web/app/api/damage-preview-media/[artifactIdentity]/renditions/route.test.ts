import { writeFileSync, unlinkSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { requestSyntheticPreviewRendition } from "../../../../../../operator-cli/src/damage-preview-rendition.test-support.js";
import { compatibleOutputProbe, subtitleOutputProbe } from "../../../../../../operator-cli/src/encode-output-rendition.test-support.js";
import { advanceCommittedArchiveEvidence } from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import { pollBrowserRenditions } from "../../../../../../encode-worker/src/browser-rendition-worker.js";
import { createDamagePreviewRenditionsRoute } from "./route";
import { createBrowserRenditionInspectionRoute } from "../../../browser-renditions/[id]/route";
import { createBrowserRenditionMediaRoute } from "../../../browser-renditions/[id]/media/route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const config = { enabled: true, password: "synthetic-viewing-password" };
const origin = "http://localhost:3000";
const headers = { Authorization: `Basic ${Buffer.from(`operator:${config.password}`).toString("base64")}`, Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" };
it("shares preview and selected-subtitle admission, replay, conflicts, stale rejection and inspection with the public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture, { probe: subtitleOutputProbe, burnSubtitleIndex: 2, generationStatus: "partial" });
  const access = fixture.openAccess();
  const url = `${origin}/api/damage-preview-media/${seeded.identity}/renditions`;
  const options = { getAccess: () => access, accessConfig: config, probe: subtitleOutputProbe, trustedOrigin: origin };
  const post = (input: unknown) => createDamagePreviewRenditionsRoute(new Request(url, { method: "POST", headers, body: JSON.stringify(input) }), seeded.identity, options);
  try {
    expect(await (await createDamagePreviewRenditionsRoute(new Request(`${url}?burnSubtitleIndex=2`, { headers }), seeded.identity, options)).json()).toEqual(seeded.review);
    const input = { mutationKey: "synthetic-preview-rendition-request", reviewToken: seeded.review.reviewToken, burnSubtitleIndex: 2 };
    expect(await (await post(input)).json()).toEqual(seeded.request);
    const conflict = await post({ ...input, burnSubtitleIndex: 3 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual((await fixture.run([...seeded.args.slice(0, -1), JSON.stringify({ reviewToken: seeded.review.reviewToken, burnSubtitleIndex: 3 })], undefined, undefined, seeded.cliOptions)).result);
    advanceCommittedArchiveEvidence(fixture, seeded.seeded.manifest);
    const staleInput = { ...input, mutationKey: "synthetic-preview-http-stale" };
    const stale = await post(staleInput);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual((await fixture.run(["damage-preview", "request-rendition", seeded.identity, "--key", staleInput.mutationKey, "--json", JSON.stringify({ reviewToken: input.reviewToken, burnSubtitleIndex: 2 })], undefined, undefined, seeded.cliOptions)).result);
    const inspected = createBrowserRenditionInspectionRoute(new Request(`${origin}/api/browser-renditions/${seeded.request.id}`, { headers }), seeded.request.id, () => access, config);
    expect(await inspected.json()).toEqual((await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).result);
    for (const query of ["burnSubtitleIndex=-1", "burnSubtitleIndex=2&burnSubtitleIndex=3", "burnSubtitleIndex=", "other=2"]) expect((await createDamagePreviewRenditionsRoute(new Request(`${url}?${query}`, { headers }), seeded.identity, options)).status).toBe(400);
  } finally { access.close(); }
});
it("authorizes review, creation, inspection and every full, HEAD and byte-range access before opening persistence", async () => {
  const getAccess = () => { throw new Error("Unauthorized access must not open persistence"); };
  for (const method of ["GET", "POST"]) expect((await createDamagePreviewRenditionsRoute(new Request(`${origin}/api/damage-preview-media/synthetic/renditions`, { method }), "synthetic", { getAccess, accessConfig: config })).status).toBe(401);
  expect(createBrowserRenditionInspectionRoute(new Request(`${origin}/api/browser-renditions/synthetic`), "synthetic", getAccess, config).status).toBe(401);
  for (const method of ["GET", "HEAD"]) for (const range of [undefined, "bytes=0-1", "bytes=10-20"]) {
    expect((await createBrowserRenditionMediaRoute(new Request(`${origin}/api/browser-renditions/synthetic/media`, { method, headers: range ? { Range: range } : {} }), "synthetic", getAccess, config)).status).toBe(401);
  }
  const denied = await createDamagePreviewRenditionsRoute(new Request(`${origin}/api/damage-preview-media/synthetic/renditions`, { method: "POST", headers: { ...headers, Origin: "https://hostile.example" }, body: "{}" }), "synthetic", { getAccess, accessConfig: config, trustedOrigin: origin });
  expect(denied.status).toBe(403);
});
it("serves authenticated sample ranges with live partial/outdated labels, precise range errors and missing-media failure", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture, { generationStatus: "partial" });
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true, generator: { probe: compatibleOutputProbe, version: async () => "synthetic ffmpeg", async generate({ destination }) { writeFileSync(destination, "0123456789"); } } });
    advanceCommittedArchiveEvidence(fixture, seeded.seeded.manifest);
    const url = `${origin}/api/browser-renditions/${seeded.request.id}/media`;
    const get = (range?: string, method = "GET") => createBrowserRenditionMediaRoute(new Request(url, { method, headers: { ...headers, ...(range ? { Range: range } : {}) } }), seeded.request.id, () => access, config);
    const range = await get("bytes=2-5");
    expect(range.status).toBe(206); expect(await range.text()).toBe("2345");
    expect(range.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(range.headers.get("X-Damage-Preview-State")).toBe("outdated"); expect(range.headers.get("X-Damage-Preview-Generation")).toBe("partial");
    expect(range.headers.get("X-Encode-Output-State")).toBeNull();
    const head = await get(undefined, "HEAD"); expect(head.status).toBe(200); expect(await head.text()).toBe(""); expect(head.headers.get("Content-Length")).toBe("10");
    for (const invalid of ["bytes=10-", "bytes=5-2", "bytes=0-1,3-4", "bytes=-0", "bytes=9007199254740992-"]) expect((await get(invalid)).status).toBe(416);
    const suffix = await get("bytes=-2"); expect(await suffix.text()).toBe("89");
    unlinkSync(access.browserRenditions.find(seeded.request.id)!.media!.path);
    expect((await get("bytes=0-1")).status).toBe(409);
    expect((await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).result).toMatchObject({ status: "complete", media: { availability: { available: false, reasonCode: "RENDITION_MEDIA_UNAVAILABLE" } }, previewCondition: { outdated: true, generationStatus: "partial" } });
  } finally { access.close(); }
});

it("closes the opened range when canonical deletion wins the final media-use admission", async () => {
  const { createApplicationOperations } = await import("@rip-dvd/application");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture);
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true, generator: { probe: compatibleOutputProbe, version: async () => "synthetic ffmpeg", async generate({ destination }) { writeFileSync(destination, "0123456789"); } } });
    const preview = await seeded.inspect();
    const racedAccess = { ...access, damagePreviews: { ...access.damagePreviews, touchMedia(id: string, identity?: string) {
      createApplicationOperations(access).deleteDamagePreviewMedia(seeded.id, { mediaToken: preview.media.token, mutationKey: "synthetic-range-deletion-race" });
      return access.damagePreviews.touchMedia(id, identity);
    } } };
    const response = await createBrowserRenditionMediaRoute(new Request(`${origin}/api/browser-renditions/${seeded.request.id}/media`, { headers: { ...headers, Range: "bytes=0-1" } }), seeded.request.id, () => racedAccess, config);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE" } });
  } finally { access.close(); }
});
