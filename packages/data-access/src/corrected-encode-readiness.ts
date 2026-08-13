import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import type { EncodeJob, EncodeJobStatus } from "./types.js";

const SAFELY_TERMINAL_ENCODE_JOB_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly EncodeJobStatus[];

export type CorrectedEncodePredecessorReadiness = Pick<
  EncodeJob,
  | "status"
  | "partialCleanupOutputPath"
  | "partialCleanupClaimToken"
  | "partialCleanupLeaseToken"
  | "publicationPending"
  | "publicationCompletionPending"
>;

export function isCorrectedEncodePredecessorReady(
  predecessor: CorrectedEncodePredecessorReadiness,
): boolean {
  return SAFELY_TERMINAL_ENCODE_JOB_STATUSES.includes(
    predecessor.status as (typeof SAFELY_TERMINAL_ENCODE_JOB_STATUSES)[number],
  ) &&
    predecessor.partialCleanupOutputPath === null &&
    predecessor.partialCleanupClaimToken === null &&
    predecessor.partialCleanupLeaseToken === null &&
    !predecessor.publicationPending &&
    !predecessor.publicationCompletionPending;
}

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
