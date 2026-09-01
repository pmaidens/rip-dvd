import {
  createDataAccessInternal,
  type CreateDataAccessOptions,
} from "./internal/create-data-access.js";
import type { DataAccess } from "./types.js";

export {
  createDiscSelectionSourceIdentity,
  discSelectionSourceDescription,
} from "./disc-selection-source-identity.js";
export {
  classifyArchiveReadFailureEvidence,
  isArchiveReadFailureEvidenceConsistent,
} from "./archive-read-failure.js";
export type {
  ArchiveReadFailureEvidenceClassification,
  ArchiveReadFailureScsiEvidence,
} from "./archive-read-failure.js";
export {
  createCleanReadArchiveIntegrityEvidence,
  createUnknownArchiveIntegrityEvidence,
  createWatchableSalvageArchiveIntegrityEvidence,
} from "./archive-integrity.js";
export {
  archiveBoundaryEvidenceFromRecord,
  createCorrectedDvdArchiveBoundaryEvidence,
  createNormalDvdArchiveBoundaryEvidence,
  DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
} from "./archive-boundary.js";
export type {
  ArchiveBoundaryEvidence,
  CorrectedDvdArchiveBoundaryEvidence,
  DvdArchiveBoundaryOutOfRangeEvidence,
  NormalDvdArchiveBoundaryEvidence,
} from "./archive-boundary.js";
export { normalizeMediaItemSearchTitle } from "./media-item-title-search.js";
export {
  ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH,
  validateEncodeQueueSearchQuery,
} from "./encode-queue-search.js";
export {
  ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH,
  ENCODE_JOB_FAILURE_PHASES,
  ENCODE_JOB_FAILURE_REASON_CODES,
  ENCODE_JOB_FAILURE_REPORT_HISTORY_LIMIT,
  ENCODE_JOB_FAILURE_REPORT_SCHEMA_VERSIONS,
  ENCODE_JOB_FAILURE_RETRYABILITIES,
  ENCODE_JOB_FAILURE_SIGNALS,
  ENCODE_JOB_FAILURE_VALIDATION_CHECKS,
} from "./encode-job-failure-report.js";
export type { EncodeQueueSearchQueryValidation } from "./encode-queue-search.js";
export {
  isCorrectedEncodePredecessorReady,
  isEncodeJobSafelyTerminal,
} from "./corrected-encode-readiness.js";
export * from "./errors.js";
export * from "./dvd-scan.js";
export {
  ARCHIVE_FAILURE_DETAIL_VERSIONS,
  ARCHIVE_INTEGRITIES,
  ARCHIVE_READ_FAILURE_CATEGORIES,
  ARCHIVE_READ_FAILURE_STAGES,
  CATALOG_REVIEW_OUTCOMES,
  DISC_SELECTION_KINDS,
  DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  MEDIA_ITEM_KINDS,
  WORKER_INCIDENT_PHASES,
  WORKER_INCIDENT_REASON_CODES,
  WORKER_INCIDENT_RECOVERY_AREAS,
  WORKER_INCIDENT_RETRYABILITIES,
  WORKER_INCIDENT_SCHEMA_VERSIONS,
  WORKER_KINDS,
} from "./domain-values.js";
export type { DvdSalvageRejectionReason } from "./domain-values.js";
export type * from "./types.js";
export type {
  DiscSelectionSourceIdentity,
  DiscSelectionSourceIdentityInput,
} from "./disc-selection-source-identity.js";
export {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  DISC_INSPECTION_SETTLING_OBSERVATION_TARGET,
  DISC_INSPECTION_SETTLING_QUIET_WINDOW_MS,
  DISC_INSPECTION_SETTLING_TIMEOUT_MS,
  DVD_LOGICAL_SECTOR_BYTES,
  ENCODE_JOB_LEASE_DURATION_MS,
} from "./types.js";
export type {
  CreateDataAccessOptions,
  PublicationMutationRecoveryLock,
} from "./internal/create-data-access.js";
export type { FilesystemPathProbe } from "./internal/bounded-filesystem-path-probe.js";

export function createDataAccess(input: CreateDataAccessOptions): DataAccess {
  return createDataAccessInternal(input);
}
