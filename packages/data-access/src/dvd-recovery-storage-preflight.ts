export const DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION =
  "dvd-recovery-storage-preflight-v1" as const;

export const DVD_RECOVERY_JOURNAL_RESERVATION_BYTES = 1_048_576;

export const DVD_RECOVERY_STORAGE_PREFLIGHT_STATUSES = [
  "supported",
  "unsupported",
  "failed_prerequisite",
] as const;

export const DVD_RECOVERY_STORAGE_REASON_CODES = [
  "STORAGE_UNSUPPORTED",
  "STORAGE_INSPECTION_FAILED",
  "JOURNAL_RESERVATION_FAILED",
  "JOURNAL_SYNC_FAILED",
  "IMAGE_SYNC_FAILED",
  "CHECKPOINT_SYNC_FAILED",
  "CHECKPOINT_REPLACEMENT_FAILED",
  "DIRECTORY_SYNC_FAILED",
  "WRITER_EXCLUSION_FAILED",
  "PREFLIGHT_CLEANUP_FAILED",
] as const;

export const DVD_RECOVERY_STORAGE_REASON_MESSAGES = {
  STORAGE_UNSUPPORTED:
    "The Originals Library storage has not demonstrated the recovery durability and ownership contract.",
  STORAGE_INSPECTION_FAILED:
    "The Originals Library storage could not be inspected for recovery prerequisites.",
  JOURNAL_RESERVATION_FAILED:
    "The bounded recovery undo journal could not reserve its required space.",
  JOURNAL_SYNC_FAILED:
    "The recovery undo journal could not be synchronized before image mutation.",
  IMAGE_SYNC_FAILED:
    "A recovery image update could not be synchronized durably.",
  CHECKPOINT_SYNC_FAILED:
    "Recovery checkpoint evidence could not be synchronized durably.",
  CHECKPOINT_REPLACEMENT_FAILED:
    "The authoritative recovery checkpoint could not be replaced atomically.",
  DIRECTORY_SYNC_FAILED:
    "Recovery journal or checkpoint directory updates could not be synchronized durably.",
  WRITER_EXCLUSION_FAILED:
    "Cross-process recovery writer exclusion could not be established.",
  PREFLIGHT_CLEANUP_FAILED:
    "The recovery storage preflight workspace could not be removed safely.",
} as const satisfies Record<DvdRecoveryStorageReasonCode, string>;

export type DvdRecoveryStoragePreflightStatus =
  (typeof DVD_RECOVERY_STORAGE_PREFLIGHT_STATUSES)[number];

export type DvdRecoveryStorageReasonCode =
  (typeof DVD_RECOVERY_STORAGE_REASON_CODES)[number];

export type DvdRecoveryStorageClass = "local" | "network" | "unknown";
export type DvdRecoveryStorageCapabilityState =
  "verified" | "failed" | "not_tested";
export type DvdRecoveryNetworkCapabilityState =
  "verified" | "not_applicable" | "unproven";

export interface DvdRecoveryStoragePreflightFacts {
  filesystemType: string;
  storageClass: DvdRecoveryStorageClass;
  journalReservationBytes: number;
  journalReservation: DvdRecoveryStorageCapabilityState;
  journalSynchronization: DvdRecoveryStorageCapabilityState;
  imageSynchronization: DvdRecoveryStorageCapabilityState;
  checkpointSynchronization: DvdRecoveryStorageCapabilityState;
  checkpointReplacement: DvdRecoveryStorageCapabilityState;
  directorySynchronization: DvdRecoveryStorageCapabilityState;
  crossProcessWriterExclusion: DvdRecoveryStorageCapabilityState;
  crossHostWriterExclusion: DvdRecoveryNetworkCapabilityState;
  disconnectionBehavior: DvdRecoveryNetworkCapabilityState;
}

export interface DvdRecoveryStoragePreflightInput {
  contractVersion: typeof DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION;
  status: DvdRecoveryStoragePreflightStatus;
  reasonCode: DvdRecoveryStorageReasonCode | null;
  facts: DvdRecoveryStoragePreflightFacts;
}

