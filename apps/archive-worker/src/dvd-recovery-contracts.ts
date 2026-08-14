import {
  createCleanReadArchiveIntegrityEvidence,
  type CleanReadArchiveIntegrityEvidence,
} from "@rip-dvd/data-access";

export const DVD_RECOVERY_POLICY_VERSION = "dvd-recovery-v1";

export interface CleanDvdRecoveryResult {
  outcome: "clean";
  declaredByteCount: number;
  recoveredByteCount: number;
  recoveryPolicyVersion: typeof DVD_RECOVERY_POLICY_VERSION;
  badSectorCount: 0;
  badAreaCount: 0;
  unrecoveredSectorRanges: readonly [];
}

/** Extended with damaged-sector outcomes by the rescue workflow. */
export type DvdRecoveryResult = CleanDvdRecoveryResult;

export interface PublishableDvdValidationResult {
  outcome: "publish";
  integrityEvidence: CleanReadArchiveIntegrityEvidence;
}

/** Extended with validation rejection and salvage outcomes by rescue slices. */
export type DvdValidationResult = PublishableDvdValidationResult;

export function createCleanDvdRecoveryResult(
  declaredByteCount: number,
): CleanDvdRecoveryResult {
  return {
    outcome: "clean",
    declaredByteCount,
    recoveredByteCount: declaredByteCount,
    recoveryPolicyVersion: DVD_RECOVERY_POLICY_VERSION,
    badSectorCount: 0,
    badAreaCount: 0,
    unrecoveredSectorRanges: [],
  };
}

export function validateDvdRecoveryResult(
  result: unknown,
  expectedByteCount: number,
): DvdValidationResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("outcome" in result) ||
    result.outcome !== "clean" ||
    !("declaredByteCount" in result) ||
    result.declaredByteCount !== expectedByteCount ||
    !("recoveredByteCount" in result) ||
    result.recoveredByteCount !== expectedByteCount ||
    !("recoveryPolicyVersion" in result) ||
    result.recoveryPolicyVersion !== DVD_RECOVERY_POLICY_VERSION ||
    !("badSectorCount" in result) ||
    result.badSectorCount !== 0 ||
    !("badAreaCount" in result) ||
    result.badAreaCount !== 0 ||
    !("unrecoveredSectorRanges" in result) ||
    !Array.isArray(result.unrecoveredSectorRanges) ||
    result.unrecoveredSectorRanges.length !== 0
  ) {
    throw new Error("DVD recovery result is invalid");
  }
  return {
    outcome: "publish",
    integrityEvidence: createCleanReadArchiveIntegrityEvidence(
      DVD_RECOVERY_POLICY_VERSION,
    ),
  };
}
