import { afterEach, expect, it, vi } from "vitest";
import { saveTimingArchive, startTimingAttempt } from "../../../../operator-cli/src/archive-job-timing.test-support";
import { createOperationsResponse } from "./route";
import { createDashboardResponse } from "../dashboard/route";
import { inspectOperationsWithArtifacts } from "@rip-dvd/application";
import { defaultArchiveImageOwnership } from "@rip-dvd/worker-runtime";

afterEach(() => vi.useRealTimers());

it("keeps saved archive inspection available while time advances between consistency reads", async () => {
  const { fixture, access, archive } = await saveTimingArchive();
  try {
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    const result = await inspectOperationsWithArtifacts(access, "original-disc-archives", {
      id: archive.id, originalsLibraryPath: fixture.originalsLibraryPath,
      archiveImageOwnership: {
        inspect(input) {
          // Filesystem observations can outlast one clock tick.
          vi.setSystemTime(Date.now() + 1000);
          return defaultArchiveImageOwnership.inspect(input);
        },
      },
    });
    expect(result).toMatchObject({ item: { archiveArtifact: { initialPreservation: { archiveJob: { timing: {
      state: "final", elapsedSeconds: 9, observedAt: "2026-02-01T00:00:00.000Z",
    } } } } } });
  } finally { access.close(); fixture.dispose(); }
});

it("keeps retry and older-attempt timing identical in CLI, HTTP inspection and dashboard history", async () => {
  const { fixture, access, claim } = await startTimingAttempt();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:05.999Z"));
    access.archiveJobs.fail(claim, "Synthetic first failure");
    vi.setSystemTime(new Date("2026-01-01T00:01:00.250Z"));
    await fixture.run(["retry-archive-request", "--key", "synthetic-retry", "--archive-request-id", claim.archiveRequestId]);
    const retry = access.archiveJobs.startForInspection(claim.discInspectionId!, "synthetic-retry-worker")!;
    vi.setSystemTime(new Date("2026-01-01T00:01:02.999Z"));
    for (const [id, timing] of [
      [claim.id, { state: "final", startedAt: "2026-01-01T00:00:00.250Z", completedAt: "2026-01-01T00:00:05.999Z", elapsedSeconds: 5 }],
      [retry.id, { state: "running", startedAt: "2026-01-01T00:01:00.250Z", completedAt: null, elapsedSeconds: 2 }],
    ] as const) {
      const cli = await fixture.run(["inspect", "archive-jobs", id]);
      const http = await createOperationsResponse(access, new Request(`http://localhost/api/operations?kind=archive-jobs&id=${id}`));
      expect(http.status).toBe(200);
      expect(await http.json()).toEqual(cli.result);
      expect(cli.result).toMatchObject({ item: { id, timing } });
      expect(await createDashboardResponse(access).json()).toMatchObject({ archiveJobs: { items: expect.arrayContaining([
        expect.objectContaining({ id, timing: expect.objectContaining(timing) }),
      ]) } });
    }
  } finally { access.close(); fixture.dispose(); }
});

it.each([false, true])("shares the exact saved source attempt across archive and job reads, unavailable=%s", async (unavailable) => {
  const { fixture, access, archive, sourceJobId } = await saveTimingArchive({ unavailable });
  try {
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    const timing = { state: unavailable ? "unavailable" : "final", startedAt: unavailable ? null : "2026-01-01T00:01:00.250Z",
      completedAt: "2026-01-01T00:01:09.999Z", elapsedSeconds: unavailable ? null : 9, observedAt: "2026-02-01T00:00:00.000Z" };
    for (const [kind, id, expected] of [
      ["archive-jobs", sourceJobId, { id: sourceJobId, timing }],
      ["original-disc-archives", archive.id, { archiveArtifact: { initialPreservation: { archiveJob: { id: sourceJobId, timing } } } }],
    ] as const) {
      const cli = await fixture.run(["inspect", kind, id]);
      const http = await createOperationsResponse(access, new Request(`http://localhost/api/operations?kind=${kind}&id=${id}`), fixture.originalsLibraryPath);
      expect(http.status).toBe(200);
      expect(cli.exitCode).toBe(0);
      expect(await http.json()).toEqual(cli.result);
      expect(cli.result).toMatchObject({ item: expected });
    }
    expect(await createDashboardResponse(access).json()).toMatchObject({ archiveJobs: { items: expect.arrayContaining([
      expect.objectContaining({ id: sourceJobId, timing }),
    ]) } });
  } finally { access.close(); fixture.dispose(); }
});
