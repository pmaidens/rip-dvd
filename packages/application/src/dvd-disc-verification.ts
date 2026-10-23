import {
  assertDvdSourceSampleManifestProjection,
  DvdCheckpointReadFault,
  dvdRecoveryStorageBlockingReason,
  ENCODE_WORK_CONFLICT,
  dvdDiscVerificationCheckpointIsCurrent,
  dvdDiscVerificationInsertionIsCurrent,
  dvdRecoveryWriteAuthority,
  RecordNotFoundError,
  StaleDvdDiscVerificationError,
  DvdSourceSampleManifestProjectionError,
  type ArchiveRecoveryId,
  type DataAccess,
  type DiscInspectionId,
  type DvdSourceSampleManifest,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import { visibleArchiveRecovery } from "./archive-recovery-view.js";

export type DvdDiscVerificationAvailabilityCode =
  | "CONSISTENCY_FAULT"
  | "STORAGE_UNSUPPORTED"
  | "WRITER_NOT_QUIESCENT";

export class DvdDiscVerificationUnavailableError extends Error {
  constructor(
    readonly code: DvdDiscVerificationAvailabilityCode,
    message: string,
  ) {
    super(message);
    this.name = "DvdDiscVerificationUnavailableError";
  }
}

function checkpointAvailabilityFailure(error: unknown):
  { code: DvdDiscVerificationAvailabilityCode; message: string } | null {
  if (
    !(error instanceof DvdCheckpointReadFault) &&
    !(error instanceof ArchiveImageOwnershipError) &&
    !(error instanceof DvdSourceSampleManifestProjectionError)
  ) return null;
  const code: DvdDiscVerificationAvailabilityCode =
    error instanceof ArchiveImageOwnershipError
      ? error.code
      : error instanceof DvdCheckpointReadFault &&
          error.code === "DVD_EVIDENCE_STORAGE_UNAVAILABLE"
        ? "STORAGE_UNSUPPORTED"
        : "CONSISTENCY_FAULT";
  return {
    code,
    message: code === "STORAGE_UNSUPPORTED"
      ? "The archive storage contract is unavailable for a stable checkpoint read."
      : code === "WRITER_NOT_QUIESCENT"
        ? "The archive writer is not quiescent."
        : "The current archive checkpoint could not be validated consistently.",
  };
}

function visibleVerification(
  verification: NonNullable<ReturnType<
    DataAccess["dvdDiscVerifications"]["findLatestForRecovery"]
  >>,
  current: boolean,
) {
  const {
    claimToken: _claimToken,
    admittedDevicePath: _admittedDevicePath,
    admittedDeviceId: _admittedDeviceId,
    admittedDeviceInode: _admittedDeviceInode,
    ...visible
  } = verification;
  return {
    ...visible,
    current,
    claimedAt: verification.claimedAt?.toISOString() ?? null,
    startedAt: verification.startedAt?.toISOString() ?? null,
    completedAt: verification.completedAt?.toISOString() ?? null,
    createdAt: verification.createdAt.toISOString(),
    updatedAt: verification.updatedAt.toISOString(),
  };
}

function authoritativeSourceSampleManifest(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  published: DvdSourceSampleManifest | null,
): DvdSourceSampleManifest | null {
  const projected = access.catalog.findDvdSourceSampleManifest(archiveId);
  assertDvdSourceSampleManifestProjection(published, projected);
  return published;
}

function currentDiscVerificationInsertion(
  access: DataAccess,
  sourceDriveId: string,
) {
  const candidates = access.discInspections.list({
    currentOnly: true,
  }).filter((inspection) =>
    inspection.status === "completed" &&
    inspection.detectedDiscId !== null
  ).map((inspection) => ({
    discInspectionId: inspection.id,
    detectedDiscId: inspection.detectedDiscId!,
    mediaGeneration: inspection.mediaGeneration,
    opticalDriveId: inspection.opticalDriveId,
  }));
  const sourceDriveInsertion = candidates.find((candidate) =>
    candidate.opticalDriveId === sourceDriveId
  );
  const current = sourceDriveInsertion ??
    (candidates.length === 1 ? candidates[0]! : null);
  const visible = candidates.map(({ opticalDriveId: _opticalDriveId, ...item }) =>
    item);
  return {
    current: current === null
      ? null
      : {
          discInspectionId: current.discInspectionId,
          detectedDiscId: current.detectedDiscId,
          mediaGeneration: current.mediaGeneration,
        },
    candidates: visible,
  };
}

function staleDiscVerificationError(
  access: DataAccess,
  input: {
    code: "DISC_INSERTION_CHANGED" | "DISC_CHECKPOINT_CHANGED";
    archiveId: OriginalDiscArchiveId;
    sourceDriveId: string;
    fallbackCheckpoint: { revision: number; digest: string };
  },
): StaleDvdDiscVerificationError {
  const insertion = currentDiscVerificationInsertion(
    access,
    input.sourceDriveId,
  );
  const header = access.catalog.findDvdArchiveEvidenceHeader(input.archiveId);
  return new StaleDvdDiscVerificationError(input.code, {
    checkpoint: header === null
      ? input.fallbackCheckpoint
      : {
          revision: header.currentManifestRevision,
          digest: header.currentManifestDigest,
        },
    insertion: insertion.current,
    insertionCandidates: insertion.candidates,
  });
}

function dvdDiscVerificationContext(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
) {
  const recovery = access.catalog.findArchiveRecoveryById(archiveRecoveryId);
  if (recovery === null) {
    throw new RecordNotFoundError("archive recovery", archiveRecoveryId);
  }
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [recovery.originalDiscArchiveId],
  })[0];
  if (archive === undefined) {
    throw new RecordNotFoundError(
      "original disc archive",
      recovery.originalDiscArchiveId,
    );
  }
  const sourceDisc = access.catalog.listDetectedDiscs(undefined, {
    ids: [archive.detectedDiscId],
  })[0];
  if (sourceDisc === undefined) {
    throw new RecordNotFoundError("detected disc", archive.detectedDiscId);
  }
  return { archive, recovery, sourceDisc };
}

