import type {
  DataAccess,
  WorkerIncidentRecoveryArea,
} from "@rip-dvd/data-access";

import { normalizeErrorMessage } from "./normalize-error-message.js";

interface EncodeWorkerIncidentOptions {
  access: DataAccess;
  log(message: string): void;
}

const pollIncident = {
  workerKind: "encode",
  reasonCode: "poll_failure",
  phase: "polling",
  evidence: {},
} as const;

function publicationRecoveryIncident(recoveryArea: WorkerIncidentRecoveryArea) {
  return {
    workerKind: "encode",
    reasonCode: "publication_recovery_failure",
    phase: "publication_recovery",
    evidence: { recoveryArea },
  } as const;
}

function logPersistenceFailure(
  options: EncodeWorkerIncidentOptions,
  action: "persisted" | "resolved",
  error: unknown,
): void {
  options.log(
    `Encode Worker Incident could not be ${action}: ${
      normalizeErrorMessage(error)
    }`,
  );
}

export function recordEncodePollIncident(
  options: EncodeWorkerIncidentOptions,
): void {
  try {
    options.access.workerIncidents.record({
      schemaVersion: 1,
      retryability: "automatic",
      ...pollIncident,
    });
  } catch (error) {
    logPersistenceFailure(options, "persisted", error);
  }
}

export function resolveEncodePollIncident(
  options: EncodeWorkerIncidentOptions,
): void {
  try {
    options.access.workerIncidents.resolve(pollIncident);
  } catch (error) {
    logPersistenceFailure(options, "resolved", error);
  }
}

export function recordEncodePublicationRecoveryIncident(
  options: EncodeWorkerIncidentOptions,
  recoveryArea: WorkerIncidentRecoveryArea,
): void {
  try {
    options.access.workerIncidents.record({
      schemaVersion: 1,
      retryability: "automatic",
      ...publicationRecoveryIncident(recoveryArea),
    });
  } catch (error) {
    logPersistenceFailure(options, "persisted", error);
  }
}

export function resolveEncodePublicationRecoveryIncident(
  options: EncodeWorkerIncidentOptions,
  recoveryArea: WorkerIncidentRecoveryArea,
): void {
  try {
    options.access.workerIncidents.resolve(
      publicationRecoveryIncident(recoveryArea),
    );
  } catch (error) {
    logPersistenceFailure(options, "resolved", error);
  }
}
