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