export async function inspectDvdDiscVerification(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const { archive, recovery, sourceDisc } = dvdDiscVerificationContext(
    access,
    archiveRecoveryId,
  );
  const inspectAtCheckpoint = (checkpoint: {
    revision: number;
    digest: string;
  } | null, sourceSampleManifest: DvdSourceSampleManifest | null,
  checkpointFailure: { code: string; message: string } | null = null) => {
    const header = checkpointFailure === null
      ? access.catalog.findDvdArchiveEvidenceHeader(archive.id)
      : null;
    const currentInsertion = currentDiscVerificationInsertion(
      access,
      sourceDisc.opticalDriveId,
    );
    const currentInspection = currentInsertion.current;
    const latest = access.dvdDiscVerifications.findLatestForRecovery(
      recovery.id,
    );
    const latestInspection = latest === null
      ? null
      : access.discInspections.list({ ids: [latest.discInspectionId] })[0] ??
        null;
    const latestCurrent = latest !== null &&
      latest.archiveRecoveryAttemptId === recovery.attemptId &&
      dvdDiscVerificationInsertionIsCurrent(latest, latestInspection) &&
      dvdDiscVerificationCheckpointIsCurrent(latest, checkpoint) &&
      header !== null &&
      dvdDiscVerificationCheckpointIsCurrent(latest, {
        revision: header.currentManifestRevision,
        digest: header.currentManifestDigest,
      });
    const checkpointReason = checkpointFailure ?? (checkpoint === null ||
      header === null ||
      header.currentManifestRevision !== checkpoint.revision ||
      header.currentManifestDigest !== checkpoint.digest
      ? {
          code: "UNSUPPORTED_EVIDENCE_FORMAT",
          message: "The archive has no current DVD recovery checkpoint.",
        }
      : null);
    const blockingReasons: Array<{ code: string; message: string }> = [];
    if (checkpointReason !== null) {
      blockingReasons.push(checkpointReason);
    }
    if (
      currentInspection === null && currentInsertion.candidates.length === 0
    ) {
      blockingReasons.push({
        code: "DISC_ABSENT",
        message: "No current completed disc insertion is available.",
      });
    } else if (currentInspection === null) {
      blockingReasons.push({
        code: "DISC_INSERTION_AMBIGUOUS",
        message: "More than one current disc insertion is available.",
      });
    }
    if (recovery.status !== "eligible") {
      blockingReasons.push({
        code: `RECOVERY_${recovery.status.toUpperCase()}`,
        message: "Archive Recovery is not eligible for DVD Disc Verification.",
      });
    }
    const active = latest?.status === "queued" ||
      latest?.status === "running";
    if (active) {
      blockingReasons.push({
        code: "DISC_VERIFICATION_ACTIVE",
        message: "A DVD Disc Verification is already active.",
      });
    }
    const encodeWorkConflict = access.archiveRecoveryWork
      .findEncodeWorkConflict(recovery.id);
    if (encodeWorkConflict !== null) {
      blockingReasons.push(ENCODE_WORK_CONFLICT);
    }
    return {
      archiveRecovery: visibleArchiveRecovery(recovery),
      checkpoint,
      insertion: currentInspection === null ? null : {
        discInspectionId: currentInspection.discInspectionId,
        detectedDiscId: currentInspection.detectedDiscId,
        mediaGeneration: currentInspection.mediaGeneration,
      },
      insertionCandidates: currentInsertion.candidates,
      sourceSampleManifest,
      verification: latest === null
        ? null
        : visibleVerification(latest, latestCurrent),
      writeAuthority: (() => {
        const storageReason = dvdRecoveryStorageBlockingReason(
          access.dvdRecoveryStorage.readCurrent(),
        );
        const verificationReason = latest === null
          ? {
              code: "DISC_VERIFICATION_REQUIRED",
              message: "The current insertion has not been verified.",
            }
          : !latestCurrent
            ? {
                code: "DISC_VERIFICATION_STALE",
                message: "The verification does not match the current insertion and checkpoint.",
              }
            : latest.status !== "completed" || latest.outcome !== "match"
              ? {
                  code: latest.outcome === "mismatch"
                    ? "DISC_VERIFICATION_MISMATCH"
                    : "DISC_VERIFICATION_INCONCLUSIVE",
                  message: latest.outcome === "mismatch"
                    ? "Automatic verification found conflicting source evidence."
                    : "Automatic verification did not establish a sampled match.",
                }
              : latest.workerExecutionId === null
                ? {
                    code: "DISC_VERIFICATION_STALE",
                    message: "The verification has no durable worker execution binding.",
                  }
              : null;
        const workflowReason = recovery.status !== "eligible"
          ? {
              code: `RECOVERY_${recovery.status.toUpperCase()}`,
              message: "Archive Recovery is not eligible for source updates.",
            }
          : null;
        const authorityReasons = [
          checkpointReason,
          storageReason,
          verificationReason,
          workflowReason,
          encodeWorkConflict === null ? null : ENCODE_WORK_CONFLICT,
        ].filter((reason) => reason !== null);
        const authority = latest === null
          ? null
          : dvdRecoveryWriteAuthority(latest);
        return authorityReasons.length === 0 && authority !== null
          ? { available: true, blockingReasons: [], authority }
          : { available: false, blockingReasons: authorityReasons };
      })(),
      action: {
        name: "verify-disc",
        available: blockingReasons.length === 0,
        blockingReasons,
        expectedInputs: currentInspection === null || checkpoint === null
          ? null
          : {
              archiveRecoveryId: recovery.id,
              discInspectionId: currentInspection.discInspectionId,
              checkpointRevision: checkpoint.revision,
              checkpointDigest: checkpoint.digest,
            },
      },
    };
  };
  try {
    const inspected = await access.withDvdCurrentCheckpoint(
      archive.id,
      archiveImageOwnership,
      async ({ checkpoint }) => inspectAtCheckpoint({
        revision: checkpoint.currentManifestRevision,
        digest: checkpoint.currentManifestDigest,
      }, authoritativeSourceSampleManifest(
        access,
        archive.id,
        checkpoint.initialEvidence.sourceSampleManifest ?? null,
      )),
    );
    return inspected ?? inspectAtCheckpoint(null, null);
  } catch (error) {
    const failure = checkpointAvailabilityFailure(error);
    if (failure === null) throw error;
    return inspectAtCheckpoint(null, null, failure);
  }
}

