import { publishCorrespondenceOutput, queryCorrespondence } from "./encode-output-correspondence.test-support.js";
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

it.each([false, true])("proves playback exclusion from the artifact-bound source map, bounded chapters %s", async (chapters) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishCorrespondenceOutput(fixture, { chapters });
  try {
    const result = await queryCorrespondence(fixture, seeded);
    expect(result).toMatchObject({ exitCode: 0, result: {
      inspection: { artifact: { provenance: { sourceSnapshotAvailability: "recorded" }, inspectability: { status: "inspected" } } },
      intervals: [{ intervalIndex: 0, status: "absent", outputInterval: null,
        reasonCode: "SOURCE_EXCLUDED_BY_SELECTION", sourceInterval: { startMilliseconds: 1000, endMilliseconds: 5000 },
        evidence: { claimSnapshotId: seeded.claim.claimToken, assessmentIdentity: seeded.assessment.id } }],
      targetedLocation: { eligible: false, reasonCode: "SOURCE_EXCLUDED_BY_SELECTION" },
    } });
    const archive = seeded.access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!;
    seeded.access.catalog.correctDiscSelection(seeded.selection.id, { originalDiscArchiveId: archive.id,
      catalogRevision: archive.updatedAt, mediaItemId: seeded.selection.mediaItemId,
      sourceIdentity: { kind: "dvd_chapters", titleNumber: 1, chapterStart: 1, chapterEnd: 1 }, reason: "Synthetic later mutable selection." });
    expect((await queryCorrespondence(fixture, seeded)).result).toEqual(result.result);
  } finally { seeded.access.close(); }
});

it.each([
  [{ overlappingPath: true }, 500, "OUTPUT_TIMING_UNSUPPORTED"],
  [{ partialOmittedMap: true }, 500, "SOURCE_MAPPING_INCOMPLETE"],
  [{ sharedSource: true }, 500, "OUTPUT_TIMING_UNSUPPORTED"],
  [{ sharedSource: true }, 100, "OUTPUT_TRUNCATED"],
  [{ sharedSource: true, chapters: true }, 100, "SOURCE_CHAPTER_MAPPING_INCOMPLETE"],
] as const)("keeps unresolved correspondence unknown, %j", async (options, duration, reasonCode) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishCorrespondenceOutput(fixture, options);
  try {
    const result = await queryCorrespondence(fixture, seeded, duration);
    expect(result).toMatchObject({ exitCode: 0, result: {
      inspection: { artifact: { inspectability: { status: "inspected" } } },
      intervals: [{ status: "unknown", outputInterval: null, reasonCode,
        evidence: { claimSnapshotId: seeded.claim.claimToken, assessmentIdentity: seeded.assessment.id } }],
      targetedLocation: { eligible: false, reasonCode: "OUTPUT_MAPPING_UNKNOWN" },
    } });
  } finally { seeded.access.close(); }
});

it.each([
  [{ assessmentIdentity: "synthetic-other-assessment" }, "SOURCE_ASSESSMENT_MISMATCH"],
  [{ titleIdentityObservationId: "synthetic-other-observation" }, "SOURCE_INTERVAL_NOT_RECORDED"],
  [{ intervalIndexes: [99] }, "SOURCE_INTERVAL_NOT_RECORDED"],
] as const)("does not retarget a query with unavailable recorded evidence, %j", async (changes, reasonCode) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishCorrespondenceOutput(fixture);
  try {
    const result = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json",
      JSON.stringify({ ...seeded.query, ...changes })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(result).toMatchObject({ exitCode: 0, result: {
      intervals: [{ status: "unknown", reasonCode, outputInterval: null }],
      targetedLocation: { reasonCode: "OUTPUT_MAPPING_UNKNOWN" },
    } });
  } finally { seeded.access.close(); }
});
