import type { DvdRecoveryStorageReasonCode } from "./dvd-recovery-storage-preflight.js";

export class RecordNotFoundError extends Error {
  constructor(recordType: string, id: string) {
    super(`${recordType} not found: ${id}`);
    this.name = "RecordNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(recordType: string, from: string, to: string) {
    super(`Invalid ${recordType} status transition: ${from} -> ${to}`);
    this.name = "InvalidStatusTransitionError";
  }
}

export class DomainInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}

export class MutationKeyConflictError extends DomainInvariantError {
  constructor() {
    super("Mutation key has already been used for different operation or inputs");
    this.name = "MutationKeyConflictError";
  }
}

export class DvdRecoveryStorageUnavailableError
  extends DomainInvariantError {
  readonly blockingReasons: readonly { code: DvdRecoveryStorageReasonCode; message: string }[];

  constructor(
    readonly code: DvdRecoveryStorageReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "DvdRecoveryStorageUnavailableError";
    this.blockingReasons = [{ code, message }];
  }
}

export class StaleCatalogRevisionError extends DomainInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "StaleCatalogRevisionError";
  }
}

export class CatalogMappingEvidenceUnavailableError
  extends DomainInvariantError {
  constructor() {
    super(
      "Catalog mapping requires current Title Identity evidence and a consistent workflow",
    );
    this.name = "CatalogMappingEvidenceUnavailableError";
  }
}

export class UnsupportedCatalogMappingSourceError
  extends DomainInvariantError {
  readonly code = "CATALOG_MAPPING_SOURCE_UNSUPPORTED" as const;

  constructor() {
    super(
      "Current-evidence mapping requires an exact DVD title or chapter range",
    );
    this.name = "UnsupportedCatalogMappingSourceError";
  }
}

export class StaleJobAttemptError extends Error {
  constructor(recordType: string, id: string) {
    super(`Stale ${recordType} attempt: ${id}`);
    this.name = "StaleJobAttemptError";
  }
}

export class StaleArchiveRecoveryAttemptError extends DomainInvariantError {
  readonly code = "STALE_RECOVERY_ATTEMPT" as const;

  constructor(
    readonly currentIdentities: {
      archiveRecoveryId: string;
      attemptId: string;
    },
  ) {
    super("Archive Recovery attempt is stale.");
    this.name = "StaleArchiveRecoveryAttemptError";
  }
}

export class StaleDvdStructuralCheckpointError extends DomainInvariantError {
  constructor() {
    super("DVD structural check checkpoint is no longer current");
    this.name = "StaleDvdStructuralCheckpointError";
  }
}

export class StaleDvdDiscVerificationError extends DomainInvariantError {
  constructor(
    readonly code:
      | "DISC_INSERTION_CHANGED"
      | "DISC_CHECKPOINT_CHANGED",
    readonly currentIdentities: {
      checkpoint: { revision: number; digest: string } | null;
      insertion: {
        discInspectionId: string;
        detectedDiscId: string;
        mediaGeneration: string;
      } | null;
      insertionCandidates: readonly {
        discInspectionId: string;
        detectedDiscId: string;
        mediaGeneration: string;
      }[];
    } | null = null,
  ) {
    super(code);
    this.name = "StaleDvdDiscVerificationError";
  }

  get reasons(): readonly {
    code: "DISC_INSERTION_CHANGED" | "DISC_CHECKPOINT_CHANGED";
    message: string;
  }[] {
    return [{ code: this.code, message: this.message }];
  }
}

export class StaleDvdDiscConfirmationError extends DomainInvariantError {
  readonly code = "DISC_CONFIRMATION_EXPIRED" as const;

  constructor(
    readonly reasons: readonly {
      code:
        | "RECOVERY_ATTEMPT_CHANGED"
        | "DISC_INSERTION_CHANGED"
        | "WORKER_EXECUTION_CHANGED"
        | "DISC_CHECKPOINT_CHANGED"
        | "DISC_VERIFICATION_CHANGED"
        | "DISC_VERIFICATION_RESULT_CHANGED"
        | "DISC_SOURCE_CHANGED";
      message: string;
    }[],
    readonly currentIdentities: {
      archiveRecoveryId: string;
      originalDiscArchiveId: string;
      archiveRecoveryAttemptId: string;
      checkpoint: { revision: number; digest: string } | null;
      insertion: {
        discInspectionId: string;
        detectedDiscId: string;
        mediaGeneration: string;
      } | null;
      verificationId: string | null;
      verificationWorkerExecutionId: string | null;
      verificationResultDigest: string | null;
    } | null = null,
  ) {
    super("DVD Disc Confirmation preview is no longer current.");
    this.name = "StaleDvdDiscConfirmationError";
  }
}

/** A marked initial save cannot be reconciled with its durable lifecycle. */
export class DvdInitialSaveFault extends DomainInvariantError {
  constructor(
    readonly code: "DVD_INITIAL_SAVE_CONSISTENCY_FAULT" | "DVD_INITIAL_SAVE_OWNERSHIP_LOST",
    options?: ErrorOptions,
  ) {
    super(code);
    this.name = "DvdInitialSaveFault";
    this.cause = options?.cause;
  }
}
