import { afterEach, expect, it } from "vitest";

import {
  seedCommittedArchiveEvidence,
} from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
} from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createDvdRecoveryRangesRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

it("matches public JSON CLI paging through the shared range operation", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  await seedCommittedArchiveEvidence(fixture, [
    { startLba: 8, sectorCount: 1, classification: "skipped_untested" },
    { startLba: 16, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);
  const access = fixture.openAccess();
  try {
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "1" });
      const args = [
        "archive-recovery", "ranges", "synthetic-committed-recovery",
        "--limit", "1",
      ];
      if (cursor !== null) {
        query.set("cursor", cursor);
        args.push("--cursor", cursor);
      }
      const web = await createDvdRecoveryRangesRoute(
        new Request(
          `http://localhost/api/archive-recoveries/synthetic-committed-recovery/ranges?${query}`,
        ),
        "synthetic-committed-recovery",
        () => access,
      );
      const cli = await fixture.run(args);
      expect(web.status).toBe(200);
      expect(web.headers.get("Cache-Control")).toBe("no-store");
      const body = await web.json();
      expect(body).toEqual(cli.result);
      cursor = body.nextCursor;
    } while (cursor !== null);
  } finally {
    access.close();
  }
});

it("returns stable HTTP errors for invalid and missing range requests", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const access = fixture.openAccess();
  try {
    const invalid = await createDvdRecoveryRangesRoute(
      new Request(
        "http://localhost/api/archive-recoveries/synthetic/ranges?limit=0",
      ),
      "synthetic",
      () => access,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "INVALID_ARGUMENTS" },
    });
    const missing = await createDvdRecoveryRangesRoute(
      new Request(
        "http://localhost/api/archive-recoveries/missing/ranges",
      ),
      "missing",
      () => access,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND" } });
  } finally {
    access.close();
  }
});
