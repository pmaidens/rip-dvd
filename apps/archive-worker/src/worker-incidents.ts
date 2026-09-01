import type {
  DataAccess,
  WorkerIncidentIdentity,
} from "@rip-dvd/data-access";

interface ArchiveWorkerIncidentOptions {
  access: DataAccess;
  log(message: string): void;
}

export type ArchiveWorkerRecoveryArea =
  | "expired_archive_job_claim"
  | "expired_cancellation";

const pollIncident = {
  workerKind: "archive",
  reasonCode: "poll_failure",
  phase: "polling",
  evidence: {},
} as const;

function claimRecoveryIncident(recoveryArea: ArchiveWorkerRecoveryArea) {
  return {
    workerKind: "archive",
    reasonCode: "claim_recovery_failure",
    phase: "claim_recovery",
    evidence: { recoveryArea },
  } as const;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logPersistenceFailure(
  options: ArchiveWorkerIncidentOptions,
  action: "persisted" | "resolved",
  error: unknown,
): void {
  options.log(
    `Archive Worker Incident could not be ${action}: ${errorMessage(error)}`,
  );
}

function recordIncident(
  options: ArchiveWorkerIncidentOptions,
  identity: WorkerIncidentIdentity,
): void {
  try {
    options.access.workerIncidents.record({
      ...identity,
      schemaVersion: 1,
      retryability: "automatic",
    });
  } catch (error) {
    logPersistenceFailure(options, "persisted", error);
  }
}

function resolveIncident(
  options: ArchiveWorkerIncidentOptions,
  identity: WorkerIncidentIdentity,
): void {
  try {
    options.access.workerIncidents.resolve(identity);
  } catch (error) {
    logPersistenceFailure(options, "resolved", error);
  }
}

export function recordArchivePollIncident(
  options: ArchiveWorkerIncidentOptions,
): void {
  recordIncident(options, pollIncident);
}

export function resolveArchivePollIncident(
  options: ArchiveWorkerIncidentOptions,
): void {
  resolveIncident(options, pollIncident);
}

export function recordArchiveClaimRecoveryIncident(
  options: ArchiveWorkerIncidentOptions,
  recoveryArea: ArchiveWorkerRecoveryArea,
): void {
  recordIncident(options, claimRecoveryIncident(recoveryArea));
}

export function resolveArchiveClaimRecoveryIncident(
  options: ArchiveWorkerIncidentOptions,
  recoveryArea: ArchiveWorkerRecoveryArea,
): void {
  resolveIncident(options, claimRecoveryIncident(recoveryArea));
}
