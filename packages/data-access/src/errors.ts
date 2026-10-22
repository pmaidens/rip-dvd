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

export class StaleCatalogRevisionError extends DomainInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "StaleCatalogRevisionError";
  }
}

export class StaleJobAttemptError extends Error {
  constructor(recordType: string, id: string) {
    super(`Stale ${recordType} attempt: ${id}`);
    this.name = "StaleJobAttemptError";
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
