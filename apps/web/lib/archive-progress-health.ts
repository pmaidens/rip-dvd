export const ARCHIVE_PROGRESS_WARNING_MS = 5 * 60_000;

export type ArchiveProgressHealth =
  | { status: "advancing" }
  | { status: "not_advancing"; durationSeconds: number };

export function assessArchiveProgress(
  archiveJob: {
    lastProgressAt: Date | string;
  },
  now: Date | number = Date.now(),
): ArchiveProgressHealth {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const lastProgressAtMs = new Date(archiveJob.lastProgressAt).getTime();
  const durationMs = Math.max(0, nowMs - lastProgressAtMs);

  if (durationMs < ARCHIVE_PROGRESS_WARNING_MS) {
    return { status: "advancing" };
  }

  return {
    status: "not_advancing",
    durationSeconds: Math.floor(durationMs / 1_000),
  };
}
