import { afterEach, expect, it } from "vitest";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import type { DamagePreviewRecreationReview, DamagePreviewInspection } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedRetainedDamagePreview, settleDamagePreviewMedia } from "../../../../../../operator-cli/src/damage-preview.test-support.js";
import { pollDamagePreviews } from "../../../../../../encode-worker/src/damage-preview-worker.js";
import { media } from "../../../../../../encode-worker/src/damage-preview.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("records current generation tools and material differences without rewriting failure or media-removal history", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, inspect } = await seedRetainedDamagePreview(fixture);
  const worker = fixture.openAccess();
  const failed = worker.damagePreviews.find(id)!;
  failed.status = "failed"; failed.reason = { code: "SYNTHETIC_FAILURE", message: "Synthetic generation failed." };
  failed.toolVersions = { handbrake: "synthetic-older-handbrake" };
  worker.damagePreviews.update(failed);
  worker.close();
  const original = await inspect();
  await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-failed-media-delete", "--json", JSON.stringify({ mediaToken: original.media.token })]);
  settleDamagePreviewMedia(fixture);
  const removed = await inspect();
  expect(removed.media.state).toBe("removed");
  const review = (await fixture.run(["damage-preview", "recreate", id])).result as DamagePreviewRecreationReview;
  const submitted = await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-new-tools", "--json", JSON.stringify({ mode: "exact", recreationToken: review.recreationToken, preflightToken: review.preflight.preflightToken })]);
  expect(submitted.exitCode).toBe(0);
  const access = fixture.openAccess();
  try {
    await pollDamagePreviews({ access, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, generator: media(), ownership: createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }) });
    const result = (await fixture.run(["damage-preview", "inspect", (submitted.result as { id: string }).id])).result;
    expect(result).toMatchObject({ generationStatus: "complete", provenance: { toolVersions: { handbrake: "synthetic-handbrake-v1", ffprobe: "synthetic-probe-v1" } }, recreation: { sourceRequestId: id, mode: "exact", generationComparison: "recorded", generationDifferences: expect.arrayContaining([{ field: "toolVersions", before: { handbrake: "synthetic-older-handbrake" }, after: { handbrake: "synthetic-handbrake-v1", ffprobe: "synthetic-probe-v1" } }]) } });
    expect(await inspect()).toEqual(removed);
  } finally { access.close(); }
});

it.each([false, true])("reports changed resolved generation flags with identical tools, ignoring new output paths, changed: %s", async (changed) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, seeded } = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  try {
    const original = access.damagePreviews.find(id)!;
    original.toolVersions = { handbrake: "synthetic-handbrake-v1", ffprobe: "synthetic-probe-v1" };
    original.streamMapping = { policyVersion: "dvd-preview-stream-map-v1", audio: [{ sourceId: 128, physicalId: 128, trackNumber: 1, codec: "ac3", channels: 2 }], subtitles: [] };
    original.deviations = ["The sample uses explicit title-time boundaries instead of the complete playback selection."];
    original.commands = [[0, 45], [66, 339]].map(([start, duration], index) => ["rip-dvd-handbrake", "--no-dvdnav", "--title", "1", "--angle", "1", "-i", seeded.archive.archivePath, "-o", `${fixture.mediaLibraryPath}/.damage-previews/${id}/${index}.partial.mkv`, "--format", "av_mkv", "--preset", "Fast 1080p30", "--audio", "1", "--subtitle", "none", "--subtitle-burned=none", "--start-at", `seconds:${start}`, "--stop-at", `seconds:${duration}`, ...(changed ? ["--decomb"] : [])]);
    access.damagePreviews.update(original);
    const review = (await fixture.run(["damage-preview", "recreate", id])).result as DamagePreviewRecreationReview;
    const requested = await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-command-difference", "--json", JSON.stringify({ mode: "exact", recreationToken: review.recreationToken, preflightToken: review.preflight.preflightToken })]);
    expect(requested.exitCode).toBe(0);
    await pollDamagePreviews({ access, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, generator: media(), ownership: createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }) });
    const inspected = (await fixture.run(["damage-preview", "inspect", (requested.result as { id: string }).id])).result as DamagePreviewInspection;
    expect(inspected.generationStatus).toBe("complete");
    const differences = inspected.recreation!.generationDifferences;
    if (changed) expect(differences).toEqual([{ field: "resolvedCommands", before: expect.arrayContaining([expect.arrayContaining(["--decomb"])]), after: expect.any(Array) }]);
    else expect(differences).toEqual([]);
  } finally { access.close(); }
});

it.each(["HandBrake 1.9.2", "HandBrake 1.10.0"])("compares retained HandBrake version identities without rewriting historical diagnostics: %s", async (version) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, inspect } = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  try {
    const original = access.damagePreviews.find(id)!;
    original.toolVersions = { handbrake: "HandBrake 1.9.2\n[01:02:03] hb_init: starting libhb thread\n[01:02:03] thread abc123 started (\"libhb\")\nHandBrake has exited.", ffprobe: "synthetic-probe-v1" };
    access.damagePreviews.update(original);
    const history = await inspect();
    const review = (await fixture.run(["damage-preview", "recreate", id])).result as DamagePreviewRecreationReview;
    const requested = await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-retained-tool-version", "--json", JSON.stringify({ mode: "exact", recreationToken: review.recreationToken, preflightToken: review.preflight.preflightToken })]);
    expect(requested.exitCode).toBe(0);
    await pollDamagePreviews({ access, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal,
      generator: { ...media(), async versions() { return { handbrake: version, ffprobe: "synthetic-probe-v1" }; } }, ownership: createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }) });
    const inspected = (await fixture.run(["damage-preview", "inspect", (requested.result as { id: string }).id])).result as DamagePreviewInspection;
    expect(inspected.generationStatus).toBe("complete");
    const tools = inspected.recreation!.generationDifferences.filter((difference) => difference.field === "toolVersions");
    expect(tools).toEqual(version === "HandBrake 1.9.2" ? [] : [{ field: "toolVersions", before: original.toolVersions, after: { handbrake: version, ffprobe: "synthetic-probe-v1" } }]);
    expect(await inspect()).toEqual(history);
  } finally { access.close(); }
});
