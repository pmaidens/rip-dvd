import {
  RecordNotFoundError,
  type ArchiveRecovery,
  type ArchiveRecoveryId,
  type DataAccess,
  type DvdRecoveryReconciliation,
} from "@rip-dvd/data-access";
import { visibleArchiveRecovery } from "./archive-recovery-view.js";

function visibleReconciliation(record: DvdRecoveryReconciliation) {
  const {
    claimToken: _claimToken,
    ...visible
  } = record;
  return {
    ...visible,
    claimedAt: record.claimedAt?.toISOString() ?? null,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function reconciliationContext(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
) {
  const recovery = access.catalog.findArchiveRecoveryById(archiveRecoveryId);
  if (recovery === null) {
    throw new RecordNotFoundError("archive recovery", archiveRecoveryId);
  }
  return recovery;
}

export function dvdRecoveryReconciliationBlockingReasons(
  recovery: Pick<ArchiveRecovery, "status" | "work">,
  latest: Pick<DvdRecoveryReconciliation, "status"> | null,
) {
  const active = latest?.status === "queued" || latest?.status === "running";
  const recoveryPassReserved = recovery.status === "running" ||
    recovery.status === "stopping" ||
    ((recovery.status === "eligible" || recovery.status === "paused") &&
      recovery.work?.status === "requested");
  return [
    ...(active ? [{
        code: "RECONCILIATION_ACTIVE",
        message: "A DVD recovery reconciliation is already active.",
      }] : []),
    ...(recoveryPassReserved ? [{
      code: "RECOVERY_PASS_ACTIVE",
      message:
        "The retained DVD recovery pass must be stopped before reconciliation.",
    }] : []),
  ];
}

export function inspectDvdRecoveryReconciliation(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
) {
  const recovery = reconciliationContext(access, archiveRecoveryId);
  const latest = access.dvdRecoveryReconciliations.findLatestForRecovery(
    recovery.id,
  );
  const blockingReasons = dvdRecoveryReconciliationBlockingReasons(
    recovery,
    latest,
  );
  return {
    archiveRecovery: visibleArchiveRecovery(recovery),
    checkpoint: access.catalog.findDvdArchiveEvidenceHeader(
      recovery.originalDiscArchiveId,
    ),
    reconciliation: latest === null ? null : visibleReconciliation(latest),
    action: {
      name: "reconcile",
      available: blockingReasons.length === 0,
      blockingReasons,
      expectedInputs: {
        archiveRecoveryId: recovery.id,
      },
    },
  };
}

export function requestDvdRecoveryReconciliation(
  access: DataAccess,
  input: {
    mutationKey: string;
    archiveRecoveryId: ArchiveRecoveryId;
  },
) {
  reconciliationContext(access, input.archiveRecoveryId);
  return {
    reconciliation: visibleReconciliation(
      access.dvdRecoveryReconciliations.submit(input),
    ),
  };
}
