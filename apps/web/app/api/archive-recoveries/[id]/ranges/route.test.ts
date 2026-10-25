import { DatabaseSync } from "node:sqlite";
import type { DataAccess } from "@rip-dvd/data-access";
import { afterEach, expect, it, vi } from "vitest";

import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
} from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
} from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { createDvdRecoveryRangesRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

async function expectWebCliParity(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  access: DataAccess,
  query: URLSearchParams = new URLSearchParams(),
) {
  const args = [
    "archive-recovery", "ranges", "synthetic-committed-recovery",
  ];
  for (const [key, value] of query) args.push(`--${key}`, value);
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
  return body;
}

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
      if (cursor !== null) {
        query.set("cursor", cursor);
      }
      const body = await expectWebCliParity(fixture, access, query);
      cursor = body.nextCursor;
    } while (cursor !== null);
  } finally {
    access.close();
  }
});

it("matches changed checkpoints, no-change history, counts, and pass estimates", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(1_500));
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 100,
    sectorCount: 4,
    classification: "skipped_untested",
  }, {
    startLba: 200,
    sectorCount: 1,
    classification: "skipped_untested",
  }], false, true);
  const initialAccess = fixture.openAccess();
  const initial = await expectWebCliParity(
    fixture,
    initialAccess,
    new URLSearchParams({ limit: "1" }),
  );
  initialAccess.close();

  const second = advanceCommittedArchiveEvidence(fixture, seeded.manifest, {
    startLba: 102,
    outcome: "failed",
    createdAtMs: 800,
    publishFilesystemCheckpoint: true,
  });
  const third = advanceCommittedArchiveEvidence(fixture, second, {
    startLba: 102,
    outcome: "failed",
    createdAtMs: 900,
    publishFilesystemCheckpoint: true,
  });
  const fourth = advanceCommittedArchiveEvidence(fixture, third, {
    startLba: 100,
    outcome: "recovered",
    createdAtMs: 1_100,
    publishFilesystemCheckpoint: true,
  });
  advanceCommittedArchiveEvidence(fixture, fourth, {
    startLba: 101,
    outcome: "recovered",
    createdAtMs: 1_300,
    publishFilesystemCheckpoint: true,
  });
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare(`
    INSERT INTO archive_recovery_work (
      archive_recovery_id, original_disc_archive_id, attempt_id, status,
      verification_id, claimed_by, claim_token, claimed_at, pass_number,
      pass_direction, pass_started_at, pass_started_manifest_revision,
      pass_initial_unrecovered_sector_count, pass_recovered_sector_count,
      pass_cursor_lba, created_at, updated_at
    ) SELECT id, original_disc_archive_id, attempt_id, 'claimed', NULL,
      'synthetic-worker', 'synthetic-claim', 1000, 1, 'forward', 1000, 3, 5, 2,
      101, 1000, 1300
    FROM archive_recoveries
    WHERE id = 'synthetic-committed-recovery'
  `).run();
  sqlite.prepare(`
    UPDATE archive_recoveries
    SET status = 'running', updated_at = 1300
    WHERE id = 'synthetic-committed-recovery'
  `).run();
  sqlite.close();

  const access = fixture.openAccess();
  try {
    const stale = await expectWebCliParity(
      fixture,
      access,
      new URLSearchParams({ cursor: initial.nextCursor }),
    );
    expect(stale).toMatchObject({
      available: false,
      unavailableReason: "DVD_RECOVERY_RANGE_CURSOR_STALE",
      checkpoint: { revision: 5 },
      progress: {
        acceptedExtentSectorCount: 1_024,
        skippedUntestedSectorCount: 2,
        individuallyFailedSectorCount: 1,
        recoveredSectorCount: 2,
        unresolvedSectorCount: 3,
        currentPass: {
          observedSectorCount: 2,
          remainingSectorCount: 3,
          completionEstimate: {
            scope: "current_pass",
            minimumRemainingMs: 300,
            maximumRemainingMs: 600,
          },
        },
      },
      history: { transitions: { totalCount: 3 } },
    });

    const current = await expectWebCliParity(fixture, access);
    expect(current).toMatchObject({
      available: true,
      checkpoint: { revision: 5 },
      history: { transitions: { totalCount: 3 } },
    });

    const unknownSqlite = new DatabaseSync(fixture.databasePath);
    unknownSqlite.prepare(`
      UPDATE archive_recovery_work
      SET pass_started_at = 1200, updated_at = 1500
      WHERE archive_recovery_id = 'synthetic-committed-recovery'
    `).run();
    unknownSqlite.close();
    const unknown = await expectWebCliParity(fixture, access);
    expect(unknown).toMatchObject({
      progress: {
        currentPass: {
          observedSectorCount: 2,
          remainingSectorCount: 3,
          completionEstimate: "unknown",
        },
      },
    });
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
