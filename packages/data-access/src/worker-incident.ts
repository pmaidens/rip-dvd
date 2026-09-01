import {
  ENCODE_WORKER_INCIDENT_RECOVERY_AREAS,
  WORKER_INCIDENT_PHASES,
  WORKER_INCIDENT_REASON_CODES,
  WORKER_INCIDENT_RECOVERY_AREAS,
  WORKER_INCIDENT_RETRYABILITIES,
  WORKER_INCIDENT_SCHEMA_VERSIONS,
  WORKER_KINDS,
} from "./domain-values.js";
import { DomainInvariantError } from "./errors.js";
import type {
  RecordWorkerIncidentInput,
  WorkerIncidentEvidence,
  WorkerIncidentIdentity,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function included<Value extends string | number>(
  values: readonly Value[],
  value: unknown,
): value is Value {
  return values.includes(value as Value);
}

function normalizeEvidence(value: unknown): WorkerIncidentEvidence {
  const evidence = value ?? {};
  if (!isRecord(evidence)) {
    throw new DomainInvariantError("Worker Incident evidence must be an object");
  }
  const keys = Object.keys(evidence);
  if (keys.length === 0) {
    return {};
  }
  if (
    keys.length !== 1 ||
    keys[0] !== "recoveryArea" ||
    !included(WORKER_INCIDENT_RECOVERY_AREAS, evidence.recoveryArea)
  ) {
    throw new DomainInvariantError("Worker Incident evidence is invalid");
  }
  return { recoveryArea: evidence.recoveryArea };
}

export function normalizeWorkerIncidentIdentity(
  input: WorkerIncidentIdentity,
): Required<WorkerIncidentIdentity> {
  if (!included(WORKER_KINDS, input.workerKind)) {
    throw new DomainInvariantError("Worker Incident worker kind is invalid");
  }
  if (!included(WORKER_INCIDENT_REASON_CODES, input.reasonCode)) {
    throw new DomainInvariantError("Worker Incident reason code is invalid");
  }
  if (!included(WORKER_INCIDENT_PHASES, input.phase)) {
    throw new DomainInvariantError("Worker Incident phase is invalid");
  }
  const evidence = normalizeEvidence(input.evidence);
  const isPolling =
    input.reasonCode === "poll_failure" && input.phase === "polling";
  const isArchiveClaimRecovery =
    input.workerKind === "archive" &&
    input.reasonCode === "claim_recovery_failure" &&
    input.phase === "claim_recovery" &&
    "recoveryArea" in evidence &&
    (evidence.recoveryArea === "expired_archive_job_claim" ||
      evidence.recoveryArea === "expired_cancellation");
  const isPublicationRecovery =
    input.workerKind === "encode" &&
    input.reasonCode === "publication_recovery_failure" &&
    input.phase === "publication_recovery" &&
    "recoveryArea" in evidence &&
    included(
      ENCODE_WORKER_INCIDENT_RECOVERY_AREAS,
      evidence.recoveryArea,
    );
  if (
    (!isPolling && !isArchiveClaimRecovery && !isPublicationRecovery) ||
    (isPolling && Object.keys(evidence).length !== 0)
  ) {
    throw new DomainInvariantError("Worker Incident identity is inconsistent");
  }
  return {
    workerKind: input.workerKind,
    reasonCode: input.reasonCode,
    phase: input.phase,
    evidence,
  };
}

export function normalizeRecordWorkerIncidentInput(
  input: RecordWorkerIncidentInput,
): RecordWorkerIncidentInput & Required<WorkerIncidentIdentity> {
  const identity = normalizeWorkerIncidentIdentity(input);
  if (!included(WORKER_INCIDENT_SCHEMA_VERSIONS, input.schemaVersion)) {
    throw new DomainInvariantError("Worker Incident schema version is invalid");
  }
  if (!included(WORKER_INCIDENT_RETRYABILITIES, input.retryability)) {
    throw new DomainInvariantError("Worker Incident retryability is invalid");
  }
  return {
    ...identity,
    schemaVersion: input.schemaVersion,
    retryability: input.retryability,
  };
}
