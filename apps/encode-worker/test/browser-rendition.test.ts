import { afterEach, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { createApplicationOperations, openBrowserRendition } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { compatibleOutputProbe, requestSyntheticRendition } from "../../operator-cli/src/encode-output-rendition.test-support.js";
import { pollBrowserRenditions, type BrowserRenditionGenerator } from "../src/browser-rendition-worker.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const generator: BrowserRenditionGenerator = {
  probe: compatibleOutputProbe, version: async () => "ffmpeg synthetic-test-tool",
  async remux({ destination, signal, onProgress }) { signal.throwIfAborted(); onProgress(50); await writeFile(destination, "synthetic remuxed MP4 bytes"); },
};
it.each([false, true])("retains a distinct rendition of the exact output without changing source status, failed=%s", async (failed) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticRendition(fixture, failed);
  const access = fixture.openAccess();
  try {
    const operations = createApplicationOperations(access, { encodeOutputMediaProbe: compatibleOutputProbe });
    const original = await operations.inspectEncodeOutput(seeded.identity);
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator, enabled: true });
    const inspected = await fixture.run(["encode-output", "inspect-rendition", seeded.request.id]);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.result).toMatchObject({ status: "complete", media: { identity: `browser-rendition-v1.${seeded.request.id}`, mediaType: "video/mp4" },
      playback: { kind: "ordinary", damageSeek: null, watchability: "not_assessed" }, conversion: { kind: "stream_copy_remux" },
      source: { identity: seeded.identity, state: failed ? "validation_failed" : "published", encodeJob: { status: failed ? "failed" : "completed" } } });
    expect(JSON.stringify(inspected.result)).not.toContain(fixture.mediaLibraryPath);
    expect(await operations.inspectEncodeOutput(seeded.identity)).toEqual(original);
    expect((await fixture.run(seeded.args)).result).toEqual(seeded.request);
    const opened = await openBrowserRendition(access, seeded.request.id, true);
    try { expect(await opened.file.readFile("utf8")).toBe("synthetic remuxed MP4 bytes"); } finally { await opened.file.close(); }
    const record = access.browserRenditions.find(seeded.request.id)!;
    expect(record.toolVersion).toBe("ffmpeg synthetic-test-tool");
    await writeFile(record.media!.path, "changed bytes");
    await expect(openBrowserRendition(access, seeded.request.id, true)).rejects.toMatchObject({ code: "RENDITION_MEDIA_IDENTITY_CHANGED" });
  } finally { access.close(); }
});
it("reports durable progress and failure without publishing incomplete media or restarting abandoned work", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticRendition(fixture);
  const access = fixture.openAccess();
  try {
    const broken: BrowserRenditionGenerator = { ...generator, async remux({ destination, onProgress }) {
      await writeFile(destination, "synthetic partial bytes"); onProgress(25);
      expect((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result).toMatchObject({ status: "generating", progress: { percent: 25 }, media: null });
      throw new Error("synthetic process failure");
    } };
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator: broken, enabled: true });
    expect((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result).toMatchObject({ status: "failed", media: null, reason: { code: "RENDITION_REMUX_FAILED" } });
    // Simulate a process death after durable claim, before media publication.
    const record = access.browserRenditions.find(seeded.request.id)!;
    record.status = "generating"; record.reason = null; access.browserRenditions.update(record);
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, generator, enabled: true });
    expect((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result).toMatchObject({ status: "interrupted", media: null, reason: { code: "RENDITION_WORKER_INTERRUPTED" } });
    expect((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result).toMatchObject({ media: null });
  } finally { access.close(); }
});
it("reports subtitle omissions and refuses a source that changed after durable admission", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const withSubtitles = async () => ({ ...(await compatibleOutputProbe("synthetic")), streams: [...(await compatibleOutputProbe("synthetic")).streams,
    { index: 2, kind: "subtitle" as const, codecName: "dvd_subtitle", language: "eng", title: null, default: false, forced: false }] });
  const seeded = await requestSyntheticRendition(fixture, false, { probe: withSubtitles });
  expect(seeded.request).toMatchObject({ conversion: { copiedStreamIndexes: [0, 1], omittedStreamIndexes: [2], subtitles: "omitted" } });
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true, generator });
    expect((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result).toMatchObject({ status: "failed", reason: { code: "RENDITION_SOURCE_CHANGED" }, media: null });
  } finally { access.close(); }
});
