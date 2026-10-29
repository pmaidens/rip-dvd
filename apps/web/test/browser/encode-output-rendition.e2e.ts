import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, test } from "@playwright/test";

// Run only with the dedicated config and its isolated synthetic server.
test.skip(process.env.RIP_DVD_RENDITION_BROWSER_GATE !== "true", "Requires the separate rendition browser gate.");
const root = resolve("test-results/rendition-browser-data");
let seeded: { id: string; identity: string };
test.beforeAll(async () => {
  const suppliedManifest = process.env.RIP_DVD_RENDITION_BROWSER_FIXTURE;
  const manifest = suppliedManifest ?? join(root, "seeded.json");
  if (existsSync(manifest)) {
    seeded = JSON.parse(readFileSync(manifest, "utf8"));
    if (!/^[0-9a-f-]{36}$/.test(seeded.id) || !/^encode-output-v1\.failed\.[0-9a-f-]{36}$/.test(seeded.identity)) throw new Error("Invalid synthetic rendition fixture identity.");
    return;
  }
  if (suppliedManifest) throw new Error("The supplied synthetic rendition fixture is missing.");
  const { probeEncodeOutputMedia } = await import("@rip-dvd/application");
  const { createOperatorWorkflowFixture } = await import("../../../operator-cli/src/operator-workflow.test-support.js");
  const { requestSyntheticRendition } = await import("../../../operator-cli/src/encode-output-rendition.test-support.js");
  const { pollBrowserRenditions } = await import("../../../encode-worker/src/browser-rendition-worker.js");
  const fixture = createOperatorWorkflowFixture(root);
  const source = join(fixture.operatorHostPath, "synthetic-browser-source.mkv");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-profile:a", "aac_low", source]);
  const output = await requestSyntheticRendition(fixture, true, { probe: probeEncodeOutputMedia, canonicalBytes: readFileSync(source) });
  const access = fixture.openAccess();
  try { await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true }); }
  finally { access.close(); }
  seeded = { id: output.request.id, identity: output.identity };
  writeFileSync(manifest, JSON.stringify(seeded));
});
test("prepares a retained synthetic rendition through the public operation", async ({ request }) => {
  const response = await request.get(`/api/browser-renditions/${seeded.id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "complete", source: { identity: seeded.identity, state: "validation_failed" },
    conversion: { kind: "stream_copy_remux" }, media: { mediaType: "video/mp4", availability: { available: true } } });
});

test("plays actual failed-source rendition with audio and seeking, and protects every range", async ({ page, request, browser, baseURL }) => {
  const url = `/api/browser-renditions/${seeded.id}/media`;
  const state = await request.get(`/api/browser-renditions/${seeded.id}`);
  expect((await state.json()).status).toBe("complete");
  const anonymous = await browser.newContext();
  try {
    expect((await anonymous.request.get(new URL(url, baseURL).toString(), { headers: { Range: "bytes=0-1" } })).status()).toBe(401);
  } finally { await anonymous.close(); }
  const range = await request.get(url, { headers: { Range: "bytes=0-1" } });
  expect(range.status()).toBe(206); expect((await range.body()).length).toBe(2);
  expect((await request.get(url, { headers: { Range: "bytes=9007199254740991-" } })).status()).toBe(416);
  await page.goto("/encoding");
  await page.getByRole("button", { name: /Failed \d+/ }).click();
  await page.getByRole("button", { name: "Inspect failed output 1" }).click();
  const panel = page.getByRole("region", { name: "Browser Viewing Rendition", exact: true });
  await expect(panel).toContainText("Validation-failed source");
  await expect(panel).toContainText("No damage seek is claimed");
  await page.evaluate(({ id, identity }) => sessionStorage.setItem(`encode-output-browser-rendition:${identity}`, id), seeded);
  await page.reload();
  await page.getByRole("button", { name: /Failed \d+/ }).click();
  await page.getByRole("button", { name: "Inspect failed output 1" }).click();
  const video = page.getByLabel("Finished Encode Output browser rendition");
  await expect(video).toBeVisible();
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = false; element.volume = 0.2; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.1);
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
  await video.evaluate((element: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
    element.pause();
    element.addEventListener("seeked", () => element.readyState >= 2 ? resolve() : reject(new Error("Seek completed without media data.")), { once: true });
    element.currentTime = 1.5;
  }));
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(1.4);
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
  const failedRanges: string[] = [];
  await page.route(`**${url}`, async (route) => { failedRanges.push(route.request().headers().range ?? "full"); await route.fulfill({ status: 416, headers: { "Content-Range": "bytes */0" } }); });
  await video.evaluate((element: HTMLVideoElement) => { element.load(); });
  await expect(panel).toContainText("The browser could not play this rendition");
  expect(failedRanges.length).toBeGreaterThan(0);
  await expect(panel).toContainText("Validation-failed source");
});
