import { expect, test, type Page } from "@playwright/test";
import type { DashboardArchiveJob, DashboardSnapshot } from "../../lib/dashboard";

const startedAt = "2026-01-01T00:00:00.250Z";
function snapshot(job: DashboardArchiveJob | null): DashboardSnapshot {
  return {
    generatedAt: job?.timing.observedAt ?? "2026-01-01T00:00:00.250Z",
    opticalDrives: { status: "loaded", items: [] },
    detectedDiscs: { status: "loaded", items: [] },
    archiveJobs: { status: "loaded", items: job ? [job] : [] },
    encodeJobs: { status: "loaded", items: [] },
    catalogReview: { status: "loaded", items: [] },
    workerIncidents: { status: "loaded", items: [] },
  };
}
function runningJob(): DashboardArchiveJob {
  return {
    id: "synthetic-timing-job", detectedDiscId: "synthetic-timing-disc",
    archiveRequestId: "synthetic-timing-request", attemptOrdinal: 1,
    discLabel: "Synthetic timing disc", opticalDriveName: "Synthetic Optical Drive",
    status: "running", progressPhase: "preparing", progressPercent: 0,
    progressBytes: 0, lastProgressAt: startedAt, startedAt, completedAt: null,
    timing: { state: "running", startedAt, completedAt: null,
      observedAt: "2026-01-01T00:00:02.999Z", elapsedSeconds: 2 },
  };
}

async function timingDashboard(page: Page, initial: DashboardSnapshot) {
  let persisted = initial;
  await page.clock.install({ time: new Date("2035-06-01T12:00:00Z") });
  // Control the status transport while exercising the real dashboard adapter.
  await page.addInitScript(() => {
    class SyntheticEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent("dashboard", {
        data: JSON.stringify((event as CustomEvent).detail),
      }));
      constructor() {
        super();
        window.addEventListener("synthetic-dashboard", this.listener);
        queueMicrotask(() => this.onopen?.());
      }
      close() { window.removeEventListener("synthetic-dashboard", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: SyntheticEventSource });
  });
  await page.route((url) => url.pathname === "/api/dashboard", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(persisted) }));
  return {
    async observe(next: DashboardSnapshot) {
      persisted = next;
      await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("synthetic-dashboard", { detail })), next);
    },
    persist(next: DashboardSnapshot) { persisted = next; },
  };
}

test("starts on the first started-job snapshot and ticks through every phase with accessible mobile labels", async ({ page }) => {
  const job = runningJob();
  const backend = await timingDashboard(page, snapshot(null));
  await page.goto("/discs");
  await expect(page.getByText(/Elapsed time:|Final duration:/)).toHaveCount(0);
  await backend.observe(snapshot(job));
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: job.discLabel }) });
  await expect(card.getByText("Elapsed time: 2s", { exact: true })).toBeVisible();
  await page.clock.runFor(1000);
  await expect(card.getByText("Elapsed time: 3s", { exact: true })).toBeVisible();
  for (const [index, phase] of (["copying", "verifying", "finalizing"] as const).entries()) {
    await backend.observe(snapshot({ ...job, progressPhase: phase, progressPercent: 20,
      timing: { ...job.timing, observedAt: `2026-01-01T00:00:0${index + 4}.999Z`, elapsedSeconds: index + 4 } }));
    await expect(card.getByText(`Elapsed time: ${index + 4}s`, { exact: true })).toBeVisible();
    await page.clock.runFor(1000);
    await expect(card.getByText(`Elapsed time: ${index + 5}s`, { exact: true })).toBeVisible();
  }
  const timer = card.getByText("Elapsed time: 7s", { exact: true });
  expect(await timer.evaluate((element) => element.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]') !== null)).toBe(false);
  const box = await timer.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

for (const status of ["completed", "failed", "aborted"] as const) {
test(`replaces a delayed ${status} update with persisted final time and restores it on reopening`, async ({ page }) => {
  const job = runningJob();
  const backend = await timingDashboard(page, snapshot(job));
  await page.goto("/discs");
  await expect(page.getByText("Elapsed time: 2s", { exact: true })).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText("Elapsed time: 12s", { exact: true })).toBeVisible();
  const completedAt = "2026-01-01T00:00:05.999Z";
  const final = snapshot({ ...job, status, completedAt,
    timing: { ...job.timing, state: "final", completedAt,
      observedAt: "2026-01-01T00:00:20.999Z", elapsedSeconds: 5 } });
  await backend.observe(final);
  await expect(page.getByText("Final duration: 5s", { exact: true })).toBeVisible();
  await page.clock.runFor(60_000);
  await expect(page.getByText("Final duration: 5s", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Final duration: 5s", { exact: true })).toBeVisible();
  await page.goto("/");
  await page.goto("/discs");
  await expect(page.getByText("Final duration: 5s", { exact: true })).toBeVisible();
});

}

test("restores running timing on refresh and shows unavailable history and unbounded hours", async ({ page }) => {
  const job = runningJob();
  const backend = await timingDashboard(page, snapshot(job));
  await page.goto("/discs");
  await expect(page.getByText("Elapsed time: 2s", { exact: true })).toBeVisible();
  backend.persist(snapshot({ ...job, timing: { ...job.timing, observedAt: "2026-01-02T02:02:03.999Z", elapsedSeconds: 93723 } }));
  await page.reload();
  await expect(page.getByText("Elapsed time: 26h 2m 3s", { exact: true })).toBeVisible();
  await page.clock.runFor(1000);
  await expect(page.getByText("Elapsed time: 26h 2m 4s", { exact: true })).toBeVisible();
  const unknown = snapshot({ ...job, startedAt: null, timing: { ...job.timing, startedAt: null, state: "unavailable", elapsedSeconds: null } });
  await backend.observe(unknown);
  await expect(page.getByText("Timing unavailable", { exact: true })).toBeVisible();
});
