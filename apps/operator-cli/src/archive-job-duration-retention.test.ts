import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { saveTimingArchive, startTimingAttempt } from "./archive-job-timing.test-support.js";

afterEach(() => vi.useRealTimers());

it("starts a retry independently and keeps both final attempt durations after reopening persistence", async () => {
  const { fixture, access, claim } = await startTimingAttempt();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:05.999Z"));
    access.archiveJobs.fail(claim, "Synthetic first failure");
    vi.setSystemTime(new Date("2026-01-01T00:01:00.250Z"));
    expect((await fixture.run(["retry-archive-request", "--key", "synthetic-retry", "--archive-request-id", claim.archiveRequestId])).exitCode).toBe(0);
    const retry = access.archiveJobs.startForInspection(claim.discInspectionId!, "synthetic-retry-worker")!;
    expect(retry.id).not.toBe(claim.id);
    const first = { id: claim.id, attemptOrdinal: 1, status: "failed", timing: {
      state: "final", startedAt: "2026-01-01T00:00:00.250Z", completedAt: "2026-01-01T00:00:05.999Z", elapsedSeconds: 5,
    } };
    expect((await fixture.run(["inspect", "archive-jobs", retry.id])).result).toMatchObject({ item: {
      attemptOrdinal: 2, timing: { state: "running", startedAt: "2026-01-01T00:01:00.250Z", completedAt: null, elapsedSeconds: 0 },
    } });
    expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: first });
    vi.setSystemTime(new Date("2026-01-01T00:01:09.999Z"));
    await fixture.run(["cancel-archive-request", "--key", "synthetic-cancel-retry", "--archive-request-id", claim.archiveRequestId]);
    access.archiveJobs.abort(retry, "Synthetic settled cancellation");
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    const second = { id: retry.id, attemptOrdinal: 2, status: "aborted", timing: {
      state: "final", startedAt: "2026-01-01T00:01:00.250Z", completedAt: "2026-01-01T00:01:09.999Z", elapsedSeconds: 9,
    } };
    expect((await fixture.run(["inspect", "archive-jobs"])).result).toMatchObject({ items: [second, first] });
    expect((await fixture.run(["inspect", "archive-jobs", retry.id])).result).toMatchObject({ item: second });
    expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: first });
  } finally { access.close(); fixture.dispose(); }
});

it.each([
  { unavailable: false, recoveryCompleted: false },
  { unavailable: true, recoveryCompleted: false },
  { unavailable: false, recoveryCompleted: true },
])("retains exact source-attempt timing through Recovery lifecycles, $unavailable, $recoveryCompleted", async (options) => {
  const { unavailable, recoveryCompleted } = options;
  const { fixture, access, archive, sourceJobId } = await saveTimingArchive(options);
  try {
    const sqlite = new DatabaseSync(fixture.databasePath);
    try {
      const states = recoveryCompleted ? ["completed"] as const : ["running", "stopping", "stopped", "running"] as const;
      for (const [index, status] of states.entries()) {
        sqlite.prepare("UPDATE archive_recoveries SET status = ?, stop_operation_id = ?, stop_requested_at = ?, stopped_at = ? WHERE id = ?")
          .run(status, status === "stopping" || status === "stopped" ? "synthetic-stop" : null,
            status === "stopping" || status === "stopped" ? 10 : null, status === "stopped" ? 11 : null, "synthetic-timing-recovery");
        vi.setSystemTime(Date.parse("2026-02-01T00:00:00Z") + index * 60_000);
        const timing = { state: unavailable ? "unavailable" : "final", startedAt: unavailable ? null : "2026-01-01T00:01:00.250Z",
          completedAt: "2026-01-01T00:01:09.999Z", elapsedSeconds: unavailable ? null : 9 };
        expect((await fixture.run(["inspect", "archive-jobs", sourceJobId])).result).toMatchObject({ item: { timing } });
        expect((await fixture.run(["inspect", "original-disc-archives", archive.id])).result).toMatchObject({ item: { archiveArtifact: {
          initialPreservation: { saved: true, archiveJob: { id: sourceJobId, status: "completed", timing } }, recovery: { state: status },
        } } });
      }
    } finally { sqlite.close(); }
  } finally { access.close(); fixture.dispose(); }
});
