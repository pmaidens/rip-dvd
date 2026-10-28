import { afterEach, expect, it } from "vitest";
import { claimNextEncodeJob } from "@rip-dvd/application";
import { seedEncodeClaim, withdrawClaimAcceptance } from "../../../../operator-cli/src/encode-claim.test-support";
import { createOperatorWorkflowFixture } from "../../../../operator-cli/src/operator-workflow.test-support";
import { createOperationsResponse } from "../operations/route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("returns the same immutable claim history through HTTP and the public JSON CLI after withdrawal", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, {});
  try {
    const claim = (await claimNextEncodeJob(seeded.access, "synthetic-parity-worker", fixture.originalsLibraryPath))!;
    const snapshot = seeded.access.encodeJobs.findClaimSnapshot(claim.claimToken);
    await withdrawClaimAcceptance(fixture, seeded.archive.id, seeded.expectedSourceDecision.acceptanceIdentity!);
    for (const offset of [0, 1]) {
      const cli = await fixture.run(["inspect", "encode-jobs", claim.id, "--limit", "1", "--offset", String(offset)]);
      const web = await createOperationsResponse(seeded.access,
        new Request(`http://localhost/api/operations?kind=encode-jobs&id=${claim.id}&limit=1&offset=${offset}`), fixture.originalsLibraryPath);
      expect(cli.exitCode).toBe(0);
      expect(web.status).toBe(200);
      expect(await web.json()).toEqual(cli.result);
      expect(cli.result).toMatchObject({ item: { status: "running",
        claimSnapshots: offset === 0 ? [JSON.parse(JSON.stringify(snapshot))] : [],
        claimSnapshotPage: { offset, limit: 1, nextOffset: null },
      } });
    }
  } finally { seeded.access.close(); }
});
