import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedDamagePreview } from "./damage-preview.test-support.js";
import { advanceCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import type { DamagePreviewAvailability } from "@rip-dvd/application";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("reviews an unmapped title with exact provenance, grouped markers and uncapped duration through JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture);
  const before = await fixture.run(["catalog-review", "show", seeded.archive.id]);
  const response = await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)]);
  expect(response.exitCode).toBe(0);
  expect(response.result).toMatchObject({
    available: false,
    blockingReasons: expect.arrayContaining([{ code: "DAMAGE_PREVIEW_GENERATION_UNAVAILABLE", message: expect.any(String) }]),
    preflightToken: expect.stringMatching(/^damage-preview-preflight:[a-f0-9]{64}$/),
    reviewedRequest: {
      checkpoint: { manifestId: seeded.manifest.id, manifestRevision: 1, manifestDigest: seeded.manifest.manifestDigest },
      title: { titleIdentityId: seeded.observation.titleIdentityId, observationId: seeded.observation.id, angleNumber: 1, chapterStart: 1, chapterEnd: 4 },
      assessmentIdentity: seeded.assessment!.id,
      context: { beforeMilliseconds: 5_000, afterMilliseconds: 5_000 },
      streams: seeded.input.streams,
      encodingProfile: { id: seeded.profile.id, version: 1, settings: seeded.profile.settings },
    },
    groups: [
      { markerIndexes: [0, 1], startMilliseconds: 1_000, endMilliseconds: 40_000 },
      { markerIndexes: [2], startMilliseconds: 71_000, endMilliseconds: 400_000 },
    ],
    clips: [
      { startMilliseconds: 0, endMilliseconds: 45_000 },
      { startMilliseconds: 66_000, endMilliseconds: 405_000 },
    ],
    estimatedDurationMilliseconds: 384_000,
    estimatedStorageBytes: null,
    knownUnknowns: expect.arrayContaining([{ code: "STORAGE_ESTIMATE_UNKNOWN", message: expect.any(String) }]),
  });
  expect(await fixture.run(["catalog-review", "show", seeded.archive.id])).toEqual(before);
  expect(await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)])).toEqual(response);
});

it("bounds coarse sampling and offers ordinary playback without an invented unknown-timing seek", async () => {
  for (const coverage of ["whole_cell", "unknown"] as const) {
    const fixture = createOperatorWorkflowFixture();
    fixtures.push(fixture);
    const seeded = await seedDamagePreview(fixture, coverage);
    const review = async (input: unknown) => (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(input)])).result as DamagePreviewAvailability;
    const initial = await review(seeded.input);
    if (coverage === "whole_cell") {
      expect(initial.blockingReasons.map((reason) => reason.code)).toContain("COARSE_SAMPLING_WINDOW_REQUIRED");
      expect(initial.estimatedDurationMilliseconds).toBeNull();
      const sampled = await review({ ...seeded.input, intervalIndexes: [2], samplingWindow: { startMilliseconds: 100_000, endMilliseconds: 110_000 } });
      expect(sampled.uncertainSpans).toMatchObject([{ startMilliseconds: 71_000, endMilliseconds: 400_000, coverage: "whole_cell" }]);
      expect(sampled.clips).toEqual([{ startMilliseconds: 95_000, endMilliseconds: 115_000 }]);
      expect(sampled.estimatedDurationMilliseconds).toBe(20_000);
    } else {
      expect(initial.blockingReasons.map((reason) => reason.code)).toContain("DAMAGE_TIMING_UNKNOWN");
      expect(initial.clips).toEqual([]);
      expect(initial.ordinaryPlayback).toMatchObject({ identifiable: true, available: false, damageSeek: null });
      const ordinary = await review({ ...seeded.input, mode: "ordinary_playback", intervalIndexes: [] });
      expect(ordinary.clips).toEqual([seeded.input.playbackRange]);
      expect(ordinary.reviewedRequest?.assessmentIdentity).toBeNull();
      expect(ordinary.blockingReasons.map((reason) => reason.code)).not.toContain("DAMAGE_TIMING_UNKNOWN");
    }
  }
});

