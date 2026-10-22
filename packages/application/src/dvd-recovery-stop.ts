import {
  archiveRecoveryWorkIdentity,
  RecordNotFoundError,
  type ArchiveRecovery,
  type ArchiveRecoveryAttemptId,
  type ArchiveRecoveryId,
  type DataAccess,
} from "@rip-dvd/data-access";

function visibleArchiveRecovery(recovery: ArchiveRecovery) {
  return {
    ...recovery,
    work: recovery.work === null
      ? null
      : archiveRecoveryWorkIdentity(recovery.work),
  };
}

export function dvdRecoveryStopAction(recovery: ArchiveRecovery) {
  const reason = recovery.status === "completed"
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
  return {
    name: "stop",
    eligible: reason === null,
    available: reason === null,
    reason: reason?.message ?? null,
    requiredInputs: ["mutationKey", "archiveRecoveryId", "attemptId"],
    blockingReasons: reason === null ? [] : [reason],
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
  if (stopped.stopOperationId === null) {
    throw new Error("Archive Recovery Stop has no durable operation identity");
  }
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
