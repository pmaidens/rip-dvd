import { afterEach, expect, it } from "vitest";
import { encodeOutputArtifactIdentity } from "@rip-dvd/application";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 90, streams: [] });

it("keeps historical source correspondence unknown while ordinary output inspection remains available", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic correspondence output" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const result = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify({
    assessmentIdentity: "synthetic-assessment", titleIdentityObservationId: "synthetic-observation", intervalIndexes: [0],
  })], undefined, undefined, { encodeOutputMediaProbe: probe });
  expect(result).toMatchObject({ exitCode: 0, result: {
    inspection: { artifact: { inspectability: { status: "inspected" } } },
    intervals: [{ intervalIndex: 0, status: "unknown", outputInterval: null,
      reasonCode: "OUTPUT_SOURCE_NOT_RECORDED", evidence: { sourceSnapshotAvailability: "not_recorded" } }],
    targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" },
  } });
  expect((await fixture.run(["encode-output", "inspect", identity], undefined, undefined,
    { encodeOutputMediaProbe: probe })).result).toMatchObject({ artifact: { inspectability: { status: "inspected" } } });
});

it.each([{}, { intervalIndexes: [] }, { intervalIndexes: [0, 0] }, { intervalIndexes: [-1] },
  { intervalIndexes: [0.5] }, { intervalIndexes: Array.from({ length: 101 }, (_, index) => index) },
  { intervalIndexes: [0], sourcePercentage: 1 }, { intervalIndexes: [0], startMilliseconds: 1000 }])(
  "rejects malformed or caller-estimated interval requests, %j", async (fields) => {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const result = await fixture.run(["encode-output", "intervals", "encode-output-v1.published.00000000-0000-4000-8000-000000000000",
      "--json", JSON.stringify({ assessmentIdentity: "synthetic-assessment", titleIdentityObservationId: "synthetic-observation", ...fields })]);
    expect(result).toMatchObject({ exitCode: 2, result: { error: { code: "INVALID_ARGUMENTS" } } });
  },
);

it("reports failed actual-output inspection as unknown without an output location", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic unprobeable output" });
  const result = await fixture.run(["encode-output", "intervals", encodeOutputArtifactIdentity(predecessor.id), "--json", JSON.stringify({
    assessmentIdentity: "synthetic-assessment", titleIdentityObservationId: "synthetic-observation", intervalIndexes: [0],
  })], undefined, undefined, { encodeOutputMediaProbe: async () => { throw new Error("Synthetic probe failure"); } });
  expect(result).toMatchObject({ exitCode: 0, result: {
    inspection: { artifact: { inspectability: { status: "unknown", reasonCode: "OUTPUT_PROBE_FAILED" } } },
    intervals: [{ status: "unknown", outputInterval: null, reasonCode: "OUTPUT_INSPECTION_UNAVAILABLE",
      evidence: { inspectionReasonCode: "OUTPUT_PROBE_FAILED" } }],
  } });
});
