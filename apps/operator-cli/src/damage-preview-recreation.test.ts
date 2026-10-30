import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DamagePreviewRecreationReview } from "@rip-dvd/application";
import { afterEach, expect, it } from "vitest";
import { advanceCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedRetainedDamagePreview, settleDamagePreviewMedia } from "./damage-preview.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("reviews exact recreation after media removal without changing the original history", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, inspect, path } = await seedRetainedDamagePreview(fixture);
  const original = await inspect();
  await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-recreation-delete", "--json", JSON.stringify({ mediaToken: original.media.token })]);
  settleDamagePreviewMedia(fixture);
  const removed = await inspect();
  expect(existsSync(path)).toBe(false);
  expect(removed.media.state).toBe("removed");
  const reviewed = await fixture.run(["damage-preview", "recreate", id]);
  expect(reviewed).toMatchObject({ exitCode: 0, result: { sourceRequestId: id, exact: { available: true, reasons: [] }, differences: [], warning: expect.stringContaining("byte-identical") } });
  expect(await inspect()).toEqual(removed);
  const access = fixture.openAccess();
  try { expect(access.damagePreviews.list()).toHaveLength(1); } finally { access.close(); }
});

it("creates a new exact linked request, replays admission after source changes and conflicts on changed intent", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, inspect, seeded } = await seedRetainedDamagePreview(fixture);
  const original = await inspect();
  const reviewed = (await fixture.run(["damage-preview", "recreate", id])).result as { recreationToken: string; preflight: { preflightToken: string } };
  const input = { mode: "exact", recreationToken: reviewed.recreationToken, preflightToken: reviewed.preflight.preflightToken };
  const args = ["damage-preview", "recreate", id, "--key", "synthetic-exact-recreation", "--json", JSON.stringify(input)];
  const requested = await fixture.run(args);
  expect(requested).toMatchObject({ exitCode: 0, result: { id: expect.not.stringMatching(id), generationStatus: "queued", recreation: { sourceRequestId: id, mode: "exact", differences: [], generationComparison: "pending" } } });
  expect(await inspect()).toEqual(original);
  advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  expect(await fixture.run(args)).toEqual(requested);
  expect(await fixture.run([...args.slice(0, -1), JSON.stringify({ ...input, mode: "current_revision", selection: seeded.input })])).toMatchObject({ exitCode: 2, result: { error: { code: "MUTATION_KEY_CONFLICT" } } });
  expect(await fixture.run([...args.slice(0, 4), "synthetic-stale-recreation", ...args.slice(5)])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_RECREATION_STALE" } } });
  const access = fixture.openAccess();
  try { expect(access.damagePreviews.list()).toHaveLength(2); } finally { access.close(); }
});

it("shows changed selections and requires an explicitly reviewed current-revision request", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, seeded, inspect } = await seedRetainedDamagePreview(fixture);
  const before = await inspect();
  const selection = { ...seeded.input, streams: { audio: [], subtitles: [] }, playbackRange: { startMilliseconds: 0, endMilliseconds: 450_000 } };
  const reviewed = (await fixture.run(["damage-preview", "recreate", id, "--json", JSON.stringify({ selection })])).result as { recreationToken: string; preflight: { preflightToken: string } };
  expect(reviewed).toMatchObject({ exact: { available: false, reasons: expect.arrayContaining([{ code: "DAMAGE_PREVIEW_RECREATION_INPUTS_CHANGED", message: expect.any(String) }]) }, differences: expect.arrayContaining([{ field: "streams", before: { audio: [128], subtitles: [] }, after: { audio: [], subtitles: [] } }]) });
  const input = { recreationToken: reviewed.recreationToken, preflightToken: reviewed.preflight.preflightToken };
  expect(await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-no-mode", "--json", JSON.stringify({ ...input, selection })])).toMatchObject({ exitCode: 2, result: { error: { code: "INVALID_ARGUMENTS" } } });
  expect(await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-current-recreation", "--json", JSON.stringify({ ...input, mode: "current_revision", selection })])).toMatchObject({ exitCode: 0, result: { recreation: { sourceRequestId: id, mode: "current_revision", differences: expect.arrayContaining([{ field: "streams", before: { audio: [128], subtitles: [] }, after: { audio: [], subtitles: [] } }]) } } });
  expect((await inspect()).provenance).toEqual(before.provenance);
});