export interface DvdRecoveryStoragePreflight
  extends DvdRecoveryStoragePreflightInput {
  checkedAt: Date;
}

const CAPABILITY_STATES = new Set<DvdRecoveryStorageCapabilityState>([
  "verified",
  "failed",
  "not_tested",
]);
const NETWORK_CAPABILITY_STATES = new Set<DvdRecoveryNetworkCapabilityState>([
  "verified",
  "not_applicable",
  "unproven",
]);

export function assertDvdRecoveryStoragePreflightInput(
  input: DvdRecoveryStoragePreflightInput,
): void {
  if (
    input.contractVersion !== DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION ||
    !DVD_RECOVERY_STORAGE_PREFLIGHT_STATUSES.includes(input.status) ||
    (input.reasonCode !== null &&
      !DVD_RECOVERY_STORAGE_REASON_CODES.includes(input.reasonCode))
  ) {
    throw new Error("DVD recovery storage preflight identity is invalid");
  }
  if (
    input.facts.filesystemType.length < 1 ||
    input.facts.filesystemType.length > 128 ||
    !["local", "network", "unknown"].includes(input.facts.storageClass) ||
    input.facts.journalReservationBytes !==
      DVD_RECOVERY_JOURNAL_RESERVATION_BYTES ||
    !CAPABILITY_STATES.has(input.facts.journalReservation) ||
    !CAPABILITY_STATES.has(input.facts.journalSynchronization) ||
    !CAPABILITY_STATES.has(input.facts.imageSynchronization) ||
    !CAPABILITY_STATES.has(input.facts.checkpointSynchronization) ||
    !CAPABILITY_STATES.has(input.facts.checkpointReplacement) ||
    !CAPABILITY_STATES.has(input.facts.directorySynchronization) ||
    !CAPABILITY_STATES.has(input.facts.crossProcessWriterExclusion) ||
    !NETWORK_CAPABILITY_STATES.has(input.facts.crossHostWriterExclusion) ||
    !NETWORK_CAPABILITY_STATES.has(input.facts.disconnectionBehavior)
  ) {
    throw new Error("DVD recovery storage preflight facts are invalid");
  }

  const localNetworkFactsAreValid = input.facts.storageClass !== "local" ||
    (input.facts.crossHostWriterExclusion === "not_applicable" &&
      input.facts.disconnectionBehavior === "not_applicable");
  const networkFactsAreValid = input.facts.storageClass !== "network" ||
    (input.facts.crossHostWriterExclusion !== "not_applicable" &&
      input.facts.disconnectionBehavior !== "not_applicable");
  if (!localNetworkFactsAreValid || !networkFactsAreValid) {
    throw new Error("DVD recovery storage network facts are invalid");
  }

  if (input.status === "supported") {
    const requiredCapabilities = [
      input.facts.journalReservation,
      input.facts.journalSynchronization,
      input.facts.imageSynchronization,
      input.facts.checkpointSynchronization,
      input.facts.checkpointReplacement,
      input.facts.directorySynchronization,
      input.facts.crossProcessWriterExclusion,
    ];
    const networkProofIsValid = input.facts.storageClass === "local" ||
      (input.facts.storageClass === "network" &&
        input.facts.crossHostWriterExclusion === "verified" &&
        input.facts.disconnectionBehavior === "verified");
    if (
      input.reasonCode !== null ||
      input.facts.storageClass === "unknown" ||
      requiredCapabilities.some((state) => state !== "verified") ||
      !networkProofIsValid
    ) {
      throw new Error("Supported DVD recovery storage preflight is incomplete");
    }
    return;
  }

  if (
    input.status === "unsupported" &&
    input.reasonCode !== "STORAGE_UNSUPPORTED"
  ) {
    throw new Error("Unsupported DVD recovery storage reason is invalid");
  }
  if (
    input.status === "failed_prerequisite" &&
    (input.reasonCode === null || input.reasonCode === "STORAGE_UNSUPPORTED")
  ) {
    throw new Error("Failed DVD recovery storage prerequisite reason is invalid");
  }
}
