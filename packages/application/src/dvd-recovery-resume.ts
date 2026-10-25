import {
  createEncodeWorkConflictCurrent,
  DvdCheckpointReadFault,
  dvdRecoveryStorageBlockingReason,
  DvdRecoveryStorageUnavailableError,
  ENCODE_WORK_CONFLICT,
  RecordNotFoundError,
  StaleArchiveRecoveryCheckpointError,
  type ArchiveRecovery,
  type ArchiveRecoveryAttemptId,
  type ArchiveRecoveryId,
  type ArchiveRecoverySpeedMode,
  type DataAccess,
  type DvdArchiveEvidenceHeader,
  type DvdRecoveryReconciliation,
  type EncodeJob,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { visibleArchiveRecovery } from "./archive-recovery-view.js";

export type DvdRecoveryResumeUnavailableCode =
  | "CONSISTENCY_FAULT"
  | "RECOVERY_RECONCILIATION_ACTIVE"
  | "RECOVERY_RECONCILIATION_FAILED"
  | "STORAGE_UNSUPPORTED"
  | "WRITER_NOT_QUIESCENT";

export class DvdRecoveryResumeUnavailableError extends Error {
  readonly blockingReasons: readonly {
    code: DvdRecoveryResumeUnavailableCode;
    message: string;
  }[];

  constructor(
    readonly code: DvdRecoveryResumeUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = "DvdRecoveryResumeUnavailableError";
    this.blockingReasons = [{ code, message }];
  }
}

function recoveryResumeUnavailableMessage(
  code: DvdRecoveryResumeUnavailableCode,
): string {
  switch (code) {
    case "RECOVERY_RECONCILIATION_ACTIVE":
      return "Archive Recovery checkpoint reconciliation is active.";
    case "RECOVERY_RECONCILIATION_FAILED":
      return "Archive Recovery checkpoint reconciliation must succeed before Resume.";
    case "STORAGE_UNSUPPORTED":
      return "The archive storage contract is unavailable for Resume.";
    case "WRITER_NOT_QUIESCENT":
      return "The archive writer is not quiescent.";
    case "CONSISTENCY_FAULT":
      return "The current archive checkpoint could not be validated consistently.";
  }
}

function recoveryReconciliationUnavailable(
  reconciliation: DvdRecoveryReconciliation | null,
): DvdRecoveryResumeUnavailableError | null {
  if (reconciliation === null || reconciliation.status === "completed") {
    return null;
  }
  const code = reconciliation.status === "failed"
    ? "RECOVERY_RECONCILIATION_FAILED"
    : "RECOVERY_RECONCILIATION_ACTIVE";
  return new DvdRecoveryResumeUnavailableError(
    code,
    recoveryResumeUnavailableMessage(code),
  );
}

function recoveryResumeAvailabilityFailure(error: unknown) {
  if (
    !(error instanceof DvdCheckpointReadFault) &&
    !(error instanceof ArchiveImageOwnershipError)
  ) return null;
  let code: DvdRecoveryResumeUnavailableCode;
  if (error instanceof ArchiveImageOwnershipError) {
    code = error.code;
  } else if (
    error.code === "RECOVERY_RECONCILIATION_ACTIVE" ||
    error.code === "RECOVERY_RECONCILIATION_FAILED"
  ) {
    code = error.code;
  } else if (error.storageFault) {
    code = "STORAGE_UNSUPPORTED";
  } else {
    code = "CONSISTENCY_FAULT";
  }
  return new DvdRecoveryResumeUnavailableError(
    code,
    recoveryResumeUnavailableMessage(code),
  );
}

export function dvdRecoveryResumeAction(input: {
  recovery: ArchiveRecovery;
  checkpoint: DvdArchiveEvidenceHeader | null;
  reconciliation: DvdRecoveryReconciliation | null;
  ownershipReasons: readonly { code: string; message: string }[];
  storageReason: { code: string; message: string } | null;
  encodeJobs: readonly Pick<EncodeJob, "id" | "status" | "createdAt">[];
}) {
  const statusReason = input.recovery.status === "paused" ||
      input.recovery.status === "stopped"
    ? null
    : {
        code: `RECOVERY_${input.recovery.status.toUpperCase()}`,
        message: "Archive Recovery is not paused or stopped.",
      };
  const checkpointReason = input.checkpoint === null
    ? {
        code: "CONSISTENCY_FAULT",
        message: "Archive Recovery has no current checkpoint.",
      }
    : null;
  const reconciliationReason = input.reconciliation === null ||
      input.reconciliation.status === "completed"
    ? null
    : input.reconciliation.status === "failed"
      ? {
          code: "RECOVERY_RECONCILIATION_FAILED",
          message:
            "Archive Recovery checkpoint reconciliation must succeed before Resume.",
        }
      : {
          code: "RECOVERY_RECONCILIATION_ACTIVE",
          message: "Archive Recovery checkpoint reconciliation is active.",
        };
  const encodeConflict = createEncodeWorkConflictCurrent(
    input.recovery,
    input.encodeJobs,
  );
  const encodeReason = encodeConflict.encodeJobs.length === 0
    ? null
    : { ...ENCODE_WORK_CONFLICT, current: encodeConflict };
  const workReason = input.recovery.work?.status === "claimed"
    ? {
        code: "RECOVERY_ACTIVE",
        message: "Archive Recovery still has claimed work.",
      }
    : null;
  const blockingReasons = [
    statusReason,
    checkpointReason,
    ...input.ownershipReasons,
    reconciliationReason,
    input.storageReason,
    encodeReason,
    workReason,
  ].filter((reason) => reason !== null);
  return {
    name: "resume",
    eligible: blockingReasons.length === 0,
    available: blockingReasons.length === 0,
    reason: blockingReasons[0]?.message ?? null,
    requiredInputs: [
      "mutationKey",
      "archiveRecoveryId",
      "attemptId",
      "checkpointRevision",
      "checkpointDigest",
      "speedMode",
    ],
    blockingReasons,
    expectedInputs: input.checkpoint === null
      ? null
      : {
          archiveRecoveryId: input.recovery.id,
          attemptId: input.recovery.attemptId,
          checkpointRevision: input.checkpoint.currentManifestRevision,
          checkpointDigest: input.checkpoint.currentManifestDigest,
          speedModes: ["normal", "low"],
        },
  };
}

export async function requestDvdRecoveryResume(
  access: DataAccess,
  input: {
    mutationKey: string;
    archiveRecoveryId: ArchiveRecoveryId;
    attemptId: ArchiveRecoveryAttemptId;
    checkpointRevision: number;
    checkpointDigest: string;
    speedMode: ArchiveRecoverySpeedMode;
  },
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const replay = access.archiveRecoveryWork.replayResume(input);
  if (replay !== null) {
    return {
      archiveRecovery: visibleArchiveRecovery(replay),
      operation: {
        kind: "archive-recoveries" as const,
        id: replay.id,
        operationId: replay.resumeOperationId,
        status: replay.status,
      },
    };
  }
  const recovery = access.catalog.findArchiveRecoveryById(
    input.archiveRecoveryId,
  );
  if (recovery === null) {
    throw new RecordNotFoundError(
      "Archive Recovery",
      input.archiveRecoveryId,
    );
  }
  const reconciliationBeforeResume = access.dvdRecoveryReconciliations
    .findLatestForRecovery(recovery.id);
  const reconciliationUnavailable = recoveryReconciliationUnavailable(
    reconciliationBeforeResume,
  );
  if (reconciliationUnavailable !== null) throw reconciliationUnavailable;
  const storageReason = dvdRecoveryStorageBlockingReason(
    access.dvdRecoveryStorage.readCurrent(),
  );
  if (storageReason !== null) {
    throw new DvdRecoveryStorageUnavailableError(
      storageReason.code,
      storageReason.message,
    );
  }
  const resumeWithCurrentCheckpoint = async () => {
    const resumed = await access.withDvdCurrentCheckpoint(
      recovery.originalDiscArchiveId,
      archiveImageOwnership,
      async ({ checkpoint, assertOwned }) => {
        if (
          checkpoint.currentManifestRevision !== input.checkpointRevision ||
          checkpoint.currentManifestDigest !== input.checkpointDigest
        ) {
          throw new StaleArchiveRecoveryCheckpointError({
            archiveRecoveryId: recovery.id,
            checkpoint: {
              revision: checkpoint.currentManifestRevision,
              digest: checkpoint.currentManifestDigest,
            },
          });
        }
        assertOwned();
        return access.archiveRecoveryWork.requestResume(input);
      },
    );
    if (resumed === null) {
      throw new DvdRecoveryResumeUnavailableError(
        "CONSISTENCY_FAULT",
        "The current archive checkpoint is unavailable.",
      );
    }
    return resumed;
  };
  const mapResumeFailure = (error: unknown): never => {
    const reconciliationUnavailable = recoveryReconciliationUnavailable(
      access.dvdRecoveryReconciliations.findLatestForRecovery(recovery.id),
    );
    if (reconciliationUnavailable !== null) throw reconciliationUnavailable;
    const unavailable = recoveryResumeAvailabilityFailure(error);
    if (unavailable !== null) throw unavailable;
    throw error;
  };
  const retryAfterCompletedReconciliation = async (error: unknown) => {
    const reconciliation = access.dvdRecoveryReconciliations
      .findLatestForRecovery(recovery.id);
    const reconciliationUnavailable = recoveryReconciliationUnavailable(
      reconciliation,
    );
    if (reconciliationUnavailable !== null) throw reconciliationUnavailable;
    if (
      error instanceof DvdCheckpointReadFault &&
      (
        error.code === "DVD_EVIDENCE_CHANGED_DURING_READ" ||
        error.code === "CONSISTENCY_FAULT"
      ) &&
      reconciliation?.status === "completed" &&
      reconciliation.id !== reconciliationBeforeResume?.id
    ) {
      try {
        return await resumeWithCurrentCheckpoint();
      } catch (retryError) {
        return mapResumeFailure(retryError);
      }
    }
    return mapResumeFailure(error);
  };
  let resumed;
  try {
    resumed = await resumeWithCurrentCheckpoint();
  } catch (error) {
    resumed = await retryAfterCompletedReconciliation(error);
  }
  return {
    archiveRecovery: visibleArchiveRecovery(resumed),
    operation: {
      kind: "archive-recoveries" as const,
      id: resumed.id,
      operationId: resumed.resumeOperationId,
      status: resumed.status,
    },
  };
}
