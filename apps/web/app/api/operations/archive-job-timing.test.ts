import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { startTimingAttempt } from "../../../../operator-cli/src/archive-job-timing.test-support";
import { createOperationsResponse } from "./route";
import { createDashboardResponse } from "../dashboard/route";
import { createDashboardEventResponse } from "../dashboard/events/route";

afterEach(() => vi.useRealTimers());

it.each(["running", "failed", "unavailable", "invalid_finish"] as const)("shares %s timing across CLI, HTTP inspection and initial and live dashboard snapshots", async (state) => {
  const { fixture, access, claim } = await startTimingAttempt();
  const abort = new AbortController();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:03.999Z"));
    if (state === "failed" || state === "invalid_finish") access.archiveJobs.fail(claim, "Synthetic timing failure");
    if (state === "unavailable") {
      const sqlite = new DatabaseSync(fixture.databasePath);
      sqlite.prepare("UPDATE archive_jobs SET started_at = ? WHERE id = ?").run(9e15, claim.id);
      sqlite.close();
    }
    if (state === "invalid_finish") {
      const sqlite = new DatabaseSync(fixture.databasePath);
      sqlite.prepare("UPDATE archive_jobs SET completed_at = ? WHERE id = ?").run(9e15, claim.id);
      sqlite.close();
    }
    for (const id of [claim.id, undefined]) {
      const cli = await fixture.run(["inspect", "archive-jobs", ...(id ? [id] : [])]);
      const http = await createOperationsResponse(access, new Request(`http://localhost/api/operations?kind=archive-jobs${id ? `&id=${id}` : ""}`));
      expect(cli.exitCode).toBe(0);
      expect(http.status).toBe(200);
      expect(await http.json()).toEqual(cli.result);
    }
    const expected = {
      id: claim.id, status: state === "failed" || state === "invalid_finish" ? "failed" : "running",
      startedAt: state === "unavailable" ? null : "2026-01-01T00:00:00.250Z",
      completedAt: state === "failed" ? "2026-01-01T00:00:03.999Z" : null,
      timing: {
        state: state === "failed" ? "final" : state === "invalid_finish" ? "unavailable" : state,
        elapsedSeconds: state === "unavailable" || state === "invalid_finish" ? null : 3,
        observedAt: "2026-01-01T00:00:03.999Z",
      },
    };
    expect(await createDashboardResponse(access).json()).toMatchObject({ archiveJobs: { items: [expected] } });
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const reader = createDashboardEventResponse(access, { signal: abort.signal }).body!.getReader();
    const readSnapshot = async () => {
      const event = new TextDecoder().decode((await reader.read()).value);
      return JSON.parse(event.split("data: ")[1]!.trim()) as unknown;
    };
    expect(await readSnapshot()).toMatchObject({ archiveJobs: { items: [expected] } });
    if (state === "running") access.archiveJobs.fail(claim, "Synthetic delayed terminal update");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await readSnapshot()).toMatchObject({ archiveJobs: { items: [{
      ...expected,
      ...(state === "running" ? { status: "failed", completedAt: "2026-01-01T00:00:03.999Z" } : {}),
      timing: { ...expected.timing, state: state === "unavailable" || state === "invalid_finish" ? "unavailable" : "final", observedAt: "2026-01-01T00:00:04.999Z" },
    }] } });
  } finally { abort.abort(); access.close(); fixture.dispose(); }
});
