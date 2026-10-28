import {
  createDvdDiscVerificationResultDigest,
  dvdConfirmedRecoveryWriteAuthority,
  StaleDvdDiscConfirmationError,
  type ArchiveRecoveryAttemptId,
  type ArchiveRecoveryId,
  type DataAccess,
  type DetectedDiscId,
  type DiscInspectionId,
  type DvdDiscConfirmation,
  type DvdDiscVerification,
  type DvdDiscVerificationId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import {
  inspectDvdDiscVerification,
} from "./dvd-disc-verification.js";

function visibleConfirmation(
  confirmation: DvdDiscConfirmation,
  current: boolean,
) {
  return {
    ...confirmation,
    current,
    expiredAt: confirmation.expiredAt?.toISOString() ?? null,
    createdAt: confirmation.createdAt.toISOString(),
  };
}

function confirmationIsCurrent(
  confirmation: DvdDiscConfirmation,
  verification: DvdDiscVerification,
  input: {
    archiveRecoveryId: string;
    originalDiscArchiveId: string;
    archiveRecoveryAttemptId: string;
    checkpoint: { revision: number; digest: string } | null;
    insertion: {
      discInspectionId: string;
      detectedDiscId: string;
      mediaGeneration: string;
    } | null;
  },
): boolean {
  return confirmation.expiredAt === null &&
    confirmation.archiveRecoveryId === input.archiveRecoveryId &&
    confirmation.originalDiscArchiveId === input.originalDiscArchiveId &&
    confirmation.archiveRecoveryAttemptId ===
      input.archiveRecoveryAttemptId &&
    confirmation.verificationId === verification.id &&
    confirmation.verificationWorkerExecutionId ===
      verification.workerExecutionId &&
    confirmation.verificationOutcome === verification.outcome &&
    confirmation.verificationResultDigest ===
      createDvdDiscVerificationResultDigest(verification) &&
    input.insertion !== null &&
    confirmation.discInspectionId === input.insertion.discInspectionId &&
    confirmation.detectedDiscId === input.insertion.detectedDiscId &&
    confirmation.mediaGeneration === input.insertion.mediaGeneration &&
    input.checkpoint !== null &&
    confirmation.checkpointRevision === input.checkpoint.revision &&
    confirmation.checkpointDigest === input.checkpoint.digest &&
    verification.checkpointRevision === input.checkpoint.revision &&
    verification.checkpointDigest === input.checkpoint.digest;
}

async function inspectDvdDiscConfirmation(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const inspection = await inspectDvdDiscVerification(
    access,
    archiveRecoveryId,
    archiveImageOwnership,
  );
  const latestConfirmation = access.dvdDiscConfirmations
    .findLatestForRecovery(archiveRecoveryId);
  const confirmationProvenance = access.dvdDiscConfirmations
    .listProvenanceForRecovery(archiveRecoveryId);
  const verification = inspection.verification;
  const persistedVerification = verification === null
    ? null
    : access.dvdDiscVerifications.find(verification.id);
  const recovery = access.catalog.findArchiveRecoveryById(archiveRecoveryId);
  const waitingResumeConfirmation = recovery?.status === "waiting_for_disc" &&
    recovery.resumeOperationId !== null &&
    recovery.work?.status === "requested" &&
    recovery.work.verificationId === persistedVerification?.id;
  const expiredConfirmationForVerification = latestConfirmation !== null &&
    persistedVerification !== null &&
    latestConfirmation.verificationId === persistedVerification.id &&
    latestConfirmation.expiredAt !== null;
  const blockingReasons = inspection.writeAuthority.blockingReasons.filter(
    (reason) =>
      reason.code !== "DISC_VERIFICATION_MISMATCH" &&
      reason.code !== "DISC_VERIFICATION_INCONCLUSIVE" &&
      !(waitingResumeConfirmation &&
        reason.code === "RECOVERY_WAITING_FOR_DISC"),
  );
  if (verification === null) {
    blockingReasons.push({
      code: "DISC_VERIFICATION_REQUIRED",
      message: "A completed mismatch or inconclusive verification is required.",
    });
  } else if (
    !verification.current ||
    verification.status !== "completed" ||
    verification.outcome === null ||
    verification.outcome === "match" ||
    verification.workerExecutionId === null
  ) {
    blockingReasons.push({
      code: verification.outcome === "match"
        ? "DISC_CONFIRMATION_NOT_REQUIRED"
        : "DISC_CONFIRMATION_EXPIRED",
      message: verification.outcome === "match"
        ? "The current DVD Disc Verification already established a match."
        : "The reviewed DVD Disc Verification is not current and complete.",
    });
  } else if (expiredConfirmationForVerification) {
    blockingReasons.push({
      code: "DISC_CONFIRMATION_EXPIRED",
      message:
        "The prior confirmation expired; run a new DVD Disc Verification before confirming again.",
    });
  }
  const expectedInputs = verification === null ||
      persistedVerification === null ||
      !verification.current ||
      verification.status !== "completed" ||
      verification.outcome === null ||
      verification.outcome === "match" ||
      verification.workerExecutionId === null ||
      expiredConfirmationForVerification ||
      inspection.checkpoint === null ||
      inspection.insertion === null
    ? null
    : {
        archiveRecoveryId: inspection.archiveRecovery.id,
        originalDiscArchiveId:
          inspection.archiveRecovery.originalDiscArchiveId,
        archiveRecoveryAttemptId: inspection.archiveRecovery.attemptId,
        discInspectionId: inspection.insertion.discInspectionId,
        detectedDiscId: inspection.insertion.detectedDiscId,
        mediaGeneration: inspection.insertion.mediaGeneration,
        verificationId: verification.id,
        verificationWorkerExecutionId: verification.workerExecutionId,
        verificationOutcome: verification.outcome,
        verificationResultDigest: createDvdDiscVerificationResultDigest(
          persistedVerification,
        ),
        checkpointRevision: inspection.checkpoint.revision,
        checkpointDigest: inspection.checkpoint.digest,
        acknowledgeMixedSource: true as const,
      };
  const confirmationCurrent = latestConfirmation !== null &&
    persistedVerification !== null &&
    confirmationIsCurrent(latestConfirmation, persistedVerification, {
      archiveRecoveryId: inspection.archiveRecovery.id,
      originalDiscArchiveId:
        inspection.archiveRecovery.originalDiscArchiveId,
      archiveRecoveryAttemptId: inspection.archiveRecovery.attemptId,
      checkpoint: inspection.checkpoint,
      insertion: inspection.insertion,
    });
  const authority = confirmationCurrent && latestConfirmation !== null &&
      persistedVerification !== null
    ? dvdConfirmedRecoveryWriteAuthority(
        persistedVerification,
        latestConfirmation,
      )
    : null;
  return {
    verificationAction: inspection.action,
    preview: {
      archiveRecovery: inspection.archiveRecovery,
      checkpoint: inspection.checkpoint,
      insertion: inspection.insertion,
      insertionCandidates: inspection.insertionCandidates,
      verification,
      confirmation: latestConfirmation === null
        ? null
        : visibleConfirmation(latestConfirmation, confirmationCurrent),
      provenance: {
        imageUsesConfirmedSource:
          confirmationProvenance.imageUsesConfirmedSource,
        confirmations: confirmationProvenance.items.map((entry) => ({
          confirmation: visibleConfirmation(
            entry.confirmation,
            confirmationCurrent &&
              entry.confirmation.id === latestConfirmation?.id,
          ),
          recoveredSectorCount: entry.recoveredSectorCount,
          failedReadCount: entry.failedReadCount,
          firstRecoveredLba: entry.firstRecoveredLba,
          lastRecoveredLba: entry.lastRecoveredLba,
          recoveredRanges: entry.recoveredRanges,
          recoveredRangesTruncated: entry.recoveredRangesTruncated,
        })),
        truncated: confirmationProvenance.truncated,
      },
      writeAuthority: authority === null || blockingReasons.length > 0
        ? { available: false, blockingReasons }
        : { available: true, blockingReasons: [], authority },
      action: {
        name: "confirm-disc",
        available: blockingReasons.length === 0 && !confirmationCurrent,
        blockingReasons: confirmationCurrent
          ? [{
              code: "DISC_ALREADY_CONFIRMED",
              message: "The current DVD Disc Verification is already confirmed.",
            }]
          : blockingReasons,
        expectedInputs,
      },
    },
  };
}

export async function inspectDvdDiscSourceIdentity(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  return inspectDvdDiscConfirmation(
    access,
    archiveRecoveryId,
    archiveImageOwnership,
  );
}

export async function previewDvdDiscConfirmation(
  access: DataAccess,
  archiveRecoveryId: ArchiveRecoveryId,
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  return (await inspectDvdDiscConfirmation(
    access,
    archiveRecoveryId,
    archiveImageOwnership,
  )).preview;
}

export async function recordDvdDiscConfirmation(
  access: DataAccess,
  input: {
    mutationKey: string;
    archiveRecoveryId: ArchiveRecoveryId;
    originalDiscArchiveId: OriginalDiscArchiveId;
    archiveRecoveryAttemptId: ArchiveRecoveryAttemptId;
    discInspectionId: DiscInspectionId;
    detectedDiscId: DetectedDiscId;
    mediaGeneration: string;
    verificationId: DvdDiscVerificationId;
    verificationWorkerExecutionId: string;
    verificationOutcome: "mismatch" | "inconclusive";
    verificationResultDigest: string;
    checkpointRevision: number;
    checkpointDigest: string;
    acknowledgeMixedSource: true;
  },
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  const replay = access.dvdDiscConfirmations.replaySubmission(input);
  if (replay !== null) {
    const current = access.dvdDiscConfirmations.find(replay.id) ?? replay;
    return {
      confirmation: visibleConfirmation(current, current.expiredAt === null),
    };
  }
  const result = await access.withDvdCurrentCheckpoint(
    input.originalDiscArchiveId,
    archiveImageOwnership,
    async ({ checkpoint, assertOwned }) => {
      if (
        checkpoint.currentManifestRevision !== input.checkpointRevision ||
        checkpoint.currentManifestDigest !== input.checkpointDigest
      ) {
        throw new StaleDvdDiscConfirmationError([{
          code: "DISC_CHECKPOINT_CHANGED",
          message: "The archive checkpoint changed after preview.",
        }]);
      }
      assertOwned();
      const confirmation = access.dvdDiscConfirmations.record(input);
      assertOwned();
      return { confirmation: visibleConfirmation(confirmation, true) };
    },
  );
  if (result === null) {
    throw new StaleDvdDiscConfirmationError([{
      code: "DISC_CHECKPOINT_CHANGED",
      message: "The archive checkpoint changed after preview.",
    }]);
  }
  return result;
}
