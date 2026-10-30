import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedRetainedDamagePreview } from "./damage-preview.test-support.js";
import { compatibleOutputProbe } from "./encode-output-rendition.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const options = { encodeOutputMediaProbe: compatibleOutputProbe, browserRenditionsEnabled: true };
it("requests and restores a separate preview rendition with canonical identity, revision and actual sample coverage", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const preview = await seedRetainedDamagePreview(fixture);
  const identity = `damage-preview-v1.${preview.id}.0`;
  const review = await fixture.run(["damage-preview", "rendition-availability", identity], undefined, undefined, options);
  expect(review).toMatchObject({ exitCode: 0, result: { available: true, source: { kind: "damage_preview", identity, requestId: preview.id,
    generationStatus: "complete", coverage: { startMilliseconds: 0, endMilliseconds: 45000 }, canonical: { mediaType: "video/x-matroska" } } } });
  const token = (review.result as { reviewToken: string }).reviewToken;
  const args = ["damage-preview", "request-rendition", identity, "--key", "synthetic-preview-rendition", "--json", JSON.stringify({ reviewToken: token })];
  const requested = await fixture.run(args, undefined, undefined, options);
  expect(requested).toMatchObject({ exitCode: 0, result: { status: "queued", source: { identity }, playback: { kind: "damage_preview_sample", watchability: "not_assessed" } } });
  const id = (requested.result as { id: string }).id;
  expect((await fixture.run(["damage-preview", "inspect-rendition", id])).result).toEqual(requested.result);
  expect((await fixture.run(args, undefined, undefined, options)).result).toEqual(requested.result);
  expect(JSON.stringify(requested.result)).not.toContain(fixture.mediaLibraryPath);
});

it("keeps partial and outdated conditions independent of conversion state and rejects a stale review without mutation", async () => {
  const { requestSyntheticPreviewRendition } = await import("./damage-preview-rendition.test-support.js");
  const { advanceCommittedArchiveEvidence } = await import("./archive-evidence.test-support.js");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture, { generationStatus: "partial" });
  advanceCommittedArchiveEvidence(fixture, seeded.seeded.manifest);
  const inspected = await fixture.run(["damage-preview", "inspect-rendition", seeded.request.id]);
  expect(inspected).toMatchObject({ exitCode: 0, result: { status: "queued", source: { generationStatus: "partial", provenance: seeded.review.source.provenance },
    previewCondition: { status: "outdated", generationStatus: "partial", outdated: true } } });
  const stale = await fixture.run(["damage-preview", "request-rendition", seeded.identity, "--key", "synthetic-preview-stale", "--json", JSON.stringify({ reviewToken: seeded.review.reviewToken })], undefined, undefined, options);
  expect(stale).toMatchObject({ exitCode: 2, result: { error: { code: "RENDITION_REVIEW_STALE", current: { previewCondition: { outdated: true } } } } });
  expect((await fixture.run(seeded.args, undefined, undefined, options)).result).toMatchObject({ id: seeded.request.id, status: "queued", previewCondition: { outdated: true } });
  const review = await fixture.run(["damage-preview", "rendition-availability", seeded.identity], undefined, undefined, options);
  expect(review).toMatchObject({ exitCode: 0, result: { available: true, previewCondition: { generationStatus: "partial", outdated: true } } });
});

