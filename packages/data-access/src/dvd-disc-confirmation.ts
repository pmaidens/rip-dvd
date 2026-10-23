import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { DomainInvariantError } from "./errors.js";
import type {
  DvdDiscConfirmation,
  DvdDiscVerification,
  DvdRecoveryWriteAuthority,
} from "./types.js";

const VERIFICATION_RESULT_DIGEST_DOMAIN =
  "rip-dvd:dvd-disc-verification-result:v1\0";

export function createDvdDiscVerificationResultDigest(
  verification: Pick<
    DvdDiscVerification,
    | "id"
    | "archiveRecoveryId"
    | "archiveRecoveryAttemptId"
    | "originalDiscArchiveId"
    | "discInspectionId"
    | "detectedDiscId"
    | "mediaGeneration"
    | "sourceMetadataFingerprint"
    | "observedMetadataFingerprint"
    | "workerExecutionId"
    | "checkpointRevision"
    | "checkpointDigest"
    | "outcome"
    | "reasons"
    | "findings"
    | "budgetExhausted"
  >,
): string {
  if (
    verification.archiveRecoveryAttemptId === null ||
    verification.workerExecutionId === null ||
    verification.outcome === null
  ) {
    throw new DomainInvariantError(
      "DVD Disc Verification result is not complete",
    );
  }
  return createHash("sha256")
    .update(VERIFICATION_RESULT_DIGEST_DOMAIN)
    .update(canonicalJson({
      id: verification.id,
      archiveRecoveryId: verification.archiveRecoveryId,
      archiveRecoveryAttemptId: verification.archiveRecoveryAttemptId,
      originalDiscArchiveId: verification.originalDiscArchiveId,
      discInspectionId: verification.discInspectionId,
      detectedDiscId: verification.detectedDiscId,
      mediaGeneration: verification.mediaGeneration,
      sourceMetadataFingerprint: verification.sourceMetadataFingerprint,
      observedMetadataFingerprint: verification.observedMetadataFingerprint,
      workerExecutionId: verification.workerExecutionId,
      checkpointRevision: verification.checkpointRevision,
      checkpointDigest: verification.checkpointDigest,
      outcome: verification.outcome,
      reasons: verification.reasons,
      findings: verification.findings,
      budgetExhausted: verification.budgetExhausted,
    }))
    .digest("hex");
}

export function dvdDiscConfirmationMatchesVerification(
  verification: DvdDiscVerification,
  confirmation: DvdDiscConfirmation,
): boolean {
  return !(
    verification.status !== "completed" ||
    verification.outcome === null ||
    verification.outcome === "match" ||
    verification.archiveRecoveryAttemptId === null ||
    verification.workerExecutionId === null ||
    confirmation.acknowledgedMixedSource !== true ||
    confirmation.archiveRecoveryId !== verification.archiveRecoveryId ||
    confirmation.archiveRecoveryAttemptId !==
      verification.archiveRecoveryAttemptId ||
    confirmation.originalDiscArchiveId !==
      verification.originalDiscArchiveId ||
    confirmation.verificationId !== verification.id ||
    confirmation.discInspectionId !== verification.discInspectionId ||
    confirmation.detectedDiscId !== verification.detectedDiscId ||
    confirmation.mediaGeneration !== verification.mediaGeneration ||
    confirmation.verificationWorkerExecutionId !==
      verification.workerExecutionId ||
    confirmation.verificationOutcome !== verification.outcome ||
    confirmation.verificationResultDigest !==
      createDvdDiscVerificationResultDigest(verification) ||
    confirmation.checkpointRevision !== verification.checkpointRevision ||
    confirmation.checkpointDigest !== verification.checkpointDigest
  );
}

export function dvdConfirmedRecoveryWriteAuthority(
  verification: DvdDiscVerification,
  confirmation: DvdDiscConfirmation,
): DvdRecoveryWriteAuthority | null {
  if (
    confirmation.expiredAt !== null ||
    verification.archiveRecoveryAttemptId === null ||
    verification.workerExecutionId === null ||
    !dvdDiscConfirmationMatchesVerification(verification, confirmation)
  ) return null;
  return {
    verificationId: verification.id,
    archiveRecoveryId: verification.archiveRecoveryId,
    archiveRecoveryAttemptId: verification.archiveRecoveryAttemptId,
    originalDiscArchiveId: verification.originalDiscArchiveId,
    discInspectionId: verification.discInspectionId,
    detectedDiscId: verification.detectedDiscId,
    mediaGeneration: verification.mediaGeneration,
    verificationWorkerExecutionId: verification.workerExecutionId,
    checkpointRevision: verification.checkpointRevision,
    checkpointDigest: verification.checkpointDigest,
    discConfirmationId: confirmation.id,
  };
}
