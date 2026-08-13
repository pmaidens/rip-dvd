import type { EncodeJobStatus } from "@rip-dvd/data-access";

const TERMINAL_ENCODE_JOB_STATUSES: ReadonlySet<EncodeJobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalEncodeJobStatus(
  status: EncodeJobStatus,
): boolean {
  return TERMINAL_ENCODE_JOB_STATUSES.has(status);
}
