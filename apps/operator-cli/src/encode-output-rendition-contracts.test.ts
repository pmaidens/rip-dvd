import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { BrowserRenditionAvailability } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { compatibleOutputProbe } from "./encode-output-rendition.test-support.js";
import { publishMeasuredCorrespondenceOutput } from "./encode-output-measured-correspondence.test-support.js";
import { seedCorrectedKeepPreflightFixture } from "./encode-output-keep-preflight.test-support.js";
import { withdrawClaimAcceptance } from "./encode-claim.test-support.js";
import { seedProvedPreviewOutput } from "./damage-preview-source-retention.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const options = { encodeOutputMediaProbe: compatibleOutputProbe, browserRenditionsEnabled: true };

it.each([false, true])("keeps source-proved Damage Preview retention independent of rendition admission and inspection, validationFailed=%s", async (validationFailed) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedProvedPreviewOutput(fixture, { validationFailed });
  const before = await seeded.inspectPreview();
  expect(before).toMatchObject({ finishedOutputInspection: { retentionSatisfied: false }, media: { retention: { protectedForReview: true } } });
  const run = (args: string[]) => fixture.run(["encode-output", ...args], undefined, undefined, options);
  const review = (await run(["rendition-availability", seeded.identity])).result as BrowserRenditionAvailability;
  expect(review.available).toBe(true);
  const admitted = await run(["request-rendition", seeded.identity, "--key", "synthetic-preview-retention-rendition", "--json", JSON.stringify({ reviewToken: review.reviewToken })]);
  expect(admitted).toMatchObject({ exitCode: 0, result: { status: "queued" } });
  const id = (admitted.result as { id: string }).id;
  expect(await run(["inspect-rendition", id])).toMatchObject({ exitCode: 0, result: { id, status: "queued" } });
  const after = await seeded.inspectPreview();
  expect(after.finishedOutputInspection).toEqual(before.finishedOutputInspection);
  expect(after.media.retention).toEqual(before.media.retention);
  expect((await seeded.inspectOutput()).operatorInspection.history).toEqual([]);
});

