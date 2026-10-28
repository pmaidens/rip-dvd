import { afterEach, expect, it } from "vitest";
import { encodeOutputArtifactIdentity } from "@rip-dvd/application";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputIntervalsRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 90, streams: [] });

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