it("deduplicates overlapping context and binds changed selections, streams, profile, timing and checkpoint", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture);
  const review = async (input: unknown) => (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(input)])).result as DamagePreviewAvailability;
  const original = await review(seeded.input);
  const expanded = await review({ ...seeded.input, context: { beforeMilliseconds: 20_000, afterMilliseconds: 20_000 } });
  expect(expanded.groups).toHaveLength(2);
  expect(expanded.clips).toEqual([{ startMilliseconds: 0, endMilliseconds: 420_000 }]);
  expect(expanded.estimatedDurationMilliseconds).toBe(420_000);
  const clipped = await review({ ...seeded.input, playbackRange: { startMilliseconds: 2_000, endMilliseconds: 399_000 } });
  expect(clipped.clips).toEqual([{ startMilliseconds: 2_000, endMilliseconds: 45_000 }, { startMilliseconds: 66_000, endMilliseconds: 399_000 }]);
  for (const change of [
    { intervalIndexes: [1] },
    { streams: { audio: [2], subtitles: [0] } },
    { titleIdentityObservationId: "synthetic-missing-observation" },
    { encodingProfileId: "synthetic-missing-profile" },
  ]) expect((await review({ ...seeded.input, ...change })).preflightToken).not.toBe(original.preflightToken);
  advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  const stale = await review(seeded.input);
  expect(stale.current.checkpoint?.manifestRevision).toBe(2);
  expect(stale.preflightToken).not.toBe(original.preflightToken);
  expect(stale.blockingReasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["TITLE_IDENTITY_NOT_CURRENT", "TITLE_DAMAGE_ASSESSMENT_NOT_CURRENT"]));
  expect(stale.markers).toEqual([]);
});

it("rejects malformed selections and keeps discovery, legacy evidence and missing records explicit", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture);
  for (const input of [
    { ...seeded.input, unexpected: true },
    { ...seeded.input, playbackRange: { startMilliseconds: 10, endMilliseconds: 10 } },
    { ...seeded.input, intervalIndexes: [0, 0] },
    { ...seeded.input, context: { beforeMilliseconds: -1, afterMilliseconds: 0 } },
    { ...seeded.input, mode: "ordinary_playback" },
  ]) {
    const response = await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(input)]);
    expect(response).toMatchObject({ exitCode: 2, result: { error: { code: "INVALID_ARGUMENTS" } } });
  }
  const discovery = await fixture.run(["damage-preview", "availability", seeded.archive.id]);
  expect(discovery).toMatchObject({ exitCode: 0, result: { available: false, preflightToken: null, titles: [{ observationId: seeded.observation.id }] } });
  expect(await fixture.run(["damage-preview", "availability", "synthetic-missing-archive"])).toMatchObject({ exitCode: 2, result: { error: { code: "NOT_FOUND" } } });
  expect(await fixture.run(["damage-preview", "request", seeded.archive.id])).toMatchObject({ exitCode: 2 });
});

it("keeps mixed precise and coarse markers in one sampled clip and withholds incomplete total cost", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture, "mixed", [[1_000, 5_000], [20_000, 40_000]]);
  const input = { ...seeded.input, intervalIndexes: [0, 1], context: { beforeMilliseconds: 0, afterMilliseconds: 0 } };
  const review = async (selection: unknown) => (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(selection)])).result as DamagePreviewAvailability;
  expect((await review(input)).estimatedDurationMilliseconds).toBeNull();
  const sampled = await review({ ...input, samplingWindow: { startMilliseconds: 25_000, endMilliseconds: 30_000 } });
  expect(sampled.groups).toEqual([{ markerIndexes: [0, 1], startMilliseconds: 1_000, endMilliseconds: 40_000 }]);
  expect(sampled.clips).toEqual([{ startMilliseconds: 1_000, endMilliseconds: 30_000 }]);
  expect(sampled.estimatedDurationMilliseconds).toBe(29_000);
  expect(sampled.uncertainSpans).toMatchObject([{ startMilliseconds: 20_000, endMilliseconds: 40_000 }]);
});

it("preserves overlapping occurrence markers without double counting their duration", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture, "source_span", [[1_000, 5_000], [3_000, 7_000], [37_000, 40_000], [71_000, 75_000]]);
  const result = await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify({ ...seeded.input, intervalIndexes: [0, 1, 2, 3], context: { beforeMilliseconds: 0, afterMilliseconds: 0 } })]);
  expect(result).toMatchObject({ exitCode: 0, result: {
    markers: [{ playbackOccurrence: 1 }, { playbackOccurrence: 2 }, { playbackOccurrence: 3 }, { playbackOccurrence: 4 }],
    groups: [{ markerIndexes: [0, 1, 2], startMilliseconds: 1_000, endMilliseconds: 40_000 }, { markerIndexes: [3], startMilliseconds: 71_000, endMilliseconds: 75_000 }],
    clips: [{ startMilliseconds: 1_000, endMilliseconds: 40_000 }, { startMilliseconds: 71_000, endMilliseconds: 75_000 }],
    estimatedDurationMilliseconds: 43_000,
  } });
});
