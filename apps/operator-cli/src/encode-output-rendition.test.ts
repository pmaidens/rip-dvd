import { afterEach, expect, it } from "vitest";
import { encodeOutputArtifactIdentity } from "@rip-dvd/application";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 10, streams: [
  { index: 0, kind: "video" as const, codecName: "h264", profile: "High", pixelFormat: "yuv420p", level: 41, language: null, title: null, default: true, forced: false },
  { index: 1, kind: "audio" as const, codecName: "aac", profile: "LC", language: "eng", title: null, default: true, forced: false },
] });

it("requests a distinct durable rendition through the public CLI and replays the original admission", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic H264 AAC output" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const options = { encodeOutputMediaProbe: probe, browserRenditionsEnabled: true };
  const availability = await fixture.run(["encode-output", "rendition-availability", identity], undefined, undefined, options);
  expect(availability.exitCode).toBe(0);
  expect(availability.result).toMatchObject({ available: true, source: { identity, type: "canonical_encode_output" } });
  const reviewToken = (availability.result as { reviewToken: string }).reviewToken;
  const args = ["encode-output", "request-rendition", identity, "--key", "synthetic-rendition-request", "--json", JSON.stringify({ reviewToken })];
  const requested = await fixture.run(args, undefined, undefined, options);
  expect(requested.exitCode).toBe(0);
  expect(requested.result).toMatchObject({ status: "queued", source: { identity }, conversion: { kind: "stream_copy_remux", container: "mp4" } });
  expect((await fixture.run(args)).result).toEqual(requested.result);
  const id = (requested.result as { id: string }).id;
  expect((await fixture.run(["encode-output", "inspect-rendition", id])).result).toEqual(requested.result);
  const conflict = await fixture.run([...args.slice(0, -1), JSON.stringify({ reviewToken: "a".repeat(64) })], undefined, undefined, options);
  expect(conflict.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});

it.each([
  ["probe", "OUTPUT_PROBE_FAILED"], ["video", "RENDITION_VIDEO_CODEC_UNSUPPORTED"],
  ["format", "RENDITION_VIDEO_FORMAT_UNSUPPORTED"], ["audio", "RENDITION_AUDIO_CODEC_UNSUPPORTED"], ["disabled", "BROWSER_RENDITIONS_DISABLED"],
])("keeps %s specifically unavailable without admitting work", async (variant, reason) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic unavailable output" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const mediaProbe = async () => {
    if (variant === "probe") throw new Error("Synthetic probe failure");
    const result = await probe();
    if (variant === "video") result.streams[0]!.codecName = "hevc";
    if (variant === "format") result.streams[0]!.pixelFormat = "yuv420p10le";
    if (variant === "audio") result.streams[1]!.codecName = "ac3";
    return result;
  };
  const options = { encodeOutputMediaProbe: mediaProbe, browserRenditionsEnabled: variant !== "disabled" };
  const available = await fixture.run(["encode-output", "rendition-availability", identity], undefined, undefined, options);
  expect(available.exitCode).toBe(0);
  if (variant === "probe") expect(available.result).toMatchObject({ source: { media: { streams: null } }, conversion: { copiedStreamIndexes: null, omittedStreamIndexes: null, subtitles: "unknown" } });
  expect(available.result).toMatchObject({ available: false, reasons: expect.arrayContaining([{ code: reason, message: expect.any(String) }]) });
  const reviewToken = (available.result as { reviewToken: string }).reviewToken;
  const rejected = await fixture.run(["encode-output", "request-rendition", identity, "--key", "synthetic-unavailable-request", "--json", JSON.stringify({ reviewToken })], undefined, undefined, options);
  expect(rejected.result).toMatchObject({ error: { code: reason } });
  expect((await fixture.run(["readiness"])).result).toMatchObject({ activeWork: [] });
});

it("rejects stale reviewed streams and allows retry with the same uncommitted key", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic stale output" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const options = { encodeOutputMediaProbe: probe, browserRenditionsEnabled: true };
  const reviewed = (await fixture.run(["encode-output", "rendition-availability", identity], undefined, undefined, options)).result as { reviewToken: string };
  const args = ["encode-output", "request-rendition", identity, "--key", "synthetic-stale-request", "--json", JSON.stringify({ reviewToken: reviewed.reviewToken })];
  const changedProbe = async () => ({ ...(await probe()), durationSeconds: 11 });
  const stale = await fixture.run(args, undefined, undefined, { ...options, encodeOutputMediaProbe: changedProbe });
  expect(stale.result).toMatchObject({ error: { code: "RENDITION_REVIEW_STALE", current: { current: { fileIdentity: expect.any(String), authorityRevision: expect.any(String) } } } });
  expect((await fixture.run(args, undefined, undefined, options)).result).toMatchObject({ status: "queued" });
});
