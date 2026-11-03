import { afterEach, expect, it, vi } from "vitest";
import { startTimingAttempt } from "./archive-job-timing.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { ARCHIVE_JOB_LEASE_DURATION_MS, createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import { createNormalDvdArchiveBoundaryEvidenceForTest } from "@rip-dvd/data-access/test-support";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => {
  vi.useRealTimers();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

it.each(["completed", "failed", "aborted", "interrupted", "expired_cancellation"] as const)("durably freezes %s timing without a browser", async (outcome) => {
  const { fixture, access, claim } = await startTimingAttempt();
  fixtures.push(fixture);
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:03.999Z"));
    if (outcome === "aborted" || outcome === "expired_cancellation") {
      expect((await fixture.run(["cancel-archive-request", "--key", "synthetic-cancel", "--archive-request-id", claim.archiveRequestId])).exitCode).toBe(0);
      expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: { status: "running", timing: { state: "running", elapsedSeconds: 3 } } });
      vi.setSystemTime(new Date("2026-01-01T00:00:05.999Z"));
    }
    if (outcome === "completed") access.archiveJobs.publish(claim, {
      archivePath: join(fixture.originalsLibraryPath, "synthetic.iso"), sizeBytes: 2048,
      boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(2048),
      integrityEvidence: createCleanReadArchiveIntegrityEvidence("synthetic-policy-v1"),
    });
    else if (outcome === "failed") access.archiveJobs.failWithReadFailure(claim, {
      stage: "initial_copy", category: "unknown", classifierVersion: "scsi-read-classifier-v2", failingLba: 0,
      requestedBlockCount: 1, retryCount: 0, scsiStatus: null, hostStatus: null, driverStatus: null, senseKey: null, asc: null, ascq: null,
    });
    else if (outcome === "aborted") access.archiveJobs.abort(claim, "Synthetic settled cancellation");
    else {
      vi.setSystemTime(new Date(claim.updatedAt.getTime() + ARCHIVE_JOB_LEASE_DURATION_MS + 1));
      if (outcome === "expired_cancellation") access.archiveJobs.finalizeExpiredCancellation(claim);
      else expect(access.archiveJobs.recoverExpiredClaims()).toMatchObject([{ id: claim.id, status: "failed" }]);
    }
    const completedAt = new Date().toISOString();
    const elapsedSeconds = outcome === "aborted" ? 5 : outcome === "completed" || outcome === "failed" ? 3 : ARCHIVE_JOB_LEASE_DURATION_MS / 1000;
    const status = outcome === "interrupted" ? "failed" : outcome === "expired_cancellation" ? "aborted" : outcome;
    for (const observation of ["2026-01-02T00:00:00Z", "2026-02-01T00:00:00Z"]) {
      vi.setSystemTime(new Date(observation));
      const timing = { state: "final", startedAt: "2026-01-01T00:00:00.250Z", completedAt, elapsedSeconds };
      expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: { status, completedAt, timing } });
      expect((await fixture.run(["inspect", "archive-jobs"])).result).toMatchObject({ items: [{ timing }] });
    }
  } finally { access.close(); }
});

it("keeps an observation running despite stalled progress and recoverable retries, without writing to the attempt", async () => {
  const { fixture, access, claim } = await startTimingAttempt();
  fixtures.push(fixture);
  try {
    access.archiveJobs.updateProgress(claim, { phase: "copying", progressPercent: 20, progressBytes: 1024 });
    // Recoverable source retries leave the job running without byte progress.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.999Z"));
    const before = access.archiveJobs.find(claim.id);
    expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: { status: "running", timing: { state: "running", elapsedSeconds: 600 } } });
    expect(access.archiveJobs.find(claim.id)).toEqual(before);
  } finally { access.close(); }
});

it.each([
  { status: "running", start: null, end: null, state: "unavailable", elapsed: null },
  { status: "running", start: 9e15, end: null, state: "unavailable", elapsed: null },
  { status: "completed", start: 1767225600250, end: null, state: "unavailable", elapsed: null },
  { status: "failed", start: 1767225600250, end: 9e15, state: "unavailable", elapsed: null },
  { status: "aborted", start: null, end: 1767225603999, state: "unavailable", elapsed: null },
  { status: "completed", start: 1767225600250, end: 1767225600999, state: "final", elapsed: 0 },
  { status: "failed", start: 1767225600250, end: 1767225600000, state: "final", elapsed: 0 },
  { status: "completed", start: 1767225600250, end: 1767319323999, state: "final", elapsed: 93723 },
])("reports historical timing honestly for $status, $start, $end", async ({ status, start, end, state, elapsed }) => {
  const { fixture, access, claim } = await startTimingAttempt();
  fixtures.push(fixture);
  access.close();
  const sqlite = new DatabaseSync(fixture.databasePath);
  try {
    // Older schemas permitted missing lifecycle evidence. Seed it without changing production constraints.
    sqlite.exec("PRAGMA ignore_check_constraints = ON");
    sqlite.prepare("UPDATE archive_jobs SET status = ?, started_at = ?, completed_at = ? WHERE id = ?").run(status, start, end, claim.id);
  } finally { sqlite.close(); }
  expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: { timing: { state, elapsedSeconds: elapsed } } });
  expect((await fixture.run(["inspect", "archive-jobs"])).result).toMatchObject({ items: [{ timing: { state, elapsedSeconds: elapsed } }] });
});


it("inspects elapsed processing time in preparing and subsequent phases through both CLI reads", async () => {
  const { fixture, access, claim } = await startTimingAttempt();
  fixtures.push(fixture);
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:02.999Z"));
    const expected = { state: "running", startedAt: "2026-01-01T00:00:00.250Z", completedAt: null, observedAt: "2026-01-01T00:00:02.999Z", elapsedSeconds: 2 };
    for (const phase of ["preparing", "copying", "verifying", "finalizing"] as const) {
      access.archiveJobs.updateProgress(claim, { phase, progressPercent: 20, progressBytes: 1024 });
      expect((await fixture.run(["inspect", "archive-jobs", claim.id])).result).toMatchObject({ item: { status: "running", progressPhase: phase, timing: expected } });
      expect((await fixture.run(["inspect", "archive-jobs"])).result).toMatchObject({ items: [{ timing: expected }] });
    }
  } finally { access.close(); }
});