export async function requestDvdDiscVerification(
  access: DataAccess,
  input: {
    mutationKey: string;
    archiveRecoveryId: ArchiveRecoveryId;
    discInspectionId: DiscInspectionId;
    checkpointRevision: number;
    checkpointDigest: string;
  },
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const { archive, recovery, sourceDisc } = dvdDiscVerificationContext(
    access,
    input.archiveRecoveryId,
  );
  const replay = access.dvdDiscVerifications.replaySubmission(input);
  if (replay !== null) {
    return { verification: visibleVerification(replay, true) };
  }
  let submitted;
  try {
    submitted = await access.withDvdCurrentCheckpoint(
      recovery.originalDiscArchiveId,
      archiveImageOwnership,
      async ({ checkpoint, assertOwned }) => {
        if (!dvdDiscVerificationCheckpointIsCurrent(input, {
          revision: checkpoint.currentManifestRevision,
          digest: checkpoint.currentManifestDigest,
        })) {
          throw staleDiscVerificationError(access, {
            code: "DISC_CHECKPOINT_CHANGED",
            archiveId: archive.id,
            sourceDriveId: sourceDisc.opticalDriveId,
            fallbackCheckpoint: {
              revision: checkpoint.currentManifestRevision,
              digest: checkpoint.currentManifestDigest,
            },
          });
        }
        authoritativeSourceSampleManifest(
          access,
          recovery.originalDiscArchiveId,
          checkpoint.initialEvidence.sourceSampleManifest ?? null,
        );
        assertOwned();
        let verification;
        try {
          verification = access.dvdDiscVerifications.submit(input);
        } catch (error) {
          if (error instanceof StaleDvdDiscVerificationError) {
            throw staleDiscVerificationError(access, {
              code: error.code,
              archiveId: archive.id,
              sourceDriveId: sourceDisc.opticalDriveId,
              fallbackCheckpoint: {
                revision: checkpoint.currentManifestRevision,
                digest: checkpoint.currentManifestDigest,
              },
            });
          }
          throw error;
        }
        assertOwned();
        return {
          verification: visibleVerification(verification, true),
        };
      },
    );
  } catch (error) {
    const failure = checkpointAvailabilityFailure(error);
    if (failure === null) throw error;
    throw new DvdDiscVerificationUnavailableError(
      failure.code,
      failure.message,
    );
  }
  if (submitted === null) {
    throw new StaleDvdDiscVerificationError(
      "DISC_CHECKPOINT_CHANGED",
    );
  }
  return submitted;
}
