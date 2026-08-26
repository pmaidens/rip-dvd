import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type { EncodeJob, EncodeJobStatus } from "./types.js";

const SAFELY_TERMINAL_ENCODE_JOB_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly EncodeJobStatus[];

export type EncodeJobSafelyTerminalState = Pick<
  EncodeJob,
  | "status"
  | "partialCleanupOutputPath"
  | "partialCleanupClaimToken"
  | "partialCleanupLeaseToken"
  | "publicationPending"
  | "publicationCompletionPending"
>;

export function isEncodeJobSafelyTerminal(
  job: EncodeJobSafelyTerminalState,
): boolean {
  return SAFELY_TERMINAL_ENCODE_JOB_STATUSES.includes(
    job.status as (typeof SAFELY_TERMINAL_ENCODE_JOB_STATUSES)[number],
  ) &&
    job.partialCleanupOutputPath === null &&
    job.partialCleanupClaimToken === null &&
    job.partialCleanupLeaseToken === null &&
    !job.publicationPending &&
    !job.publicationCompletionPending;
}

export const isCorrectedEncodePredecessorReady =
  isEncodeJobSafelyTerminal;

type CorrectedEncodeReadinessColumns = Record<
  | "status"
  | "partialCleanupOutputPath"
  | "partialCleanupClaimToken"
  | "partialCleanupLeaseToken"
  | "publicationPending"
  | "publicationCompletionPending",
  AnySQLiteColumn
>;

export function correctedEncodePredecessorReadyCondition(
  predecessor: CorrectedEncodeReadinessColumns,
): SQL {
  const terminalStatuses = sql.join(
    SAFELY_TERMINAL_ENCODE_JOB_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`${predecessor.status} in (${terminalStatuses})
    and ${predecessor.partialCleanupOutputPath} is null
    and ${predecessor.partialCleanupClaimToken} is null
    and ${predecessor.partialCleanupLeaseToken} is null
    and ${predecessor.publicationPending} = 0
    and ${predecessor.publicationCompletionPending} = 0`;
}
