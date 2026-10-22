import {
  archiveRecoveryWorkIdentity,
  RecordNotFoundError,
  type ArchiveRecoveryId,
  type DataAccess,
  type DvdRecoveryReconciliation,
} from "@rip-dvd/data-access";

function visibleArchiveRecovery(
  recovery: ReturnType<typeof reconciliationContext>,
) {
  return {
    ...recovery,
    work: recovery.work === null
      ? null
      : archiveRecoveryWorkIdentity(recovery.work),
  };
}

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

export function inspectDvdRecoveryReconciliation(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
) {
  const recovery = reconciliationContext(access, archiveRecoveryId);
  const latest = access.dvdRecoveryReconciliations.findLatestForRecovery(
    recovery.id,
  );
  const active = latest?.status === "queued" || latest?.status === "running";
  const blockingReasons = active
    ? [{
        code: "RECONCILIATION_ACTIVE",
        message: "A DVD recovery reconciliation is already active.",
      }]
    : [];
  return {
    archiveRecovery: visibleArchiveRecovery(recovery),
    checkpoint: access.catalog.findDvdArchiveEvidenceHeader(
      recovery.originalDiscArchiveId,
    ),
    reconciliation: latest === null ? null : visibleReconciliation(latest),
    action: {
      name: "reconcile",
      available: !active,
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
