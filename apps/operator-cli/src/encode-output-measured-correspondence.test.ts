import { lstatSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { claimNextEncodeJob, type EncodeOutputIntervalInspection } from "@rip-dvd/application";
import { publishMeasuredCorrespondenceOutput } from "./encode-output-measured-correspondence.test-support.js";
import { publishSyntheticClaim } from "./encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("locates the measured whole-cell envelope through the public CLI without using estimated source timestamps", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture);
  try {
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(result).toMatchObject({ exitCode: 0, result: {
      intervals: [{ status: "verified", outputInterval: { startMilliseconds: 40, endMilliseconds: 160 },
        reasonCode: "OUTPUT_CELL_CONTENT_VERIFIED", evidence: { claimSnapshotId: seeded.claim.claimToken,
          measuredCorrespondence: { policyVersion: "encode-output-exact-cell-video-v1", status: "measured" } } }],
      targetedLocation: { eligible: true, reasonCode: null },
    } });
    const ordinary = await fixture.run(["encode-output", "inspect", seeded.artifactIdentity],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect((result.result as EncodeOutputIntervalInspection).inspection).toEqual(ordinary.result);
    writeFileSync(seeded.archive.archivePath, "synthetic changed source after publication");
    const after = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(after.result).toEqual(result.result);
  } finally { seeded.access.close(); }
});

it.each([
  [{ outputFrames: ["a", "b", "c", "a", "b", "c"] }, "OUTPUT_CONTENT_AMBIGUOUS"],
  [{ outputFrames: ["lead", "a", "c", "tail"] }, "OUTPUT_CONTENT_UNRESOLVED"],
  [{ outputFrames: ["a", "b"] }, "OUTPUT_CONTENT_UNRESOLVED"],
  [{ decoderFailure: true }, "OUTPUT_MEASUREMENT_FAILED"],
  [{ incompleteNativeFrames: true }, "OUTPUT_MEASUREMENT_FAILED"],
  [{ sourceFault: "zeroed_sector" }, "OUTPUT_CELL_UNSUPPORTED"],
  [{ sourceFault: "encrypted_packet" }, "OUTPUT_CELL_UNSUPPORTED"],
] as const)("keeps incomplete or ambiguous measured content unknown, %j", async (options, reasonCode) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture, options);
  try {
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(result).toMatchObject({ exitCode: 0, result: {
      inspection: { artifact: { inspectability: { status: "inspected" } } },
      intervals: [{ status: "unknown", outputInterval: null, reasonCode }],
      targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" },
    } });
  } finally { seeded.access.close(); }
});

it("uses native decoded timestamps when the framehash encoder rounds the output time base", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture, { outputOffsetMilliseconds: 21 });
  try {
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(result).toMatchObject({ exitCode: 0, result: {
      intervals: [{ status: "verified", outputInterval: { startMilliseconds: 61, endMilliseconds: 181 } }],
    } });
  } finally { seeded.access.close(); }
});

it("checks measured bytes even when an edited output retains its recorded size and mtime", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture);
  try {
    const before = lstatSync(seeded.claim.outputPath);
    writeFileSync(seeded.claim.outputPath, "X".repeat(before.size));
    utimesSync(seeded.claim.outputPath, before.atime, before.mtime);
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(result).toMatchObject({ exitCode: 0, result: { intervals: [{ status: "unknown", outputInterval: null }] } });
    expect(JSON.stringify(result.result)).not.toContain('"status":"verified"');
  } finally { seeded.access.close(); }
});

it("does not retarget an earlier measured location to a replacement output generation", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture);
  try {
    seeded.access.encodeJobs.requeue(seeded.claim.id, { expectedSourceDecision: seeded.snapshot.source.decision });
    const replacement = (await claimNextEncodeJob(seeded.access, "synthetic-replacement-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(seeded.access, replacement);
    const run = (identity: string) => fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(await run(seeded.artifactIdentity)).toMatchObject({ exitCode: 0, result: {
      intervals: [{ status: "unknown", outputInterval: null, evidence: { claimSnapshotId: replacement.claimToken } }],
    } });
  } finally { seeded.access.close(); }
});
