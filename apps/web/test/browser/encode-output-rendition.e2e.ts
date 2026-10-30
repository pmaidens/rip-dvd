import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SyntheticViewingVariant } from "../../../encode-worker/test/browser-rendition-media.test-support.js";
import { expect, test, type Page } from "@playwright/test";

// Run only with the dedicated config and its isolated synthetic server.
test.skip(process.env.RIP_DVD_RENDITION_BROWSER_GATE !== "true", "Requires the separate rendition browser gate.");
const root = resolve("test-results/rendition-browser-data");
let seeded: { id: string; identity: string; variant: string; conversionKind: string; subtitles: string; burnSubtitleIndex?: number };
const variant = process.env.RIP_DVD_RENDITION_BROWSER_VARIANT ?? "compatible";
if (!["compatible", "incompatible", "audio_conversion", "video_format", "subtitles"].includes(variant)) throw new Error("Unknown synthetic viewing variant.");
const burn = process.env.RIP_DVD_RENDITION_BROWSER_BURN_SUBTITLE;
if (burn !== undefined && (variant !== "subtitles" || !["2", "3"].includes(burn))) throw new Error("Synthetic subtitle cases use stream 2 or 3.");
test.beforeAll(async () => {
  const suppliedManifest = process.env.RIP_DVD_RENDITION_BROWSER_FIXTURE;
  const manifest = suppliedManifest ?? join(root, "seeded.json");
  if (existsSync(manifest)) {
    seeded = JSON.parse(readFileSync(manifest, "utf8"));
    if (!/^[0-9a-f-]{36}$/.test(seeded.id) || !/^encode-output-v1\.failed\.[0-9a-f-]{36}$/.test(seeded.identity)) throw new Error("Invalid synthetic rendition fixture identity.");
    if (seeded.variant !== variant || seeded.burnSubtitleIndex !== (burn === undefined ? undefined : Number(burn))) throw new Error("The prepared synthetic rendition fixture does not match this browser case. Prepare a fresh matching fixture.");
    return;
  }
  if (suppliedManifest) throw new Error("The supplied synthetic rendition fixture is missing.");
  const { probeEncodeOutputMedia } = await import("@rip-dvd/application");
  const { createOperatorWorkflowFixture } = await import("../../../operator-cli/src/operator-workflow.test-support.js");
  const { requestSyntheticRendition } = await import("../../../operator-cli/src/encode-output-rendition.test-support.js");
  const { pollBrowserRenditions } = await import("../../../encode-worker/src/browser-rendition-worker.js");
  const fixture = createOperatorWorkflowFixture(root);
  const { createSyntheticViewingSource } = await import("../../../encode-worker/test/browser-rendition-media.test-support.js");
  const source = createSyntheticViewingSource(fixture.operatorHostPath, variant as SyntheticViewingVariant);
  const output = await requestSyntheticRendition(fixture, true, { probe: probeEncodeOutputMedia, canonicalBytes: readFileSync(source), ...(burn === undefined ? {} : { burnSubtitleIndex: Number(burn) }) });
  const access = fixture.openAccess();
  try { await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true }); }
  finally { access.close(); }
  seeded = { id: output.request.id, identity: output.identity, variant, conversionKind: output.request.conversion.kind, subtitles: output.request.conversion.subtitles, ...(burn === undefined ? {} : { burnSubtitleIndex: Number(burn) }) };
  writeFileSync(manifest, JSON.stringify(seeded));
});
test("prepares a retained synthetic rendition through the public operation", async ({ request }) => {
  const response = await request.get(`/api/browser-renditions/${seeded.id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "complete", source: { identity: seeded.identity, state: "validation_failed" },
    conversion: { kind: seeded.conversionKind, subtitles: seeded.subtitles }, media: { mediaType: "video/mp4", availability: { available: true } } });
});

async function openFailedRendition(page: Page) {
  await page.goto("/encoding");
  await page.getByRole("button", { name: /In progress \d+/ }).click();
  await page.getByRole("button", { name: "Inspect failed output 1" }).click();
  const panel = page.getByRole("region", { name: "Browser Viewing Rendition", exact: true });
  await expect(panel).toContainText("Validation-failed source");
  await expect(panel).toContainText("No damage seek is claimed");
  await page.evaluate(({ id, identity }) => sessionStorage.setItem(`encode-output-browser-rendition:${identity}`, id), seeded);
  await page.reload();
  await page.getByRole("button", { name: /In progress \d+/ }).click();
  await page.getByRole("button", { name: "Inspect failed output 1" }).click();
  const video = page.getByLabel("Finished Encode Output browser rendition");
  await expect(video).toBeVisible();
  return { video, panel };
}

test("plays and seeks an actual failed-source rendition, and protects every range", async ({ page, request, browser, baseURL }) => {
  const url = `/api/browser-renditions/${seeded.id}/media`;
  const state = await request.get(`/api/browser-renditions/${seeded.id}`);
  expect((await state.json()).status).toBe("complete");
  // New contexts inherit test options unless the credential option is cleared.
  const anonymous = await browser.newContext({ httpCredentials: undefined });
  try {
    expect((await anonymous.request.get(new URL(url, baseURL).toString(), { headers: { Range: "bytes=0-1" } })).status()).toBe(401);
  } finally { await anonymous.close(); }
  const range = await request.get(url, { headers: { Range: "bytes=0-1" } });
  expect(range.status()).toBe(206); expect((await range.body()).length).toBe(2);
  expect((await request.get(url, { headers: { Range: "bytes=9007199254740991-" } })).status()).toBe(416);
  const { video, panel } = await openFailedRendition(page);
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = false; element.volume = 0.2; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.1);
  await video.evaluate((element: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
    element.pause();
    element.addEventListener("seeked", () => element.readyState >= 2 ? resolve() : reject(new Error("Seek completed without media data.")), { once: true });
    element.currentTime = 1.5;
  }));
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(1.4);
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
  const control = `/__rendition-browser-fault/${seeded.id}`;
  expect((await request.post(control, { data: { failMedia: true } })).status()).toBe(200);
  try {
    const denied = await browser.newContext({ httpCredentials: undefined });
    try { expect((await denied.request.get(new URL(url, baseURL).toString())).status()).toBe(401); }
    finally { await denied.close(); }
    await page.reload();
    await page.getByRole("button", { name: /In progress \d+/ }).click();
    await page.getByRole("button", { name: "Inspect failed output 1" }).click();
    await video.evaluate(async (element: HTMLVideoElement) => { await element.play().catch(() => {}); });
    await expect(panel).toContainText("The browser could not play this rendition");
    expect((await (await request.get(control)).json()).injectedResponses).toBeGreaterThan(0);
    await expect(panel).toContainText("Validation-failed source");
  } finally {
    expect((await request.post(control, { data: { failMedia: false } })).status()).toBe(200);
  }
});

test("decodes non-silent rendition audio in the browser", async ({ page }) => {
  const { video } = await openFailedRendition(page);
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = false; element.volume = 0.2; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.1);
  // Web Audio reroutes the element's audio. Keep it separate from native seek checks.
  const audioLevel = await video.evaluate(async (element: HTMLVideoElement) => {
    const context = new AudioContext();
    const input = context.createMediaElementSource(element);
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    input.connect(analyser); analyser.connect(context.destination); await context.resume();
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
      analyser.getFloatTimeDomainData(samples);
      peak = Math.max(peak, ...samples.map(Math.abs));
    }
    await context.close(); return peak;
  });
  expect(audioLevel).toBeGreaterThan(0.001);
});

test("shows actual conversion and subtitle labels and renders only the selected burned captions", async ({ page }) => {
  const { video, panel } = await openFailedRendition(page);
  await expect(panel).toContainText(seeded.conversionKind === "stream_copy_remux" ? "Stream-copy remux to MP4" : "H.264/AAC conversion to MP4");
  await expect(panel).toContainText("Audio: #1 aac, eng");
  if (seeded.variant === "subtitles") {
    if (seeded.burnSubtitleIndex !== undefined) await expect(panel).toContainText(`Burned subtitle #${seeded.burnSubtitleIndex}`);
    else await expect(panel).toContainText("No subtitles are burned in");
    if (seeded.burnSubtitleIndex !== 2) await expect(panel).toContainText("#2 dvd_subtitle, eng");
    if (seeded.burnSubtitleIndex !== 3) await expect(panel).toContainText("#3 subrip, fra");
  }
  const peak = async (at: number) => video.evaluate((element: HTMLVideoElement, target) => new Promise<number>((resolve, reject) => {
    element.pause();
    element.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas"); canvas.width = element.videoWidth; canvas.height = element.videoHeight;
      const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let max = 0; for (let index = 0; index < rgba.length; index += 4) max = Math.max(max, rgba[index]!);
      resolve(max);
    }, { once: true });
    element.addEventListener("error", () => reject(new Error("Synthetic subtitle frame could not load.")), { once: true });
    element.currentTime = target;
  }), at);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  expect(await peak(0.1)).toBeLessThan(30);
  const caption = await peak(1.5);
  if (seeded.burnSubtitleIndex === undefined) expect(caption).toBeLessThan(30);
  else expect(caption).toBeGreaterThan(180);
  expect(await peak(2.8)).toBeLessThan(30);
});

