import { publishCorrespondenceOutput, seedFailedCorrespondenceOutput } from "../../../../../../operator-cli/src/encode-output-correspondence.test-support.js";
import { publishMeasuredCorrespondenceOutput } from "../../../../../../operator-cli/src/encode-output-measured-correspondence.test-support.js";
import { afterEach, expect, it } from "vitest";
import { encodeOutputArtifactIdentity } from "@rip-dvd/application";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputIntervalsRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 90, streams: [] });

it("shares inspected failed-artifact source evidence without inventing an output location", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedFailedCorrespondenceOutput(fixture);
  const mediaProbe = async () => ({ durationSeconds: 500, streams: [] });
  try {
    const response = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${seeded.artifactIdentity}/intervals?query=${encodeURIComponent(JSON.stringify(seeded.query))}`),
      seeded.artifactIdentity, () => seeded.access, mediaProbe);
    const cli = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: mediaProbe });
    expect(response.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await response.json());
    expect(cli.result).toMatchObject({
      inspection: { artifact: { state: "validation_failed", inspectability: { status: "inspected" } } },
      intervals: [{ status: "unknown", outputInterval: null, reasonCode: "OUTPUT_TIMING_UNSUPPORTED", evidence: { claimSnapshotId: seeded.claim.claimToken } }],
    });
  } finally { seeded.access.close(); }
});

it.each([
  [{}, "verified", "OUTPUT_CELL_CONTENT_VERIFIED"],
  [{ outputFrames: ["a", "b", "c", "a", "b", "c"] }, "unknown", "OUTPUT_CONTENT_AMBIGUOUS"],
  [{ outputFrames: ["a", "c"] }, "unknown", "OUTPUT_CONTENT_UNRESOLVED"],
  [{ decoderFailure: true }, "unknown", "OUTPUT_MEASUREMENT_FAILED"],
] as const)("shares generation-bound measured correspondence with the public CLI, %j", async (options, status, reasonCode) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture, options);
  try {
    const response = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${seeded.artifactIdentity}/intervals?query=${encodeURIComponent(JSON.stringify(seeded.query))}`),
      seeded.artifactIdentity, () => seeded.access, probe);
    const cli = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(response.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await response.json());
    expect(cli.result).toMatchObject({ intervals: [{ status, reasonCode }], targetedLocation: { eligible: status === "verified" } });
  } finally { seeded.access.close(); }
});

it.each([false, true])("shares interval classification and failed inspection with the JSON CLI, probe failure %s", async (failure) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic HTTP interval output" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const query = { assessmentIdentity: "synthetic-assessment", titleIdentityObservationId: "synthetic-observation", intervalIndexes: [0] };
  const mediaProbe = failure ? async () => { throw new Error("Synthetic probe failure"); } : probe;
  const access = fixture.openAccess();
  try {
    const web = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${identity}/intervals?query=${encodeURIComponent(JSON.stringify(query))}`), identity, () => access, mediaProbe);
    const cli = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify(query)], undefined, undefined,
      { encodeOutputMediaProbe: mediaProbe });
    expect(web.status).toBe(200);
    expect(web.headers.get("Cache-Control")).toBe("no-store");
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await web.json());
  } finally { access.close(); }
});

it("rejects malformed interval queries identically", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const identity = "encode-output-v1.published.00000000-0000-4000-8000-000000000000";
  const query = { assessmentIdentity: "synthetic-assessment", titleIdentityObservationId: "synthetic-observation", intervalIndexes: [0, 0] };
  const access = fixture.openAccess();
  try {
    const web = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${identity}/intervals?query=${encodeURIComponent(JSON.stringify(query))}`), identity, () => access, probe);
    const cli = await fixture.run(["encode-output", "intervals", identity, "--json", JSON.stringify(query)]);
    expect(web.status).toBe(400);
    expect(cli.exitCode).toBe(2);
    expect(cli.result).toEqual(await web.json());
  } finally { access.close(); }
});

it.each([
  [{}, 500, "absent", "SOURCE_EXCLUDED_BY_SELECTION"],
  [{ chapters: true }, 100, "absent", "SOURCE_EXCLUDED_BY_SELECTION"],
  [{ partialOmittedMap: true }, 500, "unknown", "SOURCE_MAPPING_INCOMPLETE"],
  [{ sharedSource: true }, 500, "unknown", "OUTPUT_TIMING_UNSUPPORTED"],
  [{ overlappingPath: true }, 500, "unknown", "OUTPUT_TIMING_UNSUPPORTED"],
  [{ sharedSource: true }, 100, "unknown", "OUTPUT_TRUNCATED"],
  [{ sharedSource: true, chapters: true }, 100, "unknown", "SOURCE_CHAPTER_MAPPING_INCOMPLETE"],
] as const)("shares artifact-bound selection, omission and truncation classification, %j", async (options, durationSeconds, status, reasonCode) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishCorrespondenceOutput(fixture, options);
  const mediaProbe = async () => ({ durationSeconds, streams: [] });
  try {
    const web = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${seeded.artifactIdentity}/intervals?query=${encodeURIComponent(JSON.stringify(seeded.query))}`),
      seeded.artifactIdentity, () => seeded.access, mediaProbe);
    const cli = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)],
      undefined, undefined, { encodeOutputMediaProbe: mediaProbe });
    expect(web.status).toBe(200);
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(await web.json());
    expect(cli.result).toMatchObject({
      inspection: { artifact: { inspectability: { status: "inspected" } } },
      intervals: [{ status, reasonCode, outputInterval: null, evidence: { claimSnapshotId: seeded.claim.claimToken } }],
    });
  } finally { seeded.access.close(); }
});
