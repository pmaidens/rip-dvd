import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { BrowserRenditionAvailability } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { compatibleOutputProbe } from "./encode-output-rendition.test-support.js";
import { publishMeasuredCorrespondenceOutput } from "./encode-output-measured-correspondence.test-support.js";
import { seedCorrectedKeepPreflightFixture } from "./encode-output-keep-preflight.test-support.js";
import { withdrawClaimAcceptance } from "./encode-claim.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const options = { encodeOutputMediaProbe: compatibleOutputProbe, browserRenditionsEnabled: true };

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
