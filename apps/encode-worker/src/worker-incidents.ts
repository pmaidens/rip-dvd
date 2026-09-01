import type {
  DataAccess,
  EncodeWorkerIncidentRecoveryArea,
  WorkerIncidentIdentity,
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

function publicationRecoveryIncident(
  recoveryArea: EncodeWorkerIncidentRecoveryArea,
) {
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

function recordIncident(
  options: EncodeWorkerIncidentOptions,
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
  options: EncodeWorkerIncidentOptions,
  identity: WorkerIncidentIdentity,
): void {
  try {
    options.access.workerIncidents.resolve(identity);
  } catch (error) {
    logPersistenceFailure(options, "resolved", error);
  }
}

export function recordEncodePollIncident(
  options: EncodeWorkerIncidentOptions,
): void {
  recordIncident(options, pollIncident);
}

export function resolveEncodePollIncident(
  options: EncodeWorkerIncidentOptions,
): void {
  resolveIncident(options, pollIncident);
}

export function recordEncodePublicationRecoveryIncident(
  options: EncodeWorkerIncidentOptions,
  recoveryArea: EncodeWorkerIncidentRecoveryArea,
): void {
  recordIncident(options, publicationRecoveryIncident(recoveryArea));
}

export function resolveEncodePublicationRecoveryIncident(
  options: EncodeWorkerIncidentOptions,
  recoveryArea: EncodeWorkerIncidentRecoveryArea,
): void {
  resolveIncident(options, publicationRecoveryIncident(recoveryArea));
}
