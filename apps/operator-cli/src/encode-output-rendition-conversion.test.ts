import { afterEach, expect, it } from "vitest";
import type { BrowserRenditionAvailability } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { compatibleOutputProbe, incompatibleOutputProbe, subtitleOutputProbe, requestSyntheticRendition } from "./encode-output-rendition.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("admits probed incompatible streams with durable codec and format differences through the public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticRendition(fixture, true, { probe: incompatibleOutputProbe });
  expect(seeded.review).toMatchObject({ available: true, conversion: { kind: "h264_aac_transcode", copiedStreamIndexes: [],
    streams: [
      { sourceIndex: 0, outputIndex: 0, sourceCodec: "mpeg2video", codec: "h264", mode: "transcode" },
      { sourceIndex: 1, outputIndex: 1, sourceCodec: "ac3", codec: "aac", mode: "transcode", language: "eng" },
    ] } });
  const inspected = await fixture.run(["encode-output", "inspect-rendition", seeded.request.id]);
  expect(inspected.result).toEqual(seeded.request);
  expect((await fixture.run(seeded.args)).result).toEqual(seeded.request);
  expect(seeded.request.source).toMatchObject({ identity: seeded.identity, state: "validation_failed", encodeJob: { status: "failed" } });
});

it("binds one selected burned subtitle to review and replay while preserving a separate subtitle-free rendition", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const plain = await requestSyntheticRendition(fixture, false, { probe: subtitleOutputProbe });
  expect(plain.request.conversion).toMatchObject({ subtitles: "omitted", omittedStreamIndexes: [2, 3], burnedSubtitle: null });
  const options = { encodeOutputMediaProbe: subtitleOutputProbe, browserRenditionsEnabled: true };
  const available = await fixture.run(["encode-output", "rendition-availability", plain.identity, "--json", JSON.stringify({ burnSubtitleIndex: 2 })], undefined, undefined, options);
  const review = available.result as BrowserRenditionAvailability;
  expect(review).toMatchObject({ available: true, conversion: { subtitles: "burned_in", omittedStreamIndexes: [3], burnedSubtitle: { sourceIndex: 2, codecName: "dvd_subtitle", language: "eng" } } });
  expect(review.reviewToken).not.toBe(plain.review.reviewToken);
  const args = ["encode-output", "request-rendition", plain.identity, "--key", "synthetic-burned-request", "--json", JSON.stringify({ reviewToken: review.reviewToken, burnSubtitleIndex: 2 })];
  const burned = await fixture.run(args, undefined, undefined, options);
  expect(burned).toMatchObject({ exitCode: 0, result: { status: "queued", conversion: review.conversion } });
  expect((burned.result as { id: string }).id).not.toBe(plain.request.id);
  expect((await fixture.run(args)).result).toEqual(burned.result);
  expect((await fixture.run([...args.slice(0, -1), JSON.stringify({ reviewToken: review.reviewToken, burnSubtitleIndex: 3 })], undefined, undefined, options)).result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
  expect((await fixture.run(["encode-output", "inspect-rendition", plain.request.id])).result).toEqual(plain.request);
  const stale = await fixture.run(["encode-output", "request-rendition", plain.identity, "--key", "synthetic-wrong-burn-review", "--json", JSON.stringify({ reviewToken: plain.review.reviewToken, burnSubtitleIndex: 2 })], undefined, undefined, options);
  expect(stale.result).toMatchObject({ error: { code: "RENDITION_REVIEW_STALE" } });
});
it.each([-1, 1.5, "2", null, 9007199254740992])("rejects invalid subtitle selection %s before admission", async (burnSubtitleIndex) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const result = await fixture.run(["encode-output", "rendition-availability", "synthetic", "--json", JSON.stringify({ burnSubtitleIndex })]);
  expect(result).toMatchObject({ exitCode: 2, result: { error: { code: "INVALID_ARGUMENTS" } } });
});
it("reports absent or unsupported selected subtitles without admitting work", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticRendition(fixture, false, { probe: subtitleOutputProbe });
  for (const [index, codec, reason] of [[1, "dvd_subtitle", "RENDITION_SUBTITLE_NOT_FOUND"], [2, "unknown", "RENDITION_SUBTITLE_CODEC_UNSUPPORTED"]] as const) {
    const probe = async () => { const media = await subtitleOutputProbe("synthetic"); media.streams[2]!.codecName = codec; return media; };
    const options = { encodeOutputMediaProbe: probe, browserRenditionsEnabled: true };
    const selection = { burnSubtitleIndex: index };
    const review = (await fixture.run(["encode-output", "rendition-availability", seeded.identity, "--json", JSON.stringify(selection)], undefined, undefined, options)).result as BrowserRenditionAvailability;
    expect(review).toMatchObject({ available: false, reasons: [{ code: reason }] });
    expect((await fixture.run(["encode-output", "request-rendition", seeded.identity, "--key", `synthetic-unavailable-subtitle-${index}`, "--json", JSON.stringify({ reviewToken: review.reviewToken, ...selection })], undefined, undefined, options)).result).toMatchObject({ error: { code: reason } });
  }
});

it.each(["audio", "video", "format", "silent", "burn_only"])("copies compatible streams independently when planning %s conversion", async (variant) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const probe = async () => {
    const media = await compatibleOutputProbe("synthetic");
    if (variant === "audio") media.streams[1]!.codecName = "ac3";
    if (variant === "video") media.streams[0]!.codecName = "hevc";
    if (variant === "format") media.streams[0]!.pixelFormat = "yuv420p10le";
    if (variant === "silent") media.streams = media.streams.filter((stream) => stream.kind === "video");
    if (variant === "burn_only") media.streams.push(...(await subtitleOutputProbe("synthetic")).streams.filter((stream) => stream.kind === "subtitle"));
    return media;
  };
  const seeded = await requestSyntheticRendition(fixture, false, { probe, ...(variant === "burn_only" ? { burnSubtitleIndex: 2 } : {}) });
  expect(seeded.review).toMatchObject({ available: true, conversion: { kind: variant === "silent" ? "stream_copy_remux" : "h264_aac_transcode",
    copiedStreamIndexes: variant === "audio" || variant === "silent" ? [0] : [1] } });
  if (variant === "silent") expect(seeded.request.conversion.streams?.filter((stream) => stream.kind === "audio")).toEqual([]);
});