it.each([false, true])("keeps ordinary playback independent of measured correspondence and later acceptance withdrawal, decoder failure=%s", async (decoderFailure) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture, { decoderFailure });
  const run = (args: string[]) => fixture.run(["encode-output", ...args], undefined, undefined, options);
  try {
    const intervals = await run(["intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)]);
    expect(intervals).toMatchObject({ exitCode: 0, result: { intervals: [{ status: decoderFailure ? "unknown" : "verified" }] } });
    const before = await run(["rendition-availability", seeded.artifactIdentity]);
    expect(before).toMatchObject({ exitCode: 0, result: { available: true } });
    const review = before.result as BrowserRenditionAvailability;
    await withdrawClaimAcceptance(fixture, seeded.archive.id, seeded.snapshot.source.decision.acceptanceIdentity!);
    expect((await run(["intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)])).result).toEqual(intervals.result);
    expect((await run(["rendition-availability", seeded.artifactIdentity])).result).toEqual(before.result);
    const requested = await run(["request-rendition", seeded.artifactIdentity, "--key", "synthetic-withdrawn-source-rendition", "--json", JSON.stringify({ reviewToken: review.reviewToken })]);
    expect(requested).toMatchObject({ exitCode: 0, result: { status: "queued", playback: { kind: "ordinary", damageSeek: null, watchability: "not_assessed" },
      source: { identity: seeded.artifactIdentity, encodeJob: { status: "completed" }, provenance: review.source.provenance } } });
  } finally { seeded.access.close(); }
});

it("leaves Keep, receipts and a coexisting normal output independent from failed-output rendition requests", async () => {
  const seeded = await seedCorrectedKeepPreflightFixture(); fixtures.push(seeded.fixture);
  const { fixture, access, identity, predecessor } = seeded;
  const run = (args: string[]) => fixture.run(["encode-output", ...args], undefined, undefined, options);
  try {
    const normalBytes = readFileSync(predecessor.outputPath);
    const before = await run(["inspect", identity]);
    expect(before).toMatchObject({ exitCode: 0, result: { kept: null, artifact: { state: "validation_failed", encodeJob: { status: "failed" } },
      operatorInspection: { receipts: [], status: "not_acknowledged" } } });
    const availability = (await run(["rendition-availability", identity])).result as BrowserRenditionAvailability;
    expect(availability.available).toBe(true);
    const request = ["request-rendition", identity, "--key", "synthetic-independent-rendition", "--json", JSON.stringify({ reviewToken: availability.reviewToken })];
    const admitted = await run(request);
    expect(admitted).toMatchObject({ exitCode: 0, result: { status: "queued", source: { state: "validation_failed" }, playback: { damageSeek: null } } });
    expect((await run(["inspect", identity])).result).toEqual(before.result);
    const { result: preview } = await seeded.preview(undefined, compatibleOutputProbe);
    expect(preview.eligible).toBe(true);
    const kept = await run(["keep", identity, "--key", "synthetic-independent-keep", "--json", JSON.stringify({ acknowledged: true,
      validationIdentity: preview.current.validationIdentity, previewToken: preview.previewToken })]);
    expect(kept.exitCode).toBe(0);
    expect((await run(request)).result).toEqual(admitted.result);
    expect((await run(["rendition-availability", identity])).result).toEqual(availability);
    expect((await run(["inspect", identity])).result).toMatchObject({ kept: (kept.result as { kept: unknown }).kept,
      artifact: { state: "validation_failed", encodeJob: { status: "failed" } }, operatorInspection: { receipts: [], status: "not_acknowledged" } });
    expect(readFileSync(predecessor.outputPath)).toEqual(normalBytes);
  } finally { access.close(); }
});

it.each([false, true])("stages media without retaining the database writer lock and rejects a racing authority change, race=%s", async (race) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { seedCatalogReviewForReadFixture } = await import("./operator-workflow.test-support.js");
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic admission source" });
  const identity = `encode-output-v1.published.${predecessor.id}`;
  const review = (await fixture.run(["encode-output", "rendition-availability", identity], undefined, undefined, options)).result as BrowserRenditionAvailability;
  let writerAvailableDuringStaging = false;
  const openAccess = () => {
    const access = fixture.openAccess();
    const wrapped: import("@rip-dvd/data-access").DataAccess = { ...access, browserRenditions: {
      ...access.browserRenditions,
      submit(input, prepare) {
        return access.browserRenditions.submit(input, () => {
          const staged = prepare();
          const writer = new DatabaseSync(fixture.databasePath);
          try {
            writer.exec("PRAGMA busy_timeout = 1");
            writer.exec("BEGIN IMMEDIATE");
            writer.exec("ROLLBACK");
            writerAvailableDuringStaging = true;
            if (race) writer.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1 WHERE id = ?").run(predecessor.id);
          } finally { writer.close(); }
          return staged;
        });
      },
    } };
    return wrapped;
  };
  const args = ["encode-output", "request-rendition", identity, "--key", "synthetic-staged-admission", "--json", JSON.stringify({ reviewToken: review.reviewToken })];
  const outcome = await fixture.run(args, undefined, undefined, { ...options, openAccess });
  expect(writerAvailableDuringStaging).toBe(true);
  if (race) {
    expect(outcome).toMatchObject({ exitCode: 2, result: { error: { code: "RENDITION_REVIEW_STALE", current: { available: true } } } });
    expect((await fixture.run(["readiness"])).result).toMatchObject({ activeWork: [] });
    const fresh = (await fixture.run(["encode-output", "rendition-availability", identity], undefined, undefined, options)).result as BrowserRenditionAvailability;
    expect((await fixture.run([...args.slice(0, -1), JSON.stringify({ reviewToken: fresh.reviewToken })], undefined, undefined, options)).result).toMatchObject({ status: "queued" });
  } else {
    expect(outcome).toMatchObject({ exitCode: 0, result: { status: "queued" } });
  }
});
