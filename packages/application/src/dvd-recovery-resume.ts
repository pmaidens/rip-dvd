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
function recoveryResumeAvailabilityFailure(error: unknown) {
  if (
    !(error instanceof DvdCheckpointReadFault) &&
    !(error instanceof ArchiveImageOwnershipError)
  ) return null;
  const code: DvdRecoveryResumeUnavailableCode =
    error instanceof ArchiveImageOwnershipError
      ? error.code
      : error.code === "DVD_EVIDENCE_STORAGE_UNAVAILABLE"
        ? "STORAGE_UNSUPPORTED"
        : "CONSISTENCY_FAULT";
  return new DvdRecoveryResumeUnavailableError(
    code,
    code === "STORAGE_UNSUPPORTED"
      ? "The archive storage contract is unavailable for Resume."
      : code === "WRITER_NOT_QUIESCENT"
        ? "The archive writer is not quiescent."
        : "The current archive checkpoint could not be validated consistently.",
  );
}

export function dvdRecoveryResumeAction(input: {
  recovery: ArchiveRecovery;
  checkpoint: DvdArchiveEvidenceHeader | null;
  reconciliation: DvdRecoveryReconciliation | null;
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
  const reconciliationReason = input.reconciliation?.status === "queued" ||
      input.reconciliation?.status === "running"
    ? {
        code: "RECOVERY_RECONCILIATION_ACTIVE",
        message: "Archive Recovery checkpoint reconciliation is active.",
      }
    : null;
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
  const storageReason = dvdRecoveryStorageBlockingReason(
    access.dvdRecoveryStorage.readCurrent(),
  );
  if (storageReason !== null) {
    throw new DvdRecoveryStorageUnavailableError(
      storageReason.code,
      storageReason.message,
    );
  }
  try {
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
    return {
      archiveRecovery: visibleArchiveRecovery(resumed),
      operation: {
        kind: "archive-recoveries" as const,
        id: resumed.id,
        operationId: resumed.resumeOperationId,
        status: resumed.status,
      },
    };
  } catch (error) {
    const unavailable = recoveryResumeAvailabilityFailure(error);
    if (unavailable !== null) throw unavailable;
    throw error;
  }
}