test("reviews a selected subtitle and queues a separate burned rendition through the web controls", async ({ page, request }) => {
  test.skip(variant !== "subtitles" || burn !== undefined, "The omitted-subtitle case supplies this interaction.");
  const { panel } = await openFailedRendition(page);
  await panel.getByRole("button", { name: "Check browser playback" }).click();
  await panel.getByLabel("Burn one subtitle into a separate rendition").selectOption("2");
  await expect(panel).toContainText("Burned subtitle #2");
  const response = page.waitForResponse((reply) => reply.url().includes(`/encode-outputs/${seeded.identity}/renditions`) && reply.request().method() === "POST");
  await panel.getByRole("button", { name: "Create browser rendition" }).click();
  const created = await (await response).json();
  expect(created).toMatchObject({ status: "queued", conversion: { subtitles: "burned_in", burnedSubtitle: { sourceIndex: 2 } }, source: { identity: seeded.identity, state: "validation_failed" } });
  expect(created.id).not.toBe(seeded.id);
  expect(await (await request.get(`/api/browser-renditions/${seeded.id}`)).json()).toMatchObject({ status: "complete", conversion: { subtitles: "omitted" } });
});

// Authored correspondence responses isolate browser interaction from the
// separately tested CLI/HTTP classification and real rendition clock producer.
test.describe("authored output correspondence", () => {
// Service-worker control can bypass page.route in WebKit after navigation.
// Keep the authored responses deterministic; ordinary media tests above still
// exercise the application's normal service-worker behavior.
test.use({ serviceWorkers: "block" });
for (const state of ["verified", "absent", "unknown", "changed_on_seek"] as const) {
  test(`only seeks a freshly proved output target, authored correspondence=${state}`, async ({ page }) => {
    let inspection: Record<string, any>;
    let checks = 0;
    const mutations: string[] = [];
    await page.route(`**/api/encode-outputs/${seeded.identity}`, async (route) => {
      if (route.request().method() !== "GET") { mutations.push(route.request().method()); await route.continue(); return; }
      const response = await route.fetch();
      inspection = await response.json();
      const source = inspection.artifact.provenance.sourceSnapshot.source;
      source.assessment.items = [{ titleIdentityObservationId: "synthetic-browser-title", estimatedAffectedPlayback: {
        intervals: [{ startMilliseconds: 1000, endMilliseconds: 5000, coverage: "whole_cell" }], unknownCoverage: [],
      } }];
      await route.fulfill({ response, json: inspection });
    });
    await page.route(`**/api/encode-outputs/${seeded.identity}/intervals?*`, async (route) => {
      checks += 1;
      const query = JSON.parse(new URL(route.request().url()).searchParams.get("query")!);
      const status = state === "changed_on_seek" ? checks === 1 ? "verified" : "unknown" : state;
      await route.fulfill({ json: { schemaVersion: 1, query, inspection, intervals: [{ intervalIndex: 0, status,
        outputInterval: status === "verified" ? { startMilliseconds: 1100, endMilliseconds: 2200 } : null,
        reasonCode: status === "verified" ? "OUTPUT_CELL_CONTENT_VERIFIED" : status === "absent" ? "SOURCE_EXCLUDED_BY_SELECTION" : "OUTPUT_TRUNCATED",
        reason: status === "absent" ? "Synthetic selected source is proved excluded." : status === "unknown" ? "Synthetic output truncation leaves correspondence unknown." : "Synthetic evidenced whole-cell envelope.",
      }], viewing: { renditionId: seeded.id, mediaIdentity: `browser-rendition-v1.${seeded.id}`,
        reasonCode: null, reason: null, targets: status === "verified" ? [{ intervalIndex: 0,
          canonicalOutputInterval: { startMilliseconds: 1100, endMilliseconds: 2200 },
          renditionInterval: { startMilliseconds: 1200, endMilliseconds: 2300 }, seekSeconds: 1.2 }] : [] } } });
    });
    const { video, panel } = await openFailedRendition(page);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.seekable.length)).toBeGreaterThan(0);
    await panel.getByLabel("Estimated Affected Playback interval").selectOption({ index: 1 });
    await panel.getByRole("button", { name: "Check output correspondence" }).click();
    await expect(panel).toContainText(`Correspondence: ${state === "changed_on_seek" ? "verified" : state}`);
    const seek = panel.getByRole("button", { name: "Seek to verified output interval" });
    if (state === "verified" || state === "changed_on_seek") {
      await expect(panel).toContainText("Canonical seek target: 1.1 seconds");
      await expect(panel).toContainText("Rendition seek target: 1.2 seconds");
      await seek.click();
      await expect.poll(() => checks).toBe(2);
      if (state === "verified") {
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1.2, 1);
        await expect(panel).toContainText("Seek requested at 1.2 seconds");
      } else {
        await expect(panel).toContainText("Correspondence: unknown");
        await expect(seek).toHaveCount(0);
        expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(0);
      }
    } else {
      await expect(seek).toHaveCount(0);
      expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(0);
      await expect(panel).toContainText(state === "absent" ? "SOURCE_EXCLUDED_BY_SELECTION" : "OUTPUT_TRUNCATED");
    }
    await expect(panel).toContainText("Validation-failed source");
    await expect(panel).toContainText("separate MP4");
    // Ordinary controls remain usable in every classification.
    await video.evaluate(async (element: HTMLVideoElement) => { element.currentTime = 0.2; element.muted = false; await element.play(); });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.3);
    await expect(panel).toContainText("Validation-failed source");
    expect(mutations).toEqual([]);
  });
}
});
