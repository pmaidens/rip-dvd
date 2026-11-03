import type { ArchiveJob } from "@rip-dvd/data-access";

export interface ArchiveJobTiming {
  state: "running" | "final" | "unavailable";
  startedAt: string | null;
  completedAt: string | null;
  observedAt: string;
  /** Whole elapsed seconds, rounded down and clamped to zero. */
  elapsedSeconds: number | null;
}

function timestamp(value: Date | null): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
}

/** Observes persisted lifecycle evidence without changing the attempt. */
export function describeArchiveJobTiming(
  job: Pick<ArchiveJob, "status" | "startedAt" | "completedAt">,
  observedAt = new Date(),
): ArchiveJobTiming {
  const startedAt = timestamp(job.startedAt);
  const completedAt = timestamp(job.completedAt);
  const running = job.status === "running";
  const end = running ? observedAt.getTime() : job.completedAt?.getTime();
  const available = startedAt !== null && end !== undefined &&
    Number.isFinite(end);
  return {
    state: available ? running ? "running" : "final" : "unavailable",
    startedAt,
    completedAt,
    observedAt: observedAt.toISOString(),
    elapsedSeconds: available
      ? Math.max(0, Math.floor((end - job.startedAt!.getTime()) / 1000))
      : null,
  };
}
