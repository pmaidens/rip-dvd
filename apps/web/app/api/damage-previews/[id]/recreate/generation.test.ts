import { afterEach, expect, it } from "vitest";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import type { DamagePreviewRecreationReview } from "@rip-dvd/application";
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
