import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, test } from "@playwright/test";
import { probeEncodeOutputMedia } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../../operator-cli/src/operator-workflow.test-support.js";
import { requestSyntheticRendition } from "../../../operator-cli/src/encode-output-rendition.test-support.js";
import { pollBrowserRenditions } from "../../../encode-worker/src/browser-rendition-worker.js";

// Run only with the dedicated config and its isolated synthetic server.
test.skip(process.env.RIP_DVD_RENDITION_BROWSER_GATE !== "true", "Requires the separate rendition browser gate.");
const root = resolve("test-results/rendition-browser-data");
let seeded: { id: string; identity: string };
test.beforeAll(async () => {
  const manifest = join(root, "seeded.json");
  if (existsSync(manifest)) { seeded = JSON.parse(readFileSync(manifest, "utf8")); return; }
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
test("plays actual failed-source rendition with audio and seeking, and protects every range", async ({ page, request, browser }) => {
  const url = `/api/browser-renditions/${seeded.id}/media`;
  const state = await request.get(`/api/browser-renditions/${seeded.id}`);
  expect((await state.json()).status).toBe("complete");
  const anonymous = await browser.newContext();
  try {
    expect((await anonymous.request.get(`http://localhost:3112${url}`, { headers: { Range: "bytes=0-1" } })).status()).toBe(401);
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
  await video.evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = 1.5; });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(1.4);
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
  const failedRanges: string[] = [];
  await page.route(`**${url}`, async (route) => { failedRanges.push(route.request().headers().range ?? "full"); await route.fulfill({ status: 416, headers: { "Content-Range": "bytes */0" } }); });
  await video.evaluate((element: HTMLVideoElement) => { element.load(); });
  await expect(panel).toContainText("The browser could not play this rendition");
  expect(failedRanges.length).toBeGreaterThan(0);
  await expect(panel).toContainText("Validation-failed source");
});
