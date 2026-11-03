import type { ArchiveArtifact, ArchiveJobTiming } from "@rip-dvd/application";
import { expect, test, type Page } from "@playwright/test";
import type { DashboardArchiveJob, DashboardSnapshot } from "../../lib/dashboard";

const firstTiming: ArchiveJobTiming = {
  state: "final", startedAt: "2026-01-01T00:00:00.250Z", completedAt: "2026-01-01T00:00:05.999Z",
  elapsedSeconds: 5, observedAt: "2026-01-01T00:01:00.250Z",
};
const retryTiming: ArchiveJobTiming = {
  state: "running", startedAt: "2026-01-01T00:01:00.250Z", completedAt: null,
  elapsedSeconds: 0, observedAt: "2026-01-01T00:01:00.250Z",
};
const savedTiming: ArchiveJobTiming = {
  ...retryTiming, state: "final", completedAt: "2026-01-01T00:01:09.999Z", elapsedSeconds: 9,
};
const unavailableTiming: ArchiveJobTiming = {
  ...savedTiming, state: "unavailable", startedAt: null, elapsedSeconds: null,
};

function attempt(attemptOrdinal: number, status: DashboardArchiveJob["status"], timing: ArchiveJobTiming): DashboardArchiveJob {
  return {
    id: `synthetic-retention-attempt-${attemptOrdinal}`, detectedDiscId: "synthetic-retention-disc",
    archiveRequestId: "synthetic-retention-request", attemptOrdinal,
    discLabel: "Synthetic duration retention", opticalDriveName: "Synthetic Optical Drive", status,
    startedAt: timing.startedAt, completedAt: timing.completedAt, timing,
    progressPhase: "copying", progressPercent: 25, progressBytes: 1024, lastProgressAt: timing.observedAt,
  };
}

function savedArtifact(timing: ArchiveJobTiming): ArchiveArtifact {
  return {
    schemaVersion: 1, evidenceFormat: "dvd-recovery-evidence-v1", originalDiscArchiveId: "synthetic-retention-archive",
    initialPreservation: { saved: true, archiveRequest: { id: "synthetic-retention-request", status: "fulfilled" },
      archiveJob: { id: "synthetic-exact-source-attempt", status: "completed", timing } },
    recovery: { state: "running", record: null, checkpoint: null, progress: null, history: null,
      currentWork: { recovery: null, encodeJobs: [] }, reconciliation: null },
    readiness: { sourceStability: { ready: false, state: "recovering", reasons: [] },
      titleAssessment: { ready: false, state: "unavailable", assessmentIdentity: null, reasons: [] },
      encodeEligibility: { ready: false, reasons: [], expectedInputs: [] } },
    sourceIdentity: { currentInsertion: null, verification: null, confirmation: null }, actions: [],
  };
}

async function retentionDashboard(page: Page, initial: readonly DashboardArchiveJob[], artifact = savedArtifact(savedTiming)) {
  const snapshot = (jobs: readonly DashboardArchiveJob[]): DashboardSnapshot => ({
    generatedAt: "2026-01-01T00:02:00Z", archiveJobs: { status: "loaded", items: [...jobs] },
    opticalDrives: { status: "loaded", items: [] }, detectedDiscs: { status: "loaded", items: [] },
    encodeJobs: { status: "loaded", items: [] }, catalogReview: { status: "loaded", items: [] }, workerIncidents: { status: "loaded", items: [] },
  });
  let persisted = snapshot(initial);
  let currentArtifact = artifact;
  await page.clock.install({ time: new Date("2035-06-01T12:00:00Z") });
  await page.addInitScript(() => {
    class RetentionEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent("dashboard", { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener("retention-snapshot", this.listener); queueMicrotask(() => this.onopen?.()); }
      close() { window.removeEventListener("retention-snapshot", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: RetentionEventSource });
  });
  await page.route((url) => url.pathname === "/api/dashboard", (route) => route.fulfill({ json: persisted }));
  await page.route((url) => url.pathname === "/api/operations" && url.searchParams.get("id") === "synthetic-retention-archive",
    (route) => route.fulfill({ json: { item: { archiveArtifact: currentArtifact } } }));
  return {
    persist(jobs: readonly DashboardArchiveJob[], nextArtifact = currentArtifact) { persisted = snapshot(jobs); currentArtifact = nextArtifact; },
    async observe(jobs: readonly DashboardArchiveJob[], nextArtifact = currentArtifact) {
      persisted = snapshot(jobs); currentArtifact = nextArtifact;
      await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("retention-snapshot", { detail })), persisted);
    },
  };
}

