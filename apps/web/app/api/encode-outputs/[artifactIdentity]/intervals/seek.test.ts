import { afterEach, expect, it } from "vitest";
import { seedOutputSeek, seekOptions, seekProbe } from "../../../../../../operator-cli/src/encode-output-seek.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createEncodeOutputIntervalsRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
it.each(["verified", "absent", "unknown"] as const)("shares %s mapping and rendition target evidence with public CLI", async (state) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedOutputSeek(fixture, state);
  try {
    const response = await createEncodeOutputIntervalsRoute(new Request(`http://localhost/api/encode-outputs/${seeded.artifactIdentity}/intervals?query=${encodeURIComponent(JSON.stringify(seeded.query))}`), seeded.artifactIdentity, () => seeded.access, seekProbe, true);
    const cli = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)], undefined, undefined, seekOptions);
    expect(response.status).toBe(200); expect(cli.exitCode).toBe(0);
    expect(await response.json()).toEqual(cli.result);
    expect(cli.result).toMatchObject({ intervals: [{ status: state }], viewing: { targets: state === "verified" ? [expect.objectContaining({ seekSeconds: 2.04 })] : [] } });
  } finally { seeded.access.close(); }
});
