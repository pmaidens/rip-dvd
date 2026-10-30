import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SyntheticViewingVariant } from "../../../encode-worker/test/browser-rendition-media.test-support.js";

test.skip(process.env.RIP_DVD_PREVIEW_RENDITION_BROWSER_GATE !== "true", "Requires the isolated preview rendition browser gate.");
const root = resolve(process.env.RIP_DVD_PREVIEW_BROWSER_DATA_PATH ?? "test-results/preview-rendition-browser-data/default");
const variant = process.env.RIP_DVD_PREVIEW_BROWSER_VARIANT ?? "compatible";
const sampleCase = process.env.RIP_DVD_PREVIEW_BROWSER_CASE ?? "complete";
const burn = process.env.RIP_DVD_PREVIEW_BROWSER_BURN_SUBTITLE;
if (!["compatible", "incompatible", "audio_conversion", "video_format", "subtitles"].includes(variant) || !["complete", "partial", "stale", "longclip", "missing", "conversion_failure"].includes(sampleCase)) throw new Error("Unknown synthetic preview browser case.");
if (burn !== undefined && (variant !== "subtitles" || !["2", "3"].includes(burn))) throw new Error("Synthetic subtitle cases use stream 2 or 3.");
let seeded: { id: string; requestId: string; identity: string; variant: string; sampleCase: string; burnSubtitleIndex?: number; conversionKind: string; durationSeconds: number; reviewed: boolean };
test.beforeAll(async () => {
  const manifest = process.env.RIP_DVD_PREVIEW_BROWSER_FIXTURE ?? join(root, "seeded.json");
  if (existsSync(manifest)) {
    seeded = JSON.parse(readFileSync(manifest, "utf8"));
    if (!/^[a-f0-9-]{36}$/.test(seeded.id) || !/^damage-preview-v1\.[a-f0-9-]{36}\.0$/.test(seeded.identity) || seeded.variant !== variant || seeded.sampleCase !== sampleCase || seeded.burnSubtitleIndex !== (burn === undefined ? undefined : Number(burn))) throw new Error("The synthetic preview manifest does not match this browser case.");
    return;
  }
  if (process.env.RIP_DVD_PREVIEW_BROWSER_FIXTURE) throw new Error("The supplied synthetic preview manifest is missing.");
  const { createOperatorWorkflowFixture } = await import("../../../operator-cli/src/operator-workflow.test-support.js");
  const { requestSyntheticPreviewRendition } = await import("../../../operator-cli/src/damage-preview-rendition.test-support.js");
  const { advanceCommittedArchiveEvidence } = await import("../../../operator-cli/src/archive-evidence.test-support.js");
  const { probeEncodeOutputMedia } = await import("@rip-dvd/application");
  const { createSyntheticViewingSource } = await import("../../../encode-worker/test/browser-rendition-media.test-support.js");
  const { pollBrowserRenditions } = await import("../../../encode-worker/src/browser-rendition-worker.js");
  const { createBrowserRenditionGenerator, runRenditionCommand } = await import("../../../encode-worker/src/browser-rendition-generator.js");
  const fixture = createOperatorWorkflowFixture(root);
  const durationSeconds = sampleCase === "longclip" ? 130 : 3;
  const source = createSyntheticViewingSource(fixture.operatorHostPath, variant as SyntheticViewingVariant, durationSeconds);
  const preview = await requestSyntheticPreviewRendition(fixture, { probe: probeEncodeOutputMedia, canonicalBytes: readFileSync(source), durationMilliseconds: durationSeconds * 1000,
    generationStatus: sampleCase === "partial" ? "partial" : "complete", ...(burn === undefined ? {} : { burnSubtitleIndex: Number(burn) }) });
  if (sampleCase === "stale") advanceCommittedArchiveEvidence(fixture, preview.seeded.manifest);
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true,
      ...(sampleCase === "conversion_failure" ? { generator: { ...createBrowserRenditionGenerator(), async generate(input: Parameters<ReturnType<typeof createBrowserRenditionGenerator>["generate"]>[0]) {
        await runRenditionCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", input.source, "-c:v", "synthetic-missing-encoder", input.destination], input.signal, input.executionDescriptor);
      } } } : {}) });
    const record = access.browserRenditions.find(preview.request.id)!;
    if (sampleCase === "conversion_failure") {
      if (record.status !== "failed" || record.media !== null || record.reason?.code !== "RENDITION_CONVERSION_FAILED") throw new Error("The synthetic conversion failure did not fail as expected. Use incompatible media for this case.");
    } else if (record.status !== "complete" || !record.media) throw new Error("Synthetic preview rendition generation did not complete.");
    if (sampleCase === "missing") unlinkSync(record.media!.path);
    const archive = access.catalog.listOriginalDiscArchives({ ids: [preview.seeded.archive.id] })[0]!;
    seeded = { id: record.id, requestId: preview.id, identity: preview.identity, variant, sampleCase, conversionKind: record.conversion.kind, durationSeconds,
      reviewed: archive.catalogReviewedAt !== null, ...(burn === undefined ? {} : { burnSubtitleIndex: Number(burn) }) };
  } finally { access.close(); }
  writeFileSync(manifest, JSON.stringify(seeded));
});
async function openSample(page: Page) {
  await page.goto("/catalog");
  if (seeded.reviewed) await page.getByRole("button", { name: "Reviewed", exact: true }).click();
  await page.getByRole("button", { name: seeded.reviewed ? "Open review" : "Review catalog", exact: true }).first().click();
  await page.getByRole("tab", { name: "Damage decision" }).click();
  const preview = page.getByRole("region", { name: "Damage Preview", exact: true });
  await page.evaluate(({ identity, id }) => sessionStorage.setItem(`damage-preview-browser-rendition:${identity}`, id), seeded);
  await preview.getByLabel("Damage Preview request identity").fill(seeded.requestId);
  await preview.getByRole("button", { name: "Refresh preview status", exact: true }).click();
  const panel = page.getByRole("region", { name: "Damage Preview browser viewing", exact: true });
  await expect(panel).toContainText("not finished Encode Output or a watchability verdict");
  await expect(panel).toContainText(seeded.identity);
  await expect(panel).toContainText(`Actual sample coverage: 1 s to ${1 + seeded.durationSeconds} s`);
  return { panel, video: panel.getByLabel("Damage Preview sample browser rendition") };
}
test("authorizes creation, inspection and every full, HEAD and range request and reports invalid ranges", async ({ browser, request, baseURL }) => {
  const mediaUrl = `/api/browser-renditions/${seeded.id}/media`;
  const anonymous = await browser.newContext({ httpCredentials: undefined });
  try {
    const absolute = (path: string) => new URL(path, baseURL).toString();
    expect((await anonymous.request.get(absolute(`/api/damage-preview-media/${seeded.identity}/renditions`))).status()).toBe(401);
    expect((await anonymous.request.post(absolute(`/api/damage-preview-media/${seeded.identity}/renditions`), { data: {} })).status()).toBe(401);
    expect((await anonymous.request.get(absolute(`/api/browser-renditions/${seeded.id}`))).status()).toBe(401);
    expect((await anonymous.request.head(absolute(mediaUrl))).status()).toBe(401);
    for (const range of [undefined, "bytes=0-1", "bytes=20-30"]) expect((await anonymous.request.get(absolute(mediaUrl), { headers: range ? { Range: range } : {} })).status()).toBe(401);
  } finally { await anonymous.close(); }
  if (["missing", "conversion_failure"].includes(sampleCase)) {
    expect((await request.get(mediaUrl, { headers: { Range: "bytes=0-1" } })).status()).toBe(409);
  } else {
    const range = await request.get(mediaUrl, { headers: { Range: "bytes=0-1" } });
    expect(range.status()).toBe(206); expect((await range.body()).length).toBe(2);
    expect((await request.get(mediaUrl, { headers: { Range: "bytes=9007199254740991-" } })).status()).toBe(416);
  }
});
test("plays sample audio, seeks across the actual clip and retains partial or stale labels through media failure", async ({ page, request }) => {
  const { panel, video } = await openSample(page);
  if (sampleCase === "missing" || sampleCase === "conversion_failure") {
    await expect(video).toHaveCount(0);
    await expect(panel).toContainText(sampleCase === "missing" ? "Sample rendition media is unavailable" : "RENDITION_CONVERSION_FAILED");
    return;
  }
  await expect(video).toBeVisible();
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = false; element.volume = 0.2; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.1);
  const peak = await video.evaluate(async (element: HTMLVideoElement) => {
    const context = new AudioContext(); const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaElementSource(element).connect(analyser); analyser.connect(context.destination); await context.resume();
    const samples = new Float32Array(analyser.fftSize); let peak = 0;
    for (let frame = 0; frame < 30; frame++) { await new Promise<void>((done) => requestAnimationFrame(() => done())); analyser.getFloatTimeDomainData(samples); peak = Math.max(peak, ...samples.map(Math.abs)); }
    await context.close(); return peak;
  });
  expect(peak).toBeGreaterThan(0.001);
  const target = seeded.durationSeconds - 0.5;
  await video.evaluate((element: HTMLVideoElement, at) => new Promise<void>((resolve, reject) => {
    element.pause(); element.addEventListener("seeked", () => element.readyState >= 2 ? resolve() : reject(new Error("Seek has no decoded data")), { once: true }); element.currentTime = at;
  }), target);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(target - 0.1);
  if (sampleCase === "partial") await expect(panel).toContainText("Partial sample");
  if (sampleCase === "stale") await expect(panel).toContainText("Outdated sample");
  const control = `/__rendition-browser-fault/${seeded.id}`;
  expect((await request.post(control, { data: { failMedia: true } })).status()).toBe(200);
  try {
    await video.evaluate(async (element: HTMLVideoElement) => { element.load(); await element.play().catch(() => {}); });
    await expect(panel).toContainText("The browser could not play this sample rendition");
    expect((await (await request.get(control)).json()).injectedResponses).toBeGreaterThan(0);
    if (sampleCase === "partial") await expect(panel).toContainText("Partial sample");
    if (sampleCase === "stale") await expect(panel).toContainText("Outdated sample");
  } finally { expect((await request.post(control, { data: { failMedia: false } })).status()).toBe(200); }
});
test("labels actual audio and conversion and burns only the reviewed subtitle", async ({ page }) => {
  test.skip(["missing", "conversion_failure"].includes(sampleCase), "Failure cases have no playable rendition.");
  const { panel, video } = await openSample(page);
  await expect(panel).toContainText(seeded.conversionKind === "stream_copy_remux" ? "Stream-copy remux to MP4" : "H.264/AAC conversion to MP4");
  await expect(panel).toContainText("Observed rendition audio: #1 aac, eng");
  if (variant !== "subtitles") return;
  if (burn === undefined) await expect(panel).toContainText("Soft subtitles omitted: #2 dvd_subtitle, eng");
  else await expect(panel).toContainText(`Burned subtitle #${burn}`);
  const framePeak = (at: number) => video.evaluate((element: HTMLVideoElement, target) => new Promise<number>((resolve) => {
    element.pause(); element.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas"); canvas.width = element.videoWidth; canvas.height = element.videoHeight;
      const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0); const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let peak = 0; for (let index = 0; index < pixels.length; index += 4) peak = Math.max(peak, pixels[index]!); resolve(peak);
    }, { once: true }); element.currentTime = target;
  }), at);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  expect(await framePeak(0.1)).toBeLessThan(30);
  const visible = await framePeak(1.5);
  if (burn === undefined) expect(visible).toBeLessThan(30); else expect(visible).toBeGreaterThan(180);
  expect(await framePeak(2.8)).toBeLessThan(30);
  if (burn === undefined) {
    await panel.getByRole("button", { name: "Check sample browser playback" }).click();
    await panel.getByLabel("Burn one sample subtitle into a separate rendition").selectOption("2");
    await expect(panel).toContainText("Burned subtitle #2");
    const admitted = page.waitForResponse((reply) => reply.url().includes(`/damage-preview-media/${seeded.identity}/renditions`) && reply.request().method() === "POST");
    await panel.getByRole("button", { name: "Create sample browser rendition" }).click();
    const separate = await (await admitted).json();
    expect(separate.id).not.toBe(seeded.id); expect(separate).toMatchObject({ status: "queued", conversion: { subtitles: "burned_in", burnedSubtitle: { sourceIndex: 2 } } });
  }
});
