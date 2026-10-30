import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openBrowserRendition, probeEncodeOutputMedia } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../operator-cli/src/operator-workflow.test-support.js";
import { requestSyntheticRendition } from "../../operator-cli/src/encode-output-rendition.test-support.js";
import { pollBrowserRenditions } from "../src/browser-rendition-worker.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
// A separate required media gate. Default focused tests inject the process seam.
it.skipIf(process.env.RIP_DVD_TEST_RENDITION_MEDIA !== "true").each([false, true])("remuxes actual H264/AAC synthetic canonical media, preserves failure=%s, and decodes audio and a seek", async (failed) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const source = join(fixture.operatorHostPath, "synthetic-source.mkv");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-profile:a", "aac_low", source]);
  const seeded = await requestSyntheticRendition(fixture, failed, { probe: probeEncodeOutputMedia, canonicalBytes: await readFile(source) });
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true });
    const result = await fixture.run(["encode-output", "inspect-rendition", seeded.request.id]);
    expect(result.result).toMatchObject({ status: "complete", conversion: { kind: "stream_copy_remux" }, source: { state: failed ? "validation_failed" : "published" } });
    const opened = await openBrowserRendition(access, seeded.request.id, true);
    try {
      const mp4 = await opened.file.readFile();
      expect(mp4.indexOf(Buffer.from("moov"))).toBeLessThan(mp4.indexOf(Buffer.from("mdat")));
    } finally { await opened.file.close(); }
    const mediaPath = access.browserRenditions.find(seeded.request.id)!.media!.path;
    const inspection = await probeEncodeOutputMedia(mediaPath);
    expect(inspection.streams.map((stream) => stream.codecName)).toEqual(["h264", "aac"]);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", "1.5", "-i", mediaPath, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", mediaPath, "-map", "0:a:0", "-f", "null", "-"], { stdio: "ignore" });
  } finally { access.close(); }
});

