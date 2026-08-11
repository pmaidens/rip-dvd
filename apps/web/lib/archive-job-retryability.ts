import type { ArchiveJob, DetectedDisc } from "@rip-dvd/data-access";

export function isArchiveJobRetryable(
  job: Pick<ArchiveJob, "status">,
  disc: Pick<DetectedDisc, "status"> | undefined,
): boolean {
  return job.status === "failed" && disc?.status === "approved";
}
