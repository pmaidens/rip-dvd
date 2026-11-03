import type { DashboardArchiveJob } from "../lib/dashboard";

export const unavailableArchiveJobTiming = {
  startedAt: null,
  completedAt: null,
  timing: {
    state: "unavailable",
    startedAt: null,
    completedAt: null,
    observedAt: "2026-01-01T00:00:00.000Z",
    elapsedSeconds: null,
  },
} satisfies Pick<DashboardArchiveJob, "startedAt" | "completedAt" | "timing">;