it.skipIf(process.env.RIP_DVD_TEST_RENDITION_MEDIA !== "true")("a surviving remux keeps its kernel execution lock after its parent dies", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { inspectKernelProcessLock } = await import("@rip-dvd/worker-runtime");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const lockDirectory = join(fixture.mediaLibraryPath, ".native-lock-test");
  await mkdir(lockDirectory, { mode: 0o700 });
  const lockPath = join(lockDirectory, "execution.lock");
  const output = join(lockDirectory, "synthetic.mp4");
  const runtime = new URL("../../../packages/worker-runtime/dist/index.js", import.meta.url).href;
  const script = `import { spawn } from 'node:child_process';
    import { acquireKernelProcessLock } from ${JSON.stringify(runtime)};
    const lock = acquireKernelProcessLock(process.argv[1]);
    const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', process.argv[2]], { stdio: ['ignore', 'ignore', 'ignore', lock.descriptor] });
    child.on('spawn', () => process.stdout.write(String(child.pid) + '\\n'));
    setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath, output], { stdio: ["ignore", "pipe", "pipe"] });
  let childPid: number | undefined;
  try {
    const message = await new Promise<Buffer>((resolve, reject) => {
      parent.stdout!.once("data", resolve); parent.once("error", reject);
      parent.once("exit", () => reject(new Error("Synthetic remux parent exited before progress.")));
    });
    childPid = Number(String(message).trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);
    // Wait until ffmpeg has opened its output, so the proof covers live writes.
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await readFile(output)).length > 0) break; } catch { /* output not open yet */ }
      await delay(25);
    }
    const closed = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    parent.kill("SIGKILL"); await closed;
    expect(inspectKernelProcessLock(lockPath)).toBe("held");
    for (let attempt = 0; attempt < 160 && inspectKernelProcessLock(lockPath) === "held"; attempt++) await delay(25);
    expect(inspectKernelProcessLock(lockPath)).toBe("inactive");
  } finally {
    parent.kill("SIGKILL");
    for (let attempt = 0; attempt < 160 && inspectKernelProcessLock(lockPath) === "held"; attempt++) await delay(25);
  }
});

it.skipIf(process.env.RIP_DVD_TEST_RENDITION_MEDIA !== "true").each([
  ["incompatible", undefined], ["audio_conversion", undefined], ["video_format", undefined],
  ["subtitles", undefined], ["subtitles", 2], ["subtitles", 3],
] as const)("converts real %s media with burned stream %s, preserves canonical bytes and verifies subtitle pixels", async (variant, burnSubtitleIndex) => {
  const { createSyntheticViewingSource } = await import("./browser-rendition-media.test-support.js");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const source = createSyntheticViewingSource(fixture.operatorHostPath, variant);
  const canonicalBytes = await readFile(source);
  const seeded = await requestSyntheticRendition(fixture, true, { probe: probeEncodeOutputMedia, canonicalBytes, burnSubtitleIndex });
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true });
    const inspected = await fixture.run(["encode-output", "inspect-rendition", seeded.request.id]);
    expect(inspected).toMatchObject({ exitCode: 0, result: { status: "complete", source: { state: "validation_failed", encodeJob: { status: "failed" } }, conversion: { kind: "h264_aac_transcode", subtitles: burnSubtitleIndex === undefined ? variant === "subtitles" ? "omitted" : "none" : "burned_in" } } });
    const record = access.browserRenditions.find(seeded.request.id)!;
    const mediaPath = record.media!.path;
    const output = await probeEncodeOutputMedia(mediaPath);
    expect(output.streams.map((stream) => stream.codecName)).toEqual(["h264", "aac"]);
    const audioProbe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=channels", "-of", "json", mediaPath], { encoding: "utf8" })) as { streams: { channels: number }[] };
    // These synthetic sources are mono. Copy preserves mono; conversion emits stereo.
    expect(audioProbe.streams.map((stream) => stream.channels)).toEqual([variant === "video_format" ? 1 : 2]);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", "1.5", "-i", mediaPath, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { stdio: "pipe" });
    const audio = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", mediaPath, "-map", "0:a:0", "-f", "s16le", "-"], { maxBuffer: 2_000_000 });
    expect(audio.some((byte) => byte !== 0)).toBe(true);
    const frame = (at: string) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", at, "-i", mediaPath, "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
    // Black video makes a burned caption an independently observable claim.
    const visible = frame("1.5"), before = frame("0.1"), after = frame("2.8");
    expect(Math.max(...before)).toBeLessThan(30); expect(Math.max(...after)).toBeLessThan(30);
    if (burnSubtitleIndex === undefined) expect(Math.max(...visible)).toBeLessThan(30);
    if (burnSubtitleIndex !== undefined) expect(Math.max(...visible)).toBeGreaterThan(180);
    const exported = await fixture.run(["encode-output", "export", seeded.identity, "--destination", join(fixture.operatorHostPath, "canonical-copy.mkv")]);
    expect(exported.exitCode).toBe(0);
    expect(await readFile(join(fixture.operatorHostPath, "canonical-copy.mkv"))).toEqual(canonicalBytes);
  } finally { access.close(); }
});

it.skipIf(process.env.RIP_DVD_TEST_RENDITION_MEDIA !== "true")("records an actual failed conversion process without publishing media", async () => {
  const { createSyntheticViewingSource } = await import("./browser-rendition-media.test-support.js");
  const { createBrowserRenditionGenerator, runRenditionCommand } = await import("../src/browser-rendition-generator.js");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const source = createSyntheticViewingSource(fixture.operatorHostPath, "incompatible");
  const seeded = await requestSyntheticRendition(fixture, true, { probe: probeEncodeOutputMedia, canonicalBytes: await readFile(source) });
  const access = fixture.openAccess();
  try {
    await pollBrowserRenditions({ access, mediaLibraryPath: fixture.mediaLibraryPath, signal: new AbortController().signal, enabled: true,
      generator: { ...createBrowserRenditionGenerator(), async generate(input) {
        await runRenditionCommand("ffmpeg", ["-nostdin", "-v", "error", "-i", input.source, "-c:v", "synthetic-missing-encoder", input.destination], input.signal, input.executionDescriptor);
      } } });
    expect((await fixture.run(["encode-output", "inspect-rendition", seeded.request.id])).result).toMatchObject({ status: "failed", media: null, reason: { code: "RENDITION_CONVERSION_FAILED" } });
    await expect(openBrowserRendition(access, seeded.request.id, true)).rejects.toMatchObject({ code: "RENDITION_MEDIA_UNAVAILABLE" });
  } finally { access.close(); }
});
