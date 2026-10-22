import type {
  ArchiveRecovery,
  ArchiveRecoveryId,
  ArchiveRecoveryWork,
  EncodeJob,
  EncodeJobId,
  EncodeJobStatus,
  OriginalDiscArchiveId,
} from "./types.js";
import { DomainInvariantError } from "./errors.js";

export const ENCODE_WORK_CONFLICT = {
  code: "ENCODE_WORK_CONFLICT",
  message:
    "Archive Recovery and queued or running Encode Jobs cannot use the same Original Disc Archive.",
} as const;

export const ACTIVE_ENCODE_WORK_STATUSES = [
  "queued",
  "running",
  "cancellation_requested",
] as const satisfies readonly EncodeJobStatus[];

export type ActiveEncodeWorkStatus =
  (typeof ACTIVE_ENCODE_WORK_STATUSES)[number];

export type ArchiveRecoveryWorkIdentity = Pick<
  ArchiveRecoveryWork,
  "archiveRecoveryId" | "originalDiscArchiveId" | "attemptId" | "status"
>;

export function archiveRecoveryWorkIdentity(
  work: ArchiveRecoveryWork,
): ArchiveRecoveryWorkIdentity {
  return {
    archiveRecoveryId: work.archiveRecoveryId,
    originalDiscArchiveId: work.originalDiscArchiveId,
    attemptId: work.attemptId,
    status: work.status,
  };
}

export function isActiveEncodeWorkStatus(
  status: EncodeJobStatus,
): status is ActiveEncodeWorkStatus {
  return ACTIVE_ENCODE_WORK_STATUSES.some((active) => active === status);
}

export function activeEncodeWorkIdentities(
  jobs: readonly Pick<EncodeJob, "id" | "status" | "createdAt">[],
): Array<{ id: EncodeJobId; status: ActiveEncodeWorkStatus }> {
  return jobs
    .filter((job): job is typeof job & { status: ActiveEncodeWorkStatus } =>
      isActiveEncodeWorkStatus(job.status)
    )
    .sort((left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
    )
    .map(({ id, status }) => ({ id, status }));
}

export interface EncodeWorkConflictCurrent {
  archiveRecovery: {
    id: ArchiveRecoveryId;
    originalDiscArchiveId: OriginalDiscArchiveId;
    work: ArchiveRecoveryWorkIdentity | null;
  };
  encodeJobs: readonly {
    id: EncodeJobId;
    status: ActiveEncodeWorkStatus;
  }[];
}

export function createEncodeWorkConflictCurrent(
  recovery: ArchiveRecovery,
  jobs: readonly Pick<EncodeJob, "id" | "status" | "createdAt">[],
): EncodeWorkConflictCurrent {
  return {
    archiveRecovery: {
      id: recovery.id,
      originalDiscArchiveId: recovery.originalDiscArchiveId,
      work: recovery.work === null
        ? null
        : archiveRecoveryWorkIdentity(recovery.work),
    },
    encodeJobs: activeEncodeWorkIdentities(jobs),
  };
}

export class EncodeWorkConflictError extends DomainInvariantError {
  readonly code = ENCODE_WORK_CONFLICT.code;
  readonly blockingReasons = [{
    code: ENCODE_WORK_CONFLICT.code,
    message: ENCODE_WORK_CONFLICT.message,
  }] as const;

  constructor(readonly current: EncodeWorkConflictCurrent) {
    super(ENCODE_WORK_CONFLICT.message);
    this.name = "EncodeWorkConflictError";
  }
}