test("starts a fresh retry and retains numbered final outcomes, unavailable history and investigation controls", async ({ page }) => {
  const failed = { ...attempt(1, "failed", firstTiming), investigation: {
    incidentId: "synthetic-retention-failure", worker: "Archive Worker", subjectType: "Archive Job", subjectId: "synthetic-retention-attempt-1",
    attempt: 1, reasonCode: "archive_read.unknown", failedPhase: "Copying", occurredAt: firstTiming.completedAt!,
    retryability: "appropriate" as const, retryabilityDetail: "Retry is available.", explanation: "Synthetic read failure.", suggestedAction: "Inspect the disc.", technicalEvidence: [],
  } };
  const retry = attempt(2, "running", retryTiming);
  const backend = await retentionDashboard(page, [failed]);
  await page.goto("/discs");
  await expect(page.getByText("Final duration: 5s", { exact: true })).toBeVisible();
  await backend.observe([failed, retry]);
  await expect(page.getByText("Elapsed time: 0s", { exact: true })).toBeVisible();
  const history = page.locator(".archive-attempt-history");
  await history.getByText("1 older attempt", { exact: true }).click();
  await expect(history.getByText("Final duration: 5s", { exact: true })).toBeVisible();
  await page.clock.runFor(2000);
  await expect(page.getByText("Elapsed time: 2s", { exact: true })).toBeVisible();
  const attempts = [failed, attempt(2, "aborted", savedTiming),
    attempt(3, "completed", { ...savedTiming, completedAt: "2026-01-01T00:01:12.999Z", elapsedSeconds: 12 }),
    attempt(4, "completed", unavailableTiming), attempt(5, "running", { ...retryTiming, startedAt: "2026-01-01T00:02:00.250Z", observedAt: "2026-01-01T00:02:00.250Z" })];
  await backend.observe(attempts);
  for (const [label, duration] of [["Attempt 1 · Failed", "Final duration: 5s"], ["Attempt 2 · Aborted", "Final duration: 9s"],
    ["Attempt 3 · Completed", "Final duration: 12s"], ["Attempt 4 · Completed", "Timing unavailable"]]) {
    const entry = history.getByRole("listitem").filter({ hasText: label! });
    await expect(entry.getByText(duration!, { exact: true })).toBeVisible();
  }
  await expect(history.getByRole("button", { name: "Investigate", exact: true })).toBeEnabled();
  await page.clock.runFor(60_000);
  await expect(history.getByText("Final duration: 5s", { exact: true })).toBeVisible();
  await page.reload();
  await history.getByText("4 older attempts", { exact: true }).click();
  await expect(history.getByText("Final duration: 9s", { exact: true })).toBeVisible();
  await page.goto("/");
  await page.goto("/discs");
  await history.getByText("4 older attempts", { exact: true }).click();
  await expect(history.getByText("Timing unavailable", { exact: true })).toBeVisible();
  const duration = history.getByText("Final duration: 12s", { exact: true });
  expect(await duration.evaluate((element) => element.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]'))).toBeNull();
  const box = await duration.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("keeps the exact initial duration through saved-card replacement, Recovery changes and reopening", async ({ page }) => {
  const running = attempt(1, "running", retryTiming);
  const backend = await retentionDashboard(page, [running]);
  await page.goto("/discs");
  await expect(page.getByText("Elapsed time: 0s", { exact: true })).toBeVisible();
  const saved = { ...attempt(1, "completed", firstTiming), recoveryArtifact: true, originalDiscArchiveId: "synthetic-retention-archive" };
  await backend.observe([saved]);
  const card = page.getByRole("article", { name: "Synthetic duration retention archive artifact" });
  const initial = card.getByRole("region", { name: "Initial preservation" });
  await expect(initial.getByText("Final duration: 9s", { exact: true })).toBeVisible();
  for (const [index, state] of (["running", "stopping", "stopped", "completed", "running"] as const).entries()) {
    const artifact = savedArtifact(savedTiming);
    artifact.recovery.state = state;
    await backend.observe([{ ...saved, activityRevision: `synthetic-recovery-${index}` }], artifact);
    await expect(card.getByRole("region", { name: "Archive Recovery" }).locator(`.status-${state}`)).toBeVisible();
    await page.clock.runFor(10_000);
    await expect(initial.getByText("Final duration: 9s", { exact: true })).toBeVisible();
    await expect(card.getByText(/Elapsed time:/)).toHaveCount(0);
  }
  await page.reload();
  await expect(initial.getByText("Final duration: 9s", { exact: true })).toBeVisible();
  await page.goto("/");
  await page.goto("/discs");
  const duration = initial.getByText("Final duration: 9s", { exact: true });
  await expect(duration).toBeVisible();
  expect(await duration.evaluate((element) => element.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]'))).toBeNull();
  const box = await duration.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("restores unavailable initial timing when publication happens with the archive page closed", async ({ page }) => {
  const backend = await retentionDashboard(page, [attempt(1, "running", retryTiming)]);
  await page.goto("/discs");
  await expect(page.getByText("Elapsed time: 0s", { exact: true })).toBeVisible();
  await page.goto("/");
  backend.persist([{ ...attempt(1, "completed", firstTiming), recoveryArtifact: true, originalDiscArchiveId: "synthetic-retention-archive" }], savedArtifact(unavailableTiming));
  await page.goto("/discs");
  const initial = page.getByRole("region", { name: "Initial preservation" });
  await expect(initial.getByText("Timing unavailable", { exact: true })).toBeVisible();
  await page.reload();
  await expect(initial.getByText("Timing unavailable", { exact: true })).toBeVisible();
});
