import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openBrowserRendition, probeEncodeOutputMedia } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { requestSyntheticPreviewRendition } from "../../operator-cli/src/damage-preview-rendition.test-support.js";
import { advanceCommittedArchiveEvidence } from "../../operator-cli/src/archive-evidence.test-support.js";
import { createSyntheticViewingSource } from "./browser-rendition-media.test-support.js";
import { pollBrowserRenditions } from "../src/browser-rendition-worker.js";
import { createBrowserRenditionGenerator, runRenditionCommand } from "../src/browser-rendition-generator.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
it.skipIf(process.env.RIP_DVD_TEST_PREVIEW_RENDITION_MEDIA !== "true").each([
  ["compatible", undefined, "complete", 3], ["incompatible", undefined, "partial", 3],
  ["audio_conversion", undefined, "complete", 3], ["subtitles", undefined, "complete", 3],
  ["subtitles", 2, "partial", 3], ["subtitles", 3, "complete", 3], ["compatible", undefined, "complete", 130],
] as const)("renders real preview %s burn=%s state=%s length=%ss with audible audio, actual seek and canonical independence", async (variant, burnSubtitleIndex, generationStatus, durationSeconds) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const source = createSyntheticViewingSource(fixture.operatorHostPath, variant, durationSeconds);
  const canonicalBytes = readFileSync(source);
  const seeded = await requestSyntheticPreviewRendition(fixture, { probe: probeEncodeOutputMedia, canonicalBytes, burnSubtitleIndex, generationStatus, durationMilliseconds: durationSeconds * 1000 });
  advanceCommittedArchiveEvidence(fixture, seeded.seeded.manifest);
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true });
    expect(await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).toMatchObject({ exitCode: 0, result: { status: "complete", source: { kind: "damage_preview", identity: seeded.identity, generationStatus, coverage: { startMilliseconds: 1000, endMilliseconds: 1000 + durationSeconds * 1000 } }, previewCondition: { generationStatus, outdated: true } } });
    const record = access.browserRenditions.find(seeded.request.id)!;
    const path = record.media!.path;
    const media = await probeEncodeOutputMedia(path);
    expect(media.streams.map((stream) => stream.codecName)).toEqual(["h264", "aac"]);
    expect(Math.abs(media.durationSeconds! - durationSeconds)).toBeLessThanOrEqual(0.25);
    const audio = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-t", "1", "-map", "0:a:0", "-f", "s16le", "-"]);
    expect(audio.some((byte) => byte !== 0)).toBe(true);
    const frame = (at: number) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(at), "-i", path, "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
    expect(frame(durationSeconds - 0.5).length).toBeGreaterThan(0);
    const visible = frame(1.5);
    expect(Math.max(...frame(0.1))).toBeLessThan(30); expect(Math.max(...frame(2.8))).toBeLessThan(30);
    if (burnSubtitleIndex === undefined) expect(Math.max(...visible)).toBeLessThan(30);
    else expect(Math.max(...visible)).toBeGreaterThan(180);
    const destination = join(fixture.operatorHostPath, "canonical-export.mkv");
    expect(await fixture.run(["damage-preview", "export", seeded.identity, "--destination", destination])).toMatchObject({ exitCode: 0 });
    expect(readFileSync(destination).equals(canonicalBytes)).toBe(true);
  } finally { access.close(); }
});
it.skipIf(process.env.RIP_DVD_TEST_PREVIEW_RENDITION_MEDIA !== "true")("reports a real preview conversion process failure without playable media", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const source = createSyntheticViewingSource(fixture.operatorHostPath, "incompatible");
  const seeded = await requestSyntheticPreviewRendition(fixture, { probe: probeEncodeOutputMedia, canonicalBytes: readFileSync(source), durationMilliseconds: 3000 });
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true,
      generator: { ...createBrowserRenditionGenerator(), async generate(input) {
        await runRenditionCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", input.source, "-c:v", "synthetic-missing-encoder", input.destination], input.signal, input.executionDescriptor);
      } } });
    expect(await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id])).toMatchObject({ exitCode: 0, result: { status: "failed", media: null, reason: { code: "RENDITION_CONVERSION_FAILED" } } });
    await expect(openBrowserRendition(access, seeded.request.id, true)).rejects.toMatchObject({ code: "RENDITION_MEDIA_UNAVAILABLE" });
  } finally { access.close(); }
});