it("reports missing old bytes and Title Identity after a new checkpoint, and never silently retargets", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, seeded } = await seedRetainedDamagePreview(fixture);
  advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  const review = (await fixture.run(["damage-preview", "recreate", id])).result as { recreationToken: string; preflight: { preflightToken: string } };
  expect(review).toMatchObject({ exact: { available: false, reasons: expect.arrayContaining([
    { code: "DAMAGE_PREVIEW_OLD_SOURCE_UNAVAILABLE", message: expect.any(String) },
    { code: "DAMAGE_PREVIEW_OLD_TITLE_IDENTITY_UNAVAILABLE", message: expect.any(String) },
  ]) } });
  expect(await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-unavailable-recreation", "--json", JSON.stringify({ mode: "exact", recreationToken: review.recreationToken, preflightToken: review.preflight.preflightToken })])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_EXACT_RECREATION_UNAVAILABLE", reasons: expect.arrayContaining([{ code: "DAMAGE_PREVIEW_OLD_SOURCE_UNAVAILABLE", message: expect.any(String) }]) } } });
  const access = fixture.openAccess();
  try { expect(access.damagePreviews.list()).toHaveLength(1); } finally { access.close(); }
});

it("reports missing source files and changed versioned settings as unavailable for exact recreation", async () => {
  for (const change of ["missing_source", "profile"] as const) {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const { id, seeded } = await seedRetainedDamagePreview(fixture);
    const selection = { ...seeded.input };
    if (change === "missing_source") unlinkSync(seeded.archive.archivePath);
    else {
      const access = fixture.openAccess();
      const profile = access.encodingProfiles.create({ key: "synthetic-replacement-settings", displayName: "Synthetic replacement settings", mediaDomain: "dvd_video", settings: { preset: "Fast 720p30", container: "mkv" } });
      selection.encodingProfileId = profile.id; access.close();
    }
    const result = await fixture.run(["damage-preview", "recreate", id, "--json", JSON.stringify({ selection })]);
    expect(result).toMatchObject({ exitCode: 0, result: { exact: { available: false } } });
    if (change === "missing_source") expect(result.result).toMatchObject({ exact: { reasons: expect.arrayContaining([{ code: "DAMAGE_PREVIEW_OLD_SOURCE_UNAVAILABLE", message: expect.any(String) }]) } });
    else expect(result.result).toMatchObject({ differences: expect.arrayContaining([{ field: "intendedSettings", before: expect.objectContaining({ settings: { preset: "Fast 1080p30", container: "mkv" } }), after: expect.objectContaining({ settings: { preset: "Fast 720p30", container: "mkv" } }) }]) });
  }
});

it("discovers recreation and accepts structured review and mutation inputs through stdin and file", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, seeded } = await seedRetainedDamagePreview(fixture);
  expect((await fixture.run(["help", "damage-preview"])).result).toMatchObject({ command: { usage: expect.stringContaining("recreate") } });
  const review = await fixture.run(["damage-preview", "recreate", id, "--stdin"], undefined, JSON.stringify({ selection: seeded.input }));
  const reviewed = review.result as DamagePreviewRecreationReview;
  const input = { mode: "exact", recreationToken: reviewed.recreationToken, preflightToken: reviewed.preflight.preflightToken };
  const path = join(fixture.operatorHostPath, "synthetic-recreation.json"); writeFileSync(path, JSON.stringify(input));
  expect(await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-file-recreation", "--file", path])).toMatchObject({ exitCode: 0, result: { recreation: { sourceRequestId: id } } });
});
