import {
  createEncodeWorkConflictCurrent,
  ENCODE_WORK_CONFLICT,
  RecordNotFoundError,
  type ArchiveRecovery,
  type ArchiveRecoveryAttemptId,
  type ArchiveRecoveryId,
  type DataAccess,
  type EncodeJob,
} from "@rip-dvd/data-access";
import { visibleArchiveRecovery } from "./archive-recovery-view.js";

export function dvdRecoveryStopAction(
  recovery: ArchiveRecovery,
  encodeJobs: readonly Pick<EncodeJob, "id" | "status" | "createdAt">[],
) {
  const statusReason = recovery.status === "completed"
    ? {
        code: "RECOVERY_COMPLETED",
        message: "Archive Recovery has no unresolved source to stop.",
      }
    : recovery.status === "faulted"
      ? {
          code: "RECOVERY_FAULTED",
          message: "Archive Recovery has a fault requiring attention.",
        }
      : recovery.status === "stopped"
        ? {
            code: "RECOVERY_STOPPED",
            message: "Archive Recovery is already stopped.",
          }
        : recovery.status === "stopping"
          ? {
              code: "RECOVERY_STOPPING",
              message: "Archive Recovery is already stopping.",
            }
          : null;
  const encodeConflict = createEncodeWorkConflictCurrent(recovery, encodeJobs);
  const encodeReason = encodeConflict.encodeJobs.length === 0
    ? null
    : { ...ENCODE_WORK_CONFLICT, current: encodeConflict };
  const blockingReasons = [statusReason, encodeReason].filter((reason) =>
    reason !== null
  );
  return {
    name: "stop",
    eligible: blockingReasons.length === 0,
    available: blockingReasons.length === 0,
    reason: blockingReasons[0]?.message ?? null,
    requiredInputs: ["mutationKey", "archiveRecoveryId", "attemptId"],
    blockingReasons,
    expectedInputs: {
      archiveRecoveryId: recovery.id,
      attemptId: recovery.attemptId,
    },
  };
}

export function requestDvdRecoveryStop(
  access: DataAccess,
  input: {
    mutationKey: string;
    archiveRecoveryId: ArchiveRecoveryId;
    attemptId: ArchiveRecoveryAttemptId;
  },
) {
  const recovery = access.catalog.findArchiveRecoveryById(
    input.archiveRecoveryId,
  );
  if (recovery === null) {
    throw new RecordNotFoundError(
      "Archive Recovery",
      input.archiveRecoveryId,
    );
  }
  const stopped = access.archiveRecoveryWork.requestStop(input);
  return {
    archiveRecovery: visibleArchiveRecovery(stopped),
    operation: {
      kind: "archive-recoveries" as const,
      id: stopped.id,
      operationId: stopped.stopOperationId,
      status: stopped.status,
    },
  };
}