it("shares conversion and selected subtitle plans, conflicts and explicit unavailable reasons", async () => {
  const { requestSyntheticPreviewRendition } = await import("./damage-preview-rendition.test-support.js");
  const { subtitleOutputProbe } = await import("./encode-output-rendition.test-support.js");
  const { unlinkSync } = await import("node:fs");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await requestSyntheticPreviewRendition(fixture, { probe: subtitleOutputProbe, burnSubtitleIndex: 2 });
  expect(seeded.request).toMatchObject({ conversion: { kind: "h264_aac_transcode", subtitles: "burned_in", burnedSubtitle: { sourceIndex: 2 }, omittedStreamIndexes: [3] } });
  expect(await fixture.run([...seeded.args.slice(0, -1), JSON.stringify({ reviewToken: seeded.review.reviewToken, burnSubtitleIndex: 3 })], undefined, undefined, seeded.cliOptions)).toMatchObject({ exitCode: 2, result: { error: { code: "MUTATION_KEY_CONFLICT" } } });
  expect(await fixture.run(["damage-preview", "rendition-availability", seeded.identity, "--json", '{"burnSubtitleIndex":99}'], undefined, undefined, seeded.cliOptions)).toMatchObject({ exitCode: 0, result: { available: false, reasons: [{ code: "RENDITION_SUBTITLE_NOT_FOUND" }] } });
  expect(await fixture.run(["damage-preview", "rendition-availability", seeded.identity], undefined, undefined, { ...options, encodeOutputMediaProbe: async () => { throw new Error("Synthetic probe failure"); } })).toMatchObject({ exitCode: 0, result: { available: false, source: { media: { streams: null } }, reasons: [{ code: "DAMAGE_PREVIEW_PROBE_FAILED" }] } });
  unlinkSync(seeded.path);
  expect(await fixture.run(["damage-preview", "rendition-availability", seeded.identity], undefined, undefined, options)).toMatchObject({ exitCode: 0, result: { available: false, reasons: [{ code: "DAMAGE_PREVIEW_MEDIA_MISSING" }] } });
  expect(await fixture.run(seeded.args, undefined, undefined, seeded.cliOptions)).toMatchObject({ exitCode: 0, result: { id: seeded.request.id } });
});

it("rejects a canonical file race at creation with current evidence and no partial admission", async () => {
  const { writeFileSync } = await import("node:fs");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const preview = await seedRetainedDamagePreview(fixture);
  const identity = `damage-preview-v1.${preview.id}.0`;
  const review = await fixture.run(["damage-preview", "rendition-availability", identity], undefined, undefined, options);
  const token = (review.result as { reviewToken: string }).reviewToken;
  const requested = await fixture.run(["damage-preview", "request-rendition", identity, "--key", "synthetic-creation-race", "--json", JSON.stringify({ reviewToken: token })], undefined, undefined, {
    ...options, openAccess() {
      const access = fixture.openAccess();
      return { ...access, browserRenditions: { ...access.browserRenditions, submit(input, prepare) {
        writeFileSync(preview.path, "synthetic changed canonical media");
        return access.browserRenditions.submit(input, prepare);
      } } };
    },
  });
  expect(requested).toMatchObject({ exitCode: 2, result: { error: { code: "RENDITION_REVIEW_STALE", current: { available: false, reasons: [{ code: "DAMAGE_PREVIEW_PROBE_FAILED" }] } } } });
  // Restoring the exact reviewed bytes permits a fresh request with the unused key.
  writeFileSync(preview.path, preview.bytes);
  const fresh = await fixture.run(["damage-preview", "rendition-availability", identity], undefined, undefined, options);
  expect(await fixture.run(["damage-preview", "request-rendition", identity, "--key", "synthetic-creation-race", "--json", JSON.stringify({ reviewToken: (fresh.result as { reviewToken: string }).reviewToken })], undefined, undefined, options)).toMatchObject({ exitCode: 0, result: { status: "queued" } });
});

it("lets canonical deletion win creation and keeps the failed creation key unused", async () => {
  const { createApplicationOperations } = await import("@rip-dvd/application");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const preview = await seedRetainedDamagePreview(fixture);
  const identity = `damage-preview-v1.${preview.id}.0`;
  const state = await preview.inspect();
  const review = await fixture.run(["damage-preview", "rendition-availability", identity], undefined, undefined, options);
  const args = ["damage-preview", "request-rendition", identity, "--key", "synthetic-deletion-creation-race", "--json", JSON.stringify({ reviewToken: (review.result as { reviewToken: string }).reviewToken })];
  const raced = await fixture.run(args, undefined, undefined, { ...options, openAccess() {
    const access = fixture.openAccess();
    return { ...access, browserRenditions: { ...access.browserRenditions, submit(input, prepare) {
      createApplicationOperations(access).deleteDamagePreviewMedia(preview.id, { mediaToken: state.media.token, mutationKey: "synthetic-creation-race-delete" });
      return access.browserRenditions.submit(input, prepare);
    } } };
  } });
  expect(raced).toMatchObject({ exitCode: 2, result: { error: { code: "RENDITION_REVIEW_STALE", current: { available: false, reasons: [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVING" }] } } } });
  expect(await fixture.run(args, undefined, undefined, options)).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_REMOVING" } } });
});
