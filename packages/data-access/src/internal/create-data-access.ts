import { matchesEncodeOutputFilesystemIdentity } from "../encode-output-filesystem-identity.js";
import type { EncodeJobClaimOptions } from "../encode-claim-snapshot.js";
import { ArchiveRecoveryPreviewPauseError } from "../archive-recovery-work.js";
import { createDamagePreviewAccess, damagePreviewHoldsRecovery } from "./damage-preview-store.js";
import { createEncodeOutputInspectionReceiptAccess } from "./encode-output-inspection-receipt-store.js";
import {
  canonicalPublicationJson,
  DvdCheckpointReadFault,
  readCommittedDvdCurrentCheckpoint,
  readCommittedDvdCheckpoint,
  readCommittedDvdInitialCheckpoint,
} from "../dvd-archive-checkpoint.js";
import { DvdInitialSaveFault } from "../errors.js";
import {
  assertDvdEvidenceRangeTransition,
} from "../dvd-evidence-transition.js";
import { createNotificationAccess, createNotificationEventWriter } from "./notifications.js";
import { recordNotificationOutcome } from "../notification-policy.js";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import {
  createBoundedFilesystemPathProbe,
  type FilesystemPathProbe,
} from "./bounded-filesystem-path-probe.js";
import { createArchivedDvdSelectionValidator } from "./archived-dvd-selection-validator.js";
import { listWithBoundedOffset } from "./bounded-offset-pagination.js";
import {
  createBoundedChronologicalList,
  createJobList,
} from "./bounded-chronological-list.js";
import {
  evaluateDetectedDiscRediscovery,
  normalizeDetectedDiscScan,
  requiresLegacyDiscSelectionRepair,
  toDiscSelection,
} from "./dvd-contract-provenance.js";
import { assignDvdContentIdAlias } from "./dvd-content-id-alias.js";
import {
  archiveRequests,
  archiveJobs,
  damagePreviews,
  archiveRecoveries,
  archiveRecoveryWork,
  catalogReviewEvidenceChoices,
  archiveAuditFindings,
  archiveAuditRuns,
  correctedEncodePublicationAuthorities,
  detectedDiscs,
  discInspectionAttempts,
  discInspections,
  discSelectionSupersessions,
  discSelections,
  dvdArchiveEvidenceHeaders,
  dvdArchiveEvidenceManifests,
  dvdArchiveRecoveryReads,
  dvdDiscConfirmations,
  dvdDiscVerifications,
  dvdRecoveryReconciliations,
  dvdStructuralAssessments,
  dvdStructuralCheckAttempts,
  dvdTitleDamageAssessmentAttempts,
  dvdTitleDamageAssessments,
  dvdTitleDamageDecisions,
  dvdTitleIdentities,
  dvdTitleIdentityObservations,
  dvdTitleIdentitySelectionBindings,
  dvdTitleIdentitySets,
  dvdRecoveryStoragePreflights,
  dvdSourceSampleManifests,
  encodeJobFailureReports,
  encodeJobs,
  encodeClaimSnapshots,
  encodeOutputValidations,
  validationFailedEncodeOutputs,
  encodingProfiles,
  filesystemVerificationRuns,
  legacyCutoverStagedSidecars,
  mediaItemTmdbIdentities,
  mediaItems,
  mutationInvocations,
  opticalDrives,
  originalDiscArchiveContentIds,
  originalDiscArchives,
  rearchiveMappingProposalItems,
  rearchiveMappingProposals,
  retainedEncodeOutputs,
  workerIncidents,
} from "./schema.js";
import {
  reconcileLegacyRepairCutover,
  type PublicationMutationRecoveryLock,
} from "./legacy-cutover-reconciliation.js";
import {
  dvdArchiveFileMatchesIdentity,
  hashDvdArchiveFile,
  isCurrentDvdContentSize,
  readDvdArchiveFileSize,
} from "./dvd-content-identity.js";
import {
  createJobQueueController,
  type JobQueueAdapter,
} from "./job-queue.js";
import type { LegacySidecarImportAccessFactory } from "./legacy-sidecar-catalog-adapter.js";
import { planOpticalDriveReconciliation } from "./optical-drive-reconciliation.js";
import {
  requireNonEmpty,
  requirePositiveSafeInteger,
} from "./validation.js";
import {
  validateMediaItem,
  type ValidatedMediaItem,
} from "./media-item-validation.js";
import {
  createDiscSelectionSourceIdentity,
  deserializeDiscSelectionSourceIdentity,
  discSelectionSourceDescription,
  serializeDiscSelectionSourceIdentity,
  type DiscSelectionSourceIdentityColumns,
} from "../disc-selection-source-identity.js";
import { createDvdMetadataFingerprint } from "../dvd-metadata-fingerprint.js";
import { createWatchableSalvageArchiveIntegrityEvidence } from "../archive-integrity.js";
import {
  assertDvdRecoveryEvidenceAdmissionAvailable,
  dvdRecoveryEvidenceFormatForArchive,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  DvdRecoveryEvidenceAdmissionClosedError,
  DvdRecoveryEvidenceEncodingUnavailableError,
} from "../dvd-recovery-evidence.js";
import {
  ACTIVE_ENCODE_WORK_STATUSES,
  EncodeWorkConflictError,
  createEncodeWorkConflictCurrent,
  type EncodeWorkConflictCurrent,
} from "../archive-recovery-work.js";
import {
  assertDvdRecoveryStoragePreflightInput,
  dvdRecoveryStorageBlockingReason,
  DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
  type DvdRecoveryStoragePreflight,
} from "../dvd-recovery-storage-preflight.js";
import {
  createDvdStructuralAssessment,
  DVD_STRUCTURAL_ASSESSMENT_POLICY_VERSION,
  validateDvdStructuralFailureReason,
  type DvdStructuralAssessment,
  type DvdStructuralAssessmentRecord,
  type DvdStructuralCheckAttempt,
  type DvdStructuralCheckpoint,
} from "../dvd-structural-assessment.js";
import {
  dvdDiscVerificationCheckpointIsCurrent,
  dvdDiscVerificationInsertionIsCurrent,
  dvdDiscVerificationOutcome,
  DVD_DISC_VERIFICATION_CLAIM_LEASE_MS,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  validateDvdDiscVerificationFindings,
  validateDvdSourceSampleManifest,
  type DvdDiscVerificationReasonCode,
  type DvdDiscVerificationSampleFinding,
  type DvdSourceSampleManifest,
} from "../dvd-disc-verification.js";
import {
  createDvdDiscVerificationResultDigest,
  dvdDiscConfirmationMatchesVerification,
  dvdConfirmedRecoveryWriteAuthority,
} from "../dvd-disc-confirmation.js";
import { encodingProfileQueueBlockingReasons } from "../encoding-profile-eligibility.js";
import {
  archiveBoundaryEvidenceFromRecord,
  validateDvdArchiveBoundaryEvidence,
} from "../archive-boundary.js";
import {
  assertDvdArchiveBoundaryEvidenceDigest,
  assertDvdArchiveEvidenceManifestDigests,
  assertDvdArchiveRecoveryReadEvidenceDigest,
} from "../dvd-archive-evidence-digests.js";
import {
  DVD_TITLE_IDENTITY_CONTINUITY_VERSION,
  dvdTitleIdentityCatalogMappingItems,
  dvdTitleIdentityCatalogMappingProjectionDigest,
  dvdTitleIdentityContentDigest,
  dvdTitleIdentityDiscSelectionDigest,
  dvdTitleIdentityObservationSetDigest,
  dvdTitleIdentityReviewSetDigest,
  normalizeDvdTitleIdentityObservation,
  planDvdTitleIdentityContinuity,
} from "../dvd-title-identity.js";
import {
  createDvdTitleDamageAssessment,
  dvdTitleDamageAssessmentRequiresAcceptance,
  DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION,
  DVD_TITLE_DAMAGE_SOURCE_CONTINUITY_POLICY_VERSION,
  type DvdTitleDamageAssessmentRecord,
  type DvdTitleDamageMappingInput,
  type DvdTitleDamageSourceContinuityInput,
  type PersistedDvdTitleDamageMappingInput,
  type RecordDvdTitleDamageAssessmentInput,
} from "../dvd-title-damage-assessment.js";
import { isArchiveReadFailureEvidenceConsistent } from "../archive-read-failure.js";
import {
  decodeArchivedDvdTitles,
  decodeDvdTitleMap,
  isDvdContentId,
  isDvdMetadataFingerprint,
  MAX_DVD_SCAN_INTEGER,
  MAX_DVD_TITLES,
} from "../dvd-scan.js";
import {
  ARCHIVE_FAILURE_DETAIL_VERSIONS,
  ARCHIVE_READ_FAILURE_CATEGORIES,
  ARCHIVE_READ_FAILURE_STAGES,
  ARCHIVE_RUNNING_PROGRESS_PHASES,
  ENCODE_PROGRESS_PHASES,
} from "../domain-values.js";
import {
  ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH,
  validateEncodeQueueSearchQuery,
} from "../encode-queue-search.js";
import {
  encodeJobFailureEvidenceContext,
  encodeJobFailureEvidenceFromContext,
  ENCODE_JOB_FAILURE_REPORT_HISTORY_LIMIT,
  validateEncodeJobFailureReport,
  type ValidatedEncodeJobFailureReportInput,
} from "../encode-job-failure-report.js";
import {
  CatalogMappingCapacityExceededError,
  CatalogMappingEvidenceUnavailableError,
  CatalogMappingRevisionRequiredError,
  CurrentCatalogMappingSourceError,
  DomainInvariantError,
  DvdRecoveryStorageUnavailableError,
  InvalidStatusTransitionError,
  MutationKeyConflictError,
  RecordNotFoundError,
  StaleCatalogRevisionError,
  UnsupportedCatalogMappingSourceError,
  StaleArchiveRecoveryAttemptError,
  StaleArchiveRecoveryCheckpointError,
  StaleDvdDiscConfirmationError,
  StaleDvdDiscVerificationError,
  StaleDvdStructuralCheckpointError,
  StaleDvdTitleDamageAcceptanceWithdrawalError,
  StaleDvdTitleDamageDecisionError,
  StaleJobAttemptError,
} from "../errors.js";
import { dvdTitleDamageDecisionSelectionIds } from
  "../dvd-title-damage-decision.js";
import type { LegacySidecarDataAccess } from "../legacy-sidecar-types.js";
import { normalizeMediaItemSearchTitle } from "../media-item-title-search.js";
import { rearchiveAcceptancePreviewEvidence } from "../rearchive-acceptance.js";
import {
  countArchiveAuditFindings,
  type ArchiveAuditFinding,
} from "../archive-audit-types.js";
import type {
  ArchiveAuditClaimToken,
  ArchiveAuditIncompleteReason,
  ArchiveAuditRun,
  ArchiveAuditRunId,
  ArchiveAuditRunSummary,
  ArchiveJobClaimToken,
  ArchiveJobId,
  ArchiveJob,
  ArchiveJobListOptions,
  ArchiveJobStatus,
  ArchiveJobProgress,
  ArchiveRecovery,
  ArchiveRecoveryAttemptId,
  ArchiveRecoveryClaimToken,
  ArchiveRecoveryFaultCode,
  ArchiveRecoveryId,
  ArchiveRecoveryResumeOperationId,
  ArchiveRecoveryResumeReceipt,
  ArchiveRecoverySpeedMode,
  ArchiveRecoverySpeedRequestResult,
  ArchiveRecoveryStopReceipt,
  ArchiveRecoveryStopOperationId,
  ArchiveRecoveryWork,
  ArchiveReadFailureCategory,
  ArchiveRequestId,
  ArchiveRequest,
  ArchiveRequestStatus,
  CatalogReviewActionAvailability,
  CatalogReviewChoiceId,
  CatalogReviewCompletionPreviewDecisionInput,
  CatalogReviewEvidenceChoiceResult,
  CatalogReviewEvidenceChoiceRecord,
  CatalogReviewCoverage,
  ClaimedEncodeJob,
  ClaimedArchiveRecoveryWork,
  ClaimedDvdRecoveryReconciliation,
  ChronologicalListOptions,
  ConsistentReadAccess,
  CreateDiscSelectionInput,
  CompletedCatalogReviewOutcome,
  CompletedCatalogReviewWithReplacements,
  CompletedRearchiveAcceptance,
  CorrectedEncodeReplacementInput,
  CorrectedEncodeReplacementPlan,
  DataAccess,
  DetectedDiscId,
  DetectedDiscListOptions,
  DetectedDiscStatus,
  DiscInspectionClaim,
  DiscInspectionClaimToken,
  DiscInspectionEvent,
  DiscInspectionAttemptId,
  DiscInspectionId,
  DiscInspectionReasonCode,
  DiscSelection,
  DiscSelectionId,
  DvdTitleIdentityId,
  DvdTitleDamageDecision,
  DvdTitleDamageDecisionId,
  DvdTitleDamageDecisionInspection,
  DvdTitleIdentityObservation,
  DvdTitleIdentityObservationId,
  DvdTitleIdentityReviewSet,
  DvdTitleIdentityReviewSetItem,
  DiscSelectionMutationInput,
  DiscSelectionMutationResult,
  DiscSelectionPreviewDecisionInput,
  DiscSelectionActionAvailability,
  DiscSelectionCorrectionEncodeJobLink,
  DiscSelectionCorrectionRetainedOutputSummary,
  DiscSelectionSupersession,
  DvdArchiveEvidenceHeader,
  DvdArchiveEvidenceFormat,
  DvdUnrecoveredSourceRange,
  DvdCatalogReviewWorkflowEvidence,
  DvdDiscConfirmation,
  DvdDiscConfirmationId,
  DvdDiscVerification,
  DvdDiscVerificationClaimToken,
  DvdDiscVerificationId,
  DvdRecoveryReconciliation,
  DvdRecoveryReconciliationClaimToken,
  DvdRecoveryReconciliationId,
  DvdRecoveryReconciliationPhase,
  DvdRecoveryWriteAuthority,
  DvdRecoveryCheckpointProjection,
  EncodeJobClaimToken,
  EncodeJobCleanupClaimToken,
  EncodeJobId,
  FilesystemVerificationRunId,
  FilesystemVerificationClaimToken,
  FilesystemVerificationRun,
  EncodeJob,
  EncodeJobFailureOptions,
  EncodeJobFailureReport,
  EncodeJobFailureReportId,
  EncodeJobPartialCleanup,
  EncodeJobPublicationProvenance,
  EncodeJobProgress,
  EncodeJobRequeueOptions,
  EncodeJobStatus,
  EncodingProfile,
  EncodingProfileId,
  MediaDomain,
  MediaItem,
  MediaItemMaintenance,
  MediaItemMutationOptions,
  MediaItemId,
  MediaItemKind,
  OpticalDriveId,
  OriginalDiscArchiveId,
  RecordDvdDiscConfirmationInput,
  OriginalDiscArchive,
  RecordDvdTitleDamageAcceptanceWithdrawalInput,
  RecordDvdTitleDamageDecisionInput,
  RearchiveMappingProposalMapping,
  RearchiveMappingProposalInput,
  RearchiveMappingProposalReview,
  RearchiveAcceptanceInput,
  RearchiveAcceptancePlan,
  RearchiveEncodeReplacementPlan,
  RetainedEncodeOutputId,
  RunningArchiveJob,
  RunningEncodeJob,
  TmdbIdentity,
  ArchiveReadFailureEvidence,
  WorkerIncidentId,
} from "../types.js";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  DISC_INSPECTION_SETTLING_OBSERVATION_TARGET,
  DISC_INSPECTION_SETTLING_QUIET_WINDOW_MS,
  DISC_INSPECTION_SETTLING_TIMEOUT_MS,
  DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT,
  DVD_DISC_CONFIRMATION_PROVENANCE_LIMIT,
  DVD_DISC_CONFIRMATION_RECOVERED_RANGE_LIMIT,
  DVD_LOGICAL_SECTOR_BYTES,
  DVD_RECOVERY_PASS_CLAIM_LEASE_MS,
  ENCODE_JOB_LEASE_DURATION_MS,
} from "../types.js";
import { newId, requireRow } from "./persistence.js";
import {
  correctedEncodePredecessorReadyCondition,
  isEncodeJobSafelyTerminal,
} from "../corrected-encode-readiness.js";
import {
  normalizeRecordWorkerIncidentInput,
  normalizeWorkerIncidentIdentity,
} from "../worker-incident.js";

const BUSY_TIMEOUT_MS = 5_000;
const MAX_CORRECTED_ENCODE_REPLACEMENT_PLAN_PAGE_SIZE = 101;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_STALE_MS = 300_000;
const MIGRATION_LOCK_POLL_MS = 10;
const JOB_RECOVERY_LIMIT = 100;
const RELATED_ACTIVITY_ROOT_LIMIT = 256;
const ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT = 256;
const LEGACY_ARCHIVE_RECONCILIATION_LIMIT = 4;
const LEGACY_ARCHIVE_RECONCILIATION_BYTES = 9_000_000_000;
const MAX_DISC_INSPECTION_SETTLING_RESET_COUNT = 10_000;
const DISC_SELECTION_REVIEW_BATCH_SIZE = 100;
const DISC_SELECTION_ARCHIVE_LOOKUP_LIMIT = 100;
const DISC_SELECTION_ACTION_AVAILABILITY_LIMIT = 100;
const DISC_SELECTION_SUPERSESSION_LIMIT = 100;
const DISC_SELECTION_SUPERSESSION_HISTORY_LIMIT = 101;
const DISC_SELECTION_CORRECTION_ENCODE_JOB_LINK_LIMIT = 101;
const DISC_SELECTION_CORRECTION_RETAINED_OUTPUT_SUMMARY_LIMIT = 101;
const ENCODE_JOB_FAILURE_REPORT_JOB_LIMIT = 400;
const ACTIVE_ENCODE_JOB_DISC_SELECTION_LIMIT = MAX_DVD_TITLES;
const ACTIVE_ENCODE_JOB_RESULT_LIMIT = MAX_DVD_TITLES * 8;
const DVD_ARCHIVE_EVIDENCE_AUDIT_MANIFEST_LIMIT = 10_000;
const DVD_RECOVERY_PASS_HISTORY_LIMIT = 16;
function discSelectionMatchesTitleObservation(
  selection: DiscSelection,
  observation: Pick<
    DvdTitleIdentityObservation,
    | "displayTitleNumber"
    | "angleNumber"
    | "chapterStart"
    | "chapterEnd"
    | "chapterCount"
  >,
): boolean {
  switch (selection.sourceIdentity.kind) {
    case "main_feature":
      return false;
    case "dvd_title":
      return selection.sourceIdentity.titleNumber ===
          observation.displayTitleNumber &&
        observation.angleNumber === 1 &&
        observation.chapterStart === 1 &&
        observation.chapterEnd === observation.chapterCount;
    case "dvd_chapters":
      return selection.sourceIdentity.titleNumber ===
          observation.displayTitleNumber &&
        observation.angleNumber === 1 &&
        selection.sourceIdentity.chapterStart >= observation.chapterStart &&
        selection.sourceIdentity.chapterEnd <= observation.chapterEnd;
  }
}

function discSelectionMutationEvidence(
  jobs: readonly {
    id: EncodeJobId;
    status: EncodeJobStatus;
    reservesOutputPath: boolean;
  }[],
) {
  const affectedEncodeJobs = jobs
    .filter((job) => job.status === "queued" || job.status === "running" ||
      job.status === "cancellation_requested")
    .map(({ id, status }) => ({ id, status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const outputReservationReleaseJobs = jobs
    .filter((job): job is typeof job & { status: "failed" } =>
      job.status === "failed" && job.reservesOutputPath)
    .map(({ id, status }) => ({ id, status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    affectedEncodeJobs,
    outputReservationReleaseJobs,
    historicalEncodeJobCount: jobs.length,
    evidenceHash: createHash("sha256").update(JSON.stringify({
      affectedEncodeJobs,
      outputReservationReleaseJobs,
      historicalEncodeJobCount: jobs.length,
    })).digest("hex"),
  };
}

interface EncodeJobAttemptFailureOptions extends EncodeJobFailureOptions {
  failureReports?: readonly ValidatedEncodeJobFailureReportInput[];
  validationFailedOutput?: import("../encode-output-validation.js").ValidationFailedEncodeOutputInput;
}
const MEDIA_ITEM_SEARCH_LIMIT = 100;
const WORKER_INCIDENT_RETENTION_LIMIT = 100;
const ARCHIVE_READ_FAILURE_MESSAGES = {
  unknown: "The Optical Drive returned an unclassified read failure",
  not_ready: "The Optical Drive was not ready to read the disc",
  unit_attention: "The Optical Drive reported a media change",
  hardware_error: "The Optical Drive reported a hardware fault",
  transport_error: "Communication with the Optical Drive failed",
  protection_error: "DVD copy protection or region access failed",
  out_of_range:
    "The Optical Drive reported a readable-boundary disagreement",
} satisfies Record<ArchiveReadFailureCategory, string>;

interface DiscSelectionSourceOverlapTracker {
  chapterRangesByTitle: Map<number, Array<readonly [number, number]>>;
  hasMainFeature: boolean;
  wholeTitles: Set<number>;
}

interface MappingProposalReviewTransition {
  originalDiscArchiveId: OriginalDiscArchiveId;
  catalogRevision: Date;
  completeReview?: boolean;
}

function isValidTmdbIdentity(identity: TmdbIdentity): boolean {
  return (identity.mediaType === "movie" || identity.mediaType === "tv_show") &&
    Number.isSafeInteger(identity.tmdbId) &&
    identity.tmdbId > 0;
}

function addDiscSelectionSourceToOverlapTracker(
  tracker: DiscSelectionSourceOverlapTracker,
  candidate: DiscSelectionSourceIdentityColumns,
): void {
  switch (candidate.kind) {
    case "main_feature":
      tracker.hasMainFeature = true;
      return;
    case "dvd_title":
      tracker.wholeTitles.add(candidate.titleNumber!);
      return;
    case "dvd_chapters": {
      const ranges =
        tracker.chapterRangesByTitle.get(candidate.titleNumber!) ?? [];
      ranges.push([candidate.chapterStart!, candidate.chapterEnd!]);
      tracker.chapterRangesByTitle.set(candidate.titleNumber!, ranges);
    }
  }
}

function createDiscSelectionSourceOverlapTracker():
  DiscSelectionSourceOverlapTracker {
  return {
    chapterRangesByTitle: new Map(),
    hasMainFeature: false,
    wholeTitles: new Set(),
  };
}

function discSelectionSourceOverlapsTracker(
  candidate: DiscSelectionSourceIdentityColumns,
  tracker: DiscSelectionSourceOverlapTracker,
): boolean {
  switch (candidate.kind) {
    case "main_feature":
      return tracker.hasMainFeature;
    case "dvd_title":
      return (
        tracker.wholeTitles.has(candidate.titleNumber!) ||
        (tracker.chapterRangesByTitle.get(candidate.titleNumber!)?.length ??
          0) > 0
      );
    case "dvd_chapters":
      return (
        tracker.wholeTitles.has(candidate.titleNumber!) ||
        (tracker.chapterRangesByTitle.get(candidate.titleNumber!) ?? []).some(
          ([chapterStart, chapterEnd]) =>
            chapterStart <= candidate.chapterEnd! &&
            chapterEnd >= candidate.chapterStart!,
        )
      );
  }
}
const CATALOG_REVIEW_ARCHIVE_LIMIT = 100;
const CATALOG_REVIEW_MAPPED_TITLE_SUMMARY_LIMIT = 3;
const CORRECTED_ENCODE_REPLACEMENT_LIMIT = 100;
const ENCODE_QUEUE_DISC_SELECTION_LIMIT = 100;
const RETAINED_ENCODE_OUTPUT_LOOKUP_LIMIT = 400;
const RETAINED_ENCODE_OUTPUT_PAGE_LIMIT = 100;
const DVD_RECOVERY_TRANSITION_SCAN_LIMIT = 16;
const DEFAULT_MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const opticalDriveSelection = {
  id: opticalDrives.id,
  devicePath: opticalDrives.devicePath,
  displayName: opticalDrives.displayName,
  vendor: opticalDrives.vendor,
  product: opticalDrives.product,
  serialNumber: opticalDrives.serialNumber,
  isEnabled: opticalDrives.isEnabled,
  isPresent: opticalDrives.isPresent,
  lastSeenAt: opticalDrives.lastSeenAt,
  createdAt: opticalDrives.createdAt,
  updatedAt: opticalDrives.updatedAt,
};

const detectedDiscTransitions: Readonly<
  Record<DetectedDiscStatus, readonly DetectedDiscStatus[]>
> = {
  detected: ["scanned", "rejected"],
  scanned: ["approved", "rejected"],
  approved: ["rejected"],
  archived: [],
  rejected: ["detected"],
};

function asRunningArchiveJob(job: ArchiveJob): RunningArchiveJob {
  if (job.status !== "running" || job.claimToken === null) {
    throw new DomainInvariantError("Claimed Archive Job is not running");
  }
  return job as RunningArchiveJob;
}

function asRunningEncodeJob(job: EncodeJob): RunningEncodeJob {
  if (job.status !== "running" || job.claimToken === null) {
    throw new DomainInvariantError("Claimed Encode Job is not running");
  }
  return job as RunningEncodeJob;
}

function asClaimedEncodeJob(job: EncodeJob): ClaimedEncodeJob {
  if (
    (job.status !== "running" && job.status !== "cancellation_requested") ||
    job.claimToken === null
  ) {
    throw new DomainInvariantError("Claimed Encode Job has no active claim");
  }
  return job as ClaimedEncodeJob;
}

function toEncodeJobFailureReport(
  row: typeof encodeJobFailureReports.$inferSelect,
): EncodeJobFailureReport {
  const {
    context,
    exitStatus,
    expectedSeconds,
    observedSeconds,
    schemaVersion,
    sequence: _sequence,
    signal,
    timeoutSeconds,
    validationCheck,
    ...report
  } = row;
  if (schemaVersion !== 1) {
    throw new DomainInvariantError(
      "Encode Job Failure Report schema version is unsupported",
    );
  }
  const evidence = exitStatus !== null
    ? { kind: "exit_status" as const, exitStatus }
    : signal !== null
      ? { kind: "signal" as const, signal }
      : timeoutSeconds !== null
        ? { kind: "timeout" as const, timeoutSeconds }
        : expectedSeconds !== null && observedSeconds !== null
          ? {
              kind: "duration" as const,
              expectedSeconds,
              observedSeconds,
            }
          : validationCheck !== null
            ? { kind: "validation_check" as const, check: validationCheck }
            : context !== null
              ? encodeJobFailureEvidenceFromContext(report.reasonCode, context)
              : { kind: "none" as const };
  if (evidence === null) {
    throw new DomainInvariantError(
      "Encode Job Failure Report has no valid evidence",
    );
  }
  return { ...report, schemaVersion, evidence };
}

function encodeJobFailureReportRecord(
  encodeJobId: EncodeJobId,
  report: ValidatedEncodeJobFailureReportInput,
  sequence: number,
  occurredAt: Date,
): typeof encodeJobFailureReports.$inferInsert {
  return {
    id: newId<EncodeJobFailureReportId>(),
    encodeJobId,
    schemaVersion: report.schemaVersion,
    workerKind: "encode_worker",
    reasonCode: report.reasonCode,
    phase: report.phase,
    retryability: report.retryability,
    diagnostic: report.diagnostic,
    exitStatus:
      report.evidence.kind === "exit_status"
        ? report.evidence.exitStatus
        : null,
    signal:
      report.evidence.kind === "signal" ? report.evidence.signal : null,
    timeoutSeconds:
      report.evidence.kind === "timeout"
        ? report.evidence.timeoutSeconds
        : null,
    validationCheck:
      report.evidence.kind === "validation_check"
        ? report.evidence.check
        : null,
    expectedSeconds:
      report.evidence.kind === "duration"
        ? report.evidence.expectedSeconds
        : null,
    observedSeconds:
      report.evidence.kind === "duration"
        ? report.evidence.observedSeconds
        : null,
    context: encodeJobFailureEvidenceContext(report.evidence),
    sequence,
    occurredAt,
    createdAt: occurredAt,
  };
}
const archiveUsesCurrentDvdContentId = sql<boolean>`
  length(${originalDiscArchives.fingerprint}) = 71
  and substr(${originalDiscArchives.fingerprint}, 1, 7) = 'sha256:'
  and substr(${originalDiscArchives.fingerprint}, 8) not glob '*[^0-9a-f]*'
`;

const detectedDiscUsesCurrentDvdContentId = sql<boolean>`
  length(${detectedDiscs.fingerprint}) = 71
  and substr(${detectedDiscs.fingerprint}, 1, 7) = 'sha256:'
  and substr(${detectedDiscs.fingerprint}, 8) not glob '*[^0-9a-f]*'
`;

const DVD_METADATA_FINGERPRINT_RECONCILIATION_LIMIT = 4_096;

const replacementEncodeJobRecords = alias(
  encodeJobs,
  "replacement_encode_jobs",
);
const predecessorEncodeJobRecords = alias(
  encodeJobs,
  "predecessor_encode_jobs",
);
const supersededDiscSelectionRecords = alias(
  discSelections,
  "superseded_disc_selections",
);
const claimPredecessorEncodeJobRecords = alias(
  encodeJobs,
  "claim_predecessor_encode_jobs",
);
const requestedDetectedDiscRecords = alias(
  detectedDiscs,
  "requested_detected_discs",
);
const evidenceArchiveDetectedDiscRecords = alias(
  detectedDiscs,
  "evidence_archive_detected_discs",
);
const previousDvdArchiveEvidenceManifests = alias(
  dvdArchiveEvidenceManifests,
  "previous_dvd_archive_evidence_manifests",
);
const laterDvdDiscVerificationRecords = alias(
  dvdDiscVerifications,
  "later_dvd_disc_verifications",
);
const laterDvdRecoveryReconciliationRecords = alias(
  dvdRecoveryReconciliations,
  "later_dvd_recovery_reconciliations",
);
const earlierCatalogWorkflowArchiveJobs = alias(
  archiveJobs,
  "earlier_catalog_workflow_archive_jobs",
);
const COMPLETED_ENCODE_HISTORY_SQL = `(
  (
    history_job.status = 'completed'
    and history_job.publication_completion_pending = 0
  )
  or (
    history_job.completed_at is not null
    and history_job.publication_completion_pending = 0
  )
  or (
    history_job.predecessor_encode_job_id is null
    and history_job.replace_existing_output = 1
  )
  or history_retained.replacement_encode_job_id is not null
)`;

const unresolvedLegacyDvdArchiveIdentity = and(
  eq(originalDiscArchives.discKind, "dvd"),
  sql`not (${archiveUsesCurrentDvdContentId})`,
  sql<boolean>`not exists (
      select 1
      from ${originalDiscArchiveContentIds}
      where ${originalDiscArchiveContentIds.originalDiscArchiveId} = ${originalDiscArchives.id}
    )`,
);

function nextCatalogMutationTimestamp(timestamp: Date) {
  // Review restoration uses updatedAt as a compare-and-set version. Advance it
  // even when the wall clock is frozen or moves backward.
  return sql`max(${originalDiscArchives.updatedAt} + 1, ${timestamp.getTime()})`;
}

export interface CreateDataAccessOptions {
  databasePath: string;
  migrationsFolder?: string;
  mediaLibraryPath?: string;
  originalsLibraryPath?: string;
  publicationMutationRecoveryLock?: PublicationMutationRecoveryLock;
  filesystemPathProbe?: FilesystemPathProbe;
}

export type { PublicationMutationRecoveryLock };

export type LegacySidecarMigrationAdapter = LegacySidecarImportAccessFactory;

function initialDiscSettlingState(
  timestamp: Date,
  mediaCapacityBytes: number | null,
  settlingResetCount = 0,
  settlingBaselineCapacityBytes: number | null = null,
) {
  return {
    phase: "settling" as const,
    readPathNotice: null,
    mediaCapacityBytes,
    settlingBaselineCapacityBytes:
      mediaCapacityBytes === null ? settlingBaselineCapacityBytes : null,
    stableObservationCount: mediaCapacityBytes === null ? 0 : 1,
    settlingQuietWindowStartedAt:
      mediaCapacityBytes === null ? null : timestamp,
    settlingStartedAt: timestamp,
    settlingResetCount,
    phaseStartedAt: timestamp,
    attemptStartedAt: timestamp,
  };
}

function retainedSettlingCapacityBaseline({
  currentBaselineCapacityBytes,
  currentCapacityBytes,
  currentMediaGeneration,
  mediaCapacityBytes,
  mediaGeneration,
}: {
  currentBaselineCapacityBytes: number | null;
  currentCapacityBytes: number | null;
  currentMediaGeneration: string;
  mediaCapacityBytes: number | null;
  mediaGeneration: string;
}): number | null {
  if (
    mediaCapacityBytes !== null ||
    currentMediaGeneration !== mediaGeneration
  ) {
    return null;
  }
  return currentCapacityBytes ?? currentBaselineCapacityBytes;
}

function requireDiscSettlingObservation(input: {
  mediaGeneration: string;
  mediaCapacityBytes: number | null;
}) {
  const mediaGeneration = requireNonEmpty(
    input.mediaGeneration,
    "mediaGeneration",
  );
  const mediaCapacityBytes = input.mediaCapacityBytes === null
    ? null
    : requirePositiveSafeInteger(
        input.mediaCapacityBytes,
        "mediaCapacityBytes",
      );
  if (mediaGeneration.length > 64) {
    throw new DomainInvariantError(
      "mediaGeneration must contain at most 64 characters",
    );
  }
  if (
    mediaCapacityBytes !== null &&
    (mediaCapacityBytes > 9_000_000_000 ||
      mediaCapacityBytes % DVD_LOGICAL_SECTOR_BYTES !== 0)
  ) {
    throw new DomainInvariantError(
      "mediaCapacityBytes must be a DVD-sector-aligned capacity no larger than 9000000000",
    );
  }
  return { mediaGeneration, mediaCapacityBytes };
}

function createDiscInspectionClaim(
  inspection: {
    id: DiscInspectionId;
    opticalDriveId: OpticalDriveId;
    mediaGeneration: string;
  },
  claimToken: DiscInspectionClaimToken,
): DiscInspectionClaim {
  return {
    id: inspection.id,
    opticalDriveId: inspection.opticalDriveId,
    mediaGeneration: inspection.mediaGeneration,
    claimToken,
  };
}

function acquireMigrationLock(databasePath: string): () => void {
  const lockPath = `${resolve(databasePath)}.migrate.lock`;
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  const sleepState = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "EEXIST") {
        throw error;
      }
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age >= MIGRATION_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for SQLite migration lock: ${lockPath}`,
        );
      }
      Atomics.wait(sleepState, 0, 0, MIGRATION_LOCK_POLL_MS);
    }
  }
}

const RECORDED_DISC_SETTLING_MIGRATION =
  "20260822142722_disc-inspection-settling";
const BOUNDED_DISC_SETTLING_MIGRATION =
  "20260822183552_bounded-disc-settling";
const DISC_SETTLING_COMPATIBILITY_COLUMNS = [
  {
    name: "media_capacity_bytes",
    sql: "ALTER TABLE `disc_inspections` ADD `media_capacity_bytes` integer",
  },
  {
    name: "stable_observation_count",
    sql: "ALTER TABLE `disc_inspections` ADD `stable_observation_count` integer",
  },
  {
    name: "settling_quiet_window_started_at",
    sql: "ALTER TABLE `disc_inspections` ADD `settling_quiet_window_started_at` integer",
  },
  {
    name: "settling_started_at",
    sql: "ALTER TABLE `disc_inspections` ADD `settling_started_at` integer",
  },
  {
    name: "settling_reset_count",
    sql: "ALTER TABLE `disc_inspections` ADD `settling_reset_count` integer",
  },
] as const;

function reconcileRecordedDiscSettlingSchema(
  sqlite: DatabaseSync,
  migrationsFolder: string,
): void {
  if (
    !existsSync(
      join(
        migrationsFolder,
        BOUNDED_DISC_SETTLING_MIGRATION,
        "migration.sql",
      ),
    )
  ) {
    return;
  }

  const migrationTable = sqlite
    .prepare(`
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'table' AND name = '__drizzle_migrations'
    `)
    .get();
  if (migrationTable === undefined) {
    return;
  }

  const migrationColumns = new Set(
    (
      sqlite
        .prepare("SELECT name FROM pragma_table_info('__drizzle_migrations')")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name),
  );
  if (!migrationColumns.has("name")) {
    return;
  }

  const recordedMigrations = new Set(
    (
      sqlite
        .prepare(`
          SELECT name
          FROM __drizzle_migrations
          WHERE name IN (?, ?)
        `)
        .all(
          RECORDED_DISC_SETTLING_MIGRATION,
          BOUNDED_DISC_SETTLING_MIGRATION,
        ) as Array<{ name: string }>
    ).map(({ name }) => name),
  );
  if (
    !recordedMigrations.has(RECORDED_DISC_SETTLING_MIGRATION) ||
    recordedMigrations.has(BOUNDED_DISC_SETTLING_MIGRATION)
  ) {
    return;
  }

  const discInspectionColumns = new Set(
    (
      sqlite
        .prepare("SELECT name FROM pragma_table_info('disc_inspections')")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name),
  );
  const missingColumns = DISC_SETTLING_COMPATIBILITY_COLUMNS.filter(
    ({ name }) => !discInspectionColumns.has(name),
  );
  if (missingColumns.length === 0) {
    return;
  }

  // Drizzle skips migration names already in its journal without comparing
  // hashes. Restore the nullable predecessor columns that journal says exist
  // before the pending bounded-settling migration selects them.
  sqlite.exec("BEGIN");
  try {
    for (const column of missingColumns) {
      sqlite.exec(column.sql);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

function openMigratedDatabase(
  databasePath: string,
  migrationsFolder: string,
  originalsLibraryPath?: string,
  publicationMutationRecoveryLock?: PublicationMutationRecoveryLock,
) {
  const releaseMigrationLock =
    databasePath === ":memory:"
      ? () => undefined
      : acquireMigrationLock(databasePath);
  let sqlite: DatabaseSync | undefined;

  try {
    sqlite = new DatabaseSync(databasePath);
    sqlite.function(
      "rip_dvd_normalize_media_item_title",
      { deterministic: true },
      (value) =>
        typeof value === "string"
          ? normalizeMediaItemSearchTitle(value)
          : null,
    );
    sqlite.function(
      "rip_dvd_disc_selection_source_description",
      { deterministic: true },
      (kind, titleNumber, chapterStart, chapterEnd) => {
        if (
          (kind !== "main_feature" &&
            kind !== "dvd_title" &&
            kind !== "dvd_chapters") ||
          (titleNumber !== null && typeof titleNumber !== "number") ||
          (chapterStart !== null && typeof chapterStart !== "number") ||
          (chapterEnd !== null && typeof chapterEnd !== "number")
        ) {
          return null;
        }
        return discSelectionSourceDescription(
          deserializeDiscSelectionSourceIdentity({
            kind,
            titleNumber,
            chapterStart,
            chapterEnd,
          }),
        );
      },
    );
    sqlite.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    sqlite.exec("PRAGMA foreign_keys = ON");
    if (sqlite.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error(
        "SQLite foreign key integrity check failed before migration",
      );
    }
    const journal = sqlite.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: string;
    };
    if (databasePath !== ":memory:" && journal.journal_mode !== "wal") {
      throw new Error(
        `SQLite did not enable WAL mode (reported ${journal.journal_mode})`,
      );
    }
    sqlite.exec("PRAGMA synchronous = NORMAL");

    reconcileRecordedDiscSettlingSchema(sqlite, migrationsFolder);
    const database = drizzle({ client: sqlite });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(database, { migrationsFolder });
    if (sqlite.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error(
        "SQLite foreign key integrity check failed after migration",
      );
    }
    sqlite.exec("PRAGMA foreign_keys = ON");
    if (originalsLibraryPath !== undefined) {
      reconcileLegacyRepairCutover(
        sqlite,
        originalsLibraryPath,
        publicationMutationRecoveryLock,
      );
    }
    releaseMigrationLock();
    return { database, sqlite };
  } catch (error) {
    sqlite?.close();
    releaseMigrationLock();
    throw error;
  }
}

type FilesystemVerificationRow = typeof filesystemVerificationRuns.$inferSelect;

type DvdDiscVerificationRow = typeof dvdDiscVerifications.$inferSelect;
type DvdDiscConfirmationRow = typeof dvdDiscConfirmations.$inferSelect;

type DvdRecoveryReconciliationRow =
  typeof dvdRecoveryReconciliations.$inferSelect;

const DVD_RECOVERY_RECONCILIATION_CLAIM_LEASE_MS = 60_000;

function toDvdRecoveryReconciliation(
  row: DvdRecoveryReconciliationRow,
): DvdRecoveryReconciliation {
  return row;
}

function toClaimedDvdRecoveryReconciliation(
  row: DvdRecoveryReconciliationRow,
): ClaimedDvdRecoveryReconciliation {
  if (
    row.status !== "running" || row.workerExecutionId === null ||
    row.claimToken === null || row.claimedAt === null || row.startedAt === null
  ) {
    throw new DomainInvariantError(
      "DVD recovery reconciliation claim is incomplete",
    );
  }
  return row as ClaimedDvdRecoveryReconciliation;
}

function decodeDvdRecoveryReconciliationOutcome(
  stored: string,
): DvdRecoveryReconciliation {
  const outcome = JSON.parse(stored) as DvdRecoveryReconciliationRow & {
    claimedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  return toDvdRecoveryReconciliation({
    ...outcome,
    claimedAt: outcome.claimedAt === null ? null : new Date(outcome.claimedAt),
    startedAt: outcome.startedAt === null ? null : new Date(outcome.startedAt),
    completedAt: outcome.completedAt === null
      ? null
      : new Date(outcome.completedAt),
    createdAt: new Date(outcome.createdAt),
    updatedAt: new Date(outcome.updatedAt),
  });
}

function dvdRecoveryReconciliationSemanticInput(input: {
  archiveRecoveryId: ArchiveRecoveryId;
}): string {
  return canonicalPublicationJson({
    archiveRecoveryId: input.archiveRecoveryId,
  });
}

function toDvdDiscVerification(
  row: DvdDiscVerificationRow,
): DvdDiscVerification {
  return {
    ...row,
    reasons: row.reasons,
    findings: row.findings,
  };
}

function toDvdDiscConfirmation(
  row: DvdDiscConfirmationRow,
): DvdDiscConfirmation {
  return row;
}

function dvdDiscConfirmationSemanticInput(
  input: Omit<RecordDvdDiscConfirmationInput, "mutationKey">,
): string {
  return canonicalPublicationJson(input);
}

function decodeDvdDiscConfirmationOutcome(
  stored: string,
): DvdDiscConfirmation {
  const outcome = JSON.parse(stored) as DvdDiscConfirmationRow & {
    expiredAt: string | null;
    createdAt: string;
  };
  return toDvdDiscConfirmation({
    ...outcome,
    expiredAt: outcome.expiredAt === null ? null : new Date(outcome.expiredAt),
    createdAt: new Date(outcome.createdAt),
  });
}

function dvdDiscVerificationSemanticInput(input: {
  archiveRecoveryId: ArchiveRecoveryId;
  discInspectionId: DiscInspectionId;
  checkpointRevision: number;
  checkpointDigest: string;
}): string {
  return JSON.stringify({
    archiveRecoveryId: input.archiveRecoveryId,
    discInspectionId: input.discInspectionId,
    checkpointRevision: input.checkpointRevision,
    checkpointDigest: input.checkpointDigest,
  });
}

function decodeDvdDiscVerificationOutcome(
  stored: string,
): DvdDiscVerification {
  const outcome = JSON.parse(stored) as DvdDiscVerificationRow & {
    claimedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  return toDvdDiscVerification({
    ...outcome,
    claimedAt: outcome.claimedAt === null ? null : new Date(outcome.claimedAt),
    startedAt: outcome.startedAt === null ? null : new Date(outcome.startedAt),
    completedAt: outcome.completedAt === null
      ? null
      : new Date(outcome.completedAt),
    createdAt: new Date(outcome.createdAt),
    updatedAt: new Date(outcome.updatedAt),
  });
}

function validateDvdDiscVerificationManifestBinding(
  manifest: DvdSourceSampleManifest | null,
  verification: {
    sourceMetadataFingerprint: string;
  },
  header: Pick<
    DvdArchiveEvidenceHeader,
    "acceptedEndLbaExclusive"
  > | undefined,
): void {
  if (manifest === null) return;
  if (
    header === undefined ||
    manifest.sourceMetadataFingerprint !==
      verification.sourceMetadataFingerprint ||
    manifest.acceptedEndLbaExclusive !== header.acceptedEndLbaExclusive
  ) {
    throw new DomainInvariantError(
      "DVD source sample manifest does not match its initial publication",
    );
  }
}

function toFilesystemVerificationRun(
  row: FilesystemVerificationRow,
): FilesystemVerificationRun {
  return row.target === "original_disc_archive"
    ? { ...row, target: row.target, targetId: row.targetId as OriginalDiscArchiveId }
    : { ...row, target: row.target, targetId: row.targetId as EncodeJobId };
}

type ArchiveAuditRunRow = typeof archiveAuditRuns.$inferSelect;

function toArchiveAuditRunSummary(row: ArchiveAuditRunRow): ArchiveAuditRunSummary {
  return {
    id: row.id,
    status: row.status,
    progressPhase: row.progressPhase,
    bounds: {
      recordLimit: row.recordLimit,
      concurrency: row.concurrency,
      fileTimeoutMs: row.fileTimeoutMs,
      runtimeTimeoutMs: row.runtimeTimeoutMs,
    },
    recordCount: row.recordCount,
    recordsProcessed: row.recordsProcessed,
    truncated: row.truncated,
    resultStatus: row.resultStatus,
    incompleteReason: row.incompleteReason,
    failureCode: row.failureCode,
    claimToken: row.claimToken,
    claimedAt: row.claimedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDataAccessInternal(
  options: CreateDataAccessOptions,
): DataAccess;
export function createDataAccessInternal(
  options: CreateDataAccessOptions,
  legacySidecarMigration: LegacySidecarMigrationAdapter,
  testOptions?: { allowDvdRecoveryEvidenceEncodingForExclusionTest?: boolean },
): LegacySidecarDataAccess;
export function createDataAccessInternal(
  {
    databasePath,
    migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
    mediaLibraryPath,
    originalsLibraryPath,
    publicationMutationRecoveryLock,
    filesystemPathProbe = createBoundedFilesystemPathProbe(),
  }: CreateDataAccessOptions,
  legacySidecarMigration?: LegacySidecarMigrationAdapter,
  testOptions?: { allowDvdRecoveryEvidenceEncodingForExclusionTest?: boolean },
): DataAccess | LegacySidecarDataAccess {
  const normalizedDatabasePath = requireNonEmpty(databasePath, "databasePath");
  const normalizedOriginalsLibraryPath =
    originalsLibraryPath === undefined
      ? undefined
      : realpathSync(originalsLibraryPath);
  const originalsVerificationRoot =
    originalsLibraryPath === undefined
      ? undefined
      : {
          resolvedPath: resolve(originalsLibraryPath),
        };
  const mediaVerificationRoot =
    mediaLibraryPath === undefined
      ? undefined
      : {
          resolvedPath: resolve(mediaLibraryPath),
        };
  if (normalizedDatabasePath !== ":memory:") {
    mkdirSync(dirname(resolve(normalizedDatabasePath)), { recursive: true });
  }

  const { database, sqlite } = openMigratedDatabase(
    normalizedDatabasePath,
    migrationsFolder,
    normalizedOriginalsLibraryPath,
    publicationMutationRecoveryLock,
  );

  function now(): Date {
    return new Date();
  }

  function expireInvalidDvdDiscConfirmations(
    transaction: MutationTransaction,
    workerExecutionId: string,
    confirmationId?: DvdDiscConfirmationId,
  ): number {
    const execution = requireNonEmpty(
      workerExecutionId.trim(),
      "DVD Disc Confirmation worker execution ID",
    );
    const timestamp = now();
    let expired = 0;
    const confirmations = transaction.select().from(dvdDiscConfirmations)
      .where(and(
        isNull(dvdDiscConfirmations.expiredAt),
        confirmationId === undefined
          ? undefined
          : eq(dvdDiscConfirmations.id, confirmationId),
      )).all();
    for (const confirmation of confirmations) {
      const recovery = findArchiveRecoveryRecord(transaction, {
        archiveRecoveryId: confirmation.archiveRecoveryId,
      });
      const verification = transaction.select().from(dvdDiscVerifications)
        .where(eq(dvdDiscVerifications.id, confirmation.verificationId)).get();
      const latestVerification = transaction.select({
        id: dvdDiscVerifications.id,
      }).from(dvdDiscVerifications).where(eq(
        dvdDiscVerifications.archiveRecoveryId,
        confirmation.archiveRecoveryId,
      )).orderBy(desc(dvdDiscVerifications.attemptOrdinal)).limit(1).get();
      const inspection = verification === undefined
        ? undefined
        : transaction.select().from(discInspections).where(eq(
            discInspections.id,
            verification.discInspectionId,
          )).get();
      const header = transaction.select().from(dvdArchiveEvidenceHeaders)
        .where(eq(
          dvdArchiveEvidenceHeaders.originalDiscArchiveId,
          confirmation.originalDiscArchiveId,
        )).get();
      const boundDescendant = recovery?.work !== null &&
        recovery?.work?.verificationId === confirmation.verificationId &&
        recovery.work.discConfirmationId === confirmation.id &&
        header !== undefined &&
        header.currentManifestRevision > confirmation.checkpointRevision;
      const liveBoundClaim = recovery?.work?.status === "claimed" &&
        recovery.work.verificationId === confirmation.verificationId &&
        recovery.work.discConfirmationId === confirmation.id &&
        recovery.work.claimedBy ===
          confirmation.verificationWorkerExecutionId &&
        recovery.work.claimedAt !== null &&
        recovery.work.claimedAt.getTime() >=
          timestamp.getTime() - DVD_RECOVERY_PASS_CLAIM_LEASE_MS;
      let reason: DvdDiscConfirmationRow["expiryReason"] = null;
      if (
        recovery === null ||
        recovery.attemptId !== confirmation.archiveRecoveryAttemptId ||
        recovery.originalDiscArchiveId !== confirmation.originalDiscArchiveId
      ) {
        reason = "RECOVERY_ATTEMPT_CHANGED";
      } else if (
        verification === undefined ||
        latestVerification?.id !== verification.id ||
        verification.status !== "completed" ||
        verification.outcome !== confirmation.verificationOutcome ||
        verification.archiveRecoveryId !== confirmation.archiveRecoveryId ||
        verification.archiveRecoveryAttemptId !==
          confirmation.archiveRecoveryAttemptId ||
        verification.originalDiscArchiveId !==
          confirmation.originalDiscArchiveId ||
        verification.discInspectionId !== confirmation.discInspectionId ||
        verification.detectedDiscId !== confirmation.detectedDiscId ||
        verification.mediaGeneration !== confirmation.mediaGeneration ||
        verification.workerExecutionId === null ||
        verification.workerExecutionId !==
          confirmation.verificationWorkerExecutionId ||
        verification.checkpointRevision !== confirmation.checkpointRevision ||
        verification.checkpointDigest !== confirmation.checkpointDigest
      ) {
        reason = "DISC_VERIFICATION_CHANGED";
      } else if (
        createDvdDiscVerificationResultDigest(
          toDvdDiscVerification(verification),
        ) !== confirmation.verificationResultDigest
      ) {
        reason = "DISC_VERIFICATION_RESULT_CHANGED";
      } else if (
        confirmation.verificationWorkerExecutionId !== execution &&
        !liveBoundClaim
      ) {
        reason = "WORKER_EXECUTION_CHANGED";
      } else if (
        !dvdDiscVerificationInsertionIsCurrent(verification, inspection)
      ) {
        reason = "DISC_INSERTION_CHANGED";
      } else if (
        header === undefined ||
        !boundDescendant && (
          header.currentManifestRevision !== confirmation.checkpointRevision ||
          header.currentManifestDigest !== confirmation.checkpointDigest
        )
      ) {
        reason = "DISC_CHECKPOINT_CHANGED";
      }
      if (reason !== null) {
        expired += transaction.update(dvdDiscConfirmations).set({
          expiredAt: timestamp,
          expiryReason: reason,
        }).where(and(
          eq(dvdDiscConfirmations.id, confirmation.id),
          isNull(dvdDiscConfirmations.expiredAt),
        )).returning({ id: dvdDiscConfirmations.id }).all().length;
      }
    }
    return expired;
  }

  function readDvdDiscVerificationEvidence(
    transaction: MutationTransaction,
    verification: Pick<
      DvdDiscVerification,
      "originalDiscArchiveId" | "sourceMetadataFingerprint" |
        "checkpointRevision" | "checkpointDigest"
    >,
  ) {
    const header = transaction.select().from(dvdArchiveEvidenceHeaders)
      .where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        verification.originalDiscArchiveId,
      )).get();
    const storedManifest = transaction.select({
      manifest: dvdSourceSampleManifests.manifest,
    }).from(dvdSourceSampleManifests).where(eq(
      dvdSourceSampleManifests.originalDiscArchiveId,
      verification.originalDiscArchiveId,
    )).get()?.manifest;
    const manifest = storedManifest === undefined
      ? null
      : validateDvdSourceSampleManifest(storedManifest);
    validateDvdDiscVerificationManifestBinding(
      manifest,
      verification,
      header,
    );
    return { header, manifest };
  }

  function evaluatePersistedDvdDiscVerification(
    transaction: MutationTransaction,
    verification: typeof dvdDiscVerifications.$inferSelect,
    terminal: {
      budgetExhausted: boolean;
      checkpointChanged?: boolean;
      findings: readonly DvdDiscVerificationSampleFinding[];
      insertionChanged?: boolean;
      interrupted: boolean;
    },
  ) {
    const inspection = transaction.select().from(discInspections)
      .where(eq(
        discInspections.id,
        verification.discInspectionId,
      )).get();
    const { header, manifest } = readDvdDiscVerificationEvidence(
      transaction,
      verification,
    );
    validateDvdDiscVerificationFindings(manifest, terminal.findings);
    return dvdDiscVerificationOutcome({
      metadataMatches: verification.sourceMetadataFingerprint ===
        verification.observedMetadataFingerprint,
      manifestUnavailable: manifest === null,
      coverageComplete: manifest?.samples.length ===
          DVD_SOURCE_SAMPLE_BAND_COUNT &&
        terminal.findings.length === manifest.samples.length,
      budgetExhausted: terminal.budgetExhausted,
      interrupted: terminal.interrupted,
      insertionChanged: terminal.insertionChanged === true ||
        !dvdDiscVerificationInsertionIsCurrent(verification, inspection),
      checkpointChanged: terminal.checkpointChanged === true ||
        !dvdDiscVerificationCheckpointIsCurrent(
          verification,
          header === undefined
            ? null
            : {
                revision: header.currentManifestRevision,
                digest: header.currentManifestDigest,
              },
        ),
      findings: terminal.findings,
    });
  }

  let activeDiscSelectionTransaction: CatalogTransaction | null = null;
  let activeDiscSelectionUsesCurrentTitleIdentity = false;
  function discSelectionTransaction<T>(
    action: (transaction: CatalogTransaction) => T,
    options?: { behavior: "immediate" },
  ): T {
    if (activeDiscSelectionTransaction !== null) {
      return action(activeDiscSelectionTransaction);
    }
    return database.transaction(action as Parameters<typeof database.transaction>[0], options) as T;
  }

  function replayEncodeMutation(
    transaction: MutationTransaction,
    mutationKey: string | undefined,
    operation: string,
    semanticInput: string,
  ): EncodeJob | null {
    if (mutationKey === undefined) return null;
    return readMutationInvocation(
      transaction,
      mutationKey,
      operation,
      semanticInput,
      (stored) => {
        const outcome = JSON.parse(stored) as EncodeJob;
        for (const field of [
          "claimedAt", "startedAt", "completedAt", "verifiedAt", "createdAt",
          "updatedAt",
        ] as const) {
          if (outcome[field] !== null) outcome[field] = new Date(outcome[field]);
        }
        return outcome;
      },
    ) ?? null;
  }

  function saveEncodeMutation(
    transaction: MutationTransaction,
    mutationKey: string | undefined,
    operation: string,
    semanticInput: string,
    outcome: EncodeJob,
  ): EncodeJob {
    return mutationKey === undefined
      ? outcome
      : recordMutationInvocation(
        transaction, mutationKey, operation, semanticInput, outcome, now(),
      );
  }

  function encodeEnqueueSemanticInput(input: import("../types.js").EncodeJobEnqueueInput) {
    return JSON.stringify({
      discSelectionId: input.discSelectionId,
      encodingProfileId: input.encodingProfileId,
      outputPath: requireNonEmpty(input.outputPath, "outputPath"),
      priority: input.priority ?? 0,
      ...(input.expectedSourceDecision === undefined ? {} : {
        expectedSourceDecision: JSON.parse(canonicalPublicationJson(input.expectedSourceDecision)),
      }),
    });
  }

  function encodeRequeueSemanticInput(
    id: EncodeJobId,
    options?: EncodeJobRequeueOptions,
  ): string {
    return JSON.stringify({
      id,
      outputPath: options?.outputPath ?? null,
      priority: options?.priority ?? null,
      expectedRevision: options?.expectedRevision ?? null,
      acknowledgeReplacement: options?.acknowledgeReplacement ?? false,
      ...(options?.expectedSourceDecision === undefined ? {} : {
        expectedSourceDecision: JSON.parse(canonicalPublicationJson(options.expectedSourceDecision)),
      }),
    });
  }

  const hasDvdRecoveryEvidenceSchema = sqlite.prepare(`
    select 1
    from sqlite_schema
    where type = 'table' and name = 'dvd_archive_evidence_headers'
  `).get() !== undefined;
  const dvdRecoveryEvidenceEncodingGateClosed =
    hasDvdRecoveryEvidenceSchema &&
    testOptions?.allowDvdRecoveryEvidenceEncodingForExclusionTest !== true;
  const noWithdrawnTitleDamageAcceptanceForSelection = (
    originalDiscArchiveId: AnySQLiteColumn,
    discSelectionId: AnySQLiteColumn,
  ) => sql`not exists (
    select 1
    from dvd_title_damage_decisions as withdrawn_decision
    where withdrawn_decision.id = (
      select latest_decision.id
      from dvd_title_damage_decisions as latest_decision
      where latest_decision.original_disc_archive_id = ${originalDiscArchiveId}
      order by latest_decision.recorded_at desc, latest_decision.id desc
      limit 1
    )
      and withdrawn_decision.decision = 'withdrawn'
      and exists (
        select 1
        from json_each(withdrawn_decision.snapshot, '$.reviewedContent') as content
        join json_each(content.value, '$.catalogMappings') as mapping
        where json_extract(mapping.value, '$.discSelectionId') = ${discSelectionId}
      )
  )`;
  const dvdRecoveryEvidenceMarkerCondition = (
    querySource: Pick<typeof database, "select">,
    archiveId: AnySQLiteColumn,
  ) => or(
    exists(
      querySource
        .select({ id: dvdArchiveEvidenceHeaders.originalDiscArchiveId })
        .from(dvdArchiveEvidenceHeaders)
        .where(eq(
          dvdArchiveEvidenceHeaders.originalDiscArchiveId,
          archiveId,
        )),
    ),
    exists(
      querySource
        .select({ id: archiveJobs.id })
        .from(archiveJobs)
        .where(and(
          eq(archiveJobs.originalDiscArchiveId, archiveId),
          eq(archiveJobs.evidenceFormat, DVD_RECOVERY_EVIDENCE_FORMAT),
        )),
    ),
  );
  const findArchiveRecoveryRecord = (
    querySource: Pick<typeof database, "select">,
    options: {
      archiveRecoveryId?: ArchiveRecoveryId;
      originalDiscArchiveId?: OriginalDiscArchiveId;
    },
  ): ArchiveRecovery | null => {
    const conditions = [
      options.archiveRecoveryId === undefined
        ? undefined
        : eq(archiveRecoveries.id, options.archiveRecoveryId),
      options.originalDiscArchiveId === undefined
        ? undefined
        : eq(
          archiveRecoveries.originalDiscArchiveId,
          options.originalDiscArchiveId,
        ),
    ].filter((condition) => condition !== undefined);
    const recovery = querySource
      .select()
      .from(archiveRecoveries)
      .where(and(...conditions))
      .get();
    if (recovery === undefined) return null;
    const work = querySource
      .select()
      .from(archiveRecoveryWork)
      .where(eq(archiveRecoveryWork.archiveRecoveryId, recovery.id))
      .get() ?? null;
    return { ...recovery, work };
  };
  const listActiveEncodeWorkForArchive = (
    querySource: Pick<typeof database, "select">,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) => querySource
    .select({
      id: encodeJobs.id,
      status: encodeJobs.status,
      createdAt: encodeJobs.createdAt,
    })
    .from(encodeJobs)
    .innerJoin(
      discSelections,
      eq(discSelections.id, encodeJobs.discSelectionId),
    )
    .where(and(
      eq(discSelections.originalDiscArchiveId, originalDiscArchiveId),
      inArray(encodeJobs.status, ACTIVE_ENCODE_WORK_STATUSES),
    ))
    .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
    .all();
  const encodeWorkConflictCurrent = (
    querySource: Pick<typeof database, "select">,
    recovery: ArchiveRecovery,
  ): EncodeWorkConflictCurrent => createEncodeWorkConflictCurrent(
    recovery,
    listActiveEncodeWorkForArchive(
      querySource,
      recovery.originalDiscArchiveId,
    ),
  );
  const requireNoActiveEncodeWork = (
    querySource: Pick<typeof database, "select">,
    recovery: ArchiveRecovery,
  ): void => {
    const current = encodeWorkConflictCurrent(querySource, recovery);
    if (current.encodeJobs.length > 0) {
      throw new EncodeWorkConflictError(current);
    }
  };
  const requireNoArchiveRecoveryWork = (
    querySource: Pick<typeof database, "select">,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): void => {
    const recovery = findArchiveRecoveryRecord(querySource, {
      originalDiscArchiveId,
    });
    if (recovery !== null && recovery.work !== null) {
      throw new EncodeWorkConflictError(
        encodeWorkConflictCurrent(querySource, recovery),
      );
    }
  };
  const requireCurrentArchiveRecoveryClaim = (
    querySource: Pick<typeof database, "select">,
    claim: ClaimedArchiveRecoveryWork,
  ): ArchiveRecovery => {
    const recovery = findArchiveRecoveryRecord(querySource, {
      archiveRecoveryId: claim.archiveRecoveryId,
      originalDiscArchiveId: claim.originalDiscArchiveId,
    });
    if (
      recovery?.work?.status !== "claimed" ||
      recovery.work.claimToken !== claim.claimToken ||
      recovery.work.claimedBy !== claim.claimedBy ||
      recovery.work.attemptId !== claim.attemptId ||
      recovery.attemptId !== claim.attemptId
    ) {
      throw new StaleJobAttemptError(
        "Archive Recovery work",
        claim.archiveRecoveryId,
      );
    }
    return recovery;
  };
  const currentDvdUnrecoveredSourceRanges = (
    querySource: Pick<typeof database, "select">,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) =>
    requireRow(
      querySource.select({
        unrecoveredSourceRanges:
          dvdArchiveEvidenceManifests.unrecoveredSourceRanges,
      }).from(dvdArchiveEvidenceHeaders).innerJoin(
        dvdArchiveEvidenceManifests,
        eq(
          dvdArchiveEvidenceManifests.id,
          dvdArchiveEvidenceHeaders.currentManifestId,
        ),
      ).where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        originalDiscArchiveId,
      )).get(),
      "DVD Archive Evidence",
      originalDiscArchiveId,
    ).unrecoveredSourceRanges;
  const settledArchiveRecoveryStatus = (
    querySource: Pick<typeof database, "select">,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): "eligible" | "completed" => {
    return currentDvdUnrecoveredSourceRanges(
      querySource,
      originalDiscArchiveId,
    ).length === 0
      ? "completed"
      : "eligible";
  };
  const unrecoveredSectorCount = (
    querySource: Pick<typeof database, "select">,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): number => {
    return currentDvdUnrecoveredSourceRanges(
      querySource,
      originalDiscArchiveId,
    ).reduce(
      (total, range) => total + range.sectorCount,
      0,
    );
  };
  const archiveRecoveryPassStart = (
    querySource: Pick<typeof database, "select">,
    recovery: ArchiveRecovery,
    timestamp: Date,
  ) => {
    const work = recovery.work;
    if (work !== null && work.passStartedAt !== null) {
      return {
        passStartedAt: work.passStartedAt,
        passStartedManifestRevision: work.passStartedManifestRevision,
        passInitialUnrecoveredSectorCount:
          work.passInitialUnrecoveredSectorCount,
        passObservationCount: work.passObservationCount,
        passPositiveIntervalCount: work.passPositiveIntervalCount,
        passMinimumIntervalMs: work.passMinimumIntervalMs,
        passMaximumIntervalMs: work.passMaximumIntervalMs,
        passLastObservedAt: work.passLastObservedAt,
      };
    }
    const passStartedManifestRevision = requireRow(
      querySource.select({
        revision: dvdArchiveEvidenceHeaders.currentManifestRevision,
      }).from(dvdArchiveEvidenceHeaders).where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        recovery.originalDiscArchiveId,
      )).get(),
      "DVD Archive Evidence",
      recovery.originalDiscArchiveId,
    ).revision;
    return {
      passStartedAt: timestamp,
      passStartedManifestRevision,
      passInitialUnrecoveredSectorCount: unrecoveredSectorCount(
        querySource,
        recovery.originalDiscArchiveId,
      ),
      passObservationCount: 0,
      passPositiveIntervalCount: 0,
      passMinimumIntervalMs: null,
      passMaximumIntervalMs: null,
      passLastObservedAt: null,
    };
  };
  const recordArchiveRecoveryOutcome = (
    transaction: CatalogTransaction,
    recovery: Pick<ArchiveRecovery, "id" | "originalDiscArchiveId" | "attemptId">,
    kind: "recovery_completed" | "recovery_attention",
    sourceTransitionId = `attempt:${recovery.attemptId}`,
  ): void => {
    const disc = requireRow(
      transaction.select({ volumeLabel: detectedDiscs.volumeLabel })
        .from(originalDiscArchives)
        .innerJoin(detectedDiscs, eq(
          detectedDiscs.id,
          originalDiscArchives.detectedDiscId,
        ))
        .where(eq(originalDiscArchives.id, recovery.originalDiscArchiveId))
        .get(),
      "Original Disc Archive source",
      recovery.originalDiscArchiveId,
    );
    recordNotificationOutcome(createNotificationEventWriter(transaction, now), {
      kind,
      sourceEventId: `archive-recovery:${recovery.id}:${sourceTransitionId}:${kind}`,
      originalDiscArchiveId: recovery.originalDiscArchiveId,
      label: disc.volumeLabel,
    });
  };
  const archiveRecoveryPassSettlement = (
    querySource: Pick<typeof database, "select">,
    recovery: ArchiveRecovery,
    timestamp: Date,
  ) => {
    const work = recovery.work;
    if (
      work === null || work.passStartedAt === null ||
      work.passInitialUnrecoveredSectorCount === null
    ) {
      throw new DomainInvariantError(
        "Archive Recovery pass has no durable starting progress",
      );
    }
    const remainingSectorCount = unrecoveredSectorCount(
      querySource,
      recovery.originalDiscArchiveId,
    );
    if (
      work.passInitialUnrecoveredSectorCount - remainingSectorCount !==
        work.passRecoveredSectorCount
    ) {
      throw new DomainInvariantError(
        "Archive Recovery pass progress does not match the current checkpoint",
      );
    }
    const outcome = remainingSectorCount === 0
      ? "completed" as const
      : work.passRecoveredSectorCount > 0
        ? "productive" as const
        : "no_progress" as const;
    const completedAtMs = timestamp.getTime();
    return {
      outcome,
      history: [
        ...recovery.passHistory,
        {
          passNumber: work.passNumber,
          direction: work.passDirection,
          initialUnrecoveredSectorCount:
            work.passInitialUnrecoveredSectorCount,
          recoveredSectorCount: work.passRecoveredSectorCount,
          remainingSectorCount,
          lastCursorLba: work.passCursorLba,
          startedAtMs: work.passStartedAt.getTime(),
          completedAtMs,
          elapsedMs: Math.max(
            0,
            completedAtMs - work.passStartedAt.getTime(),
          ),
          outcome,
        },
      ].slice(-DVD_RECOVERY_PASS_HISTORY_LIMIT),
    };
  };
  const insertQueuedDvdDiscVerification = (
    transaction: CatalogTransaction,
    input: Pick<
      DvdDiscVerification,
      | "archiveRecoveryId"
      | "archiveRecoveryAttemptId"
      | "originalDiscArchiveId"
      | "discInspectionId"
      | "detectedDiscId"
      | "mediaGeneration"
      | "sourceMetadataFingerprint"
      | "observedMetadataFingerprint"
      | "checkpointRevision"
      | "checkpointDigest"
    >,
    timestamp: Date,
  ) => {
    const id = newId<DvdDiscVerificationId>();
    const attemptOrdinal = requireRow(
      transaction.select({
        value:
          sql<number>`coalesce(max(${dvdDiscVerifications.attemptOrdinal}), 0) + 1`,
      }).from(dvdDiscVerifications).where(eq(
        dvdDiscVerifications.archiveRecoveryId,
        input.archiveRecoveryId,
      )).get(),
      "DVD Disc Verification attempt sequence",
      input.archiveRecoveryId,
    ).value;
    return requireRow(
      transaction.insert(dvdDiscVerifications).values({
        id,
        ...input,
        attemptOrdinal,
        status: "queued",
        reasons: [],
        findings: [],
        budgetExhausted: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).returning().get(),
      "DVD Disc Verification",
      id,
    );
  };
  const queueNextArchiveRecoveryPassVerification = (
    transaction: CatalogTransaction,
    recovery: ArchiveRecovery,
    timestamp: Date,
  ): void => {
    const verificationId = recovery.work?.verificationId;
    if (verificationId === null || verificationId === undefined) {
      throw new DomainInvariantError(
        "Archive Recovery pass has no bound DVD Disc Verification",
      );
    }
    const previous = requireRow(
      transaction.select().from(dvdDiscVerifications).where(and(
        eq(dvdDiscVerifications.id, verificationId),
        eq(dvdDiscVerifications.archiveRecoveryId, recovery.id),
        eq(
          dvdDiscVerifications.archiveRecoveryAttemptId,
          recovery.attemptId,
        ),
        eq(dvdDiscVerifications.status, "completed"),
        eq(dvdDiscVerifications.outcome, "match"),
      )).get(),
      "DVD Disc Verification",
      verificationId,
    );
    const header = requireRow(
      transaction.select().from(dvdArchiveEvidenceHeaders).where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        recovery.originalDiscArchiveId,
      )).get(),
      "DVD Archive Evidence",
      recovery.originalDiscArchiveId,
    );
    insertQueuedDvdDiscVerification(transaction, {
      archiveRecoveryId: recovery.id,
      archiveRecoveryAttemptId: recovery.attemptId,
      originalDiscArchiveId: recovery.originalDiscArchiveId,
      discInspectionId: previous.discInspectionId,
      detectedDiscId: previous.detectedDiscId,
      mediaGeneration: previous.mediaGeneration,
      sourceMetadataFingerprint: previous.sourceMetadataFingerprint,
      observedMetadataFingerprint: previous.observedMetadataFingerprint,
      checkpointRevision: header.currentManifestRevision,
      checkpointDigest: header.currentManifestDigest,
    }, timestamp);
  };
  const currentResumeInsertion = (
    transaction: CatalogTransaction,
    recovery: Pick<ArchiveRecovery, "originalDiscArchiveId">,
  ) => {
    const source = transaction.select({
      opticalDriveId: detectedDiscs.opticalDriveId,
    }).from(originalDiscArchives).innerJoin(
      detectedDiscs,
      eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
    ).where(eq(
      originalDiscArchives.id,
      recovery.originalDiscArchiveId,
    )).get();
    const candidates = transaction.select({ inspection: discInspections })
      .from(discInspections).innerJoin(
        opticalDrives,
        eq(opticalDrives.id, discInspections.opticalDriveId),
      ).where(and(
        eq(opticalDrives.isPresent, true),
        eq(opticalDrives.isEnabled, true),
        eq(discInspections.isCurrent, true),
        eq(discInspections.status, "completed"),
        isNotNull(discInspections.detectedDiscId),
      )).orderBy(
        desc(discInspections.updatedAt),
        desc(discInspections.id),
      ).all();
    const sourceInsertion = candidates.find(({ inspection }) =>
      inspection.opticalDriveId === source?.opticalDriveId
    );
    return sourceInsertion?.inspection ??
      (candidates.length === 1 ? candidates[0]!.inspection : null);
  };
  const queueResumeVerification = (
    transaction: CatalogTransaction,
    recovery: ArchiveRecovery,
    inspection: typeof discInspections.$inferSelect,
    timestamp: Date,
  ) => {
    if (inspection.detectedDiscId === null) {
      throw new DomainInvariantError(
        "Archive Recovery Resume insertion has no Detected Disc",
      );
    }
    const header = requireRow(
      transaction.select().from(dvdArchiveEvidenceHeaders).where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        recovery.originalDiscArchiveId,
      )).get(),
      "DVD Archive Evidence",
      recovery.originalDiscArchiveId,
    );
    if (
      recovery.resumeCheckpointRevision !== header.currentManifestRevision ||
      recovery.resumeCheckpointDigest !== header.currentManifestDigest
    ) {
      throw new StaleJobAttemptError(
        "Archive Recovery checkpoint",
        recovery.id,
      );
    }
    const archive = requireRow(
      transaction.select().from(originalDiscArchives).where(eq(
        originalDiscArchives.id,
        recovery.originalDiscArchiveId,
      )).get(),
      "Original Disc Archive",
      recovery.originalDiscArchiveId,
    );
    const observedDisc = requireRow(
      transaction.select().from(detectedDiscs).where(eq(
        detectedDiscs.id,
        inspection.detectedDiscId,
      )).get(),
      "Detected Disc",
      inspection.detectedDiscId,
    );
    const storedSourceManifest = transaction.select({
      manifest: dvdSourceSampleManifests.manifest,
    }).from(dvdSourceSampleManifests).where(eq(
      dvdSourceSampleManifests.originalDiscArchiveId,
      recovery.originalDiscArchiveId,
    )).get()?.manifest;
    const sourceManifest = storedSourceManifest === undefined
      ? null
      : validateDvdSourceSampleManifest(storedSourceManifest);
    validateDvdDiscVerificationManifestBinding(sourceManifest, {
      sourceMetadataFingerprint: archive.fingerprint,
    }, header);
    return insertQueuedDvdDiscVerification(transaction, {
      archiveRecoveryId: recovery.id,
      archiveRecoveryAttemptId: recovery.attemptId,
      originalDiscArchiveId: recovery.originalDiscArchiveId,
      discInspectionId: inspection.id,
      detectedDiscId: observedDisc.id,
      mediaGeneration: inspection.mediaGeneration,
      sourceMetadataFingerprint:
        sourceManifest?.sourceMetadataFingerprint ?? archive.fingerprint,
      observedMetadataFingerprint: observedDisc.fingerprint,
      checkpointRevision: header.currentManifestRevision,
      checkpointDigest: header.currentManifestDigest,
    }, timestamp);
  };
  const activateResumeInsertion = (
    transaction: CatalogTransaction,
    recovery: ArchiveRecovery,
    inspection: typeof discInspections.$inferSelect,
    timestamp: Date,
  ): ArchiveRecovery => {
    const priorVerificationId = recovery.work?.verificationId ?? null;
    const verification = queueResumeVerification(
      transaction,
      recovery,
      inspection,
      timestamp,
    );
    requireRow(
      transaction.update(archiveRecoveryWork).set({
        verificationId: verification.id,
        discConfirmationId: null,
        requestedAt: timestamp,
        updatedAt: timestamp,
      }).where(and(
        eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
        eq(archiveRecoveryWork.attemptId, recovery.attemptId),
        eq(archiveRecoveryWork.status, "requested"),
        priorVerificationId === null
          ? isNull(archiveRecoveryWork.verificationId)
          : eq(archiveRecoveryWork.verificationId, priorVerificationId),
      )).returning({
        archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
      }).get(),
      "Archive Recovery work",
      recovery.id,
    );
    requireRow(
      transaction.update(archiveRecoveries).set({
        status: "eligible",
        speedRequestResult: null,
        updatedAt: timestamp,
      }).where(and(
        eq(archiveRecoveries.id, recovery.id),
        eq(archiveRecoveries.attemptId, recovery.attemptId),
        eq(archiveRecoveries.status, "waiting_for_disc"),
      )).returning({ id: archiveRecoveries.id }).get(),
      "Archive Recovery",
      recovery.id,
    );
    return requireRow(
      findArchiveRecoveryRecord(transaction, {
        archiveRecoveryId: recovery.id,
      }) ?? undefined,
      "Archive Recovery",
      recovery.id,
    );
  };
  const settleGeneratedContinuationVerification = (
    transaction: CatalogTransaction,
    verification: typeof dvdDiscVerifications.$inferSelect,
    evaluated: {
      outcome: "match" | "mismatch" | "inconclusive";
      reasons: readonly DvdDiscVerificationReasonCode[];
    } | null,
    timestamp: Date,
  ): void => {
    const recovery = findArchiveRecoveryRecord(transaction, {
      archiveRecoveryId: verification.archiveRecoveryId,
    });
    const lastPass = recovery?.passHistory.at(-1);
    const retryableInterruption = evaluated?.outcome === "inconclusive" &&
      evaluated.reasons.includes("DISC_VERIFICATION_INTERRUPTED") &&
      evaluated.reasons.every((reason) =>
        reason === "DISC_SAMPLE_COVERAGE_INCOMPLETE" ||
        reason === "DISC_VERIFICATION_INTERRUPTED"
      );
    if (
      recovery?.status === "eligible" &&
      recovery.attemptId === verification.archiveRecoveryAttemptId &&
      recovery.resumeOperationId != null &&
      recovery.work?.status === "requested" &&
      recovery.work.verificationId === verification.id
    ) {
      if (retryableInterruption) {
        const retry = insertQueuedDvdDiscVerification(transaction, {
          archiveRecoveryId: verification.archiveRecoveryId,
          archiveRecoveryAttemptId: verification.archiveRecoveryAttemptId,
          originalDiscArchiveId: verification.originalDiscArchiveId,
          discInspectionId: verification.discInspectionId,
          detectedDiscId: verification.detectedDiscId,
          mediaGeneration: verification.mediaGeneration,
          sourceMetadataFingerprint: verification.sourceMetadataFingerprint,
          observedMetadataFingerprint:
            verification.observedMetadataFingerprint,
          checkpointRevision: verification.checkpointRevision,
          checkpointDigest: verification.checkpointDigest,
        }, timestamp);
        requireRow(
          transaction.update(archiveRecoveryWork).set({
            verificationId: retry.id,
            requestedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
            eq(archiveRecoveryWork.attemptId, recovery.attemptId),
            eq(archiveRecoveryWork.status, "requested"),
            eq(archiveRecoveryWork.verificationId, verification.id),
          )).returning({
            archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
          }).get(),
          "Archive Recovery work",
          recovery.id,
        );
        return;
      }
      if (evaluated?.outcome === "match") return;
      transaction.update(archiveRecoveries).set({
        status: "waiting_for_disc",
        updatedAt: timestamp,
      }).where(and(
        eq(archiveRecoveries.id, recovery.id),
        eq(archiveRecoveries.attemptId, recovery.attemptId),
        eq(archiveRecoveries.status, "eligible"),
      )).run();
      return;
    }
    if (
      recovery?.status !== "eligible" ||
      recovery.attemptId !== verification.archiveRecoveryAttemptId ||
      recovery.work?.status !== "requested" ||
      recovery.work.verificationId !== null ||
      recovery.work.passStartedAt !== null ||
      lastPass?.outcome !== "productive" ||
      recovery.work.passNumber !== lastPass.passNumber + 1
    ) return;
    if (evaluated?.outcome === "match") return;
    if (retryableInterruption) {
      insertQueuedDvdDiscVerification(transaction, {
        archiveRecoveryId: verification.archiveRecoveryId,
        archiveRecoveryAttemptId: verification.archiveRecoveryAttemptId,
        originalDiscArchiveId: verification.originalDiscArchiveId,
        discInspectionId: verification.discInspectionId,
        detectedDiscId: verification.detectedDiscId,
        mediaGeneration: verification.mediaGeneration,
        sourceMetadataFingerprint: verification.sourceMetadataFingerprint,
        observedMetadataFingerprint: verification.observedMetadataFingerprint,
        checkpointRevision: verification.checkpointRevision,
        checkpointDigest: verification.checkpointDigest,
      }, timestamp);
      return;
    }
    requireRow(
      transaction.update(archiveRecoveries).set({
        status: "faulted",
        faultCode: "DISC_VERIFICATION_STALE",
        pauseReason: null,
        updatedAt: timestamp,
      }).where(and(
        eq(archiveRecoveries.id, recovery.id),
        eq(archiveRecoveries.attemptId, recovery.attemptId),
        eq(archiveRecoveries.status, "eligible"),
      )).returning({ id: archiveRecoveries.id }).get(),
      "Archive Recovery",
      recovery.id,
    );
    recordArchiveRecoveryOutcome(transaction, recovery, "recovery_attention");
  };
  const archiveRecoveryCompletionAfterInterruption = (
    transaction: CatalogTransaction,
    recovery: ArchiveRecovery,
    timestamp: Date,
  ) => {
    const status = settledArchiveRecoveryStatus(
      transaction,
      recovery.originalDiscArchiveId,
    );
    if (status === "eligible") {
      return { status, history: null };
    }
    const completion = archiveRecoveryPassSettlement(
      transaction,
      recovery,
      timestamp,
    );
    if (completion.outcome !== "completed") {
      throw new DomainInvariantError(
        "Completed Archive Recovery still has unrecovered sectors",
      );
    }
    recordArchiveRecoveryOutcome(transaction, recovery, "recovery_completed");
    return { status, history: completion.history };
  };
  const requireNoPendingDvdRecoveryReconciliation = (
    querySource: Pick<typeof database, "select">,
    archiveRecoveryId: ArchiveRecoveryId,
  ): void => {
    const latest = querySource.select({
      status: dvdRecoveryReconciliations.status,
    }).from(dvdRecoveryReconciliations).where(eq(
      dvdRecoveryReconciliations.archiveRecoveryId,
      archiveRecoveryId,
    )).orderBy(desc(dvdRecoveryReconciliations.attemptOrdinal)).limit(1).get();
    if (latest !== undefined && latest.status !== "completed") {
      throw new InvalidStatusTransitionError(
        "DVD recovery reconciliation",
        latest.status,
        "source read",
      );
    }
  };
  const noArchiveRecoveryWorkCondition = (
    querySource: Pick<typeof database, "select">,
    originalDiscArchiveId: AnySQLiteColumn,
  ) => notExists(
    querySource
      .select({ id: archiveRecoveryWork.archiveRecoveryId })
      .from(archiveRecoveryWork)
      .where(eq(
        archiveRecoveryWork.originalDiscArchiveId,
        originalDiscArchiveId,
      )),
  );
  const dvdRecoveryEvidenceEncodeExclusion = {
    rawSql: !dvdRecoveryEvidenceEncodingGateClosed
      ? ""
      : `and not exists (
          select 1
          from dvd_archive_evidence_headers as recovery_evidence
          where recovery_evidence.original_disc_archive_id =
            reviewed_archive.id
        )
        and not exists (
          select 1
          from archive_jobs as recovery_job
          where recovery_job.original_disc_archive_id = reviewed_archive.id
            and recovery_job.evidence_format =
              '${DVD_RECOVERY_EVIDENCE_FORMAT}'
        )`,
    forArchive: (querySource: Pick<typeof database, "select">) =>
      dvdRecoveryEvidenceEncodingGateClosed
        ? sql`not ${dvdRecoveryEvidenceMarkerCondition(
            querySource,
            originalDiscArchives.id,
          )}`
        : undefined,
  };
  const requireDvdRecoveryEvidenceEncodingAvailableForEncodeJob = (
    querySource: Pick<typeof database, "select">,
    id: EncodeJobId,
  ): void => {
    if (!hasDvdRecoveryEvidenceSchema) return;
    const targetArchive = querySource
      .select({ id: discSelections.originalDiscArchiveId })
      .from(encodeJobs)
      .innerJoin(
        discSelections,
        eq(discSelections.id, encodeJobs.discSelectionId),
      )
      .where(eq(encodeJobs.id, id))
      .limit(1)
      .get();
    if (targetArchive !== undefined) {
      requireNoArchiveRecoveryWork(querySource, targetArchive.id);
    }
    if (!dvdRecoveryEvidenceEncodingGateClosed) return;
    const evidenceArchive = querySource
      .select({ id: discSelections.originalDiscArchiveId })
      .from(encodeJobs)
      .innerJoin(
        discSelections,
        eq(discSelections.id, encodeJobs.discSelectionId),
      )
      .where(and(
        eq(encodeJobs.id, id),
        dvdRecoveryEvidenceMarkerCondition(
          querySource,
          discSelections.originalDiscArchiveId,
        ),
      ))
      .limit(1)
      .get();
    if (evidenceArchive !== undefined) {
      throw new DvdRecoveryEvidenceEncodingUnavailableError();
    }
  };
  const requireDvdRecoveryEvidenceEncodingAvailableForDiscSelections = (
    querySource: Pick<typeof database, "select">,
    discSelectionIds: readonly DiscSelectionId[],
  ): void => {
    if (discSelectionIds.length === 0) return;
    const archiveIds = new Set(
      querySource
        .select({ id: discSelections.originalDiscArchiveId })
        .from(discSelections)
        .where(inArray(discSelections.id, discSelectionIds))
        .all()
        .map(({ id }) => id),
    );
    for (const archiveId of archiveIds) {
      requireNoArchiveRecoveryWork(querySource, archiveId);
    }
    if (!dvdRecoveryEvidenceEncodingGateClosed) return;
    const evidenceArchive = querySource
      .select({ id: discSelections.originalDiscArchiveId })
      .from(discSelections)
      .where(and(
        inArray(discSelections.id, discSelectionIds),
        dvdRecoveryEvidenceMarkerCondition(
          querySource,
          discSelections.originalDiscArchiveId,
        ),
      ))
      .limit(1)
      .get();
    if (evidenceArchive !== undefined) {
      throw new DvdRecoveryEvidenceEncodingUnavailableError();
    }
  };
  const encodeQueueDiscSelectionPageStatement = sqlite.prepare(`
    with requested_selection as (
      select
        ? as has_completed_encode,
        ? as search_pattern
    ),
    completed_selection_history as (
      select distinct history_job.disc_selection_id
      from encode_jobs as history_job
      left join retained_encode_outputs as history_retained
        on history_retained.replacement_encode_job_id = history_job.id
      where ${COMPLETED_ENCODE_HISTORY_SQL}
    ),
    eligible_selection as (
      select
        disc_selection.id,
        reviewed_archive.catalog_reviewed_at,
        rip_dvd_normalize_media_item_title(media_item.title)
          as normalized_media_title,
        media_item.year as media_year,
        rip_dvd_normalize_media_item_title(
          media_item.title || ' ' ||
          coalesce(cast(media_item.year as text), '') || ' ' ||
          rip_dvd_disc_selection_source_description(
            disc_selection.kind,
            disc_selection.title_number,
            disc_selection.chapter_start,
            disc_selection.chapter_end
          )
        ) as searchable_details,
        case when completed_selection_history.disc_selection_id is null
          then 0 else 1 end as has_completed_encode
      from disc_selections as disc_selection
      inner join original_disc_archives as reviewed_archive
        on reviewed_archive.id = disc_selection.original_disc_archive_id
      inner join media_items as media_item
        on media_item.id = disc_selection.media_item_id
      left join completed_selection_history
        on completed_selection_history.disc_selection_id = disc_selection.id
      where disc_selection.is_catalog_active = 1
        and reviewed_archive.catalog_review_outcome =
          'reviewed_with_selections'
        and reviewed_archive.legacy_cutover_pending = 0
        ${dvdRecoveryEvidenceEncodeExclusion.rawSql}
    ),
    queue_counts as (
      select
        coalesce(sum(case when has_completed_encode = 0 then 1 else 0 end), 0)
          as not_encoded,
        coalesce(sum(case when has_completed_encode = 1 then 1 else 0 end), 0)
          as re_encode
      from eligible_selection
    ),
    matching_selection as (
      select eligible_selection.*
      from eligible_selection
      cross join requested_selection
      where eligible_selection.has_completed_encode =
          requested_selection.has_completed_encode
        and (
          requested_selection.search_pattern is null
          or eligible_selection.searchable_details like
            requested_selection.search_pattern
        )
    ),
    matching_count as (
      select count(*) as total
      from matching_selection
    ),
    queue_page as (
      select
        id,
        catalog_reviewed_at,
        normalized_media_title,
        media_year
      from matching_selection
      cross join requested_selection
      order by
        case when requested_selection.has_completed_encode = 0
          then catalog_reviewed_at end desc,
        case when requested_selection.has_completed_encode = 1
          then normalized_media_title end,
        case when requested_selection.has_completed_encode = 1
          then media_year end,
        id
      limit ? offset ?
    )
    select
      queue_counts.not_encoded,
      queue_counts.re_encode,
      matching_count.total,
      queue_page.id
    from queue_counts
    cross join matching_count
    cross join requested_selection
    left join queue_page on 1 = 1
    order by
      case when requested_selection.has_completed_encode = 0
        then queue_page.catalog_reviewed_at end desc,
      case when requested_selection.has_completed_encode = 1
        then queue_page.normalized_media_title end,
      case when requested_selection.has_completed_encode = 1
        then queue_page.media_year end,
      queue_page.id
  `);

  function getCatalogReviewCoverage(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): CatalogReviewCoverage {
    const archiveEvidence = requireRow(
      database
        .select({ scanData: detectedDiscs.scanData })
        .from(originalDiscArchives)
        .innerJoin(
          detectedDiscs,
          eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
        )
        .where(eq(originalDiscArchives.id, originalDiscArchiveId))
        .get(),
      "Original Disc Archive",
      originalDiscArchiveId,
    );
    const archivedTitles = (
      decodeArchivedDvdTitles(archiveEvidence.scanData) ?? []
    ).map(({ number, chapters }) => ({ number, chapters }));

    const summary = database
      .select({
        discSelectionCount: count(),
        mediaItemsWithSelections: countDistinct(discSelections.mediaItemId),
        mainFeatureSelections: sql<number>`coalesce(sum(case when ${discSelections.kind} = 'main_feature' then 1 else 0 end), 0)`,
      })
      .from(discSelections)
      .where(and(
        eq(
          discSelections.originalDiscArchiveId,
          originalDiscArchiveId,
        ),
        eq(discSelections.isCatalogActive, true),
      ))
      .get();
    if (!summary) {
      throw new DomainInvariantError(
        "Catalog Review Coverage summary could not be read",
      );
    }

    if (archivedTitles.length === 0) {
      return {
        ...summary,
        mappedTitles: 0,
        partiallyMappedTitles: 0,
        unmappedTitles: 0,
        titles: [],
      };
    }

    const titleMapValues = archivedTitles.map(() => "(?, ?, ?)").join(", ");
    const statement = sqlite.prepare(`
      with title_map(title_number, chapters, ordinal) as (
        values ${titleMapValues}
      ),
      raw_intervals as (
        select
          title_map.title_number,
          disc_selections.id as selection_id,
          case
            when disc_selections.kind = 'dvd_title' then 1
            else max(1, disc_selections.chapter_start)
          end as interval_start,
          case
            when disc_selections.kind = 'dvd_title' then title_map.chapters
            else min(title_map.chapters, disc_selections.chapter_end)
          end as interval_end,
          case when disc_selections.kind = 'dvd_title' then 1 else 0 end
            as is_whole_title
        from title_map
        inner join disc_selections
          on disc_selections.title_number = title_map.title_number
        where disc_selections.original_disc_archive_id = ?
          and disc_selections.is_catalog_active = 1
          and disc_selections.kind in ('dvd_title', 'dvd_chapters')
      ),
      valid_intervals as (
        select *
        from raw_intervals
        where interval_start <= interval_end
      ),
      ordered_intervals as (
        select
          *,
          max(interval_end) over (
            partition by title_number
            order by interval_start, interval_end, selection_id
            rows between unbounded preceding and 1 preceding
          ) as preceding_interval_end
        from valid_intervals
      ),
      grouped_intervals as (
        select
          *,
          sum(
            case
              when preceding_interval_end is null
                or interval_start > preceding_interval_end
                then 1
              else 0
            end
          ) over (
            partition by title_number
            order by interval_start, interval_end, selection_id
            rows unbounded preceding
          ) as interval_group
        from ordered_intervals
      ),
      coverage_islands as (
        select
          title_number,
          interval_group,
          min(interval_start) as interval_start,
          max(interval_end) as interval_end
        from grouped_intervals
        group by title_number, interval_group
      ),
      covered_chapters as (
        select
          title_number,
          sum(interval_end - interval_start + 1) as covered_chapters
        from coverage_islands
        group by title_number
      ),
      overlap_by_title as (
        select
          title_number,
          max(
            case
              when preceding_interval_end >= interval_start then 1
              else 0
            end
          ) as has_overlap
        from ordered_intervals
        group by title_number
      ),
      whole_title_by_title as (
        select
          title_number,
          max(is_whole_title) as has_whole_title,
          sum(is_whole_title) as whole_title_selections
        from raw_intervals
        group by title_number
      )
      select
        title_map.title_number,
        title_map.chapters,
        coalesce(whole_title_by_title.has_whole_title, 0) as has_whole_title,
        coalesce(covered_chapters.covered_chapters, 0) as covered_chapters,
        case
          when coalesce(overlap_by_title.has_overlap, 0) = 1
            or coalesce(whole_title_by_title.whole_title_selections, 0) > 1
            then 1
          else 0
        end as has_overlap
      from title_map
      left join whole_title_by_title using (title_number)
      left join covered_chapters using (title_number)
      left join overlap_by_title using (title_number)
      order by title_map.ordinal
    `);
    const parameters = archivedTitles.flatMap((title, index) => [
      title.number,
      title.chapters,
      index,
    ]);
    const rows = statement.all(
      ...parameters,
      originalDiscArchiveId,
    ) as Array<{
      title_number: number;
      chapters: number;
      has_whole_title: number;
      covered_chapters: number;
      has_overlap: number;
    }>;
    const titles = rows.map((row) => ({
      titleNumber: row.title_number,
      status: row.has_whole_title === 1 ||
          (row.chapters > 0 && row.covered_chapters >= row.chapters)
        ? "mapped" as const
        : row.covered_chapters > 0
        ? "partially_mapped" as const
        : "unmapped" as const,
      hasOverlap: row.has_overlap === 1,
    }));

    return {
      ...summary,
      mappedTitles: titles.filter(({ status }) => status === "mapped").length,
      partiallyMappedTitles: titles.filter(
        ({ status }) => status === "partially_mapped",
      ).length,
      unmappedTitles: titles.filter(({ status }) => status === "unmapped")
        .length,
      titles,
    };
  }

  type CatalogTransaction = Parameters<
    Parameters<typeof database.transaction>[0]
  >[0];
  type CatalogReader = CatalogTransaction | typeof database;

  function appendEncodeJobFailureReports(
    transaction: CatalogTransaction,
    encodeJobId: EncodeJobId | undefined,
    reports: readonly ValidatedEncodeJobFailureReportInput[] | undefined,
    occurredAt: Date,
  ): void {
    if (encodeJobId === undefined || reports === undefined) {
      return;
    }
    const latestSequence = transaction
      .select({ sequence: encodeJobFailureReports.sequence })
      .from(encodeJobFailureReports)
      .where(eq(encodeJobFailureReports.encodeJobId, encodeJobId))
      .orderBy(desc(encodeJobFailureReports.sequence))
      .limit(1)
      .get()?.sequence ?? 0;
    for (const [index, report] of reports.entries()) {
      transaction.insert(encodeJobFailureReports).values(
        encodeJobFailureReportRecord(
          encodeJobId,
          report,
          latestSequence + index + 1,
          occurredAt,
        ),
      ).run();
    }
  }

  function matchesLatestPublicationRecoveryFailure(
    row: typeof encodeJobFailureReports.$inferSelect,
    report: ValidatedEncodeJobFailureReportInput,
  ): boolean {
    return report.reasonCode === "publication_recovery_failed" &&
      row.reasonCode === report.reasonCode &&
      row.phase === report.phase &&
      row.retryability === report.retryability &&
      row.diagnostic === report.diagnostic &&
      row.context === encodeJobFailureEvidenceContext(report.evidence);
  }

  function completeEncodeCancellation(
    claim: RunningEncodeJob,
    reports: readonly ValidatedEncodeJobFailureReportInput[] = [],
    cleanup?: EncodeJobPartialCleanup,
  ): EncodeJob {
    const timestamp = now();
    const cleanupPending = reports.length > 0;
    const expiredBefore = new Date(
      timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
    );
    if (
      cleanup !== undefined &&
      (cleanup.jobId !== claim.id ||
        cleanup.claimToken !== claim.claimToken ||
        cleanup.publicationPending)
    ) {
      throw new DomainInvariantError(
        "Encode Job cancellation cleanup provenance is invalid",
      );
    }
    return database.transaction((transaction) => {
      const cancelled = transaction
        .update(encodeJobs)
        .set({
          status: "cancelled",
          reservesOutputPath: sql`case when exists (
            select 1 from encode_jobs as corrected_replacement
            where corrected_replacement.predecessor_encode_job_id = ${claim.id}
              and corrected_replacement.output_path = ${claim.outputPath}
              and corrected_replacement.reserves_output_path = 1
          ) then 0 else ${claim.replaceExistingOutput ? 1 : 0} end`,
          partialCleanupOutputPath: cleanupPending ? claim.outputPath : null,
          partialCleanupClaimToken: cleanupPending ? claim.claimToken : null,
          partialCleanupLeaseToken: null,
          publicationPending: false,
          publicationCompletionPending: false,
          progressEtaSeconds: null,
          claimedBy: null,
          claimToken: null,
          claimedAt: null,
          completedAt: claim.completedAt,
          errorMessage: null,
          updatedAt: timestamp,
        })
        .where(and(
          eq(encodeJobs.id, claim.id),
          eq(encodeJobs.status, "cancellation_requested"),
          eq(encodeJobs.claimToken, claim.claimToken),
          eq(encodeJobs.publicationPending, false),
          eq(encodeJobs.publicationCompletionPending, false),
          cleanupPending
            ? and(
                gt(encodeJobs.updatedAt, expiredBefore),
                cleanup === undefined
                  ? and(
                      isNull(encodeJobs.partialCleanupLeaseToken),
                      or(
                        and(
                          isNull(encodeJobs.partialCleanupOutputPath),
                          isNull(encodeJobs.partialCleanupClaimToken),
                        ),
                        and(
                          eq(
                            encodeJobs.partialCleanupOutputPath,
                            claim.outputPath,
                          ),
                          eq(
                            encodeJobs.partialCleanupClaimToken,
                            claim.claimToken,
                          ),
                        ),
                      ),
                    )
                  : and(
                      eq(
                        encodeJobs.partialCleanupOutputPath,
                        cleanup.outputPath,
                      ),
                      eq(
                        encodeJobs.partialCleanupClaimToken,
                        cleanup.claimToken,
                      ),
                      cleanup.leaseToken === null
                        ? isNull(encodeJobs.partialCleanupLeaseToken)
                        : eq(
                            encodeJobs.partialCleanupLeaseToken,
                            cleanup.leaseToken,
                          ),
                    ),
              )
            : and(
                isNull(encodeJobs.partialCleanupOutputPath),
                isNull(encodeJobs.partialCleanupClaimToken),
                isNull(encodeJobs.partialCleanupLeaseToken),
              ),
        ))
        .returning()
        .get();
      if (!cancelled) {
        throw new StaleJobAttemptError("encode job", claim.id);
      }
      appendEncodeJobFailureReports(
        transaction,
        cancelled.id,
        reports,
        timestamp,
      );
      if (!cleanupPending) {
        clearCorrectedEncodePublicationAuthority(transaction, cancelled.id);
      }
      return cancelled;
    }, { behavior: "immediate" });
  }

  function uniqueDeclaredByteCount(
    byteCounts: readonly (number | null)[],
  ): number | null {
    const observed = new Set(
      byteCounts.filter((byteCount): byteCount is number =>
        byteCount !== null
      ),
    );
    return observed.size === 1 ? [...observed][0]! : null;
  }

  function currentDeclaredByteCountForDetectedDisc(
    transaction: CatalogTransaction,
    detectedDiscId: DetectedDiscId,
  ): number | null {
    return uniqueDeclaredByteCount(
      transaction
        .select({ totalBytes: discInspections.totalBytes })
        .from(discInspections)
        .where(
          and(
            eq(discInspections.detectedDiscId, detectedDiscId),
            eq(discInspections.isCurrent, true),
            eq(discInspections.status, "completed"),
            isNotNull(discInspections.totalBytes),
          ),
        )
        .all()
        .map(({ totalBytes }) => totalBytes),
    );
  }

  function attemptedDeclaredByteCountsForArchiveRequest(
    transaction: Pick<typeof database, "select">,
    archiveRequestId: ArchiveRequestId,
  ): (number | null)[] {
    return transaction
      .select({ totalBytes: discInspections.totalBytes })
      .from(archiveJobs)
      .innerJoin(
        discInspections,
        eq(discInspections.id, archiveJobs.discInspectionId),
      )
      .where(
        and(
          eq(archiveJobs.archiveRequestId, archiveRequestId),
          isNotNull(discInspections.totalBytes),
        ),
      )
      .all()
      .map(({ totalBytes }) => totalBytes);
  }

  function attemptedDeclaredByteCountForArchiveRequest(
    transaction: Pick<typeof database, "select">,
    archiveRequestId: ArchiveRequestId,
  ): number | null {
    return uniqueDeclaredByteCount(
      attemptedDeclaredByteCountsForArchiveRequest(
        transaction,
        archiveRequestId,
      ),
    );
  }

  function declaredByteCountForArchiveRequest(
    transaction: Pick<typeof database, "select">,
    archiveRequestId: ArchiveRequestId,
    requestedDetectedDiscId: DetectedDiscId,
  ): number | null {
    const attemptedByteCounts = attemptedDeclaredByteCountsForArchiveRequest(
      transaction,
      archiveRequestId,
    );
    if (attemptedByteCounts.length > 0) {
      return uniqueDeclaredByteCount(attemptedByteCounts);
    }
    const rearchiveSourceArchiveId = transaction
      .select({ id: archiveRequests.rearchiveSourceArchiveId })
      .from(archiveRequests)
      .where(eq(archiveRequests.id, archiveRequestId))
      .get()?.id;
    if (
      rearchiveSourceArchiveId !== null &&
      rearchiveSourceArchiveId !== undefined
    ) {
      const sourceArchive = transaction
        .select({
          boundaryReportedSizeBytes:
            originalDiscArchives.boundaryReportedSizeBytes,
          sizeBytes: originalDiscArchives.sizeBytes,
        })
        .from(originalDiscArchives)
        .where(eq(originalDiscArchives.id, rearchiveSourceArchiveId))
        .get();
      return sourceArchive?.boundaryReportedSizeBytes ??
        sourceArchive?.sizeBytes ?? null;
    }
    return uniqueDeclaredByteCount(
      transaction
        .select({ totalBytes: discInspections.totalBytes })
        .from(discInspections)
        .where(
          and(
            eq(discInspections.detectedDiscId, requestedDetectedDiscId),
            eq(discInspections.status, "completed"),
            isNotNull(discInspections.totalBytes),
          ),
        )
        .all()
        .map(({ totalBytes }) => totalBytes),
    );
  }

  type ArchiveRequestDvdContinuationCandidate = {
    request: typeof archiveRequests.$inferSelect;
    requestedDiscId: DetectedDiscId;
    requestedDiscScanData: unknown;
    requestedDiscStatus: DetectedDiscStatus;
  };

  function requiredArchiveRequestDiscStatus(
    request: Pick<
      typeof archiveRequests.$inferSelect,
      "rearchiveSourceArchiveId"
    >,
  ): "approved" | "archived" {
    return request.rearchiveSourceArchiveId === null
      ? "approved"
      : "archived";
  }

  function archiveRequestMatchesDvdContinuationIdentity(
    currentDisc: Pick<
      typeof detectedDiscs.$inferSelect,
      "discKind" | "fingerprint" | "scanData"
    >,
    currentDeclaredByteCount: number | null,
    candidate: ArchiveRequestDvdContinuationCandidate,
    requestDeclaredByteCount: number | null,
    querySource: Pick<typeof database, "select">,
  ): boolean {
    if (
      currentDeclaredByteCount === null ||
      requestDeclaredByteCount === null
    ) {
      return false;
    }
    return archiveRequestMatchesDvdContinuationDiscIdentity(
      currentDisc,
      candidate,
      querySource,
    ) && requestDeclaredByteCount === currentDeclaredByteCount;
  }

  function archiveRequestMatchesDvdContinuationDiscIdentity(
    currentDisc: Pick<
      typeof detectedDiscs.$inferSelect,
      "discKind" | "fingerprint" | "scanData"
    >,
    candidate: ArchiveRequestDvdContinuationCandidate,
    querySource: Pick<typeof database, "select">,
  ): boolean {
    if (
      currentDisc.discKind !== "dvd" ||
      candidate.requestedDiscStatus !==
        requiredArchiveRequestDiscStatus(candidate.request)
    ) {
      return false;
    }
    const currentTitleMap = decodeDvdTitleMap(currentDisc.scanData);
    const requestedIdentityMatches =
      candidate.request.rearchiveSourceArchiveId === null
        ? decodeDvdTitleMap(candidate.requestedDiscScanData)?.contentId ===
          currentDisc.fingerprint
        : originalArchiveMatchesFingerprintOrContentIdAlias(
            candidate.request.rearchiveSourceArchiveId,
            currentDisc.fingerprint,
            querySource,
          );
    return currentTitleMap?.contentId === currentDisc.fingerprint &&
      requestedIdentityMatches;
  }

  function archiveRequestWithCreationPriority(
    transaction: CatalogTransaction,
    request: typeof archiveRequests.$inferSelect,
    requestedPriority: number | undefined,
    timestamp: Date,
  ): typeof archiveRequests.$inferSelect {
    if (
      requestedPriority === undefined ||
      request.status !== "pending" ||
      requestedPriority === request.priority
    ) {
      return request;
    }
    return requireRow(
      transaction
        .update(archiveRequests)
        .set({ priority: requestedPriority, updatedAt: timestamp })
        .where(
          and(
            eq(archiveRequests.id, request.id),
            eq(archiveRequests.status, "pending"),
          ),
        )
        .returning()
        .get(),
      "archive request",
      request.id,
    );
  }

  function clearCorrectedEncodePublicationAuthority(
    transaction: CatalogTransaction,
    jobId: EncodeJobId,
  ): void {
    transaction
      .delete(correctedEncodePublicationAuthorities)
      .where(eq(
        correctedEncodePublicationAuthorities.replacementEncodeJobId,
        jobId,
      ))
      .run();
  }

  function retainCorrectedEncodeOutput(
    transaction: CatalogTransaction,
    job: EncodeJob,
    provenance: EncodeJobPublicationProvenance | undefined,
    timestamp: Date,
  ): void {
    const publicationAuthority = transaction
      .select()
      .from(correctedEncodePublicationAuthorities)
      .where(eq(
        correctedEncodePublicationAuthorities.replacementEncodeJobId,
        job.id,
      ))
      .get();
    if (provenance?.retainedOutputPath === undefined) {
      if (
        provenance?.retainedOutputIdentity !== undefined ||
        (
          job.predecessorEncodeJobId !== null &&
          job.replacementOutputIdentity !== null
        ) ||
        publicationAuthority !== undefined
      ) {
        throw new DomainInvariantError(
          "Retained Encode output provenance is incomplete",
        );
      }
      return;
    }
    const retainedOutputPath = requireNonEmpty(
      provenance.retainedOutputPath,
      "retainedOutputPath",
    );
    const retainedOutputIdentity = provenance.retainedOutputIdentity;
    if (
      job.predecessorEncodeJobId === null ||
      retainedOutputIdentity === undefined ||
      (
        job.replacementOutputIdentity !== null &&
        retainedOutputIdentity !== job.replacementOutputIdentity
      )
    ) {
      throw new DomainInvariantError(
        "Retained Encode output requires corrected replacement provenance",
      );
    }
    if (
      publicationAuthority?.claimToken !== job.claimToken ||
      publicationAuthority.retainedOutputPath !== retainedOutputPath
    ) {
      throw new DomainInvariantError(
        "Retained Encode output path conflicts with publication authority",
      );
    }
    if (publicationAuthority.filesystemIdentity !== retainedOutputIdentity) {
      throw new DomainInvariantError(
        "Retained Encode output identity conflicts with publication authority",
      );
    }
    const existing = transaction
      .select()
      .from(retainedEncodeOutputs)
      .where(eq(retainedEncodeOutputs.retainedOutputPath, retainedOutputPath))
      .get();
    if (existing !== undefined) {
      if (
        existing.predecessorEncodeJobId !== job.predecessorEncodeJobId ||
        existing.replacementEncodeJobId !== job.id ||
        existing.filesystemIdentity !== retainedOutputIdentity ||
        existing.state !== "retained" ||
        !existing.cleanupEligible
      ) {
        throw new DomainInvariantError(
          "Retained Encode output provenance conflicts with publication",
        );
      }
      return;
    }
    if (job.replacementOutputIdentity === null) {
      throw new DomainInvariantError(
        "Retained Encode output requires corrected replacement provenance",
      );
    }
    const sourceEncodeJobId = job.completedAt === null
      ? job.predecessorEncodeJobId
      : job.id;
    const sourceJob = requireRow(
      transaction
        .select()
        .from(encodeJobs)
        .where(eq(encodeJobs.id, sourceEncodeJobId))
        .get(),
      "retained Encode output source job",
      sourceEncodeJobId,
    );
    transaction
      .insert(retainedEncodeOutputs)
      .values({
        id: newId<RetainedEncodeOutputId>(),
        predecessorEncodeJobId: job.predecessorEncodeJobId,
        replacementEncodeJobId: job.id,
        sourceEncodeJobId,
        retainedOutputPath,
        filesystemIdentity: retainedOutputIdentity,
        validationResult: sourceJob.outputValidationResult,
        validationFilesystemIdentity:
          sourceJob.outputValidationFilesystemIdentity,
        validatedAt: sourceJob.outputValidatedAt,
        completeness: sourceJob.outputCompleteness,
        state: "retained",
        cleanupEligible: true,
        retainedAt: timestamp,
      })
      .onConflictDoNothing({
        target: retainedEncodeOutputs.retainedOutputPath,
      })
      .run();
    const retained = transaction
      .select()
      .from(retainedEncodeOutputs)
      .where(eq(retainedEncodeOutputs.retainedOutputPath, retainedOutputPath))
      .get();
    if (
      retained?.predecessorEncodeJobId !== job.predecessorEncodeJobId ||
      retained.replacementEncodeJobId !== job.id ||
      retained.sourceEncodeJobId !== sourceEncodeJobId ||
      retained.retainedOutputPath !== retainedOutputPath ||
      retained.filesystemIdentity !== retainedOutputIdentity ||
      retained.validationResult !== sourceJob.outputValidationResult ||
      retained.validationFilesystemIdentity !==
        sourceJob.outputValidationFilesystemIdentity ||
      retained.validatedAt?.getTime() !==
        sourceJob.outputValidatedAt?.getTime() ||
      retained.completeness !== sourceJob.outputCompleteness ||
      retained.state !== "retained" ||
      !retained.cleanupEligible
    ) {
      throw new DomainInvariantError(
        "Retained Encode output provenance conflicts with publication",
      );
    }
  }

  function finalizePublishedEncodeJob(
    transaction: CatalogTransaction,
    completionCondition: ReturnType<typeof and>,
    provenance: EncodeJobPublicationProvenance | undefined,
    operation: string,
    jobId: EncodeJobId,
    replayedCompletion?: Pick<
      EncodeJob,
      | "completedAt"
      | "outputValidationResult"
      | "outputValidationFilesystemIdentity"
      | "outputValidatedAt"
      | "outputCompleteness"
    >,
  ): EncodeJob | undefined {
    const current = transaction
      .select()
      .from(encodeJobs)
      .where(completionCondition)
      .get();
    if (!current) {
      throw new StaleJobAttemptError(operation, jobId);
    }
    const finalizedAt = now();
    const publishedValidation = provenance?.publishedOutputValidation;
    const validationRecord = publishedValidation === undefined ? undefined : transaction.select().from(encodeOutputValidations)
      .where(and(eq(encodeOutputValidations.encodeJobId, jobId),
        eq(encodeOutputValidations.claimToken, current.partialCleanupClaimToken ?? current.claimToken!),
        eq(encodeOutputValidations.filesystemIdentity, publishedValidation.filesystemIdentity))).get();
    const sourceClaim = current.partialCleanupClaimToken ?? current.claimToken;
    if (replayedCompletion === undefined && sourceClaim !== null && transaction.select().from(encodeClaimSnapshots)
      .where(eq(encodeClaimSnapshots.id, sourceClaim)).get() !== undefined && validationRecord === undefined) {
      throw new DomainInvariantError("Claimed source output requires its exact recorded validation");
    }
    retainCorrectedEncodeOutput(
      transaction,
      current,
      provenance,
      finalizedAt,
    );
    return transaction
      .update(encodeJobs)
      .set({
        completedAt: replayedCompletion === undefined
          ? finalizedAt
          : replayedCompletion.completedAt,
        outputValidationResult: replayedCompletion === undefined
          ? publishedValidation?.result ?? null
          : replayedCompletion.outputValidationResult,
        outputValidationFilesystemIdentity:
          replayedCompletion === undefined
            ? publishedValidation?.filesystemIdentity ?? null
            : replayedCompletion.outputValidationFilesystemIdentity,
        outputValidatedAt: replayedCompletion === undefined
          ? publishedValidation === undefined ? null : validationRecord?.validatedAt ?? finalizedAt
          : replayedCompletion.outputValidatedAt,
        outputCompleteness: replayedCompletion === undefined
          ? publishedValidation?.completeness ?? null
          : replayedCompletion.outputCompleteness,
        replaceExistingOutput: false,
        replacementOutputIdentity: null,
        publicationCompletionPending: false,
        updatedAt: finalizedAt,
      })
      .where(completionCondition)
      .returning()
      .get();
  }

  function completedAtAfterInterruptedPublication() {
    return sql`case when (
      (
        ${encodeJobs.predecessorEncodeJobId} is null
        and ${encodeJobs.replaceExistingOutput} = 1
      )
      or exists (
        select 1
        from ${retainedEncodeOutputs} as prior_retained_output
        where prior_retained_output.replacement_encode_job_id =
          ${encodeJobs.id}
      )
    ) then ${encodeJobs.completedAt} else null end`;
  }

  function retainedEncodeOutputLookupIds(
    ids: readonly EncodeJobId[],
  ): EncodeJobId[] {
    if (ids.length > RETAINED_ENCODE_OUTPUT_LOOKUP_LIMIT) {
      throw new DomainInvariantError(
        `Retained Encode output lookup is limited to ${RETAINED_ENCODE_OUTPUT_LOOKUP_LIMIT} jobs`,
      );
    }
    return [...new Set(ids)];
  }

  function encodeEligibleDiscSelectionCondition() {
    return and(
      eq(discSelections.isCatalogActive, true),
      exists(
        database
          .select({ id: originalDiscArchives.id })
          .from(originalDiscArchives)
          .where(and(
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
            eq(
              originalDiscArchives.catalogReviewOutcome,
              "reviewed_with_selections",
            ),
            eq(originalDiscArchives.legacyCutoverPending, false),
            dvdRecoveryEvidenceEncodeExclusion.forArchive(database),
          )),
      ),
    );
  }

  function mediaItemDeletionReason(
    childCount: number,
    discSelectionReferenceCount: number,
  ): string | null {
    const blockers = [
      childCount === 0
        ? null
        : `${childCount} child ${
          childCount === 1 ? "Media Item" : "Media Items"
        }`,
      discSelectionReferenceCount === 0
        ? null
        : `${discSelectionReferenceCount} Disc Selection ${
          discSelectionReferenceCount === 1 ? "reference" : "references"
        }`,
    ].filter((blocker): blocker is string => blocker !== null);
    return blockers.length === 0 ? null : blockers.join(" and ");
  }

  function hasDiscSelectionSupersession(
    id: DiscSelectionId,
    querySource: Pick<typeof database, "select"> = database,
  ): boolean {
    return querySource
      .select({
        supersededDiscSelectionId:
          discSelectionSupersessions.supersededDiscSelectionId,
      })
      .from(discSelectionSupersessions)
      .where(or(
        eq(discSelectionSupersessions.supersededDiscSelectionId, id),
        eq(discSelectionSupersessions.replacementDiscSelectionId, id),
      ))
      .limit(1)
      .get() !== undefined;
  }

  function readDiscSelectionActionAvailability(
    input: {
      selection: typeof discSelections.$inferSelect;
      scanData: unknown;
      legacyCutoverPending: boolean;
    },
    querySource: Pick<typeof database, "select"> = database,
  ): DiscSelectionActionAvailability {
    const relatedEncodeJob = querySource
      .select({ id: encodeJobs.id, status: encodeJobs.status })
      .from(encodeJobs)
      .where(eq(encodeJobs.discSelectionId, input.selection.id))
      .orderBy(
        sql`case ${encodeJobs.status} when 'cancellation_requested' then 0 when 'running' then 1 when 'queued' then 2 when 'completed' then 3 else 4 end`,
        asc(encodeJobs.createdAt),
        asc(encodeJobs.id),
      )
      .limit(1)
      .get() ?? null;
    const needsRepair = requiresLegacyDiscSelectionRepair(
      input.selection,
      createArchivedDvdSelectionValidator(input.scanData),
    );
    const activeJob = relatedEncodeJob?.status === "queued" ||
        relatedEncodeJob?.status === "running" ||
        relatedEncodeJob?.status === "cancellation_requested"
      ? relatedEncodeJob as {
        id: EncodeJobId;
        status: "queued" | "running" | "cancellation_requested";
      }
      : null;
    const preservedLineage = hasDiscSelectionSupersession(
      input.selection.id,
      querySource,
    );

    if (input.legacyCutoverPending) {
      return {
        discSelectionId: input.selection.id,
        state: "changes_unavailable",
        availableActions: [],
        reason:
          "Disc Selection changes are unavailable while legacy cutover repair is pending",
        relatedEncodeJob: null,
      };
    }
    if (needsRepair) {
      return {
        discSelectionId: input.selection.id,
        state: "needs_repair",
        availableActions: activeJob === null ? ["repair", "remove"] : [],
        reason: activeJob === null
          ? "Unsafe legacy Disc Selection; repair or remove it before completing Catalog Review"
          : `Encode Job ${activeJob.id} is ${activeJob.status}; this unsafe legacy Disc Selection needs repair, but direct mutation is unavailable while the job is active`,
        relatedEncodeJob: activeJob,
      };
    }
    if (relatedEncodeJob !== null) {
      return {
        discSelectionId: input.selection.id,
        state: "locked_provenance",
        availableActions: ["correct"],
        reason: activeJob === null
          ? `Encode Job ${relatedEncodeJob.id} is ${relatedEncodeJob.status}; correct this Disc Selection by supersession to preserve its provenance`
          : `Encode Job ${activeJob.id} is ${activeJob.status}; correcting by supersession will request cancellation and preserve its provenance`,
        relatedEncodeJob,
      };
    }
    if (preservedLineage) {
      return {
        discSelectionId: input.selection.id,
        state: "correction_lineage",
        availableActions: ["correct", "remove"],
        reason:
          "This Disc Selection belongs to immutable correction lineage; correct it by supersession or remove it while retaining history",
        relatedEncodeJob: null,
      };
    }
    return {
      discSelectionId: input.selection.id,
      state: "editable",
      availableActions: ["update", "remove"],
      reason: null,
      relatedEncodeJob: null,
    };
  }

  function readMediaItemMaintenance(
    ids: readonly MediaItemId[],
    currentArchiveId: OriginalDiscArchiveId | undefined,
    querySource: Pick<typeof database, "select"> = database,
  ): MediaItemMaintenance[] {
    if (ids.length === 0) {
      return [];
    }
    if (ids.length > MEDIA_ITEM_SEARCH_LIMIT) {
      throw new DomainInvariantError(
        `Media Item maintenance is limited to ${MEDIA_ITEM_SEARCH_LIMIT} records`,
      );
    }
    const existingIds = querySource
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(inArray(mediaItems.id, [...ids]))
      .all()
      .map(({ id }) => id);
    const childCounts = new Map(
      querySource
        .select({ mediaItemId: mediaItems.parentId, value: count() })
        .from(mediaItems)
        .where(inArray(mediaItems.parentId, [...ids]))
        .groupBy(mediaItems.parentId)
        .all()
        .map((row) => [row.mediaItemId, row.value]),
    );
    const selectionCounts = new Map(
      querySource
        .select({
          mediaItemId: discSelections.mediaItemId,
          discSelectionReferenceCount: count(),
          referencedArchiveCount: countDistinct(
            discSelections.originalDiscArchiveId,
          ),
          otherArchiveCount: currentArchiveId === undefined
            ? countDistinct(discSelections.originalDiscArchiveId)
            : countDistinct(
              sql`case when ${discSelections.originalDiscArchiveId} <> ${
                currentArchiveId
              } then ${discSelections.originalDiscArchiveId} end`,
            ),
        })
        .from(discSelections)
        .where(inArray(discSelections.mediaItemId, [...ids]))
        .groupBy(discSelections.mediaItemId)
        .all()
        .map((row) => [row.mediaItemId, row]),
    );
    return existingIds.map((mediaItemId) => {
      const childCount = childCounts.get(mediaItemId) ?? 0;
      const selectionCount = selectionCounts.get(mediaItemId);
      const discSelectionReferenceCount =
        selectionCount?.discSelectionReferenceCount ?? 0;
      const reason = mediaItemDeletionReason(
        childCount,
        discSelectionReferenceCount,
      );
      return {
        mediaItemId,
        childCount,
        discSelectionReferenceCount,
        referencedArchiveCount: selectionCount?.referencedArchiveCount ?? 0,
        otherArchiveCount: selectionCount?.otherArchiveCount ?? 0,
        deletionAvailability: reason === null
          ? { state: "available", reason: null }
          : { state: "unavailable", reason },
      } satisfies MediaItemMaintenance;
    });
  }

  function inspectMediaItemImpact(
    id: MediaItemId,
    querySource: Pick<typeof database, "select"> = database,
  ): { affectedArchiveCount: number; revision: string } {
    const directChildren = querySource.select({ id: mediaItems.id }).from(mediaItems)
      .where(eq(mediaItems.parentId, id)).orderBy(asc(mediaItems.id)).all()
      .map((row) => row.id);
    const descendants: MediaItemId[] = [id];
    let frontier = directChildren;
    while (frontier.length > 0) {
      descendants.push(...frontier);
      const next: MediaItemId[] = [];
      for (let offset = 0; offset < frontier.length; offset += 500) {
        next.push(...querySource.select({ id: mediaItems.id }).from(mediaItems)
          .where(inArray(mediaItems.parentId, frontier.slice(offset, offset + 500))).all()
          .map((row) => row.id));
      }
      frontier = next;
    }
    const references: Array<{ id: DiscSelectionId; archiveId: OriginalDiscArchiveId; mediaItemId: MediaItemId }> = [];
    for (let offset = 0; offset < descendants.length; offset += 500) {
      references.push(...querySource.select({ id: discSelections.id,
        archiveId: discSelections.originalDiscArchiveId,
        mediaItemId: discSelections.mediaItemId }).from(discSelections)
        .where(inArray(discSelections.mediaItemId, descendants.slice(offset, offset + 500))).all());
    }
    references.sort((left, right) => left.id.localeCompare(right.id));
    return {
      affectedArchiveCount: new Set(references.map((reference) => reference.archiveId)).size,
      revision: createHash("sha256").update(JSON.stringify({ directChildren, references })).digest("hex"),
    };
  }

  function activeDiscSelectionSourceOverlapExists(
    transaction: CatalogTransaction,
    archiveId: OriginalDiscArchiveId,
    candidate: DiscSelectionSourceIdentityColumns,
  ): boolean {
    const coordinateOverlap = candidate.kind === "main_feature"
      ? eq(discSelections.kind, "main_feature")
      : candidate.kind === "dvd_title"
      ? eq(discSelections.titleNumber, candidate.titleNumber!)
      : and(
        eq(discSelections.titleNumber, candidate.titleNumber!),
        or(
          eq(discSelections.kind, "dvd_title"),
          and(
            eq(discSelections.kind, "dvd_chapters"),
            lte(discSelections.chapterStart, candidate.chapterEnd!),
            gte(discSelections.chapterEnd, candidate.chapterStart!),
          ),
        ),
      );
    return transaction
      .select({ id: discSelections.id })
      .from(discSelections)
      .where(and(
        eq(discSelections.originalDiscArchiveId, archiveId),
        eq(discSelections.isCatalogActive, true),
        coordinateOverlap,
      ))
      .limit(1)
      .get() !== undefined;
  }

  function removeDvdTitleIdentitySelectionBinding(
    transaction: CatalogTransaction,
    discSelectionId: DiscSelectionId,
  ): void {
    transaction.delete(dvdTitleIdentitySelectionBindings).where(eq(
      dvdTitleIdentitySelectionBindings.discSelectionId,
      discSelectionId,
    )).run();
  }

  function syncDvdTitleIdentitySelectionBinding(
    transaction: CatalogTransaction,
    selection: DiscSelection,
    timestamp: Date,
  ): void {
    removeDvdTitleIdentitySelectionBinding(transaction, selection.id);
    const header = transaction.select().from(dvdArchiveEvidenceHeaders)
      .where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        selection.originalDiscArchiveId,
      )).get();
    if (
      header === undefined ||
      header.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT
    ) {
      return;
    }
    const set = transaction.select().from(dvdTitleIdentitySets).where(and(
      eq(
        dvdTitleIdentitySets.originalDiscArchiveId,
        selection.originalDiscArchiveId,
      ),
      eq(dvdTitleIdentitySets.manifestId, header.currentManifestId),
      eq(
        dvdTitleIdentitySets.manifestRevision,
        header.currentManifestRevision,
      ),
      eq(dvdTitleIdentitySets.manifestDigest, header.currentManifestDigest),
    )).get();
    if (set === undefined) return;
    const currentRows = transaction.select().from(dvdTitleIdentityObservations)
      .where(eq(dvdTitleIdentityObservations.manifestId, set.manifestId))
      .all();
    assertPersistedDvdTitleIdentitySet(
      set,
      currentRows,
      header.acceptedEndLbaExclusive,
    );
    const matches = currentRows
      .filter((row) => discSelectionMatchesTitleObservation(selection, row));
    if (matches.length !== 1) return;
    const match = matches[0]!;
    transaction.insert(dvdTitleIdentitySelectionBindings).values({
      titleIdentityId: match.titleIdentityId,
      discSelectionId: selection.id,
      lastObservationId: match.id,
      state: "mapped",
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
  }

  function requireCurrentCatalogMappingEvidence(
    reader: CatalogReader,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) {
    const header = reader.select().from(dvdArchiveEvidenceHeaders)
      .where(eq(
        dvdArchiveEvidenceHeaders.originalDiscArchiveId,
        originalDiscArchiveId,
      )).get();
    if (header === undefined) {
      throw new CatalogMappingEvidenceUnavailableError();
    }
    const archiveJob = reader.select({ status: archiveJobs.status })
      .from(archiveJobs)
      .where(eq(archiveJobs.id, header.sourceArchiveJobId)).get();
    const recovery = reader.select({
      id: archiveRecoveries.id,
      status: archiveRecoveries.status,
    })
      .from(archiveRecoveries)
      .where(eq(
        archiveRecoveries.originalDiscArchiveId,
        originalDiscArchiveId,
      )).get();
    if (
      archiveJob?.status !== "completed" ||
      recovery === undefined ||
      recovery.status === "faulted"
    ) {
      throw new CatalogMappingEvidenceUnavailableError();
    }
    const set = reader.select().from(dvdTitleIdentitySets).where(and(
      eq(dvdTitleIdentitySets.originalDiscArchiveId, originalDiscArchiveId),
      eq(dvdTitleIdentitySets.manifestId, header.currentManifestId),
      eq(
        dvdTitleIdentitySets.manifestRevision,
        header.currentManifestRevision,
      ),
      eq(dvdTitleIdentitySets.manifestDigest, header.currentManifestDigest),
    )).get();
    if (set === undefined) {
      throw new CatalogMappingEvidenceUnavailableError();
    }
    const currentRows = reader.select().from(dvdTitleIdentityObservations)
      .where(eq(dvdTitleIdentityObservations.manifestId, set.manifestId))
      .all();
    assertPersistedDvdTitleIdentitySet(
      set,
      currentRows,
      header.acceptedEndLbaExclusive,
    );
    const currentMappingRows = currentRows.filter(({ angleNumber }) =>
      angleNumber === 1
    );
    if (currentMappingRows.length === 0) {
      throw new CatalogMappingEvidenceUnavailableError();
    }
    return currentMappingRows;
  }

  function catalogMappingEvidenceFormat(
    reader: CatalogReader,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) {
    const header = reader.select({
      evidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
    }).from(dvdArchiveEvidenceHeaders).where(eq(
      dvdArchiveEvidenceHeaders.originalDiscArchiveId,
      originalDiscArchiveId,
    )).get();
    return dvdRecoveryEvidenceFormatForArchive(
      header,
      reader.select({ evidenceFormat: archiveJobs.evidenceFormat })
        .from(archiveJobs)
        .where(eq(
          archiveJobs.originalDiscArchiveId,
          originalDiscArchiveId,
        )).all(),
    );
  }

  function validateCurrentCatalogMappingSourceIdentity(
    sourceIdentityInput: CreateDiscSelectionInput["sourceIdentity"],
    currentRows: ReturnType<typeof requireCurrentCatalogMappingEvidence>,
  ) {
    const sourceIdentity = createDiscSelectionSourceIdentity(
      sourceIdentityInput,
    );
    if (sourceIdentity.kind === "main_feature") {
      throw new UnsupportedCatalogMappingSourceError();
    }
    const matches = currentRows.filter((row) =>
      row.displayTitleNumber === sourceIdentity.titleNumber &&
      row.angleNumber === 1 &&
      (sourceIdentity.kind === "dvd_title"
        ? row.chapterStart === 1 && row.chapterEnd === row.chapterCount
        : sourceIdentity.chapterStart >= row.chapterStart &&
          sourceIdentity.chapterEnd <= row.chapterEnd)
    );
    if (matches.length !== 1) {
      throw new CurrentCatalogMappingSourceError();
    }
    return sourceIdentity;
  }

  function validateDiscSelectionSourceIdentity(
    reader: CatalogReader,
    originalDiscArchiveId: OriginalDiscArchiveId,
    scanData: unknown,
    sourceIdentityInput: CreateDiscSelectionInput["sourceIdentity"],
  ) {
    const evidenceFormat = catalogMappingEvidenceFormat(
      reader,
      originalDiscArchiveId,
    );
    if (evidenceFormat === null) {
      return createArchivedDvdSelectionValidator(scanData).validate(
        sourceIdentityInput,
      );
    }
    return validateCurrentCatalogMappingSourceIdentity(
      sourceIdentityInput,
      requireCurrentCatalogMappingEvidence(reader, originalDiscArchiveId),
    );
  }

  function insertDiscSelection(
    transaction: CatalogTransaction,
    input: CreateDiscSelectionInput,
    id: DiscSelectionId,
    timestamp: Date,
    options: {
      activeSourceTracker?: DiscSelectionSourceOverlapTracker;
      rejectSourceOverlap?: boolean;
      allowRearchiveAcceptance?: boolean;
      validateAgainstCurrentTitleIdentity?: boolean;
    } = {},
  ) {
    const source = requireRow(
      transaction
        .select({
          discKind: originalDiscArchives.discKind,
          rearchiveSourceArchiveId:
            originalDiscArchives.rearchiveSourceArchiveId,
          scanData: detectedDiscs.scanData,
        })
        .from(originalDiscArchives)
        .innerJoin(
          detectedDiscs,
          eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
        )
        .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
        .get(),
      "original disc archive",
      input.originalDiscArchiveId,
    );
    const dvdEvidenceHeader = transaction.select({
      evidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
    }).from(dvdArchiveEvidenceHeaders).where(eq(
      dvdArchiveEvidenceHeaders.originalDiscArchiveId,
      input.originalDiscArchiveId,
    )).get();
    if (dvdEvidenceHeader?.evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT) {
      const activeSelectionCount = transaction.select({ value: count() })
        .from(discSelections).where(and(
          eq(
            discSelections.originalDiscArchiveId,
            input.originalDiscArchiveId,
          ),
          eq(discSelections.isCatalogActive, true),
        )).get()?.value ?? 0;
      if (activeSelectionCount >= MAX_DVD_TITLES) {
        throw new CatalogMappingCapacityExceededError(MAX_DVD_TITLES);
      }
    }
    requireRow(
      transaction
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(eq(mediaItems.id, input.mediaItemId))
        .get(),
      "media item",
      input.mediaItemId,
    );
    if (source.discKind !== "dvd") {
      throw new DomainInvariantError(
        "DVD Disc Selections require a DVD Original Disc Archive",
      );
    }
    if (
      source.rearchiveSourceArchiveId !== null &&
      options.allowRearchiveAcceptance !== true
    ) {
      throw new DomainInvariantError(
        "Fresh re-archive mappings require Re-archive Acceptance",
      );
    }
    const sourceIdentity = options.validateAgainstCurrentTitleIdentity
      ? validateDiscSelectionSourceIdentity(
        transaction,
        input.originalDiscArchiveId,
        source.scanData,
        input.sourceIdentity,
      )
      : createArchivedDvdSelectionValidator(source.scanData).validate(
        input.sourceIdentity,
      );
    const sourcePersistence =
      serializeDiscSelectionSourceIdentity(sourceIdentity);
    if (options.rejectSourceOverlap) {
      const overlapsSource = options.activeSourceTracker
        ? discSelectionSourceOverlapsTracker(
            sourcePersistence,
            options.activeSourceTracker,
          )
        : activeDiscSelectionSourceOverlapExists(
            transaction,
            input.originalDiscArchiveId,
            sourcePersistence,
          );
      if (overlapsSource) {
        throw new DomainInvariantError(
          "Assisted Mapping cannot use an overlapping DVD source",
        );
      }
    }
    const selection = toDiscSelection(requireRow(
      transaction
        .insert(discSelections)
        .values({
          id,
          originalDiscArchiveId: input.originalDiscArchiveId,
          mediaItemId: input.mediaItemId,
          ...sourcePersistence,
          label: input.label,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get(),
      "disc selection",
      id,
    ));
    if (options.activeSourceTracker) {
      addDiscSelectionSourceToOverlapTracker(
        options.activeSourceTracker,
        sourcePersistence,
      );
    }
    syncDvdTitleIdentitySelectionBinding(transaction, selection, timestamp);
    return selection;
  }

  function reopenCatalogReview(
    transaction: CatalogTransaction,
    archiveId: OriginalDiscArchiveId,
    timestamp: Date,
    expectedRevision?: Date,
    staleOperation = "Mapping Proposal",
  ): void {
    const latestEvidenceChoice = transaction
      .select({ choice: catalogReviewEvidenceChoices.choice })
      .from(catalogReviewEvidenceChoices)
      .where(eq(
        catalogReviewEvidenceChoices.originalDiscArchiveId,
        archiveId,
      ))
      .orderBy(
        desc(catalogReviewEvidenceChoices.catalogRevision),
        desc(catalogReviewEvidenceChoices.id),
      )
      .limit(1)
      .get();
    const currentArchive = requireRow(
      transaction
        .select({
          catalogReviewOutcome: originalDiscArchives.catalogReviewOutcome,
        })
        .from(originalDiscArchives)
        .where(eq(originalDiscArchives.id, archiveId))
        .get(),
      "original disc archive",
      archiveId,
    );
    if (
      currentArchive.catalogReviewOutcome === "archive_only" &&
      latestEvidenceChoice?.choice === "archive_only"
    ) {
      throw new CatalogMappingEvidenceUnavailableError();
    }
    const changedArchive = transaction
      .update(originalDiscArchives)
      .set({
        catalogReviewedAt: null,
        catalogReviewOutcome: "needs_review",
        updatedAt: nextCatalogMutationTimestamp(timestamp),
      })
      .where(and(
        eq(originalDiscArchives.id, archiveId),
        expectedRevision === undefined
          ? undefined
          : eq(originalDiscArchives.updatedAt, expectedRevision),
      ))
      .returning({ id: originalDiscArchives.id })
      .get();
    if (expectedRevision !== undefined && !changedArchive) {
      throw new DomainInvariantError(
        `Catalog review changed; reload before saving ${staleOperation}`,
      );
    }
  }

  function requestEncodeJobCancellation(
    transaction: CatalogTransaction,
    id: EncodeJobId,
    timestamp: Date,
  ): EncodeJob {
    const current = requireRow(
      transaction
        .select()
        .from(encodeJobs)
        .where(eq(encodeJobs.id, id))
        .get(),
      "encode job",
      id,
    );
    if (current.status !== "queued" && current.status !== "running") {
      throw new InvalidStatusTransitionError(
        "encode job",
        current.status,
        "cancelled",
      );
    }
    const claimToken = current.status === "running"
      ? current.claimToken
      : null;
    if (current.status === "running" && claimToken === null) {
      throw new DomainInvariantError(
        "Running Encode Job has no claim token",
      );
    }
    const requestedStatus = current.status === "running"
      ? "cancellation_requested" as const
      : "cancelled" as const;
    const predecessor = current.predecessorEncodeJobId === null
      ? undefined
      : transaction
          .select({ outputPath: encodeJobs.outputPath })
          .from(encodeJobs)
          .where(eq(encodeJobs.id, current.predecessorEncodeJobId))
          .get();
    const protectsCorrectedSamePath =
      predecessor?.outputPath === current.outputPath;
    const updated = transaction
      .update(encodeJobs)
      .set({
        status: requestedStatus,
        reservesOutputPath: current.status === "queued"
          ? current.replaceExistingOutput || protectsCorrectedSamePath
          : true,
        progressEtaSeconds: null,
        updatedAt: timestamp,
      })
      .where(and(
        eq(encodeJobs.id, id),
        eq(encodeJobs.status, current.status),
        claimToken !== null
          ? eq(encodeJobs.claimToken, claimToken)
          : undefined,
      ))
      .returning()
      .get();
    if (!updated) {
      throw new InvalidStatusTransitionError(
        "encode job",
        current.status,
        requestedStatus,
      );
    }
    return updated;
  }

  function validateAssistedMappingShape(
    transaction: CatalogTransaction,
    mediaItem: ValidatedMediaItem,
  ): void {
    const parent = mediaItem.parentId === null
      ? null
      : requireRow(
          transaction
            .select({ kind: mediaItems.kind })
            .from(mediaItems)
            .where(eq(mediaItems.id, mediaItem.parentId))
            .get(),
          "media item",
          mediaItem.parentId,
        );
    if (
      mediaItem.kind === "season" &&
      (mediaItem.seasonNumber === null || parent?.kind !== "tv_show")
    ) {
      throw new DomainInvariantError(
        "Assisted Mapping requires a numbered Season beneath a TV Show",
      );
    }
    if (
      mediaItem.kind === "episode" &&
      (mediaItem.episodeNumber === null || parent?.kind !== "season")
    ) {
      throw new DomainInvariantError(
        "Assisted Mapping requires a numbered Episode beneath a Season",
      );
    }
    if (
      (mediaItem.kind === "trailer" || mediaItem.kind === "bonus_feature") &&
      parent !== null &&
      !["movie", "tv_show", "season", "episode"].includes(parent.kind)
    ) {
      throw new DomainInvariantError(
        "Assisted Mapping can attach a Trailer or Bonus Feature only to a Movie, TV Show, Season, or Episode",
      );
    }
  }

  function insertValidatedMediaItem(
    transaction: CatalogTransaction,
    input: Parameters<typeof validateMediaItem>[0],
    timestamp: Date,
    options: { requireAssistedMappingShape?: boolean } = {},
  ) {
    const values = validateMediaItem(
      input,
      transaction,
      { titleNormalization: "trim" },
    );
    if (options.requireAssistedMappingShape) {
      validateAssistedMappingShape(transaction, values);
    }
    return requireRow(
      transaction
        .insert(mediaItems)
        .values({
          id: input.id,
          ...values,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get(),
      "media item",
      input.id,
    );
  }

  function ensureMediaItemTmdbIdentity(
    transaction: CatalogTransaction,
    mediaItem: { id: MediaItemId; kind: MediaItemKind },
    identity: TmdbIdentity | undefined,
    timestamp: Date,
  ): void {
    if (identity === undefined) return;
    if (
      !isValidTmdbIdentity(identity) ||
      mediaItem.kind !== identity.mediaType
    ) {
      throw new DomainInvariantError(
        "TMDB identity must match a Movie or TV Show Media Item",
      );
    }
    const current = transaction
      .select({
        mediaType: mediaItemTmdbIdentities.mediaType,
        tmdbId: mediaItemTmdbIdentities.tmdbId,
      })
      .from(mediaItemTmdbIdentities)
      .where(eq(mediaItemTmdbIdentities.mediaItemId, mediaItem.id))
      .get();
    if (current) {
      if (
        current.mediaType === identity.mediaType &&
        current.tmdbId === identity.tmdbId
      ) {
        return;
      }
      throw new DomainInvariantError(
        "Media Item already has a different TMDB identity",
      );
    }
    transaction.insert(mediaItemTmdbIdentities).values({
      mediaItemId: mediaItem.id,
      mediaType: identity.mediaType,
      tmdbId: identity.tmdbId,
      createdAt: timestamp,
    }).run();
  }

  function runMediaItemMutation(
    transaction: CatalogTransaction,
    mutationKey: string | undefined,
    operation: string,
    semanticInput: string,
    mutate: () => MediaItem,
  ): MediaItem {
    if (mutationKey !== undefined) {
      const previous = transaction.select().from(mutationInvocations)
        .where(eq(mutationInvocations.key, mutationKey)).get();
      if (previous) {
        if (previous.operation !== operation || previous.semanticInput !== semanticInput) {
          throw new MutationKeyConflictError();
        }
        const outcome = JSON.parse(previous.outcome) as MediaItem;
        return {
          ...outcome,
          createdAt: new Date(outcome.createdAt),
          updatedAt: new Date(outcome.updatedAt),
        };
      }
    }
    const outcome = mutate();
    if (mutationKey !== undefined) {
      transaction.insert(mutationInvocations).values({
        key: mutationKey,
        operation,
        semanticInput,
        outcome: JSON.stringify(outcome),
        createdAt: now(),
      }).run();
    }
    return outcome;
  }

  function requireMediaItemRevision(item: MediaItem, expected: Date | undefined): void {
    if (expected !== undefined && item.updatedAt.getTime() !== expected.getTime()) {
      throw new DomainInvariantError("Media Item changed; preview again before saving");
    }
  }

  function requireMediaItemMaintenanceRevision(
    maintenance: MediaItemMaintenance,
    options: MediaItemMutationOptions | undefined,
    impactRevision: string,
  ): void {
    if ((options?.expectedReferencedArchiveCount !== undefined &&
        maintenance.referencedArchiveCount !== options.expectedReferencedArchiveCount) ||
        (options?.expectedChildCount !== undefined &&
        maintenance.childCount !== options.expectedChildCount) ||
        (options?.expectedImpactRevision !== undefined &&
        impactRevision !== options.expectedImpactRevision)) {
      throw new DomainInvariantError("Media Item changed; preview again before saving");
    }
  }

  function projectMediaItemUpdate(
    transaction: CatalogTransaction | typeof database,
    current: MediaItem,
    input: Parameters<DataAccess["catalog"]["updateMediaItem"]>[1],
  ): MediaItem {
    const values = validateMediaItem({
      ...current,
      ...input,
      id: current.id,
      parentId: input.parentId === undefined ? current.parentId : input.parentId,
      kind: input.kind === undefined ? current.kind : input.kind,
      title: input.title === undefined ? current.title : input.title,
      year: input.year === undefined ? current.year : input.year,
      seasonNumber: input.seasonNumber === undefined ? current.seasonNumber : input.seasonNumber,
      episodeNumber: input.episodeNumber === undefined ? current.episodeNumber : input.episodeNumber,
    }, transaction, { titleNormalization: input.title === undefined ? "preserve" : "trim" });
    const identity = transaction.select({ mediaType: mediaItemTmdbIdentities.mediaType })
      .from(mediaItemTmdbIdentities)
      .where(eq(mediaItemTmdbIdentities.mediaItemId, current.id)).get();
    if (identity && identity.mediaType !== values.kind) {
      throw new DomainInvariantError("Media Item kind must match its TMDB identity");
    }
    return { ...current, ...values };
  }

  function finishCatalogReviewAfterMapping(
    transaction: CatalogTransaction,
    id: OriginalDiscArchiveId,
    catalogRevision: Date,
    timestamp: Date,
  ): void {
    const archive = requireReviewableDiscSelections(id, transaction);
    completeCatalogReviewTransition(
      transaction,
      archive,
      catalogRevision,
      "reviewed_with_selections",
      timestamp,
      {
        staleMessage:
          "Catalog review changed; reload before accepting the automatic proposal",
      },
    );
  }

  function completeCatalogReviewTransition(
    transaction: CatalogTransaction,
    archive: typeof originalDiscArchives.$inferSelect,
    catalogRevision: Date,
    outcome: CompletedCatalogReviewOutcome,
    timestamp: Date,
    options: {
      allowIdempotentCompletion?: boolean;
      staleMessage?: string;
    } = {},
  ): typeof originalDiscArchives.$inferSelect {
    const staleMessage = options.staleMessage ??
      "Catalog review changed; reload before completing review";
    if (archive.legacyCutoverPending) {
      throw new DomainInvariantError(
        "Catalog review cannot be completed while legacy cutover repair is pending",
      );
    }
    if (archive.updatedAt.getTime() !== catalogRevision.getTime()) {
      throw new DomainInvariantError(staleMessage);
    }
    if (archive.catalogReviewedAt !== null) {
      if (
        options.allowIdempotentCompletion &&
        archive.catalogReviewOutcome === outcome
      ) {
        return archive;
      }
      if (options.allowIdempotentCompletion) {
        throw new DomainInvariantError(
          "Catalog review already has a different completed outcome",
        );
      }
      throw new DomainInvariantError(staleMessage);
    }
    const completed = transaction
      .update(originalDiscArchives)
      .set({
        catalogReviewedAt: timestamp,
        catalogReviewOutcome: outcome,
        updatedAt: nextCatalogMutationTimestamp(timestamp),
      })
      .where(and(
        eq(originalDiscArchives.id, archive.id),
        eq(originalDiscArchives.updatedAt, catalogRevision),
        isNull(originalDiscArchives.catalogReviewedAt),
        eq(originalDiscArchives.catalogReviewOutcome, "needs_review"),
      ))
      .returning()
      .get();
    if (!completed) {
      throw new DomainInvariantError(staleMessage);
    }
    return completed;
  }

  function validateMappingProposalReviewTransition(
    input: MappingProposalReviewTransition,
    proposalName: "Mapping Proposal" | "Episodic Mapping Proposal",
  ): void {
    if (
      !(input.catalogRevision instanceof Date) ||
      !Number.isSafeInteger(input.catalogRevision.getTime())
    ) {
      throw new DomainInvariantError(
        `${proposalName} catalog revision must be a valid timestamp`,
      );
    }
    if (
      input.completeReview !== undefined &&
      typeof input.completeReview !== "boolean"
    ) {
      throw new DomainInvariantError(
        `${proposalName} completion choice must be a boolean`,
      );
    }
  }

  function applyMappingProposalReviewTransition(
    transaction: CatalogTransaction,
    input: MappingProposalReviewTransition,
    timestamp: Date,
  ): void {
    if (input.completeReview) {
      finishCatalogReviewAfterMapping(
        transaction,
        input.originalDiscArchiveId,
        input.catalogRevision,
        timestamp,
      );
      return;
    }
    reopenCatalogReview(
      transaction,
      input.originalDiscArchiveId,
      timestamp,
      input.catalogRevision,
    );
  }

  async function inspectFilesystemPath(
    path: string,
    configuredRoot?: { resolvedPath: string },
    expectedSizeBytes?: number,
  ): Promise<{
    verificationStatus: "accessible" | "missing" | "inaccessible" | "error";
    verificationMessage: string;
    verifiedAt: Date;
  }> {
    try {
      const inspection = expectedSizeBytes === undefined
        ? await filesystemPathProbe.inspect(
            path,
            configuredRoot?.resolvedPath,
          )
        : await filesystemPathProbe.inspect(
            path,
            configuredRoot?.resolvedPath,
            expectedSizeBytes,
          );
      if (inspection === "unsafe") {
        return {
          verificationStatus: "error",
          verificationMessage:
            "Recorded path is outside the configured library.",
          verifiedAt: now(),
        };
      }
      if (inspection === "size_mismatch") {
        return {
          verificationStatus: "error",
          verificationMessage:
            "File size does not match the Original Disc Archive.",
          verifiedAt: now(),
        };
      }
      if (inspection !== "file") {
        return {
          verificationStatus: "error",
          verificationMessage: "Recorded path is not a regular file.",
          verifiedAt: now(),
        };
      }
      return {
        verificationStatus: "accessible",
        verificationMessage: "File is accessible.",
        verifiedAt: now(),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return {
          verificationStatus: "missing",
          verificationMessage: "File is missing at the recorded path.",
          verifiedAt: now(),
        };
      }
      if (code === "EACCES" || code === "EPERM") {
        return {
          verificationStatus: "inaccessible",
          verificationMessage:
            "The recorded path cannot be accessed.",
          verifiedAt: now(),
        };
      }
      return {
        verificationStatus: "error",
        verificationMessage: "Verification failed unexpectedly.",
        verifiedAt: now(),
      };
    }
  }

  function legacyCutoverFenceCondition(
    fingerprint: string,
    archivePath: string,
  ) {
    return normalizedOriginalsLibraryPath === undefined
      ? or(
          eq(legacyCutoverStagedSidecars.fingerprint, fingerprint),
          eq(legacyCutoverStagedSidecars.archivePath, archivePath),
        )
      : eq(
          legacyCutoverStagedSidecars.originalsLibraryPath,
          normalizedOriginalsLibraryPath,
        );
  }

  function optionalSafeInteger(
    value: number | null | undefined,
    field: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number | null | undefined {
    if (value === null || value === undefined) {
      return value;
    }
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new DomainInvariantError(
        `${field} must be a safe integer between ${minimum} and ${maximum}`,
      );
    }
    return value;
  }

  function requireSafeIntegerInRange(
    value: number,
    field: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number {
    const validated = optionalSafeInteger(value, field, minimum, maximum);
    if (validated === null || validated === undefined) {
      throw new DomainInvariantError(`${field} must be present`);
    }
    return validated;
  }

  function requireCatalogReviewCompletionArchive(
    archiveId: OriginalDiscArchiveId,
    querySource: Pick<typeof database, "select">,
  ): typeof originalDiscArchives.$inferSelect {
    const archive = requireRow(
      querySource
        .select()
        .from(originalDiscArchives)
        .where(eq(originalDiscArchives.id, archiveId))
        .get(),
      "original disc archive",
      archiveId,
    );
    if (archive.discKind !== "dvd") {
      throw new DomainInvariantError(
        "Catalog review currently requires a DVD Original Disc Archive",
      );
    }
    if (
      archive.rearchiveSourceArchiveId !== null &&
      archive.catalogReviewedAt === null
    ) {
      throw new DomainInvariantError(
        "Fresh re-archive review is completed through Re-archive Acceptance",
      );
    }
    return archive;
  }

  function requireReviewableDiscSelections(
    archiveId: OriginalDiscArchiveId,
    querySource: Pick<typeof database, "select"> = database,
  ): typeof originalDiscArchives.$inferSelect {
    const archive = requireCatalogReviewCompletionArchive(
      archiveId,
      querySource,
    );
    const scanData = requireRow(
      querySource
        .select({ scanData: detectedDiscs.scanData })
        .from(detectedDiscs)
        .where(eq(detectedDiscs.id, archive.detectedDiscId))
        .get(),
      "detected disc",
      archive.detectedDiscId,
    ).scanData;
    const validator = createArchivedDvdSelectionValidator(scanData);
    let lastSelectionId: DiscSelectionId | undefined;
    let selectionCount = 0;
    while (true) {
      const rows = querySource
        .select()
        .from(discSelections)
        .where(
          and(
            eq(discSelections.originalDiscArchiveId, archiveId),
            eq(discSelections.isCatalogActive, true),
            lastSelectionId === undefined
              ? undefined
              : gt(discSelections.id, lastSelectionId),
          ),
        )
        .orderBy(asc(discSelections.id))
        .limit(DISC_SELECTION_REVIEW_BATCH_SIZE)
        .all();
      for (const row of rows) {
        const selection = toDiscSelection(row);
        validator.validate(
          selection.sourceIdentity,
          { persistedSourceKey: row.sourceKey },
        );
        selectionCount += 1;
      }
      if (rows.length < DISC_SELECTION_REVIEW_BATCH_SIZE) {
        break;
      }
      lastSelectionId = rows.at(-1)!.id;
    }
    if (selectionCount === 0) {
      throw new DomainInvariantError(
        "Catalog review requires at least one Disc Selection",
      );
    }
    return archive;
  }

  function validateDiscSelectionsOutsideWriter(
    archiveId: OriginalDiscArchiveId,
    catalogRevision: Date,
  ): typeof originalDiscArchives.$inferSelect {
    return database.transaction(
      (transaction) => {
        requireCatalogReviewCompletionRevision(
          archiveId,
          catalogRevision,
          transaction,
        );
        return requireReviewableDiscSelections(archiveId, transaction);
      },
      { behavior: "deferred" },
    );
  }

  function requireArchiveOnlyReview(
    archiveId: OriginalDiscArchiveId,
    querySource: Pick<typeof database, "select"> = database,
  ): typeof originalDiscArchives.$inferSelect {
    const archive = requireCatalogReviewCompletionArchive(
      archiveId,
      querySource,
    );
    const activeSelection = querySource
      .select({ id: discSelections.id })
      .from(discSelections)
      .where(and(
        eq(discSelections.originalDiscArchiveId, archiveId),
        eq(discSelections.isCatalogActive, true),
      ))
      .limit(1)
      .get();
    if (activeSelection) {
      throw new DomainInvariantError(
        "Archive-only Review cannot contain Disc Selections",
      );
    }
    return archive;
  }

  function validateArchiveOnlyOutsideWriter(
    archiveId: OriginalDiscArchiveId,
    catalogRevision: Date,
  ): typeof originalDiscArchives.$inferSelect {
    return database.transaction(
      (transaction) => {
        requireCatalogReviewCompletionRevision(
          archiveId,
          catalogRevision,
          transaction,
        );
        return requireArchiveOnlyReview(archiveId, transaction);
      },
      { behavior: "deferred" },
    );
  }

  function requireCatalogReviewCompletionRevision(
    archiveId: OriginalDiscArchiveId,
    catalogRevision: Date,
    querySource: Pick<typeof database, "select">,
  ): void {
    const archive = requireRow(
      querySource
        .select({ updatedAt: originalDiscArchives.updatedAt })
        .from(originalDiscArchives)
        .where(eq(originalDiscArchives.id, archiveId))
        .get(),
      "original disc archive",
      archiveId,
    );
    if (archive.updatedAt.getTime() !== catalogRevision.getTime()) {
      throw new StaleCatalogRevisionError(
        "Catalog review changed; reload before completing review",
      );
    }
  }

  function readCatalogReviewActionAvailability(
    archiveId: OriginalDiscArchiveId,
  ): CatalogReviewActionAvailability {
    const availability = (
      validate: (id: OriginalDiscArchiveId) => typeof originalDiscArchives.$inferSelect,
    ): CatalogReviewActionAvailability["completeWithSelections"] => {
      try {
        const archive = validate(archiveId);
        if (archive.legacyCutoverPending) {
          return {
            state: "blocked",
            reason: "Catalog review cannot be completed while legacy cutover repair is pending",
          };
        }
        if (archive.catalogReviewedAt !== null) {
          return { state: "blocked", reason: "Catalog review is already complete" };
        }
        return { state: "available", reason: null };
      } catch (error) {
        if (error instanceof DomainInvariantError) {
          return { state: "blocked", reason: error.message };
        }
        throw error;
      }
    };
    return {
      completeWithSelections: availability(requireReviewableDiscSelections),
      completeArchiveOnly: availability(requireArchiveOnlyReview),
    };
  }

  function requireCurrentCatalogValidation(
    validatedArchive: typeof originalDiscArchives.$inferSelect,
    querySource: Pick<typeof database, "select">,
    staleCatalogRevision = false,
  ): typeof originalDiscArchives.$inferSelect {
    const currentArchive = querySource
      .select()
      .from(originalDiscArchives)
      .where(and(
        eq(originalDiscArchives.id, validatedArchive.id),
        eq(originalDiscArchives.updatedAt, validatedArchive.updatedAt),
      ))
      .get();
    if (currentArchive) {
      return currentArchive;
    }
    if (staleCatalogRevision) {
      throw new StaleCatalogRevisionError(
        "Catalog review changed; reload before completing review",
      );
    }
    throw new DomainInvariantError(
      "Catalog changed during validation; retry the operation",
    );
  }

  /** Matches stored identities and metadata-derived compatibility identities. */
  function findOriginalArchiveByFingerprintOrContentIdAlias(
    fingerprintOrContentIdAlias: string,
    querySource: Pick<typeof database, "select"> = database,
  ) {
    const direct = querySource
      .select({
        detectedDiscId: originalDiscArchives.detectedDiscId,
        discKind: originalDiscArchives.discKind,
        id: originalDiscArchives.id,
      })
      .from(originalDiscArchives)
      .leftJoin(
        originalDiscArchiveContentIds,
        eq(
          originalDiscArchiveContentIds.originalDiscArchiveId,
          originalDiscArchives.id,
        ),
      )
      .where(
        or(
          eq(
            originalDiscArchives.fingerprint,
            fingerprintOrContentIdAlias,
          ),
          eq(
            originalDiscArchiveContentIds.contentId,
            fingerprintOrContentIdAlias,
          ),
        ),
      )
      .orderBy(
        asc(originalDiscArchives.archivedAt),
        asc(originalDiscArchives.id),
      )
      .get();
    if (direct !== undefined || !isDvdMetadataFingerprint(
      fingerprintOrContentIdAlias,
    )) {
      return direct;
    }

    const candidates = querySource
      .select({
        detectedDiscId: originalDiscArchives.detectedDiscId,
        discKind: originalDiscArchives.discKind,
        id: originalDiscArchives.id,
        boundaryReportedSizeBytes:
          originalDiscArchives.boundaryReportedSizeBytes,
        scanData: detectedDiscs.scanData,
        sizeBytes: originalDiscArchives.sizeBytes,
        volumeLabel: detectedDiscs.volumeLabel,
      })
      .from(originalDiscArchives)
      .innerJoin(
        detectedDiscs,
        eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
      )
      .where(and(
        eq(originalDiscArchives.discKind, "dvd"),
        or(
          isNotNull(originalDiscArchives.boundaryReportedSizeBytes),
          isNotNull(originalDiscArchives.sizeBytes),
        ),
      ))
      .orderBy(asc(originalDiscArchives.id))
      .limit(DVD_METADATA_FINGERPRINT_RECONCILIATION_LIMIT + 1)
      .all();
    if (candidates.length > DVD_METADATA_FINGERPRINT_RECONCILIATION_LIMIT) {
      throw new DomainInvariantError(
        "DVD metadata fingerprint reconciliation exceeds its safety limit",
      );
    }
    const matches = candidates.flatMap((candidate) => {
      const scan = decodeDvdTitleMap(candidate.scanData);
      const reportedSizeBytes = candidate.boundaryReportedSizeBytes ??
        candidate.sizeBytes;
      if (scan === null || reportedSizeBytes === null) {
        return [];
      }
      return createDvdMetadataFingerprint({
        sizeBytes: reportedSizeBytes,
        titles: scan.titles,
        volumeLabel: candidate.volumeLabel ?? undefined,
      }) === fingerprintOrContentIdAlias
        ? [{
            detectedDiscId: candidate.detectedDiscId,
            discKind: candidate.discKind,
            id: candidate.id,
          }]
        : [];
    });
    if (matches.length > 1) {
      throw new DomainInvariantError(
        "DVD metadata fingerprint matches multiple Original Disc Archives",
      );
    }
    return matches[0];
  }

  function originalArchiveMatchesFingerprintOrContentIdAlias(
    archiveId: OriginalDiscArchiveId,
    fingerprintOrContentIdAlias: string,
    querySource: Pick<typeof database, "select"> = database,
  ): boolean {
    const candidates = querySource
      .select({
        contentId: originalDiscArchiveContentIds.contentId,
        fingerprint: originalDiscArchives.fingerprint,
        boundaryReportedSizeBytes:
          originalDiscArchives.boundaryReportedSizeBytes,
        scanData: detectedDiscs.scanData,
        sizeBytes: originalDiscArchives.sizeBytes,
        volumeLabel: detectedDiscs.volumeLabel,
      })
      .from(originalDiscArchives)
      .innerJoin(
        detectedDiscs,
        eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
      )
      .leftJoin(
        originalDiscArchiveContentIds,
        eq(
          originalDiscArchiveContentIds.originalDiscArchiveId,
          originalDiscArchives.id,
        ),
      )
      .where(eq(originalDiscArchives.id, archiveId))
      .limit(DVD_METADATA_FINGERPRINT_RECONCILIATION_LIMIT + 1)
      .all();
    if (candidates.length > DVD_METADATA_FINGERPRINT_RECONCILIATION_LIMIT) {
      throw new DomainInvariantError(
        "Original Disc Archive content identity aliases exceed the safety limit",
      );
    }
    if (candidates.some((candidate) =>
      candidate.fingerprint === fingerprintOrContentIdAlias ||
      candidate.contentId === fingerprintOrContentIdAlias
    )) {
      return true;
    }
    const candidate = candidates[0];
    const reportedSizeBytes = candidate?.boundaryReportedSizeBytes ??
      candidate?.sizeBytes;
    if (
      candidate === undefined ||
      reportedSizeBytes === null ||
      reportedSizeBytes === undefined ||
      !isDvdMetadataFingerprint(fingerprintOrContentIdAlias)
    ) {
      return false;
    }
    const scan = decodeDvdTitleMap(candidate.scanData);
    return scan !== null && createDvdMetadataFingerprint({
      sizeBytes: reportedSizeBytes,
      titles: scan.titles,
      volumeLabel: candidate.volumeLabel ?? undefined,
    }) === fingerprintOrContentIdAlias;
  }

  function originalArchivesShareDiscIdentity(
    firstArchiveId: OriginalDiscArchiveId,
    secondArchiveId: OriginalDiscArchiveId,
    querySource: Pick<typeof database, "select"> = database,
  ): boolean {
    if (firstArchiveId === secondArchiveId) {
      return true;
    }
    const archives = querySource
      .select({
        fingerprint: originalDiscArchives.fingerprint,
        id: originalDiscArchives.id,
      })
      .from(originalDiscArchives)
      .where(inArray(originalDiscArchives.id, [
        firstArchiveId,
        secondArchiveId,
      ]))
      .all();
    const firstArchive = archives.find(({ id }) => id === firstArchiveId);
    const secondArchive = archives.find(({ id }) => id === secondArchiveId);
    return firstArchive !== undefined && secondArchive !== undefined &&
      (originalArchiveMatchesFingerprintOrContentIdAlias(
        firstArchiveId,
        secondArchive.fingerprint,
        querySource,
      ) || originalArchiveMatchesFingerprintOrContentIdAlias(
        secondArchiveId,
        firstArchive.fingerprint,
        querySource,
      ));
  }

  function hasPendingArchiveRequestForDisc(
    disc: Pick<
      typeof detectedDiscs.$inferSelect,
      "discKind" | "fingerprint"
    >,
    options?: { admittedOnly?: boolean },
  ): boolean {
    const candidates = database
      .select({
        evidenceFormat: archiveRequests.evidenceFormat,
        fingerprint: detectedDiscs.fingerprint,
        rearchiveSourceArchiveId: archiveRequests.rearchiveSourceArchiveId,
      })
      .from(archiveRequests)
      .innerJoin(
        detectedDiscs,
        eq(detectedDiscs.id, archiveRequests.detectedDiscId),
      )
      .where(
        and(
          eq(archiveRequests.status, "pending"),
          eq(detectedDiscs.discKind, disc.discKind),
          or(
            eq(detectedDiscs.fingerprint, disc.fingerprint),
            isNotNull(archiveRequests.rearchiveSourceArchiveId),
          ),
        ),
      )
      .orderBy(
        desc(archiveRequests.priority),
        asc(archiveRequests.createdAt),
        asc(archiveRequests.id),
      )
      .limit(ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT + 1)
      .all();
    if (candidates.length > ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT) {
      throw new DomainInvariantError(
        "Pending Archive Request identity lookup exceeds the safety limit",
      );
    }
    return candidates.some((candidate) =>
      (!options?.admittedOnly || candidate.evidenceFormat === null) &&
      (
        candidate.fingerprint === disc.fingerprint ||
        (candidate.rearchiveSourceArchiveId !== null &&
          originalArchiveMatchesFingerprintOrContentIdAlias(
            candidate.rearchiveSourceArchiveId,
            disc.fingerprint,
          ))
      )
    );
  }

  function hasUnresolvedLegacyDvdArchiveIdentity(
    querySource: Pick<typeof database, "select"> = database,
  ): boolean {
    return querySource
      .select({ id: originalDiscArchives.id })
      .from(originalDiscArchives)
      .where(unresolvedLegacyDvdArchiveIdentity)
      .limit(1)
      .get() !== undefined;
  }

  function requireLegacyDvdArchiveIdentitiesResolved(
    discKind: (typeof detectedDiscs.$inferSelect)["discKind"],
    fingerprint: string,
    querySource: Pick<typeof database, "select"> = database,
  ): void {
    if (
      discKind === "dvd" &&
      isDvdContentId(fingerprint) &&
      hasUnresolvedLegacyDvdArchiveIdentity(querySource)
    ) {
      throw new DomainInvariantError(
        "Legacy DVD archive content identities must be reconciled before Archive Jobs can advance",
      );
    }
  }

  function reconcileLegacyDvdArchiveContentId(
    fingerprint: string,
    sizeBytes: number | undefined,
    mutationFence?: (
      querySource: Pick<typeof database, "select">,
    ) => void,
  ): void {
    if (
      sizeBytes === undefined ||
      !isDvdContentId(fingerprint) ||
      findOriginalArchiveByFingerprintOrContentIdAlias(fingerprint) !==
        undefined
    ) {
      return;
    }
    if (!isCurrentDvdContentSize(sizeBytes)) {
      throw new DomainInvariantError("DVD content size is invalid");
    }

    const unresolvedCandidates = database
      .select({
        archivePath: originalDiscArchives.archivePath,
        fingerprint: originalDiscArchives.fingerprint,
        id: originalDiscArchives.id,
        sizeBytes: originalDiscArchives.sizeBytes,
      })
      .from(originalDiscArchives)
      .where(unresolvedLegacyDvdArchiveIdentity)
      .orderBy(
        desc(sql`${originalDiscArchives.sizeBytes} = ${sizeBytes}`),
        desc(sql`${originalDiscArchives.sizeBytes} is null`),
        asc(originalDiscArchives.id),
      )
      .limit(LEGACY_ARCHIVE_RECONCILIATION_LIMIT + 1)
      .all();
    const candidates: Array<
      (typeof unresolvedCandidates)[number] & { resolvedSizeBytes: number }
    > = [];
    let candidateBytes = 0;
    for (const candidate of unresolvedCandidates) {
      if (candidates.length >= LEGACY_ARCHIVE_RECONCILIATION_LIMIT) {
        break;
      }
      let candidateSizeBytes = candidate.sizeBytes;
      if (
        candidateSizeBytes === null ||
        !isCurrentDvdContentSize(candidateSizeBytes)
      ) {
        try {
          candidateSizeBytes = readDvdArchiveFileSize(candidate.archivePath);
        } catch {
          throw new DomainInvariantError(
            "Legacy DVD archive content identity requires operator remediation because its size cannot be safely derived",
          );
        }
      }
      if (
        candidateBytes + candidateSizeBytes >
          LEGACY_ARCHIVE_RECONCILIATION_BYTES
      ) {
        break;
      }
      candidates.push({ ...candidate, resolvedSizeBytes: candidateSizeBytes });
      candidateBytes += candidateSizeBytes;
    }

    for (const candidate of candidates) {
      const candidateSizeBytes = candidate.resolvedSizeBytes;
      const hashed = hashDvdArchiveFile(
        candidate.archivePath,
        candidateSizeBytes,
      );
      database.transaction((transaction) => {
        mutationFence?.(transaction);
        const candidateSizeCondition = candidate.sizeBytes === null
          ? isNull(originalDiscArchives.sizeBytes)
          : eq(originalDiscArchives.sizeBytes, candidate.sizeBytes);
        const current = transaction
          .select({ id: originalDiscArchives.id })
          .from(originalDiscArchives)
          .where(
            and(
              eq(originalDiscArchives.id, candidate.id),
              eq(originalDiscArchives.archivePath, candidate.archivePath),
              eq(originalDiscArchives.fingerprint, candidate.fingerprint),
              candidateSizeCondition,
              eq(originalDiscArchives.discKind, "dvd"),
            ),
          )
          .get();
        if (
          !current ||
          !dvdArchiveFileMatchesIdentity(
            candidate.archivePath,
            hashed.identity,
          )
        ) {
          throw new DomainInvariantError(
            "Legacy DVD archive changed during content identity reconciliation",
          );
        }
        if (candidate.sizeBytes !== candidateSizeBytes) {
          const updated = transaction
            .update(originalDiscArchives)
            .set({ sizeBytes: candidateSizeBytes, updatedAt: now() })
            .where(
              and(
                eq(originalDiscArchives.id, candidate.id),
                candidateSizeCondition,
              ),
            )
            .returning({ id: originalDiscArchives.id })
            .get();
          if (!updated) {
            throw new DomainInvariantError(
              "Legacy DVD archive changed during content identity reconciliation",
            );
          }
        }
        assignDvdContentIdAlias(transaction, {
          originalDiscArchiveId: candidate.id,
          contentId: hashed.contentId,
          conflictMessages: {
            fingerprintOwner:
              "DVD content identity is already stored as a different Original Disc Archive fingerprint",
            aliasOwner:
              "DVD content identity is already assigned to a different Original Disc Archive",
          },
        });
      }, { behavior: "immediate" });
      if (hashed.contentId === fingerprint) {
        return;
      }
    }
    if (hasUnresolvedLegacyDvdArchiveIdentity()) {
      throw new DomainInvariantError(
        "Legacy DVD archive reconciliation made bounded progress; retry detection to continue",
      );
    }
  }

  function requireEncodingProfileInDomain(
    querySource: Pick<typeof database, "select">,
    id: EncodingProfileId,
    mediaDomain: MediaDomain,
  ): typeof encodingProfiles.$inferSelect {
    const profile = querySource
      .select()
      .from(encodingProfiles)
      .where(
        and(
          eq(encodingProfiles.id, id),
          eq(encodingProfiles.mediaDomain, mediaDomain),
        ),
      )
      .get();
    if (profile) {
      return profile;
    }

    const existing = querySource
      .select({ mediaDomain: encodingProfiles.mediaDomain })
      .from(encodingProfiles)
      .where(eq(encodingProfiles.id, id))
      .get();
    if (existing) {
      throw new DomainInvariantError(
        "Encoding Profile does not belong to the requested media domain",
      );
    }
    throw new RecordNotFoundError("encoding profile", id);
  }

  function archiveJobListCondition(
    statuses: ArchiveJobStatus[] | undefined,
    options: ArchiveJobListOptions | undefined,
  ) {
    const requestScope = options?.archiveRequestIds?.length
      ? inArray(archiveJobs.archiveRequestId, [...options.archiveRequestIds])
      : undefined;
    const discScope = options?.detectedDiscIds?.length
      ? inArray(archiveJobs.detectedDiscId, [...options.detectedDiscIds])
      : undefined;
    if (
      (options?.archiveRequestIds !== undefined ||
        options?.detectedDiscIds !== undefined) &&
      requestScope === undefined &&
      discScope === undefined
    ) {
      return null;
    }
    return and(
      statuses?.length ? inArray(archiveJobs.status, statuses) : undefined,
      requestScope === undefined
        ? discScope
        : discScope === undefined
          ? requestScope
          : or(requestScope, discScope),
    );
  }

  const listArchiveJobs = createBoundedChronologicalList<
    ArchiveJob,
    ArchiveJobStatus,
    ArchiveJobListOptions
  >({
    activeStatuses: ["running"],
    historyStatuses: ["completed", "failed", "aborted"],
    chronologicalAt: (job) => job.updatedAt,
    readAll(statuses, options) {
      const condition = archiveJobListCondition(statuses, options);
      if (condition === null) {
        return [];
      }
      return database
        .select()
        .from(archiveJobs)
        .where(condition)
        .orderBy(asc(archiveJobs.createdAt), asc(archiveJobs.id))
        .all();
    },
    readNewest(statuses, limit, options) {
      const condition = archiveJobListCondition(statuses, options);
      if (condition === null) {
        return [];
      }
      return database
        .select()
        .from(archiveJobs)
        .where(condition)
        .orderBy(desc(archiveJobs.updatedAt), desc(archiveJobs.id))
        .limit(limit)
        .all();
    },
  });

  const listArchiveRequests = createBoundedChronologicalList<
    typeof archiveRequests.$inferSelect,
    ArchiveRequestStatus,
    ChronologicalListOptions
  >({
    activeStatuses: [
      "pending",
      "running",
      "needs_attention",
      "cancellation_requested",
    ],
    historyStatuses: ["fulfilled", "cancelled"],
    chronologicalAt: (request) => request.updatedAt,
    readAll(statuses) {
      return database
        .select()
        .from(archiveRequests)
        .where(
          statuses?.length
            ? inArray(archiveRequests.status, statuses)
            : undefined,
        )
        .orderBy(
          desc(archiveRequests.priority),
          asc(archiveRequests.createdAt),
          asc(archiveRequests.id),
        )
        .all();
    },
    readNewest(statuses, limit) {
      return database
        .select()
        .from(archiveRequests)
        .where(
          statuses?.length
            ? inArray(archiveRequests.status, statuses)
            : undefined,
        )
        .orderBy(desc(archiveRequests.updatedAt), desc(archiveRequests.id))
        .limit(limit)
        .all();
    },
  });

  const listEncodeJobs = createJobList<EncodeJob, EncodeJobStatus>({
    activeStatuses: ["queued", "running", "cancellation_requested"],
    historyStatuses: ["completed", "failed", "cancelled"],
    readQueue(statuses) {
      return database
        .select()
        .from(encodeJobs)
        .where(
          statuses?.length ? inArray(encodeJobs.status, statuses) : undefined,
        )
        .orderBy(desc(encodeJobs.priority), asc(encodeJobs.createdAt))
        .all();
    },
    readNewest(statuses, limit) {
      return database
        .select()
        .from(encodeJobs)
        .where(
          statuses?.length ? inArray(encodeJobs.status, statuses) : undefined,
        )
        .orderBy(desc(encodeJobs.updatedAt), desc(encodeJobs.id))
        .limit(limit)
        .all();
    },
  });

  const correctedEncodeReplacementPlanStatement = sqlite.prepare(`
    with recursive correction_lineage(
      ancestor_disc_selection_id,
      replacement_disc_selection_id
    ) as (
      select
        supersession.superseded_disc_selection_id,
        active_replacement.id
      from disc_selection_supersessions as supersession
      inner join disc_selections as active_replacement
        on active_replacement.id = supersession.replacement_disc_selection_id
      where active_replacement.original_disc_archive_id = ?
        and active_replacement.is_catalog_active = 1
      union
      select
        prior_correction.superseded_disc_selection_id,
        correction_lineage.replacement_disc_selection_id
      from correction_lineage
      inner join disc_selection_supersessions as prior_correction
        on prior_correction.replacement_disc_selection_id =
          correction_lineage.ancestor_disc_selection_id
    )
    select distinct
      predecessor.id as predecessor_encode_job_id,
      active_replacement.id as replacement_disc_selection_id,
      predecessor.encoding_profile_id as proposed_encoding_profile_id,
      predecessor.output_path as proposed_output_path,
      predecessor.status as predecessor_status,
      predecessor.partial_cleanup_output_path,
      predecessor.partial_cleanup_claim_token,
      predecessor.partial_cleanup_lease_token,
      predecessor.publication_pending,
      predecessor.publication_completion_pending,
      predecessor.reserves_output_path,
      predecessor.replace_existing_output
    from correction_lineage
    inner join disc_selections as active_replacement
      on active_replacement.id =
        correction_lineage.replacement_disc_selection_id
    inner join encode_jobs as predecessor
      on predecessor.disc_selection_id =
        correction_lineage.ancestor_disc_selection_id
    left join encode_jobs as corrected_replacement
      on corrected_replacement.predecessor_encode_job_id = predecessor.id
    where corrected_replacement.id is null
      and (? is null or predecessor.id = ?)
    order by predecessor.created_at, predecessor.id
    limit ? offset ?
  `);
  const prepareRearchiveEncodeReplacementPlanStatement = () => sqlite.prepare(`
    with recursive rearchive_lineage(
      source_disc_selection_id,
      lineage_disc_selection_id
    ) as (
      select
        proposal_item.source_disc_selection_id,
        proposal_item.source_disc_selection_id
      from rearchive_mapping_proposal_items as proposal_item
      where proposal_item.target_archive_id = ?
      union
      select
        rearchive_lineage.source_disc_selection_id,
        supersession.superseded_disc_selection_id
      from rearchive_lineage
      inner join disc_selection_supersessions as supersession
        on supersession.replacement_disc_selection_id =
          rearchive_lineage.lineage_disc_selection_id
    )
    select
      predecessor.id as predecessor_encode_job_id,
      min(rearchive_lineage.source_disc_selection_id) as
        source_disc_selection_id,
      count(distinct rearchive_lineage.source_disc_selection_id) as
        source_disc_selection_count,
      predecessor.encoding_profile_id as proposed_encoding_profile_id,
      predecessor.output_path as proposed_output_path,
      predecessor.status as predecessor_status,
      predecessor.partial_cleanup_output_path,
      predecessor.partial_cleanup_claim_token,
      predecessor.partial_cleanup_lease_token,
      predecessor.publication_pending,
      predecessor.publication_completion_pending,
      predecessor.reserves_output_path,
      predecessor.replace_existing_output
    from rearchive_lineage
    inner join encode_jobs as predecessor
      on predecessor.disc_selection_id =
        rearchive_lineage.lineage_disc_selection_id
    left join encode_jobs as replacement
      on replacement.predecessor_encode_job_id = predecessor.id
    where replacement.id is null
    group by predecessor.id
    order by predecessor.created_at, predecessor.id
    limit ? offset ?
  `);
  const releaseCorrectedFailedReservationsStatement = sqlite.prepare(`
    with recursive correction_lineage(ancestor_disc_selection_id) as (
      select
        supersession.superseded_disc_selection_id
      from disc_selection_supersessions as supersession
      inner join disc_selections as active_replacement
        on active_replacement.id = supersession.replacement_disc_selection_id
      where active_replacement.original_disc_archive_id = ?
        and active_replacement.is_catalog_active = 1
      union
      select
        prior_correction.superseded_disc_selection_id
      from correction_lineage
      inner join disc_selection_supersessions as prior_correction
        on prior_correction.replacement_disc_selection_id =
          correction_lineage.ancestor_disc_selection_id
    )
    update encode_jobs
    set reserves_output_path = 0, updated_at = ?
    where status = 'failed'
      and replace_existing_output = 0
      and reserves_output_path = 1
      and partial_cleanup_output_path is null
      and partial_cleanup_claim_token is null
      and partial_cleanup_lease_token is null
      and publication_pending = 0
      and publication_completion_pending = 0
      and disc_selection_id in (
        select correction_lineage.ancestor_disc_selection_id
        from correction_lineage
      )
  `);

  interface EncodeReplacementReadinessRow {
    predecessor_status: EncodeJobStatus;
    partial_cleanup_output_path: string | null;
    partial_cleanup_claim_token: EncodeJobClaimToken | null;
    partial_cleanup_lease_token: EncodeJobCleanupClaimToken | null;
    publication_pending: number;
    publication_completion_pending: number;
    reserves_output_path: number;
    replace_existing_output: number;
  }

  function replacementReadiness(row: EncodeReplacementReadinessRow) {
    const predecessorReady = isEncodeJobSafelyTerminal({
      status: row.predecessor_status,
      partialCleanupOutputPath: row.partial_cleanup_output_path,
      partialCleanupClaimToken: row.partial_cleanup_claim_token,
      partialCleanupLeaseToken: row.partial_cleanup_lease_token,
      publicationPending: row.publication_pending === 1,
      publicationCompletionPending:
        row.publication_completion_pending === 1,
    });
    return {
      predecessorReady,
      releasesFailedOutputReservation:
        row.predecessor_status === "failed" && predecessorReady &&
        row.reserves_output_path === 1 &&
        row.replace_existing_output === 0,
    };
  }

  function readCorrectedEncodeReplacementPlans(input: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    predecessorEncodeJobId?: EncodeJobId;
    limit: number;
    offset?: number;
  }): CorrectedEncodeReplacementPlan[] {
    const limit = requirePositiveSafeInteger(input.limit, "limit");
    if (limit > MAX_CORRECTED_ENCODE_REPLACEMENT_PLAN_PAGE_SIZE) {
      throw new DomainInvariantError(
        `Corrected Encode replacement plan limit cannot exceed ${MAX_CORRECTED_ENCODE_REPLACEMENT_PLAN_PAGE_SIZE}`,
      );
    }
    const offset = optionalSafeInteger(input.offset, "offset", 0) ?? 0;
    const predecessorEncodeJobId = input.predecessorEncodeJobId ?? null;
    const rows = correctedEncodeReplacementPlanStatement.all(
      input.originalDiscArchiveId,
      predecessorEncodeJobId,
      predecessorEncodeJobId,
      limit,
      offset,
    ) as unknown as Array<{
      predecessor_encode_job_id: EncodeJobId;
      replacement_disc_selection_id: DiscSelectionId;
      proposed_encoding_profile_id: EncodingProfileId;
      proposed_output_path: string;
      predecessor_status: EncodeJobStatus;
      partial_cleanup_output_path: string | null;
      partial_cleanup_claim_token: EncodeJobClaimToken | null;
      partial_cleanup_lease_token: EncodeJobCleanupClaimToken | null;
      publication_pending: number;
      publication_completion_pending: number;
      reserves_output_path: number;
      replace_existing_output: number;
    }>;
    return rows.map((row) => ({
      predecessorEncodeJobId: row.predecessor_encode_job_id,
      replacementDiscSelectionId: row.replacement_disc_selection_id,
      proposedEncodingProfileId: row.proposed_encoding_profile_id,
      proposedOutputPath: row.proposed_output_path,
      predecessorStatus: row.predecessor_status,
      ...replacementReadiness(row),
    }));
  }

  function readRearchiveEncodeReplacementPlans(input: {
    targetArchiveId: OriginalDiscArchiveId;
    limit: number;
    offset?: number;
  }): RearchiveEncodeReplacementPlan[] {
    const limit = requirePositiveSafeInteger(input.limit, "limit");
    if (limit > MAX_CORRECTED_ENCODE_REPLACEMENT_PLAN_PAGE_SIZE) {
      throw new DomainInvariantError(
        `Re-archive replacement plan limit cannot exceed ${MAX_CORRECTED_ENCODE_REPLACEMENT_PLAN_PAGE_SIZE}`,
      );
    }
    const offset = optionalSafeInteger(input.offset, "offset", 0) ?? 0;
    const rows = prepareRearchiveEncodeReplacementPlanStatement().all(
      input.targetArchiveId,
      limit,
      offset,
    ) as unknown as Array<EncodeReplacementReadinessRow & {
      predecessor_encode_job_id: EncodeJobId;
      source_disc_selection_id: DiscSelectionId;
      source_disc_selection_count: number;
      proposed_encoding_profile_id: EncodingProfileId;
      proposed_output_path: string;
    }>;
    return rows.map((row) => {
      if (row.source_disc_selection_count !== 1) {
        throw new DomainInvariantError(
          "Re-archive replacement lineage reaches more than one reviewed mapping",
        );
      }
      return {
        predecessorEncodeJobId: row.predecessor_encode_job_id,
        sourceDiscSelectionId: row.source_disc_selection_id,
        proposedEncodingProfileId: row.proposed_encoding_profile_id,
        proposedOutputPath: row.proposed_output_path,
        predecessorStatus: row.predecessor_status,
        ...replacementReadiness(row),
      };
    });
  }

  function readAllCorrectedEncodeReplacementPlans(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): CorrectedEncodeReplacementPlan[] {
    const replacements: CorrectedEncodeReplacementPlan[] = [];
    const limit = 100;
    for (let offset = 0;; offset += limit) {
      const page = readCorrectedEncodeReplacementPlans({
        originalDiscArchiveId,
        limit,
        offset,
      });
      replacements.push(...page);
      if (page.length < limit) return replacements;
    }
  }

  const encodeAttemptCondition = (
    claim: RunningEncodeJob,
    timestamp: Date,
  ) =>
    and(
      eq(encodeJobs.id, claim.id),
      eq(encodeJobs.status, "running"),
      eq(encodeJobs.claimToken, claim.claimToken),
      gt(
        encodeJobs.updatedAt,
        new Date(timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS),
      ),
      exists(
        database
          .select({ id: discSelections.id })
          .from(discSelections)
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
          )
          .where(
            and(
              eq(discSelections.id, encodeJobs.discSelectionId),
              eq(discSelections.isCatalogActive, true),
              eq(originalDiscArchives.legacyCutoverPending, false),
              dvdRecoveryEvidenceEncodeExclusion.forArchive(database),
            ),
          ),
      ),
    );

  function appendValidationFailedOutput(
    transaction: Parameters<Parameters<typeof database.transaction>[0]>[0],
    claim: RunningEncodeJob,
    updated: EncodeJob | undefined,
    input: EncodeJobAttemptFailureOptions["validationFailedOutput"],
    timestamp: Date,
  ): void {
    if (updated === undefined || input === undefined) return;
    if (updated.publicationPending || updated.partialCleanupOutputPath !== null || input.outputPath === updated.outputPath) {
      throw new DomainInvariantError("Failed Encode Output cannot share publication or cleanup authority");
    }
    if (transaction.select().from(encodeOutputValidations).where(and(eq(encodeOutputValidations.encodeJobId, claim.id),
      eq(encodeOutputValidations.claimToken, claim.claimToken))).get() !== undefined) {
      throw new DomainInvariantError("A passing Encode Output validation cannot become a failed artifact");
    }
    const snapshot = transaction.select().from(encodeClaimSnapshots).where(eq(encodeClaimSnapshots.id, claim.claimToken)).get();
    if (snapshot !== undefined && (snapshot.encodeJobId !== claim.id || snapshot.source.output.path !== updated.outputPath)) {
      throw new DomainInvariantError("Failed Encode Output claim provenance is inconsistent");
    }
    transaction.insert(validationFailedEncodeOutputs).values({
      id: newId<import("../types.js").ValidationFailedEncodeOutputId>(), encodeJobId: claim.id, claimToken: claim.claimToken,
      outputPath: input.outputPath, filesystemIdentity: input.filesystemIdentity, changeTimeMs: input.changeTimeMs,
      validatedAt: timestamp, sourceSnapshot: snapshot === undefined ? null : JSON.parse(JSON.stringify(snapshot)),
      failure: input.failure,
    }).run();
  }

  const encodeJobAdapter = {
    recordType: "encode job",
    find: (id) =>
      database.select().from(encodeJobs).where(eq(encodeJobs.id, id)).get(),
    list: listEncodeJobs,
    claim: (workerId, token, timestamp, options?: EncodeJobClaimOptions) =>
      database.transaction((transaction) => {
        const nextReviewedJob = transaction
          .select({
            id: encodeJobs.id,
            outputPath: encodeJobs.outputPath,
            replaceExistingOutput: encodeJobs.replaceExistingOutput,
            predecessorOutputPath: predecessorEncodeJobRecords.outputPath,
            predecessorStatus: predecessorEncodeJobRecords.status,
            predecessorReplaceExistingOutput:
              predecessorEncodeJobRecords.replaceExistingOutput,
          })
          .from(encodeJobs)
          .innerJoin(
            discSelections,
            eq(discSelections.id, encodeJobs.discSelectionId),
          )
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
          )
          .leftJoin(
            predecessorEncodeJobRecords,
            eq(
              predecessorEncodeJobRecords.id,
              encodeJobs.predecessorEncodeJobId,
            ),
          )
          .where(
            and(
              eq(encodeJobs.status, "queued"),
              options === undefined ? undefined : eq(encodeJobs.id, options.jobId),
              isNull(encodeJobs.partialCleanupClaimToken),
              isNull(encodeJobs.partialCleanupOutputPath),
              isNull(encodeJobs.partialCleanupLeaseToken),
              eq(discSelections.isCatalogActive, true),
              eq(
                originalDiscArchives.catalogReviewOutcome,
                "reviewed_with_selections",
              ),
              eq(originalDiscArchives.legacyCutoverPending, false),
              noArchiveRecoveryWorkCondition(
                transaction,
                originalDiscArchives.id,
              ),
              options === undefined
                ? sql`not ${dvdRecoveryEvidenceMarkerCondition(transaction, originalDiscArchives.id)}`
                : dvdRecoveryEvidenceEncodeExclusion.forArchive(transaction),
              noWithdrawnTitleDamageAcceptanceForSelection(
                originalDiscArchives.id,
                encodeJobs.discSelectionId,
              ),
              or(
                isNull(encodeJobs.predecessorEncodeJobId),
                correctedEncodePredecessorReadyCondition(
                  predecessorEncodeJobRecords,
                ),
              ),
            ),
          )
          .orderBy(
            desc(encodeJobs.priority),
            asc(encodeJobs.createdAt),
            asc(encodeJobs.id),
          )
          .limit(1)
          .get();
        if (!nextReviewedJob) {
          return undefined;
        }
        const queued = requireRow(transaction.select().from(encodeJobs)
          .where(eq(encodeJobs.id, nextReviewedJob.id)).get(), "Encode Job", nextReviewedJob.id);
        const selection = requireRow(transaction.select().from(discSelections)
          .where(eq(discSelections.id, queued.discSelectionId)).get(), "Disc Selection", queued.discSelectionId);
        const newFormat = dvdRecoveryEvidenceFormatForArchive(
          access.catalog.findDvdArchiveEvidenceHeader(selection.originalDiscArchiveId),
          access.archiveJobs.listForArchive(selection.originalDiscArchiveId),
        ) !== null;
        // Legacy callers cannot claim new-format work without checkpoint preparation.
        if (newFormat && options === undefined) return undefined;
        const source = newFormat ? options!.snapshotSource(queued) : null;
        if (source !== null && (source.archive.id !== selection.originalDiscArchiveId ||
          source.selection.id !== queued.discSelectionId || source.profile.id !== queued.encodingProfileId ||
          canonicalPublicationJson(source.decision) !== canonicalPublicationJson(queued.expectedSourceDecision))) {
          throw new DomainInvariantError("Encode claim source does not match the queued decision");
        }
        const predecessorStillEligible = or(
          isNull(encodeJobs.predecessorEncodeJobId),
          exists(
            transaction
              .select({ id: claimPredecessorEncodeJobRecords.id })
              .from(claimPredecessorEncodeJobRecords)
              .where(and(
                eq(
                  claimPredecessorEncodeJobRecords.id,
                  encodeJobs.predecessorEncodeJobId,
                ),
                correctedEncodePredecessorReadyCondition(
                  claimPredecessorEncodeJobRecords,
                ),
              )),
          ),
        );
        const claimed = transaction
          .update(encodeJobs)
          .set({
            status: "running",
            replaceExistingOutput:
              nextReviewedJob.replaceExistingOutput ||
              (nextReviewedJob.outputPath ===
                  nextReviewedJob.predecessorOutputPath &&
                (nextReviewedJob.predecessorStatus === "completed" ||
                  nextReviewedJob.predecessorReplaceExistingOutput === true)),
            claimedBy: workerId,
            claimToken: token,
            claimedAt: timestamp,
            startedAt: timestamp,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(encodeJobs.status, "queued"),
              eq(encodeJobs.id, nextReviewedJob.id),
              predecessorStillEligible,
              exists(
                transaction
                  .select({ id: discSelections.id })
                  .from(discSelections)
                  .innerJoin(
                    originalDiscArchives,
                    eq(
                      originalDiscArchives.id,
                      discSelections.originalDiscArchiveId,
                    ),
                  )
                  .where(and(
                    eq(discSelections.id, encodeJobs.discSelectionId),
                    eq(discSelections.isCatalogActive, true),
                    eq(
                      originalDiscArchives.catalogReviewOutcome,
                      "reviewed_with_selections",
                    ),
                    eq(originalDiscArchives.legacyCutoverPending, false),
                    noArchiveRecoveryWorkCondition(
                      transaction,
                      originalDiscArchives.id,
                    ),
                    dvdRecoveryEvidenceEncodeExclusion.forArchive(
                      transaction,
                    ),
                    noWithdrawnTitleDamageAcceptanceForSelection(
                      originalDiscArchives.id,
                      encodeJobs.discSelectionId,
                    ),
                  )),
              ),
            ),
          )
          .returning()
          .get();
        if (claimed && source !== null) transaction.insert(encodeClaimSnapshots).values({
          id: token, encodeJobId: claimed.id, source, createdAt: timestamp,
        }).run();
        return claimed ? asRunningEncodeJob(claimed) : undefined;
      }, { behavior: "immediate" }),
    isAttemptCurrent: (current, _claim, timestamp) =>
      current.updatedAt.getTime() >
      timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
    updateAttempt: (claim, update, _completion, failureOptions) =>
      database.transaction((transaction) => {
        const updated = transaction
          .update(encodeJobs)
          .set({
            ...update,
            ...(update.status === "completed"
              ? {
                  progressEtaSeconds: null,
                  replaceExistingOutput: false,
                  replacementOutputIdentity: null,
                }
              : update.status === "failed"
                ? {
                    progressEtaSeconds: null,
                    ...(failureOptions?.preserveReplacementAuthority
                      ? {}
                      : {
                          replaceExistingOutput: false,
                          replacementOutputIdentity: null,
                        }),
                  }
                : {}),
          })
          .where(and(
            encodeAttemptCondition(claim, update.updatedAt),
            update.status === "completed"
              ? isNull(encodeJobs.predecessorEncodeJobId)
              : undefined,
          ))
          .returning()
          .get();
        if (
          updated &&
          update.status === "failed" &&
          !failureOptions?.preserveReplacementAuthority
        ) {
          clearCorrectedEncodePublicationAuthority(transaction, updated.id);
        }
        appendValidationFailedOutput(transaction, claim, updated, failureOptions?.validationFailedOutput, update.updatedAt);
        appendEncodeJobFailureReports(
          transaction,
          update.status === "failed" ? updated?.id : undefined,
          failureOptions?.failureReports,
          update.updatedAt,
        );
        return updated;
      }, { behavior: "immediate" }),
    updateProgressAttempt: (claim, update, details, failureOptions) =>
      database.transaction((transaction) => {
        const updated = transaction
          .update(encodeJobs)
          .set({
            ...update,
            progressPhase: details.phase,
            progressEtaSeconds:
              update.status === "failed" ? null : details.etaSeconds,
            ...(update.status === "failed" &&
              !failureOptions?.preserveReplacementAuthority
              ? {
                  replaceExistingOutput: false,
                  replacementOutputIdentity: null,
                }
              : {}),
          })
          .where(encodeAttemptCondition(claim, update.updatedAt))
          .returning()
          .get();
        if (
          updated &&
          update.status === "failed" &&
          !failureOptions?.preserveReplacementAuthority
        ) {
          clearCorrectedEncodePublicationAuthority(transaction, updated.id);
        }
        appendValidationFailedOutput(transaction, claim, updated, failureOptions?.validationFailedOutput, update.updatedAt);
        appendEncodeJobFailureReports(
          transaction,
          update.status === "failed" ? updated?.id : undefined,
          failureOptions?.failureReports,
          update.updatedAt,
        );
        return updated;
      }, { behavior: "immediate" }),
    progressDetailsChanged: (current, previous) =>
      current?.phase !== previous?.phase,
    requeue: (id, expectedStatus, current, update, options) => {
      const effectiveOutputPath =
        expectedStatus === "completed" || current.replaceExistingOutput
          ? current.outputPath
          : options?.outputPath;
      const keepsOutputPath =
        effectiveOutputPath === undefined ||
        effectiveOutputPath === current.outputPath;
      const preservesTerminalReplacement =
        expectedStatus !== "completed" &&
        keepsOutputPath &&
        current.replaceExistingOutput;
      const targetOutputPath = effectiveOutputPath ?? current.outputPath;
      return database.transaction((transaction) => {
        const semanticInput = encodeRequeueSemanticInput(id, options);
        const replay = replayEncodeMutation(
          transaction,
          options?.mutationKey, "encode_job.requeue", semanticInput,
        );
        if (replay) return replay;
        options?.assertSourceDecision?.();
        requireDvdRecoveryEvidenceEncodingAvailableForEncodeJob(
          transaction,
          id,
        );
        if (
          options?.mutationKey !== undefined &&
          (expectedStatus === "completed" || current.replaceExistingOutput)
        ) {
          const latest = transaction.select({
            status: encodeJobs.status,
            replaceExistingOutput: encodeJobs.replaceExistingOutput,
            updatedAt: encodeJobs.updatedAt,
          }).from(encodeJobs).where(eq(encodeJobs.id, id)).get();
          if (options.acknowledgeReplacement !== true || !options.expectedRevision) {
            throw new DomainInvariantError(
              "Encode Job replacement consequences must be acknowledged",
            );
          }
          if (
            latest === undefined ||
            latest.status !== expectedStatus ||
            latest.replaceExistingOutput !== current.replaceExistingOutput ||
            latest.updatedAt.toISOString() !== options.expectedRevision
          ) {
            throw new DomainInvariantError("Encode Job replacement preview is stale");
          }
        }
        const outputOwner = transaction
          .select({ id: encodeJobs.id })
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.outputPath, targetOutputPath),
            eq(encodeJobs.reservesOutputPath, true),
            ne(encodeJobs.id, id),
          ))
          .limit(1)
          .get();
        if (outputOwner) {
          throw new DomainInvariantError(
            `Encode Job output is already assigned: ${targetOutputPath}`,
          );
        }
        const requeued = transaction
          .update(encodeJobs)
          .set({
            ...update,
            completedAt: current.completedAt,
            expectedSourceDecision: options?.expectedSourceDecision ?? null,
            outputPath: effectiveOutputPath,
            reservesOutputPath: true,
            priority: options?.priority,
            progressPhase: null,
            progressEtaSeconds: null,
            replaceExistingOutput:
              (expectedStatus === "completed" && keepsOutputPath) ||
              preservesTerminalReplacement,
            replacementOutputIdentity: preservesTerminalReplacement
              ? current.replacementOutputIdentity
              : null,
            ...(keepsOutputPath
              ? {}
              : {
                  verificationStatus: null,
                  verificationMessage: null,
                  verifiedAt: null,
                }),
          })
          .where(
            and(
              eq(encodeJobs.id, id),
              eq(encodeJobs.status, expectedStatus),
              isNull(encodeJobs.partialCleanupOutputPath),
              isNull(encodeJobs.partialCleanupClaimToken),
              isNull(encodeJobs.partialCleanupLeaseToken),
              eq(encodeJobs.publicationPending, false),
              exists(
                transaction
                  .select({ id: discSelections.id })
                  .from(discSelections)
                  .innerJoin(
                    originalDiscArchives,
                    eq(
                      originalDiscArchives.id,
                      discSelections.originalDiscArchiveId,
                    ),
                  )
                  .where(
                    and(
                      eq(discSelections.id, encodeJobs.discSelectionId),
                      eq(discSelections.isCatalogActive, true),
                      eq(
                        originalDiscArchives.catalogReviewOutcome,
                        "reviewed_with_selections",
                      ),
                      eq(originalDiscArchives.legacyCutoverPending, false),
                      dvdRecoveryEvidenceEncodeExclusion.forArchive(
                        transaction,
                      ),
                    ),
                  ),
              ),
            ),
          )
          .returning()
          .get();
        if (requeued) {
          clearCorrectedEncodePublicationAuthority(transaction, requeued.id);
          return saveEncodeMutation(
            transaction,
            options?.mutationKey, "encode_job.requeue", semanticInput, requeued,
          );
        }
        return requeued;
      }, { behavior: "immediate" });
    },
  } satisfies JobQueueAdapter<
    EncodeJob,
    RunningEncodeJob,
    EncodeJobId,
    EncodeJobClaimToken,
    void,
    EncodeJobRequeueOptions,
    EncodeJobClaimOptions,
    Pick<EncodeJobProgress, "etaSeconds" | "phase">,
    EncodeJobAttemptFailureOptions
  >;

  const encodeJobQueue = createJobQueueController({
    adapter: encodeJobAdapter,
    createToken: () => newId<EncodeJobClaimToken>(),
    now,
    requeueFrom: ["failed", "completed", "cancelled"],
  });

  const detectedDiscConditionFor = (
    statuses: DetectedDiscStatus[] | undefined,
    options: DetectedDiscListOptions | undefined,
  ) => {
    const conditions = [
      statuses?.length ? inArray(detectedDiscs.status, statuses) : undefined,
      options?.ids ? inArray(detectedDiscs.id, [...options.ids]) : undefined,
    ].filter((condition) => condition !== undefined);
    return conditions.length > 0 ? and(...conditions) : undefined;
  };
  const listDetectedDiscRecords = createBoundedChronologicalList<
    typeof detectedDiscs.$inferSelect,
    DetectedDiscStatus,
    DetectedDiscListOptions
  >({
    activeStatuses: ["detected", "scanned", "approved"],
    historyStatuses: ["archived", "rejected"],
    chronologicalAt: (disc) => disc.detectedAt,
    readAll(statuses, options) {
      return database
        .select()
        .from(detectedDiscs)
        .where(detectedDiscConditionFor(statuses, options))
        .orderBy(asc(detectedDiscs.detectedAt), asc(detectedDiscs.id))
        .all();
    },
    readNewest(statuses, limit, options) {
      return database
        .select()
        .from(detectedDiscs)
        .where(detectedDiscConditionFor(statuses, options))
        .orderBy(desc(detectedDiscs.detectedAt), desc(detectedDiscs.id))
        .limit(limit)
        .all();
    },
  });

  type MutationTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

  function readMutationInvocation<T>(
    transaction: MutationTransaction,
    mutationKey: string,
    operation: string,
    semanticInput: string,
    decode: (stored: string) => T,
  ): T | undefined {
    const previous = transaction.select().from(mutationInvocations)
      .where(eq(mutationInvocations.key, mutationKey)).get();
    if (!previous) return undefined;
    if (previous.operation !== operation || previous.semanticInput !== semanticInput) {
      throw new MutationKeyConflictError();
    }
    return decode(previous.outcome);
  }

  function recordMutationInvocation<T>(
    transaction: MutationTransaction,
    mutationKey: string,
    operation: string,
    semanticInput: string,
    outcome: T,
    timestamp: Date,
  ): T {
    transaction.insert(mutationInvocations).values({
      key: mutationKey,
      operation,
      semanticInput,
      outcome: JSON.stringify(outcome),
      createdAt: timestamp,
    }).run();
    return outcome;
  }

  function decodeMappingProposalOutcome<T>(stored: string): T {
    return JSON.parse(stored, (field, value: unknown) =>
      (field === "createdAt" || field === "updatedAt") &&
          typeof value === "string"
        ? new Date(value)
        : value) as T;
  }

  function toDvdTitleDamageDecision(
    row: typeof dvdTitleDamageDecisions.$inferSelect,
  ): DvdTitleDamageDecision {
    if (row.decision === "withdrawn") {
      if (row.acceptedDecisionId === null) {
        throw new DomainInvariantError(
          "Withdrawn Title Damage decision must reference its accepted decision",
        );
      }
      return {
        ...row,
        decision: "withdrawn",
        acceptedDecisionId: row.acceptedDecisionId,
      };
    }
    if (row.acceptedDecisionId !== null) {
      throw new DomainInvariantError(
        "Only a withdrawn Title Damage decision may reference an accepted decision",
      );
    }
    return {
      ...row,
      decision: row.decision,
      acceptedDecisionId: null,
    };
  }

  function decodeDvdTitleDamageDecision(
    stored: string,
  ): DvdTitleDamageDecision {
    const parsed = JSON.parse(stored) as
      & Omit<
        typeof dvdTitleDamageDecisions.$inferSelect,
        "catalogRevision" | "recordedAt"
      >
      & { catalogRevision: string; recordedAt: string };
    return toDvdTitleDamageDecision({
      ...parsed,
      catalogRevision: new Date(parsed.catalogRevision),
      recordedAt: new Date(parsed.recordedAt),
    });
  }

  function dvdTitleDamagePreviewSemanticInput(input: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    excludedTitleIdentityIds: readonly DvdTitleIdentityId[];
    mainFeatureResolutions: readonly {
      discSelectionId: DiscSelectionId;
      titleIdentityId: DvdTitleIdentityId;
    }[];
  }): string {
    return JSON.stringify([
      input.originalDiscArchiveId,
      [...input.excludedTitleIdentityIds].sort(),
      [...input.mainFeatureResolutions].sort((left, right) =>
        left.discSelectionId.localeCompare(right.discSelectionId)
      ),
    ]);
  }

  function dvdTitleDamageDecisionSemanticInput(
    input: RecordDvdTitleDamageDecisionInput,
  ): string {
    return JSON.stringify({
      originalDiscArchiveId: input.originalDiscArchiveId,
      previewToken: input.previewToken,
      operator: input.operator.trim(),
      damageAcknowledgement: input.damageAcknowledgement,
      checkpoint: input.checkpoint,
      assessmentIdentity: input.assessmentIdentity,
      reviewSetIdentity: input.reviewSetIdentity,
      catalogMappingProjectionId: input.catalogMappingProjectionId,
      reviewedContentIdentity: input.reviewedContentIdentity,
      excludedTitleIdentityIds: [...input.excludedTitleIdentityIds].sort(),
      mainFeatureResolutions: [...input.mainFeatureResolutions].sort(
        (left, right) =>
          left.discSelectionId.localeCompare(right.discSelectionId),
      ),
    });
  }

  function dvdTitleDamageWithdrawalPreviewSemanticInput(input: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    acceptedDecisionId: DvdTitleDamageDecisionId;
  }): string {
    return JSON.stringify({
      originalDiscArchiveId: input.originalDiscArchiveId,
      acceptedDecisionId: input.acceptedDecisionId,
    });
  }

  function dvdTitleDamageWithdrawalSemanticInput(
    input: RecordDvdTitleDamageAcceptanceWithdrawalInput,
  ): string {
    return JSON.stringify({
      originalDiscArchiveId: input.originalDiscArchiveId,
      acceptedDecisionId: input.acceptedDecisionId,
      previewToken: input.previewToken,
      operator: input.operator.trim(),
    });
  }

  function dvdTitleDamageWithdrawalAffectedWork(
    reader: MutationTransaction | typeof database,
    decision: DvdTitleDamageDecision,
  ) {
    const selectionIds = dvdTitleDamageDecisionSelectionIds(decision);
    if (selectionIds.length === 0) return [];
    const jobs = reader.select({
      id: encodeJobs.id,
      discSelectionId: encodeJobs.discSelectionId,
      status: encodeJobs.status,
    }).from(encodeJobs).where(and(
      inArray(encodeJobs.discSelectionId, selectionIds),
      inArray(encodeJobs.status, ["queued", "running"]),
    )).orderBy(asc(encodeJobs.id)).all();
    return jobs;
  }

  function currentDvdTitleDamageDecisionIdentities(
    reader: MutationTransaction | typeof database,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): DvdTitleDamageDecisionInspection["currentIdentities"] {
    const archive = reader.select({ updatedAt: originalDiscArchives.updatedAt })
      .from(originalDiscArchives)
      .where(eq(originalDiscArchives.id, originalDiscArchiveId))
      .get();
    const header = reader.select().from(dvdArchiveEvidenceHeaders).where(eq(
      dvdArchiveEvidenceHeaders.originalDiscArchiveId,
      originalDiscArchiveId,
    )).get();
    const recovery = reader.select({
      id: archiveRecoveries.id,
      attemptId: archiveRecoveries.attemptId,
      state: archiveRecoveries.status,
    }).from(archiveRecoveries).where(eq(
      archiveRecoveries.originalDiscArchiveId,
      originalDiscArchiveId,
    )).get();
    // The authoritative inspection checks the current structural assessment,
    // Title Identity review set, mapping projection, continuity, and timing
    // evidence. During an immediate transaction these reads share the same
    // SQLite connection and therefore the same atomic write fence.
    const damageInspection = inspectDvdTitleDamageAssessment(
      originalDiscArchiveId,
    );
    const currentAssessment = damageInspection.state === "current" &&
        damageInspection.currentAssessmentIdentity !== null
      ? reader.select().from(dvdTitleDamageAssessments).where(eq(
        dvdTitleDamageAssessments.id,
        damageInspection.currentAssessmentIdentity,
      )).get() ?? null
      : null;
    return {
      catalogRevision: archive?.updatedAt.toISOString() ?? null,
      checkpoint: header === undefined
        ? null
        : {
          revision: header.currentManifestRevision,
          digest: header.currentManifestDigest,
        },
      recovery: recovery ?? null,
      assessmentIdentity: currentAssessment?.id ?? null,
      reviewSetIdentity:
        currentAssessment?.titleIdentityReviewSetIdentity ?? null,
      catalogMappingProjectionId:
        currentAssessment?.catalogMappingProjectionId ?? null,
    };
  }

  function inspectDvdTitleDamageDecision(
    originalDiscArchiveId: OriginalDiscArchiveId,
    reader: MutationTransaction | typeof database = database,
  ): DvdTitleDamageDecisionInspection {
    const latestRow = reader.select().from(dvdTitleDamageDecisions).where(eq(
      dvdTitleDamageDecisions.originalDiscArchiveId,
      originalDiscArchiveId,
    )).orderBy(
      desc(dvdTitleDamageDecisions.recordedAt),
      desc(dvdTitleDamageDecisions.id),
    ).limit(1).get() ?? null;
    const latest = latestRow === null
      ? null
      : toDvdTitleDamageDecision(latestRow);
    const currentIdentities = currentDvdTitleDamageDecisionIdentities(
      reader,
      originalDiscArchiveId,
    );
    const current = latest !== null &&
        latest.catalogRevision.toISOString() ===
          currentIdentities.catalogRevision &&
        latest.checkpointRevision === currentIdentities.checkpoint?.revision &&
        latest.checkpointDigest === currentIdentities.checkpoint?.digest &&
        latest.assessmentIdentity === currentIdentities.assessmentIdentity &&
        latest.reviewSetIdentity === currentIdentities.reviewSetIdentity &&
        latest.catalogMappingProjectionId ===
          currentIdentities.catalogMappingProjectionId &&
        latest.snapshot.current.recovery.id === currentIdentities.recovery?.id &&
        latest.snapshot.current.recovery.attemptId ===
          currentIdentities.recovery?.attemptId &&
        latest.snapshot.current.recovery.state ===
          currentIdentities.recovery?.state &&
        reader.select({ sequence: dvdTitleDamageAssessmentAttempts.sequence })
          .from(dvdTitleDamageAssessmentAttempts)
          .where(and(
            eq(
              dvdTitleDamageAssessmentAttempts.originalDiscArchiveId,
              originalDiscArchiveId,
            ),
            gt(
              dvdTitleDamageAssessmentAttempts.sequence,
              latest.assessmentAttemptSequence,
            ),
            ne(
              dvdTitleDamageAssessmentAttempts.assessmentId,
              latest.assessmentIdentity,
            ),
          )).limit(1).get() === undefined
      ? latest
      : null;
    return {
      schemaVersion: 1,
      state: current !== null
        ? current.decision
        : latest === null
        ? "not_recorded"
        : "expired",
      current,
      latest,
      currentIdentities,
    };
  }

  function decodeArchiveRecoveryStopReceipt(
    stored: string,
  ): ArchiveRecoveryStopReceipt {
    const outcome = JSON.parse(stored, (field, value: unknown) =>
      field.endsWith("At") && typeof value === "string"
        ? new Date(value)
        : value) as ArchiveRecoveryStopReceipt;
    const legacyWork = outcome.work;
    const storedRecoveredSectorCount = legacyWork?.passRecoveredSectorCount;
    const passStarted = legacyWork !== null && (
      legacyWork.status === "claimed" ||
      (legacyWork.passCursorLba !== null &&
        legacyWork.passCursorLba !== undefined) ||
      (legacyWork.passStartedAt !== null &&
        legacyWork.passStartedAt !== undefined) ||
      (legacyWork.passInitialUnrecoveredSectorCount !== null &&
        legacyWork.passInitialUnrecoveredSectorCount !== undefined) ||
      (storedRecoveredSectorCount ?? 0) > 0
    );
    const recoveredSectorCount = storedRecoveredSectorCount ??
      (passStarted && legacyWork !== null
        ? database.select({
            value:
              sql<number>`coalesce(sum(${dvdArchiveRecoveryReads.sectorCount}), 0)`,
          }).from(dvdArchiveRecoveryReads).where(and(
            eq(
              dvdArchiveRecoveryReads.originalDiscArchiveId,
              outcome.originalDiscArchiveId,
            ),
            eq(dvdArchiveRecoveryReads.outcome, "recovered"),
            gte(dvdArchiveRecoveryReads.createdAt, legacyWork.createdAt),
          )).get()?.value ?? 0
        : 0);
    const initialUnrecoveredSectorCount =
      legacyWork?.passInitialUnrecoveredSectorCount ??
      (passStarted
        ? unrecoveredSectorCount(database, outcome.originalDiscArchiveId) +
          recoveredSectorCount
        : null);
    return {
      ...outcome,
      pauseReason: outcome.pauseReason ?? null,
      passHistory: outcome.passHistory ?? [],
      work: legacyWork === null
        ? null
        : {
            ...legacyWork,
            passNumber: legacyWork.passNumber ?? 1,
            passDirection: legacyWork.passDirection ?? "forward",
            passStartedAt: legacyWork.passStartedAt ??
              (passStarted ? legacyWork.createdAt : null),
            passStartedManifestRevision:
              legacyWork.passStartedManifestRevision ?? null,
            passInitialUnrecoveredSectorCount:
              initialUnrecoveredSectorCount,
            passRecoveredSectorCount: recoveredSectorCount,
            passObservationCount: legacyWork.passObservationCount ?? null,
            passPositiveIntervalCount:
              legacyWork.passPositiveIntervalCount ?? null,
            passMinimumIntervalMs: legacyWork.passMinimumIntervalMs ?? null,
            passMaximumIntervalMs: legacyWork.passMaximumIntervalMs ?? null,
            passLastObservedAt: legacyWork.passLastObservedAt ?? null,
          },
    };
  }

  function decodeArchiveRecoveryResumeReceipt(
    stored: string,
  ): ArchiveRecoveryResumeReceipt {
    return decodeArchiveRecoveryStopReceipt(stored) as
      unknown as ArchiveRecoveryResumeReceipt;
  }

  function decodeCatalogReviewCompletionOutcome(
    stored: string,
  ): CompletedCatalogReviewWithReplacements {
    return JSON.parse(stored, (field, value: unknown) =>
      field.endsWith("At") && typeof value === "string"
        ? new Date(value)
        : value) as CompletedCatalogReviewWithReplacements;
  }

  function decodeCatalogReviewEvidenceChoiceResult(
    stored: string,
  ): CatalogReviewEvidenceChoiceResult {
    return JSON.parse(stored, (field, value: unknown) =>
      (field.endsWith("At") || field === "catalogRevision") &&
          typeof value === "string"
        ? new Date(value)
        : value) as CatalogReviewEvidenceChoiceResult;
  }

  function decodeRearchiveMappingProposalReview(
    stored: string,
  ): RearchiveMappingProposalReview {
    return JSON.parse(stored, (field, value: unknown) =>
      [
        "archivedAt",
        "catalogReviewedAt",
        "verifiedAt",
        "createdAt",
        "updatedAt",
      ].includes(field) && typeof value === "string"
        ? new Date(value)
        : value) as RearchiveMappingProposalReview;
  }

  function decodeRearchiveAcceptance(
    stored: string,
  ): CompletedRearchiveAcceptance {
    return JSON.parse(stored, (field, value: unknown) =>
      field.endsWith("At") && typeof value === "string"
        ? new Date(value)
        : value) as CompletedRearchiveAcceptance;
  }

  type RearchiveProposalReader = CatalogReader;

  interface ValidatedCorrectedEncodeReplacement {
    input: CorrectedEncodeReplacementInput;
    predecessor: typeof encodeJobs.$inferSelect;
    outputPath: string;
    replacesExistingOutput: boolean;
  }

  interface DvdEvidenceReplacementEncodingCapability {
    originalDiscArchiveId: OriginalDiscArchiveId;
  }

  function requireEncodeJob(
    reader: RearchiveProposalReader,
    id: EncodeJobId,
  ): typeof encodeJobs.$inferSelect {
    return requireRow(
      reader
        .select()
        .from(encodeJobs)
        .where(eq(encodeJobs.id, id))
        .get(),
      "encode job",
      id,
    );
  }

  function validateCorrectedEncodeReplacement(
    reader: RearchiveProposalReader,
    input: CorrectedEncodeReplacementInput,
    predecessor: typeof encodeJobs.$inferSelect,
  ): ValidatedCorrectedEncodeReplacement {
    const profile = requireRow(
      reader
        .select()
        .from(encodingProfiles)
        .where(eq(encodingProfiles.id, input.encodingProfileId))
        .get(),
      "encoding profile",
      input.encodingProfileId,
    );
    if (
      input.encodingProfileId !== predecessor.encodingProfileId &&
      (!profile.isActive || profile.mediaDomain !== "dvd_video")
    ) {
      throw new DomainInvariantError(
        "Corrected replacement encodes require the prior or an active DVD video Encoding Profile",
      );
    }
    const outputPath = requireNonEmpty(input.outputPath, "outputPath");
    const outputOwner = reader
      .select({ id: encodeJobs.id })
      .from(encodeJobs)
      .where(and(
        eq(encodeJobs.outputPath, outputPath),
        eq(encodeJobs.reservesOutputPath, true),
        ne(encodeJobs.id, predecessor.id),
      ))
      .limit(1)
      .get();
    if (outputOwner !== undefined) {
      throw new DomainInvariantError(
        `Encode Job output is already assigned: ${outputPath}`,
      );
    }
    if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) {
      throw new DomainInvariantError("priority must be a safe integer");
    }
    return {
      input,
      predecessor,
      outputPath,
      replacesExistingOutput:
        outputPath === predecessor.outputPath &&
        (predecessor.status === "completed" ||
          predecessor.replaceExistingOutput),
    };
  }

  function requireDvdEvidenceReplacementEncodingAvailable(
    reader: RearchiveProposalReader,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): DvdEvidenceReplacementEncodingCapability {
    requireNoArchiveRecoveryWork(reader, originalDiscArchiveId);
    if (dvdRecoveryEvidenceEncodingGateClosed) {
      const markedArchive = reader
        .select({ id: originalDiscArchives.id })
        .from(originalDiscArchives)
        .where(and(
          eq(originalDiscArchives.id, originalDiscArchiveId),
          dvdRecoveryEvidenceMarkerCondition(
            reader,
            originalDiscArchives.id,
          ),
        ))
        .limit(1)
        .get();
      if (markedArchive !== undefined) {
        throw new DvdRecoveryEvidenceEncodingUnavailableError();
      }
    }
    return { originalDiscArchiveId };
  }

  function insertCorrectedEncodeReplacementJob(
    transaction: CatalogTransaction,
    candidate: ValidatedCorrectedEncodeReplacement,
    originalDiscArchiveId: OriginalDiscArchiveId,
    evidenceEncodingCapability: DvdEvidenceReplacementEncodingCapability,
    discSelectionId: DiscSelectionId,
    timestamp: Date,
  ): EncodeJob {
    if (
      evidenceEncodingCapability.originalDiscArchiveId !==
        originalDiscArchiveId
    ) {
      throw new DomainInvariantError(
        "Corrected Encode replacement evidence capability does not match the target archive",
      );
    }
    if (
      candidate.outputPath === candidate.predecessor.outputPath &&
      candidate.predecessor.reservesOutputPath
    ) {
      transaction
        .update(encodeJobs)
        .set({ reservesOutputPath: false, updatedAt: timestamp })
        .where(eq(encodeJobs.id, candidate.predecessor.id))
        .run();
    }
    return requireRow(
      transaction
        .insert(encodeJobs)
        .values({
          id: newId<EncodeJobId>(),
          predecessorEncodeJobId: candidate.predecessor.id,
          discSelectionId,
          encodingProfileId: candidate.input.encodingProfileId,
          outputPath: candidate.outputPath,
          priority:
            candidate.input.priority ?? candidate.predecessor.priority,
          replaceExistingOutput: candidate.replacesExistingOutput,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning()
        .get(),
      "corrected Encode replacement",
      candidate.predecessor.id,
    );
  }

  function listActiveRearchiveSourceSelections(
    reader: RearchiveProposalReader,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) {
    return reader
      .select()
      .from(discSelections)
      .where(and(
        eq(
          discSelections.originalDiscArchiveId,
          originalDiscArchiveId,
        ),
        eq(discSelections.isCatalogActive, true),
      ))
      .orderBy(asc(discSelections.createdAt), asc(discSelections.id))
      .all()
      .map(toDiscSelection);
  }

  function evaluateRearchiveMappingProposal(
    reader: RearchiveProposalReader,
    input: RearchiveMappingProposalInput,
    persisted: boolean,
    options: {
      allowUnavailableCurrentEvidence?: boolean;
      providedSourceSelections?: ReturnType<typeof toDiscSelection>[];
    } = {},
  ): RearchiveMappingProposalReview {
    const targetArchive = requireRow(
      reader
        .select()
        .from(originalDiscArchives)
        .where(eq(
          originalDiscArchives.id,
          input.originalDiscArchiveId,
        ))
        .get(),
      "original disc archive",
      input.originalDiscArchiveId,
    );
    if (targetArchive.rearchiveSourceArchiveId === null) {
      throw new DomainInvariantError(
        "Re-archive Mapping Proposals require a fresh re-archive generation",
      );
    }
    const sourceArchive = requireRow(
      reader
        .select()
        .from(originalDiscArchives)
        .where(eq(
          originalDiscArchives.id,
          targetArchive.rearchiveSourceArchiveId,
        ))
        .get(),
      "re-archive source",
      targetArchive.rearchiveSourceArchiveId,
    );
    const targetDisc = requireRow(
      reader
        .select({ scanData: detectedDiscs.scanData })
        .from(detectedDiscs)
        .where(eq(detectedDiscs.id, targetArchive.detectedDiscId))
        .get(),
      "detected disc",
      targetArchive.detectedDiscId,
    );
    const legacyValidator = createArchivedDvdSelectionValidator(
      targetDisc.scanData,
    );
    let currentMappingRows: ReturnType<
      typeof requireCurrentCatalogMappingEvidence
    > | null = null;
    if (
      catalogMappingEvidenceFormat(reader, targetArchive.id) ===
        DVD_RECOVERY_EVIDENCE_FORMAT
    ) {
      try {
        currentMappingRows = requireCurrentCatalogMappingEvidence(
          reader,
          targetArchive.id,
        );
      } catch (error) {
        if (
          options.allowUnavailableCurrentEvidence !== true ||
          !(error instanceof CatalogMappingEvidenceUnavailableError)
        ) {
          throw error;
        }
      }
    }
    const sourceSelections = options.providedSourceSelections ??
      listActiveRearchiveSourceSelections(reader, sourceArchive.id);
    const proposedMappingsById = new Map<
      DiscSelectionId,
      RearchiveMappingProposalInput["mappings"][number]
    >();
    for (const mapping of input.mappings) {
      if (proposedMappingsById.has(mapping.sourceDiscSelectionId)) {
        throw new DomainInvariantError(
          "Re-archive Mapping Proposal cannot repeat a prior Disc Selection",
        );
      }
      proposedMappingsById.set(mapping.sourceDiscSelectionId, mapping);
    }

    const revisionsAreStale =
      !(input.catalogRevision instanceof Date) ||
      !Number.isSafeInteger(input.catalogRevision.getTime()) ||
      !(input.sourceCatalogRevision instanceof Date) ||
      !Number.isSafeInteger(input.sourceCatalogRevision.getTime()) ||
      input.catalogRevision.getTime() !== targetArchive.updatedAt.getTime() ||
      input.sourceCatalogRevision.getTime() !==
        sourceArchive.updatedAt.getTime();
    let hasStaleMapping = revisionsAreStale;
    let hasIncompleteMapping = sourceSelections.length === 0;
    let hasIncompatibleMapping = false;
    const mappings: RearchiveMappingProposalMapping[] = sourceSelections.map(
      (sourceSelection) => {
      const proposed = proposedMappingsById.get(sourceSelection.id);
      if (proposed === undefined) {
        hasIncompleteMapping = true;
        return {
          state: revisionsAreStale ? "stale" as const : "incomplete" as const,
          reason: revisionsAreStale
            ? "The source or target Catalog Review changed after this proposal was loaded"
            : "The prior Disc Selection is missing from the proposal",
          sourceDiscSelectionId: sourceSelection.id,
          priorMapping: {
            mediaItemId: sourceSelection.mediaItemId,
            sourceIdentity: sourceSelection.sourceIdentity,
            label: sourceSelection.label,
          },
          proposedMapping: {
            mediaItemId: sourceSelection.mediaItemId,
            sourceIdentity: sourceSelection.sourceIdentity,
            label: sourceSelection.label,
          },
        };
      }
      proposedMappingsById.delete(sourceSelection.id);
      if (revisionsAreStale) {
        return {
          state: "stale" as const,
          reason:
            "The source or target Catalog Review changed after this proposal was loaded",
          sourceDiscSelectionId: sourceSelection.id,
          priorMapping: {
            mediaItemId: sourceSelection.mediaItemId,
            sourceIdentity: sourceSelection.sourceIdentity,
            label: sourceSelection.label,
          },
          proposedMapping: {
            mediaItemId: proposed.mediaItemId,
            sourceIdentity: proposed.sourceIdentity,
            label: proposed.label,
          },
        };
      }
      let reason: string | null = null;
      let sourceIdentity = proposed.sourceIdentity;
      const mediaItemExists = reader
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(eq(mediaItems.id, proposed.mediaItemId))
        .get() !== undefined;
      if (!mediaItemExists) {
        reason = "The proposed Media Item no longer exists";
      } else if (
        proposed.label !== null && proposed.label.trim().length === 0
      ) {
        reason = "The proposed label must not be empty";
      } else {
        try {
          const validatedSourceIdentity = currentMappingRows === null
            ? legacyValidator.validate(proposed.sourceIdentity)
            : validateCurrentCatalogMappingSourceIdentity(
              proposed.sourceIdentity,
              currentMappingRows,
            );
          sourceIdentity = validatedSourceIdentity;
        } catch (error) {
          reason = error instanceof Error
            ? error.message
            : "The proposed source is incompatible with the fresh inspection";
        }
      }
      if (reason !== null) hasIncompatibleMapping = true;
      return {
        state: reason === null ? "valid" as const : "incompatible" as const,
        reason,
        sourceDiscSelectionId: sourceSelection.id,
        priorMapping: {
          mediaItemId: sourceSelection.mediaItemId,
          sourceIdentity: sourceSelection.sourceIdentity,
          label: sourceSelection.label,
        },
        proposedMapping: {
          mediaItemId: proposed.mediaItemId,
          sourceIdentity,
          label: proposed.label,
        },
      };
      },
    );
    for (const proposed of proposedMappingsById.values()) {
      hasStaleMapping = true;
      mappings.push({
        state: "stale",
        reason: "The prior Disc Selection is no longer active on the source archive",
        sourceDiscSelectionId: proposed.sourceDiscSelectionId,
        priorMapping: null,
        proposedMapping: {
          mediaItemId: proposed.mediaItemId,
          sourceIdentity: proposed.sourceIdentity,
          label: proposed.label,
        },
      });
    }
    return {
      state: hasStaleMapping
        ? "stale"
        : hasIncompatibleMapping
          ? "incompatible"
          : hasIncompleteMapping
            ? "incomplete"
            : "ready",
      persisted,
      catalogRevision: targetArchive.updatedAt.toISOString(),
      sourceCatalogRevision: sourceArchive.updatedAt.toISOString(),
      sourceArchive,
      targetArchive,
      mappings,
    };
  }

  function readRearchiveMappingProposal(
    reader: RearchiveProposalReader,
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): RearchiveMappingProposalReview | null {
    const targetArchive = reader
      .select()
      .from(originalDiscArchives)
      .where(eq(originalDiscArchives.id, originalDiscArchiveId))
      .get();
    if (
      !targetArchive || targetArchive.rearchiveSourceArchiveId === null ||
      targetArchive.catalogReviewedAt !== null
    ) {
      return null;
    }
    const sourceArchive = requireRow(
      reader
        .select()
        .from(originalDiscArchives)
        .where(eq(
          originalDiscArchives.id,
          targetArchive.rearchiveSourceArchiveId,
        ))
        .get(),
      "re-archive source",
      targetArchive.rearchiveSourceArchiveId,
    );
    const saved = reader
      .select()
      .from(rearchiveMappingProposals)
      .where(eq(
        rearchiveMappingProposals.targetArchiveId,
        originalDiscArchiveId,
      ))
      .get();
    if (saved === undefined) {
      const sourceSelections = listActiveRearchiveSourceSelections(
        reader,
        sourceArchive.id,
      );
      return evaluateRearchiveMappingProposal(reader, {
        originalDiscArchiveId,
        catalogRevision: targetArchive.updatedAt,
        sourceCatalogRevision: sourceArchive.updatedAt,
        mappings: sourceSelections.map((selection) => ({
          sourceDiscSelectionId: selection.id,
          mediaItemId: selection.mediaItemId,
          sourceIdentity: selection.sourceIdentity,
          label: selection.label,
        })),
      }, false, {
        allowUnavailableCurrentEvidence: true,
        providedSourceSelections: sourceSelections,
      });
    }
    const mappings = reader
      .select()
      .from(rearchiveMappingProposalItems)
      .where(eq(
        rearchiveMappingProposalItems.targetArchiveId,
        originalDiscArchiveId,
      ))
      .orderBy(asc(rearchiveMappingProposalItems.ordinal))
      .all()
      .map((mapping) => ({
        sourceDiscSelectionId: mapping.sourceDiscSelectionId,
        mediaItemId: mapping.mediaItemId,
        sourceIdentity: deserializeDiscSelectionSourceIdentity(mapping),
        label: mapping.label,
      }));
    return evaluateRearchiveMappingProposal(reader, {
      originalDiscArchiveId,
      catalogRevision: saved.updatedAt,
      sourceCatalogRevision: saved.sourceCatalogRevision,
      mappings,
    }, true, { allowUnavailableCurrentEvidence: true });
  }

  function planRearchiveAcceptance(
    reader: RearchiveProposalReader,
    input: RearchiveAcceptanceInput,
  ): RearchiveAcceptancePlan {
    if (
      !(input.catalogRevision instanceof Date) ||
      !Number.isSafeInteger(input.catalogRevision.getTime()) ||
      !(input.sourceCatalogRevision instanceof Date) ||
      !Number.isSafeInteger(input.sourceCatalogRevision.getTime())
    ) {
      throw new DomainInvariantError(
        "Re-archive Acceptance revisions must be valid timestamps",
      );
    }
    if (
      !Array.isArray(input.replacements) ||
      input.replacements.length > CORRECTED_ENCODE_REPLACEMENT_LIMIT
    ) {
      throw new DomainInvariantError(
        "Re-archive replacement plan is limited to 100 jobs",
      );
    }
    const proposal = readRearchiveMappingProposal(
      reader,
      input.targetArchiveId,
    );
    if (proposal === null || !proposal.persisted) {
      throw new DomainInvariantError(
        "Re-archive Acceptance requires a saved Re-archive Mapping Proposal",
      );
    }
    if (proposal.state !== "ready") {
      throw new DomainInvariantError(
        `Re-archive Mapping Proposal is ${proposal.state}`,
      );
    }
    if (
      proposal.sourceArchive.catalogReviewOutcome !==
        "reviewed_with_selections" ||
      proposal.sourceArchive.catalogReviewedAt === null
    ) {
      throw new DomainInvariantError(
        "Re-archive Acceptance requires a reviewed source archive",
      );
    }
    if (
      proposal.catalogRevision !== input.catalogRevision.toISOString() ||
      proposal.sourceCatalogRevision !==
        input.sourceCatalogRevision.toISOString()
    ) {
      throw new StaleCatalogRevisionError(
        "Re-archive Mapping Proposal changed; preview acceptance again",
      );
    }
    const sourceSelectionIds = proposal.mappings.map(
      (mapping) => mapping.sourceDiscSelectionId,
    );
    const affectedEncodeJobs = sourceSelectionIds.length === 0
      ? []
      : reader
          .select()
          .from(encodeJobs)
          .where(and(
            inArray(encodeJobs.discSelectionId, sourceSelectionIds),
            inArray(encodeJobs.status, ["queued", "running"]),
          ))
          .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
          .all();
    const lineageSourceSelectionIds = new Map<DiscSelectionId, DiscSelectionId>(
      sourceSelectionIds.map((id) => [id, id]),
    );
    let lineageFrontier = [...sourceSelectionIds];
    while (lineageFrontier.length > 0) {
      const nextFrontier: DiscSelectionId[] = [];
      for (let offset = 0; offset < lineageFrontier.length; offset += 500) {
        const rows = reader
          .select({
            supersededDiscSelectionId:
              discSelectionSupersessions.supersededDiscSelectionId,
            replacementDiscSelectionId:
              discSelectionSupersessions.replacementDiscSelectionId,
          })
          .from(discSelectionSupersessions)
          .where(inArray(
            discSelectionSupersessions.replacementDiscSelectionId,
            lineageFrontier.slice(offset, offset + 500),
          ))
          .orderBy(
            asc(discSelectionSupersessions.createdAt),
            asc(discSelectionSupersessions.supersededDiscSelectionId),
          )
          .all();
        for (const row of rows) {
          const sourceDiscSelectionId = lineageSourceSelectionIds.get(
            row.replacementDiscSelectionId,
          );
          if (sourceDiscSelectionId === undefined) continue;
          const existingSource = lineageSourceSelectionIds.get(
            row.supersededDiscSelectionId,
          );
          if (
            existingSource !== undefined &&
            existingSource !== sourceDiscSelectionId
          ) {
            throw new DomainInvariantError(
              "Re-archive replacement lineage reaches more than one reviewed mapping",
            );
          }
          if (existingSource === undefined) {
            lineageSourceSelectionIds.set(
              row.supersededDiscSelectionId,
              sourceDiscSelectionId,
            );
            nextFrontier.push(row.supersededDiscSelectionId);
          }
        }
      }
      lineageFrontier = nextFrontier;
    }
    const lineageIds = [...lineageSourceSelectionIds.keys()];
    const predecessorJobs: Array<typeof encodeJobs.$inferSelect> = [];
    for (let offset = 0; offset < lineageIds.length; offset += 500) {
      predecessorJobs.push(...reader
        .select()
        .from(encodeJobs)
        .where(inArray(
          encodeJobs.discSelectionId,
          lineageIds.slice(offset, offset + 500),
        ))
        .all());
    }
    predecessorJobs.sort((left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
    );
    const existingReplacementPredecessorIds = new Set<EncodeJobId>();
    const predecessorJobIds = predecessorJobs.map((job) => job.id);
    for (let offset = 0; offset < predecessorJobIds.length; offset += 500) {
      for (const row of reader
        .select({ predecessorEncodeJobId: encodeJobs.predecessorEncodeJobId })
        .from(encodeJobs)
        .where(inArray(
          encodeJobs.predecessorEncodeJobId,
          predecessorJobIds.slice(offset, offset + 500),
        ))
        .all()) {
        if (row.predecessorEncodeJobId !== null) {
          existingReplacementPredecessorIds.add(
            row.predecessorEncodeJobId,
          );
        }
      }
    }
    const availableReplacementEncodes = predecessorJobs
      .filter((job) => !existingReplacementPredecessorIds.has(job.id))
      .map((job) => ({
        predecessorEncodeJobId: job.id,
        sourceDiscSelectionId: lineageSourceSelectionIds.get(
          job.discSelectionId,
        )!,
        proposedEncodingProfileId: job.encodingProfileId,
        proposedOutputPath: job.outputPath,
        predecessorStatus: job.status,
        predecessorReady: isEncodeJobSafelyTerminal(job),
        releasesFailedOutputReservation:
          job.status === "failed" && isEncodeJobSafelyTerminal(job) &&
          job.reservesOutputPath && !job.replaceExistingOutput,
      }));
    const availableByPredecessorId = new Map(
      availableReplacementEncodes.map((replacement) => [
        replacement.predecessorEncodeJobId,
        replacement,
      ]),
    );
    const predecessorIds = new Set<EncodeJobId>();
    const outputPaths = new Set<string>();
    const replacementEncodes = input.replacements.map((replacement) => {
      if (predecessorIds.has(replacement.predecessorEncodeJobId)) {
        throw new DomainInvariantError(
          "Re-archive replacement plan contains a duplicate predecessor",
        );
      }
      predecessorIds.add(replacement.predecessorEncodeJobId);
      const available = availableByPredecessorId.get(
        replacement.predecessorEncodeJobId,
      );
      if (available === undefined) {
        throw new DomainInvariantError(
          `Encode Job ${replacement.predecessorEncodeJobId} is not available for re-archive replacement`,
        );
      }
      const predecessor = requireRow(
        predecessorJobs.find((job) =>
          job.id === replacement.predecessorEncodeJobId
        ),
        "encode job",
        replacement.predecessorEncodeJobId,
      );
      const validated = validateCorrectedEncodeReplacement(
        reader,
        replacement,
        predecessor,
      );
      if (outputPaths.has(validated.outputPath)) {
        throw new DomainInvariantError(
          `Re-archive replacement output is selected more than once: ${validated.outputPath}`,
        );
      }
      outputPaths.add(validated.outputPath);
      return {
        ...replacement,
        sourceDiscSelectionId: available.sourceDiscSelectionId,
        predecessorStatus: available.predecessorStatus,
        predecessorReady: available.predecessorReady,
        replacesExistingOutput: validated.replacesExistingOutput,
      };
    });
    return {
      targetArchiveId: proposal.targetArchive.id,
      sourceArchiveId: proposal.sourceArchive.id,
      catalogRevision: proposal.catalogRevision,
      sourceCatalogRevision: proposal.sourceCatalogRevision,
      mappings: proposal.mappings.map((mapping) => ({
        sourceDiscSelectionId: mapping.sourceDiscSelectionId,
        mediaItemId: mapping.proposedMapping.mediaItemId,
        sourceIdentity: mapping.proposedMapping.sourceIdentity,
        label: mapping.proposedMapping.label,
      })),
      affectedEncodeJobs,
      replacementEncodes,
      availableReplacementEncodes,
    };
  }

  function replayRecoveryMutation<T extends { id: string; status: string }>(
    mutationKey: string,
    operation: string,
    targetId: string,
    mutate: (transaction: MutationTransaction) => T,
  ): T {
    const result = database.transaction((transaction): { id: string; status: string; phase?: string } => {
      const semanticInput = JSON.stringify({ targetId });
      const previous = readMutationInvocation(transaction, mutationKey, operation,
        semanticInput, (stored) => JSON.parse(stored) as T);
      if (previous !== undefined) return previous;
      const outcome = mutate(transaction);
      return recordMutationInvocation(transaction, mutationKey, operation,
        semanticInput, outcome, now());
    }, { behavior: "immediate" });
    return result as T;
  }

  function cancelArchiveRequest(
    transaction: MutationTransaction,
    id: ArchiveRequestId,
  ) {
    const timestamp = now();
    const current = requireRow(
      transaction.select().from(archiveRequests)
        .where(eq(archiveRequests.id, id)).get(),
      "archive request", id,
    );
    if (["cancelled", "fulfilled", "cancellation_requested"].includes(current.status)) {
      return current;
    }
    const active = current.status === "running";
    return requireRow(
      transaction.update(archiveRequests).set({
        status: active ? "cancellation_requested" : "cancelled",
        cancellationRequestedAt: timestamp,
        cancelledAt: active ? null : timestamp,
        updatedAt: timestamp,
      }).where(and(
        eq(archiveRequests.id, id), eq(archiveRequests.status, current.status),
      )).returning().get(),
      "archive request", id,
    );
  }

  function createArchiveRequest(input: {
    detectedDiscId: DetectedDiscId;
    evidenceFormat?: DvdArchiveEvidenceFormat;
    priority?: number;
  }, mutationKey?: string) {
    const timestamp = now();
    return database.transaction((transaction) => {
      const semanticInput = JSON.stringify({
        detectedDiscId: input.detectedDiscId,
        evidenceFormat: input.evidenceFormat ?? null,
      });
      if (mutationKey !== undefined) {
        const previous = readMutationInvocation(transaction, mutationKey,
          "archive_request.submit", semanticInput, (stored) => {
            const outcome = JSON.parse(stored) as ArchiveRequest;
            return {
              ...outcome,
              rearchiveSourceArchiveId:
                outcome.rearchiveSourceArchiveId ?? null,
              evidenceFormat: outcome.evidenceFormat ?? null,
              cancellationRequestedAt: outcome.cancellationRequestedAt === null
                ? null : new Date(outcome.cancellationRequestedAt),
              fulfilledAt: outcome.fulfilledAt === null
                ? null : new Date(outcome.fulfilledAt),
              cancelledAt: outcome.cancelledAt === null
                ? null : new Date(outcome.cancelledAt),
              createdAt: new Date(outcome.createdAt),
              updatedAt: new Date(outcome.updatedAt),
            };
          });
        if (previous !== undefined) return previous;
      }
      assertDvdRecoveryEvidenceAdmissionAvailable(input.evidenceFormat);
      const saveOutcome = (outcome: ArchiveRequest): ArchiveRequest =>
        mutationKey === undefined ? outcome : recordMutationInvocation(
          transaction, mutationKey, "archive_request.submit", semanticInput,
          outcome, timestamp,
        );
      const disc = requireRow(
        transaction
          .select()
          .from(detectedDiscs)
          .where(eq(detectedDiscs.id, input.detectedDiscId))
          .get(),
        "detected disc",
        input.detectedDiscId,
      );
      if (
        findOriginalArchiveByFingerprintOrContentIdAlias(
          disc.fingerprint,
          transaction,
        )
      ) {
        throw new DomainInvariantError(
          "A Detected Disc with existing archive provenance cannot be requested",
        );
      }
      if (disc.status !== "scanned" && disc.status !== "approved") {
        throw new InvalidStatusTransitionError(
          "detected disc",
          disc.status,
          "approved",
        );
      }
      requireLegacyDvdArchiveIdentitiesResolved(
        disc.discKind,
        disc.fingerprint,
        transaction,
      );
      if (disc.status === "scanned") {
        requireRow(
          transaction
            .update(detectedDiscs)
            .set({ status: "approved", updatedAt: timestamp })
            .where(
              and(
                eq(detectedDiscs.id, disc.id),
                eq(detectedDiscs.status, "scanned"),
              ),
            )
            .returning({ id: detectedDiscs.id })
            .get(),
          "detected disc",
          disc.id,
        );
      }

      const existing = transaction
        .select()
        .from(archiveRequests)
        .where(
          and(
            eq(archiveRequests.detectedDiscId, disc.id),
            inArray(archiveRequests.status, [
              "pending",
              "running",
              "needs_attention",
              "cancellation_requested",
            ]),
          ),
        )
        .get();
      if (existing) {
        assertDvdRecoveryEvidenceAdmissionAvailable(existing.evidenceFormat);
        return saveOutcome(
          archiveRequestWithCreationPriority(
            transaction,
            existing,
            input.priority,
            timestamp,
          ),
        );
      }
      const declaredByteCount = disc.discKind === "dvd"
        ? currentDeclaredByteCountForDetectedDisc(transaction, disc.id)
        : null;
      if (disc.discKind === "dvd" && declaredByteCount !== null) {
        const reusableRequests = transaction
          .select({
            request: archiveRequests,
            requestedDiscId: requestedDetectedDiscRecords.id,
            requestedDiscScanData: requestedDetectedDiscRecords.scanData,
            requestedDiscStatus: requestedDetectedDiscRecords.status,
          })
          .from(archiveRequests)
          .innerJoin(
            requestedDetectedDiscRecords,
            eq(
              requestedDetectedDiscRecords.id,
              archiveRequests.detectedDiscId,
            ),
          )
          .where(
            and(
              inArray(archiveRequests.status, [
                "pending",
                "running",
                "needs_attention",
                "cancellation_requested",
              ]),
              eq(requestedDetectedDiscRecords.discKind, "dvd"),
              eq(
                requestedDetectedDiscRecords.fingerprint,
                disc.fingerprint,
              ),
              ne(requestedDetectedDiscRecords.id, disc.id),
            ),
          )
          .all()
          .filter((candidate) =>
            archiveRequestMatchesDvdContinuationIdentity(
              disc,
              declaredByteCount,
              candidate,
              attemptedDeclaredByteCountForArchiveRequest(
                transaction,
                candidate.request.id,
              ),
              transaction,
            )
          );
        if (reusableRequests.length > 1) {
          throw new DomainInvariantError(
            "Disc identity matches multiple reusable Archive Requests",
          );
        }
        const reusableRequest = reusableRequests[0]?.request;
        assertDvdRecoveryEvidenceAdmissionAvailable(
          reusableRequest?.evidenceFormat,
        );
        if (reusableRequest?.status === "needs_attention") {
          return saveOutcome(
            requireRow(
              transaction
                .update(archiveRequests)
                .set({
                  status: "pending",
                  priority: input.priority ?? reusableRequest.priority,
                  cancellationRequestedAt: null,
                  fulfilledAt: null,
                  cancelledAt: null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(archiveRequests.id, reusableRequest.id),
                    eq(archiveRequests.status, "needs_attention"),
                  ),
                )
                .returning()
                .get(),
              "archive request",
              reusableRequest.id,
            ),
          );
        }
        if (reusableRequest !== undefined) {
          return saveOutcome(
            archiveRequestWithCreationPriority(
              transaction,
              reusableRequest,
              input.priority,
              timestamp,
            ),
          );
        }
      }
      return saveOutcome(
        requireRow(
          transaction
            .insert(archiveRequests)
            .values({
              id: newId<ArchiveRequestId>(),
              detectedDiscId: disc.id,
              evidenceFormat: input.evidenceFormat ?? null,
              priority: input.priority ?? 0,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning()
            .get(),
          "archive request",
          disc.id,
        ),
      );
    }, { behavior: "immediate" });
  }

  const archiveProgress = new Map<
    ArchiveJobId,
    {
      token: ArchiveJobClaimToken;
      lastProgressAt: Date;
      latestBytes: number;
      latestEtaSeconds: number | null;
      latestPercent: number;
      latestPhase: ArchiveJob["progressPhase"];
      persistedPercent: number;
      persistedPhase: ArchiveJob["progressPhase"];
      persistedAt: number;
    }
  >();
  const requireLegacyArchiveJobMutation = (claim: RunningArchiveJob) => {
    assertDvdRecoveryEvidenceAdmissionAvailable(claim.evidenceFormat);
  };
  const archiveProgressPatchForClaim = (
    archiveJobId: ArchiveJobId,
    claimToken: ArchiveJobClaimToken | null,
  ) => {
    const progress = archiveProgress.get(archiveJobId);
    if (claimToken === null || progress?.token !== claimToken) {
      return {};
    }
    return {
      progressPhase: progress.latestPhase,
      progressPercent: progress.latestPercent,
      progressBytes: progress.latestBytes,
      progressEtaSeconds: progress.latestEtaSeconds,
      lastProgressAt: progress.lastProgressAt,
    };
  };
  const archiveTerminalProgressPatchForClaim = (
    archiveJobId: ArchiveJobId,
    claimToken: ArchiveJobClaimToken | null,
  ) => ({
    ...archiveProgressPatchForClaim(archiveJobId, claimToken),
    progressEtaSeconds: null,
  });
  const archiveReadFailurePatch = (
    evidence: ArchiveReadFailureEvidence,
  ) => {
    if (!ARCHIVE_READ_FAILURE_STAGES.includes(evidence.stage)) {
      throw new DomainInvariantError("read failure stage is unsupported");
    }
    if (!ARCHIVE_READ_FAILURE_CATEGORIES.includes(evidence.category)) {
      throw new DomainInvariantError("read failure category is unsupported");
    }
    const classifierVersion = requireNonEmpty(
      evidence.classifierVersion,
      "read failure classifierVersion",
    );
    if (classifierVersion.length > 128) {
      throw new DomainInvariantError(
        "read failure classifierVersion exceeds 128 characters",
      );
    }
    const scsiStatus = optionalSafeInteger(
      evidence.scsiStatus,
      "read failure scsiStatus",
      0,
      0xff,
    ) ?? null;
    const hostStatus = optionalSafeInteger(
      evidence.hostStatus,
      "read failure hostStatus",
      0,
      0xffff,
    ) ?? null;
    const driverStatus = optionalSafeInteger(
      evidence.driverStatus,
      "read failure driverStatus",
      0,
      0xffff,
    ) ?? null;
    if (
      [scsiStatus, hostStatus, driverStatus].some((value) => value === null) &&
      [scsiStatus, hostStatus, driverStatus].some((value) => value !== null)
    ) {
      throw new DomainInvariantError(
        "read failure transport status must be complete or unavailable",
      );
    }
    const asc = optionalSafeInteger(
      evidence.asc,
      "read failure asc",
      0,
      0xff,
    ) ?? null;
    const ascq = optionalSafeInteger(
      evidence.ascq,
      "read failure ascq",
      0,
      0xff,
    ) ?? null;
    if ((asc === null) !== (ascq === null)) {
      throw new DomainInvariantError(
        "read failure ASC and ASCQ must both be present or unavailable",
      );
    }
    const senseKey = optionalSafeInteger(
      evidence.senseKey,
      "read failure senseKey",
      0,
      0x0f,
    ) ?? null;
    if (!isArchiveReadFailureEvidenceConsistent({
      category: evidence.category,
      scsiStatus,
      hostStatus,
      driverStatus,
      senseKey,
      asc,
      ascq,
    })) {
      throw new DomainInvariantError(
        "read failure evidence does not match category",
      );
    }
    return {
      readFailureStage: evidence.stage,
      readFailureCategory: evidence.category,
      readFailureClassifierVersion: classifierVersion,
      readFailureLba: requireSafeIntegerInRange(
        evidence.failingLba,
        "read failure failingLba",
        0,
      ),
      readFailureRequestedBlockCount: requireSafeIntegerInRange(
        evidence.requestedBlockCount,
        "read failure requestedBlockCount",
        1,
        0xffff_ffff,
      ),
      readFailureRetryCount: requireSafeIntegerInRange(
        evidence.retryCount,
        "read failure retryCount",
        0,
        0xffff_ffff,
      ),
      readFailureScsiStatus: scsiStatus,
      readFailureHostStatus: hostStatus,
      readFailureDriverStatus: driverStatus,
      readFailureSenseKey: senseKey,
      readFailureAsc: asc,
      readFailureAscq: ascq,
    };
  };
  const recordArchiveJobFailure = (
    transaction: CatalogTransaction,
    job: ArchiveJob,
  ): void => {
    const disc = requireRow(
      transaction.select().from(detectedDiscs)
        .where(eq(detectedDiscs.id, job.detectedDiscId)).get(),
      "detected disc",
      job.detectedDiscId,
    );
    recordNotificationOutcome(createNotificationEventWriter(transaction, now), {
      kind: "archive_failed",
      sourceEventId: `archive-job:${job.id}:failed`,
      archiveJobId: job.id,
      label: disc.volumeLabel,
    });
  };
  const failArchiveJob = (
    claim: RunningArchiveJob,
    errorMessageInput: string,
    readFailure?: ArchiveReadFailureEvidence,
  ): ArchiveJob => {
    requireLegacyArchiveJobMutation(claim);
    const timestamp = now();
    const errorMessage = requireNonEmpty(
      errorMessageInput,
      "errorMessage",
    ).slice(0, 500);
    const readFailureValues = readFailure === undefined
      ? undefined
      : archiveReadFailurePatch(readFailure);
    const failed = database.transaction((transaction) => {
      const request = transaction
        .select({ status: archiveRequests.status })
        .from(archiveRequests)
        .where(
          and(
            eq(archiveRequests.id, claim.archiveRequestId),
            inArray(archiveRequests.status, [
              "running",
              "cancellation_requested",
            ]),
          ),
        )
        .get();
      if (!request) {
        throw new StaleJobAttemptError("archive job", claim.id);
      }
      const cancellationWins = request.status === "cancellation_requested";
      const job = transaction
        .update(archiveJobs)
        .set({
          status: cancellationWins ? "aborted" : "failed",
          ...archiveTerminalProgressPatchForClaim(claim.id, claim.claimToken),
          ...(cancellationWins
            ? {}
            : {
                failureDetailVersion: ARCHIVE_FAILURE_DETAIL_VERSIONS[0],
                ...readFailureValues,
              }),
          completedAt: timestamp,
          errorMessage: cancellationWins
            ? "Archive cancelled by operator"
            : errorMessage,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(archiveJobs.id, claim.id),
            eq(archiveJobs.status, "running"),
            eq(archiveJobs.claimToken, claim.claimToken),
            gt(
              archiveJobs.updatedAt,
              new Date(timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS),
            ),
          ),
        )
        .returning()
        .get();
      if (!job) {
        throw new StaleJobAttemptError("archive job", claim.id);
      }
      requireRow(
        transaction
          .update(archiveRequests)
          .set(cancellationWins
            ? {
                status: "cancelled",
                cancelledAt: timestamp,
                updatedAt: timestamp,
              }
            : { status: "needs_attention", updatedAt: timestamp })
          .where(
            and(
              eq(archiveRequests.id, job.archiveRequestId),
              eq(archiveRequests.status, request.status),
            ),
          )
          .returning({ id: archiveRequests.id })
          .get(),
        "archive request",
        job.archiveRequestId,
      );
      if (!cancellationWins) recordArchiveJobFailure(transaction, job);
      return job;
    }, { behavior: "immediate" });
    archiveProgress.delete(claim.id);
    return failed;
  };
  const inspectionProgress = new Map<
    DiscInspectionId,
    {
      latestBytes: number;
      latestBytesPerSecond: number | null;
      latestEtaSeconds: number | null;
      persistedAt: number;
      persistedBytes: number;
      token: DiscInspectionClaimToken;
    }
  >();
  let expiredCancellationCursor:
    | { id: ArchiveJobId; updatedAt: Date }
    | undefined;

  class DiscSelectionPreviewRollback extends Error {
    constructor(readonly result: DiscSelectionMutationResult) {
      super("Disc Selection preview rolled back");
    }
  }

  function discSelectionPreviewSemanticInput(
    input: Pick<DiscSelectionPreviewDecisionInput,
      "originalDiscArchiveId" | "expectedCatalogRevision" | "mutation">,
  ): string {
    return JSON.stringify({
      originalDiscArchiveId: input.originalDiscArchiveId,
      expectedCatalogRevision: input.expectedCatalogRevision,
      mutation: input.mutation,
    });
  }

  function catalogReviewCompletionSemanticInput(input: {
    id: OriginalDiscArchiveId;
    catalogRevision: Date;
    outcome: CompletedCatalogReviewOutcome;
    replacements: readonly CorrectedEncodeReplacementInput[];
  }): string {
    return JSON.stringify({
      id: input.id,
      catalogRevision: input.catalogRevision.toISOString(),
      outcome: input.outcome,
      replacements: input.replacements,
    });
  }

  function catalogReviewEvidenceChoiceSemanticInput(input: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    choice: "archive_only" | "reopen";
    catalogRevision: Date;
    checkpointRevision: number;
    checkpointDigest: string;
  }): string {
    return JSON.stringify({
      originalDiscArchiveId: input.originalDiscArchiveId,
      choice: input.choice,
      catalogRevision: input.catalogRevision.toISOString(),
      checkpointRevision: input.checkpointRevision,
      checkpointDigest: input.checkpointDigest,
    });
  }

  function rearchiveAcceptanceSemanticInput(
    input: RearchiveAcceptanceInput,
  ): string {
    return JSON.stringify({
      targetArchiveId: input.targetArchiveId,
      catalogRevision: input.catalogRevision.toISOString(),
      sourceCatalogRevision: input.sourceCatalogRevision.toISOString(),
      replacements: input.replacements,
    });
  }

  function performDiscSelectionMutation(
    input: DiscSelectionMutationInput,
    previewOnly: boolean,
  ): DiscSelectionMutationResult {
    if (activeDiscSelectionTransaction !== null) {
      throw new DomainInvariantError("Nested Disc Selection mutations are unavailable");
    }
    const { mutation, originalDiscArchiveId, mutationKey, expectedCatalogRevision,
      previewToken } = input;
    const semanticInput = JSON.stringify({ originalDiscArchiveId, expectedCatalogRevision,
      previewToken, mutation });
    try {
      return database.transaction((transaction) => {
        if (mutationKey !== undefined) {
          const previous = transaction.select().from(mutationInvocations)
            .where(eq(mutationInvocations.key, mutationKey)).get();
          if (previous) {
            if (previous.operation !== `disc_selection.${mutation.action}` ||
                previous.semanticInput !== semanticInput) {
              throw new MutationKeyConflictError();
            }
            const saved = JSON.parse(previous.outcome) as {
              discSelection: Record<string, unknown>;
              supersession?: Record<string, unknown>;
              deletedEncodeJobs?: number;
              deletionComplete?: boolean;
            };
            return {
              ...saved,
              discSelection: {
                ...saved.discSelection,
                createdAt: new Date(saved.discSelection.createdAt as string),
                updatedAt: new Date(saved.discSelection.updatedAt as string),
              },
              ...(saved.supersession ? { supersession: {
                ...saved.supersession,
                createdAt: new Date(saved.supersession.createdAt as string),
              } } : {}),
            } as ReturnType<typeof access.catalog.mutateDiscSelection>;
          }
        }
        let expectedPreviewEvidenceHash: string | undefined;
        if (previewToken !== undefined) {
          if (expectedCatalogRevision === undefined) {
            throw new DomainInvariantError(
              "Disc Selection preview does not match the proposed change",
            );
          }
          const previewDecision = transaction.select().from(mutationInvocations)
            .where(eq(mutationInvocations.key, previewToken)).get();
          if (previewDecision?.operation !== "disc_selection.preview" ||
              previewDecision.semanticInput !== discSelectionPreviewSemanticInput({
                originalDiscArchiveId,
                expectedCatalogRevision,
                mutation,
              })) {
            throw new DomainInvariantError(
              "Disc Selection preview does not match the proposed change",
            );
          }
          const savedPreview = JSON.parse(previewDecision.outcome) as {
            expectedPreviewEvidenceHash?: unknown;
          };
          if (typeof savedPreview.expectedPreviewEvidenceHash !== "string" ||
              !/^[a-f0-9]{64}$/.test(savedPreview.expectedPreviewEvidenceHash)) {
            throw new DomainInvariantError(
              "Disc Selection preview does not match the proposed change",
            );
          }
          expectedPreviewEvidenceHash = savedPreview.expectedPreviewEvidenceHash;
        }
        const archive = requireRow(transaction.select({
          updatedAt: originalDiscArchives.updatedAt,
          headerEvidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
        })
          .from(originalDiscArchives)
          .leftJoin(
            dvdArchiveEvidenceHeaders,
            eq(
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
              originalDiscArchives.id,
            ),
          )
          .where(eq(originalDiscArchives.id, originalDiscArchiveId)).get(),
        "original disc archive", originalDiscArchiveId);
        const evidenceFormat = dvdRecoveryEvidenceFormatForArchive(
          archive.headerEvidenceFormat === null
            ? null
            : { evidenceFormat: archive.headerEvidenceFormat },
          transaction.select({ evidenceFormat: archiveJobs.evidenceFormat })
            .from(archiveJobs)
            .where(eq(
              archiveJobs.originalDiscArchiveId,
              originalDiscArchiveId,
            )).all(),
        );
        if (
          mutation.action === "create" &&
          evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT &&
          expectedCatalogRevision === undefined
        ) {
          throw new CatalogMappingRevisionRequiredError();
        }
        if (expectedCatalogRevision !== undefined &&
            archive.updatedAt.getTime() !== expectedCatalogRevision.getTime()) {
          throw new StaleCatalogRevisionError(
            "Catalog review revision is stale",
          );
        }
        if (evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT) {
          requireCurrentCatalogMappingEvidence(
            transaction,
            originalDiscArchiveId,
          );
        }
        if (mutation.action === "create" || mutation.action === "repair" ||
            mutation.action === "correct") {
          if (mutation.selection.originalDiscArchiveId !== originalDiscArchiveId) {
            throw new DomainInvariantError("Disc Selection cannot move between Original Disc Archives");
          }
        } else if (mutation.action === "update" &&
            mutation.changes.originalDiscArchiveId !== originalDiscArchiveId) {
          throw new DomainInvariantError("Disc Selection cannot move between Original Disc Archives");
        }
        if (mutation.action !== "create") {
          const current = requireRow(transaction.select()
            .from(discSelections).where(eq(discSelections.id, mutation.discSelectionId)).get(),
          "disc selection", mutation.discSelectionId);
          if (current.originalDiscArchiveId !== originalDiscArchiveId) {
            throw new RecordNotFoundError("disc selection", mutation.discSelectionId);
          }
          if (expectedPreviewEvidenceHash !== undefined) {
            const jobs = transaction.select({
              id: encodeJobs.id,
              status: encodeJobs.status,
              reservesOutputPath: encodeJobs.reservesOutputPath,
            })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, mutation.discSelectionId))
              .all();
            const { evidenceHash } = discSelectionMutationEvidence(jobs);
            if (evidenceHash !== expectedPreviewEvidenceHash) {
              throw new DomainInvariantError(
                "Disc Selection preview is stale because Encode Job history changed",
              );
            }
          }
          if (mutation.action === "repair") {
            const source = requireRow(transaction.select({ scanData: detectedDiscs.scanData })
              .from(originalDiscArchives)
              .innerJoin(detectedDiscs, eq(detectedDiscs.id, originalDiscArchives.detectedDiscId))
              .where(eq(originalDiscArchives.id, originalDiscArchiveId)).get(),
            "original disc archive", originalDiscArchiveId);
            if (!requiresLegacyDiscSelectionRepair(
              current, createArchivedDvdSelectionValidator(source.scanData),
            )) {
              throw new DomainInvariantError("Disc Selection does not need unsafe legacy repair");
            }
          }
        }
        const previousTransaction = activeDiscSelectionTransaction;
        const previousCurrentTitleIdentityValidation =
          activeDiscSelectionUsesCurrentTitleIdentity;
        activeDiscSelectionTransaction = transaction;
        activeDiscSelectionUsesCurrentTitleIdentity =
          evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT;
        try {
          const result = (() => {
            switch (mutation.action) {
              case "create":
                return { discSelection: access.catalog.createDiscSelection(mutation.selection) };
              case "update":
                return { discSelection: access.catalog.updateDiscSelection(mutation.discSelectionId, mutation.changes) };
              case "repair":
                return { discSelection: access.catalog.repairDiscSelection(mutation.discSelectionId, mutation.selection) };
              case "correct": {
                const correction = access.catalog.correctDiscSelection(mutation.discSelectionId, mutation.selection);
                return { discSelection: correction.discSelection, supersession: correction.supersession };
              }
              case "delete": {
                const deletion = access.catalog.deleteDiscSelection(mutation.discSelectionId);
                return { discSelection: deletion, deletedEncodeJobs: deletion.deletedEncodeJobs,
                  deletionComplete: deletion.deletionComplete };
              }
            }
          })();
          if (previewOnly) {
            throw new DiscSelectionPreviewRollback(result);
          }
          if (previewToken !== undefined) {
            transaction.delete(mutationInvocations)
              .where(eq(mutationInvocations.key, previewToken)).run();
          }
          if (mutationKey !== undefined) {
            transaction.insert(mutationInvocations).values({
              key: mutationKey,
              operation: `disc_selection.${mutation.action}`,
              semanticInput,
              outcome: JSON.stringify(result),
              createdAt: now(),
            }).run();
          }
          return result;
        } finally {
          activeDiscSelectionTransaction = previousTransaction;
          activeDiscSelectionUsesCurrentTitleIdentity =
            previousCurrentTitleIdentityValidation;
        }
      }, { behavior: "immediate" });
    } catch (error) {
      if (previewOnly && error instanceof DiscSelectionPreviewRollback) {
        return error.result;
      }
      throw error;
    }
  }

  type ProfileTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

  function previewProfileState(
    transaction: ProfileTransaction,
    input: { id: EncodingProfileId; mediaDomain: MediaDomain; isActive: boolean },
  ) {
    const target = requireEncodingProfileInDomain(transaction, input.id, input.mediaDomain);
    const versions = transaction.select().from(encodingProfiles).where(and(
      eq(encodingProfiles.mediaDomain, target.mediaDomain),
      eq(encodingProfiles.key, target.key),
    )).orderBy(asc(encodingProfiles.version)).all();
    const revision = createHash("sha256").update(JSON.stringify({
      targetId: input.id,
      requestedActiveState: input.isActive,
      versions: versions.map(({ id, version, isActive, updatedAt }) => ({
        id, version, isActive, updatedAt: updatedAt.toISOString(),
      })),
    })).digest("hex");
    return {
      target,
      activeVersion: versions.find((version) => version.isActive) ?? null,
      revision,
    };
  }

  function createProfile(
    transaction: ProfileTransaction,
    input: Parameters<DataAccess["encodingProfiles"]["create"]>[0],
  ) {
    const timestamp = now();
    const id = newId<EncodingProfileId>();
    const key = requireNonEmpty(input.key, "key");
    const existing = transaction.select({ id: encodingProfiles.id })
      .from(encodingProfiles).where(and(
        eq(encodingProfiles.mediaDomain, input.mediaDomain),
        eq(encodingProfiles.key, key),
      )).get();
    if (existing) {
      throw new DomainInvariantError("Encoding Profile key already exists in this media domain");
    }
    return requireRow(transaction.insert(encodingProfiles).values({
      id, key,
      displayName: requireNonEmpty(input.displayName, "displayName"),
      mediaDomain: input.mediaDomain,
      version: 1,
      isActive: true,
      settings: input.settings,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).returning().get(), "encoding profile", id);
  }

  function createProfileVersion(
    transaction: ProfileTransaction,
    input: Parameters<DataAccess["encodingProfiles"]["createVersion"]>[0],
  ) {
    const timestamp = now();
    const source = requireEncodingProfileInDomain(
      transaction, input.sourceProfileId, input.mediaDomain,
    );
    const latest = requireRow(transaction.select({ version: encodingProfiles.version })
      .from(encodingProfiles).where(and(
        eq(encodingProfiles.mediaDomain, source.mediaDomain),
        eq(encodingProfiles.key, source.key),
      )).orderBy(desc(encodingProfiles.version)).limit(1).get(),
    "encoding profile", source.id);
    const version = requirePositiveSafeInteger(latest.version + 1, "version");
    const id = newId<EncodingProfileId>();
    return requireRow(transaction.insert(encodingProfiles).values({
      id, key: source.key, displayName: source.displayName,
      mediaDomain: source.mediaDomain, version, isActive: false,
      settings: input.settings, createdAt: timestamp, updatedAt: timestamp,
    }).returning().get(), "encoding profile", id);
  }

  function setProfileActive(
    transaction: ProfileTransaction,
    input: Parameters<DataAccess["encodingProfiles"]["setActive"]>[0],
  ) {
    const profile = requireEncodingProfileInDomain(transaction, input.id, input.mediaDomain);
    const latestUpdate = transaction.select({ updatedAt: encodingProfiles.updatedAt })
      .from(encodingProfiles).where(and(
        eq(encodingProfiles.mediaDomain, profile.mediaDomain),
        eq(encodingProfiles.key, profile.key),
      )).orderBy(desc(encodingProfiles.updatedAt)).limit(1).get();
    const timestamp = new Date(Math.max(
      Date.now(), (latestUpdate?.updatedAt.getTime() ?? 0) + 1,
    ));
    if (input.isActive) {
      transaction.update(encodingProfiles).set({ isActive: false, updatedAt: timestamp })
        .where(and(
          eq(encodingProfiles.mediaDomain, profile.mediaDomain),
          eq(encodingProfiles.key, profile.key),
          eq(encodingProfiles.isActive, true),
          ne(encodingProfiles.id, profile.id),
        )).run();
    }
    return requireRow(transaction.update(encodingProfiles)
      .set({ isActive: input.isActive, updatedAt: timestamp })
      .where(eq(encodingProfiles.id, profile.id)).returning().get(),
    "encoding profile", profile.id);
  }

  function readArchiveAuditFindings(id: ArchiveAuditRunId): ArchiveAuditFinding[] {
    return database.select({ finding: archiveAuditFindings.finding })
      .from(archiveAuditFindings)
      .where(eq(archiveAuditFindings.archiveAuditRunId, id))
      .orderBy(asc(archiveAuditFindings.sequence))
      .all()
      .map(({ finding }) => JSON.parse(finding) as ArchiveAuditFinding);
  }

  function toArchiveAuditRun(row: ArchiveAuditRunRow): ArchiveAuditRun {
    const findings = readArchiveAuditFindings(row.id);
    return {
      ...toArchiveAuditRunSummary(row),
      counts: countArchiveAuditFindings(findings),
      findings,
    };
  }

  function requireDvdStructuralCheckpoint(
    querySource: Pick<typeof database, "select">,
    checkpoint: DvdStructuralCheckpoint,
  ) {
    const header = querySource.select({
      evidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
      currentManifestId: dvdArchiveEvidenceHeaders.currentManifestId,
      currentManifestRevision:
        dvdArchiveEvidenceHeaders.currentManifestRevision,
      currentManifestDigest: dvdArchiveEvidenceHeaders.currentManifestDigest,
      acceptedEndLbaExclusive:
        dvdArchiveEvidenceHeaders.acceptedEndLbaExclusive,
    }).from(dvdArchiveEvidenceHeaders).where(eq(
      dvdArchiveEvidenceHeaders.originalDiscArchiveId,
      checkpoint.originalDiscArchiveId,
    )).get();
    const manifest = querySource.select({
      id: dvdArchiveEvidenceManifests.id,
      originalDiscArchiveId:
        dvdArchiveEvidenceManifests.originalDiscArchiveId,
      revision: dvdArchiveEvidenceManifests.revision,
      manifestDigest: dvdArchiveEvidenceManifests.manifestDigest,
      acceptedEndLbaExclusive:
        dvdArchiveEvidenceManifests.acceptedEndLbaExclusive,
      evidenceFormat: dvdArchiveEvidenceManifests.evidenceFormat,
    }).from(dvdArchiveEvidenceManifests).where(eq(
      dvdArchiveEvidenceManifests.id,
      checkpoint.manifestId,
    )).get();
    if (
      header === undefined ||
      header.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT
    ) {
      throw new DomainInvariantError(
        "DVD structural check requires a committed recovery checkpoint",
      );
    }
    if (
      header.currentManifestId !== checkpoint.manifestId ||
      header.currentManifestRevision !== checkpoint.manifestRevision ||
      header.currentManifestDigest !== checkpoint.manifestDigest ||
      header.acceptedEndLbaExclusive !==
        checkpoint.acceptedEndLbaExclusive
    ) {
      throw new StaleDvdStructuralCheckpointError();
    }
    if (
      manifest === undefined ||
      manifest.originalDiscArchiveId !== checkpoint.originalDiscArchiveId ||
      manifest.revision !== checkpoint.manifestRevision ||
      manifest.manifestDigest !== checkpoint.manifestDigest ||
      manifest.acceptedEndLbaExclusive !==
        checkpoint.acceptedEndLbaExclusive ||
      manifest.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT
    ) {
      throw new DomainInvariantError("DVD structural checkpoint is inconsistent");
    }
    return manifest;
  }

  function toDvdStructuralAssessment(
    row: typeof dvdStructuralAssessments.$inferSelect,
  ): DvdStructuralAssessmentRecord {
    const assessment = createDvdStructuralAssessment({
      checkpoint: {
        originalDiscArchiveId: row.originalDiscArchiveId,
        manifestId: row.manifestId,
        manifestRevision: row.manifestRevision,
        manifestDigest: row.manifestDigest,
        acceptedEndLbaExclusive: row.acceptedEndLbaExclusive,
      },
      findings: row.findings,
    });
    if (
      assessment.id !== row.id ||
      assessment.policyVersion !== row.policyVersion ||
      assessment.validity !== row.validity
    ) {
      throw new DomainInvariantError(
        "Persisted DVD structural assessment is invalid",
      );
    }
    return { ...assessment, createdAt: row.createdAt };
  }

  function findDvdStructuralAssessment(
    id: string,
  ): DvdStructuralAssessmentRecord {
    const row = database.select().from(dvdStructuralAssessments)
      .where(eq(dvdStructuralAssessments.id, id)).get();
    if (row === undefined) {
      throw new DomainInvariantError(
        "DVD structural check attempt has no assessment",
      );
    }
    return toDvdStructuralAssessment(row);
  }

  function toDvdStructuralCheckAttempt(
    row: typeof dvdStructuralCheckAttempts.$inferSelect,
  ): DvdStructuralCheckAttempt {
    const checkpoint = {
      originalDiscArchiveId: row.originalDiscArchiveId,
      manifestId: row.manifestId,
      manifestRevision: row.manifestRevision,
      manifestDigest: row.manifestDigest,
      acceptedEndLbaExclusive: row.acceptedEndLbaExclusive,
    };
    if (row.outcome === "completed") {
      if (row.assessmentId === null || row.findings === null) {
        throw new DomainInvariantError(
          "Completed DVD structural check attempt is incomplete",
        );
      }
      const result = createDvdStructuralAssessment({
        checkpoint,
        findings: row.findings,
      });
      if (result.id !== row.assessmentId) {
        throw new DomainInvariantError(
          "DVD structural check attempt conflicts with its assessment",
        );
      }
      return {
        sequence: row.sequence,
        checkpoint,
        createdAt: row.createdAt,
        outcome: "completed",
        assessmentIdentity: row.assessmentId,
        findings: result.findings,
        reason: null,
      };
    }
    if (row.failureCode === null || row.failureMessage === null) {
      throw new DomainInvariantError(
        "Failed DVD structural check attempt has no reason",
      );
    }
    return {
      sequence: row.sequence,
      checkpoint,
      createdAt: row.createdAt,
      outcome: "failed",
      assessmentIdentity: null,
      findings: null,
      reason: validateDvdStructuralFailureReason({
        code: row.failureCode,
        message: row.failureMessage,
      }),
    };
  }

  function findLatestDvdStructuralAttempt(
    originalDiscArchiveId: OriginalDiscArchiveId,
    checkpoint?: DvdStructuralCheckpoint,
    outcome?: "completed" | "failed",
  ): DvdStructuralCheckAttempt | null {
    const conditions = [
      eq(
        dvdStructuralCheckAttempts.originalDiscArchiveId,
        originalDiscArchiveId,
      ),
      checkpoint === undefined
        ? undefined
        : eq(dvdStructuralCheckAttempts.manifestId, checkpoint.manifestId),
      checkpoint === undefined
        ? undefined
        : eq(
          dvdStructuralCheckAttempts.manifestRevision,
          checkpoint.manifestRevision,
        ),
      checkpoint === undefined
        ? undefined
        : eq(
          dvdStructuralCheckAttempts.manifestDigest,
          checkpoint.manifestDigest,
        ),
      outcome === undefined
        ? undefined
        : eq(dvdStructuralCheckAttempts.outcome, outcome),
    ].filter((condition) => condition !== undefined);
    const row = database.select().from(dvdStructuralCheckAttempts)
      .where(and(...conditions))
      .orderBy(desc(dvdStructuralCheckAttempts.sequence)).limit(1).get();
    return row === undefined ? null : toDvdStructuralCheckAttempt(row);
  }

  function inspectDvdStructuralAssessment(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) {
    const id = originalDiscArchiveId;
    const archive = access.catalog.listOriginalDiscArchives({ ids: [id] })[0];
    if (archive === undefined) {
      throw new RecordNotFoundError(
        "Original Disc Archive",
        originalDiscArchiveId,
      );
    }
    const header = access.catalog.findDvdArchiveEvidenceHeader(id);
    const marked = dvdRecoveryEvidenceFormatForArchive(
      header,
      access.archiveJobs.listForArchive(id),
    );
    const common = {
      schemaVersion: 1 as const,
      policyVersion: DVD_STRUCTURAL_ASSESSMENT_POLICY_VERSION,
      originalDiscArchiveId,
    };
    if (marked === null) {
      return {
        ...common,
        state: "unavailable" as const,
        checkpoint: null,
        currentAssessmentIdentity: null,
        assessment: null,
        latestAttempt: null,
        unavailableReasons: [{
          code: "UNSUPPORTED_EVIDENCE_FORMAT",
          message: "Structural assessment requires dvd-recovery-evidence-v1.",
        }],
      };
    }
    if (header === null) {
      return {
        ...common,
        state: "unavailable" as const,
        checkpoint: null,
        currentAssessmentIdentity: null,
        assessment: null,
        latestAttempt: null,
        unavailableReasons: [{
          code: "CONSISTENCY_FAULT",
          message: "The committed DVD checkpoint is unavailable.",
        }],
      };
    }
    const checkpoint: DvdStructuralCheckpoint = {
      originalDiscArchiveId,
      manifestId: header.currentManifestId,
      manifestRevision: header.currentManifestRevision,
      manifestDigest: header.currentManifestDigest,
      acceptedEndLbaExclusive: header.acceptedEndLbaExclusive,
    };
    const latestAttempt = findLatestDvdStructuralAttempt(id, checkpoint);
    const currentAttempt = findLatestDvdStructuralAttempt(
      id,
      checkpoint,
      "completed",
    );
    const priorAttempt = currentAttempt ??
      findLatestDvdStructuralAttempt(id, undefined, "completed");
    const assessment = priorAttempt?.outcome === "completed"
      ? findDvdStructuralAssessment(priorAttempt.assessmentIdentity)
      : null;
    const isCurrent = currentAttempt !== null;
    const state = isCurrent
      ? "current" as const
      : assessment === null
        ? "pending" as const
        : "outdated" as const;
    const unavailableReasons = isCurrent
      ? []
      : [
        state === "pending"
          ? {
            code: "ASSESSMENT_PENDING",
            message: "Structural assessment is pending for the current checkpoint.",
          }
          : {
            code: "ASSESSMENT_OUTDATED",
            message: "The displayed structural assessment is for an older checkpoint.",
          },
        ...(latestAttempt?.outcome === "failed"
          ? [latestAttempt.reason]
          : []),
      ];
    return {
      ...common,
      state,
      checkpoint,
      currentAssessmentIdentity: isCurrent ? assessment!.id : null,
      assessment,
      latestAttempt,
      unavailableReasons,
    };
  }

  function finalizeArchiveAuditRun(
    claim: ArchiveAuditRunSummary,
    input: {
      findings: readonly ArchiveAuditFinding[];
      incompleteReason: ArchiveAuditIncompleteReason | null;
      resultStatus: "complete" | "incomplete";
      validateCurrent(current: ArchiveAuditRunRow): boolean;
    },
  ): ArchiveAuditRun {
    if (claim.claimToken === null) {
      throw new StaleJobAttemptError("archive audit run", claim.id);
    }
    const claimToken = claim.claimToken;
    return database.transaction((transaction) => {
      const current = transaction.select().from(archiveAuditRuns)
        .where(eq(archiveAuditRuns.id, claim.id)).get();
      if (current?.status !== "running" || current.claimToken !== claimToken ||
        !input.validateCurrent(current)) {
        throw new StaleJobAttemptError("archive audit run", claim.id);
      }
      transaction.delete(archiveAuditFindings)
        .where(eq(archiveAuditFindings.archiveAuditRunId, claim.id)).run();
      if (input.findings.length > 0) {
        transaction.insert(archiveAuditFindings).values(
          input.findings.map((finding, sequence) => ({
            archiveAuditRunId: claim.id,
            sequence,
            finding: JSON.stringify(finding),
          })),
        ).run();
      }
      const timestamp = now();
      const row = requireRow(transaction.update(archiveAuditRuns).set({
        status: "completed",
        progressPhase: "completed",
        recordsProcessed: input.findings.length,
        resultStatus: input.resultStatus,
        incompleteReason: input.incompleteReason,
        claimToken: null,
        claimedAt: null,
        completedAt: timestamp,
        updatedAt: timestamp,
      }).where(and(eq(archiveAuditRuns.id, claim.id),
        eq(archiveAuditRuns.status, "running"),
        eq(archiveAuditRuns.claimToken, claimToken))).returning().get(),
      "archive audit run", claim.id);
      return {
        ...toArchiveAuditRunSummary(row),
        counts: countArchiveAuditFindings(input.findings),
        findings: input.findings,
      };
    });
  }

  function readCurrentDvdRecoveryStoragePreflight():
    DvdRecoveryStoragePreflight | null {
    const row = database
      .select()
      .from(dvdRecoveryStoragePreflights)
      .where(eq(dvdRecoveryStoragePreflights.scope, "originals_library"))
      .get();
    if (row === undefined) return null;
    const preflight: DvdRecoveryStoragePreflight = {
      contractVersion: row.contractVersion as
        typeof DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
      status: row.status,
      reasonCode: row.reasonCode,
      facts: row.facts,
      checkedAt: row.checkedAt,
    };
    assertDvdRecoveryStoragePreflightInput(preflight);
    return preflight;
  }

  function updateDvdInitialClaim(claim: RunningArchiveJob, workerId?: string): RunningArchiveJob {
    const timestamp = now();
    const expiredBefore = new Date(timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS);
    const renewed = database.update(archiveJobs).set({
      updatedAt: timestamp,
      ...(workerId === undefined ? {} : {
        claimToken: newId<ArchiveJobClaimToken>(), claimedBy: workerId, claimedAt: timestamp,
      }),
    }).where(and(
      eq(archiveJobs.id, claim.id), eq(archiveJobs.status, "running"),
      eq(archiveJobs.archiveRequestId, claim.archiveRequestId),
      eq(archiveJobs.detectedDiscId, claim.detectedDiscId),
      eq(archiveJobs.evidenceFormat, DVD_RECOVERY_EVIDENCE_FORMAT),
      eq(archiveJobs.claimToken, claim.claimToken),
      workerId === undefined ? gt(archiveJobs.updatedAt, expiredBefore) : lte(archiveJobs.updatedAt, expiredBefore),
      exists(database.select({ id: archiveRequests.id }).from(archiveRequests).where(and(
        eq(archiveRequests.id, archiveJobs.archiveRequestId),
        eq(archiveRequests.evidenceFormat, DVD_RECOVERY_EVIDENCE_FORMAT),
        eq(archiveRequests.status, "running"),
      ))),
    )).returning().get();
    if (!renewed) throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_OWNERSHIP_LOST");
    return asRunningArchiveJob(renewed);
  }

  function publishArchive(
    claim: RunningArchiveJob,
    input: Parameters<import("../types.js").ArchiveJobAccess["publish"]>[1],
    initialSave?: import("../types.js").DvdInitialArchiveSave,
  ): ArchiveJob {

    const initial = initialSave?.manifest;
    if (!initial) requireLegacyArchiveJobMutation(claim);
    else {
      if (claim.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT ||
        initial.sourceArchiveJobId !== claim.id || initial.revision !== 1 ||
        initial.previousManifestId !== null || initial.recoveryReadId !== null ||
        initial.previousManifestDigest !== null || initial.recoveryReadEvidenceDigest !== null ||
        initial.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT ||
        initial.unrecoveredSourceRanges.some(r => r.classification !== "skipped_untested"))
        throw new DomainInvariantError("Invalid initial DVD save provenance");
      assertDvdArchiveEvidenceManifestDigests(initial);
      assertDvdArchiveBoundaryEvidenceDigest(input.boundaryEvidence, initial.boundaryEvidenceDigest);
      if (initial.boundaryPolicyVersion !== input.boundaryEvidence.policyVersion ||
        initial.boundaryReportedSizeBytes !== input.boundaryEvidence.reportedSizeBytes ||
        initial.boundaryPublishedSizeBytes !== input.sizeBytes)
        throw new DomainInvariantError("Initial DVD save boundary conflicts with checkpoint");
      const existing = access.archiveJobs.find(claim.id);
      if (existing?.status === "completed") {
        const header = access.catalog.findDvdArchiveEvidenceHeader(initial.originalDiscArchiveId as OriginalDiscArchiveId);
        const archive = access.catalog.listOriginalDiscArchives({ ids: [initial.originalDiscArchiveId as OriginalDiscArchiveId] })[0];
        if (existing.originalDiscArchiveId !== initial.originalDiscArchiveId ||
          header?.sourceArchiveJobId !== claim.id || header.currentManifestId !== initial.id ||
          header.currentManifestRevision !== 1 || header.currentManifestDigest !== initial.manifestDigest ||
          archive?.archivePath !== input.archivePath ||
          access.archiveRequests.find(existing.archiveRequestId)?.status !== "fulfilled" ||
          access.catalog.findArchiveRecovery(archive.id) === null)
          throw new DvdInitialSaveFault("DVD_INITIAL_SAVE_CONSISTENCY_FAULT");
        return existing;
      }
    }
    const archivePath = requireNonEmpty(input.archivePath, "archivePath");
    const sizeBytes = requirePositiveSafeInteger(input.sizeBytes, "sizeBytes");
    const boundaryEvidence = validateDvdArchiveBoundaryEvidence(
      input.boundaryEvidence,
      sizeBytes,
    );
    const boundaryProof =
      "endpointProof" in boundaryEvidence
        ? {
            firstExcludedLba:
              boundaryEvidence.endpointProof.firstExcludedLba,
            maximumReferencedLba: null,
            outOfRangeEvidence:
              boundaryEvidence.endpointProof.outOfRangeEvidence,
          }
        : "outOfRangeEvidence" in boundaryEvidence
          ? {
              firstExcludedLba: boundaryEvidence.firstExcludedLba,
              maximumReferencedLba:
                boundaryEvidence.maximumReferencedLba,
              outOfRangeEvidence: boundaryEvidence.outOfRangeEvidence,
            }
          : null;
    const boundaryProofColumns =
      boundaryProof !== null
        ? {
            boundaryFirstExcludedLba: boundaryProof.firstExcludedLba,
            boundaryMaximumReferencedLba:
              boundaryProof.maximumReferencedLba,
            boundaryReadFailureClassifierVersion:
              boundaryProof.outOfRangeEvidence.classifierVersion,
            boundaryReadFailureScsiStatus:
              boundaryProof.outOfRangeEvidence.scsiStatus,
            boundaryReadFailureHostStatus:
              boundaryProof.outOfRangeEvidence.hostStatus,
            boundaryReadFailureDriverStatus:
              boundaryProof.outOfRangeEvidence.driverStatus,
            boundaryReadFailureSenseResponseCode:
              boundaryProof.outOfRangeEvidence.senseResponseCode,
            boundaryReadFailureSenseKey:
              boundaryProof.outOfRangeEvidence.senseKey,
            boundaryReadFailureAsc:
              boundaryProof.outOfRangeEvidence.asc,
            boundaryReadFailureAscq:
              boundaryProof.outOfRangeEvidence.ascq,
          }
        : {
            boundaryFirstExcludedLba: null,
            boundaryMaximumReferencedLba: null,
            boundaryReadFailureClassifierVersion: null,
            boundaryReadFailureScsiStatus: null,
            boundaryReadFailureHostStatus: null,
            boundaryReadFailureDriverStatus: null,
            boundaryReadFailureSenseResponseCode: null,
            boundaryReadFailureSenseKey: null,
            boundaryReadFailureAsc: null,
            boundaryReadFailureAscq: null,
          };
    const integrityEvidence = input.integrityEvidence;
    let integrityPolicyVersion: string | null;
    let badSectorCountsByTitle = null;
    if (integrityEvidence.integrity === "unknown") {
      if (
        integrityEvidence.policyVersion !== null ||
        integrityEvidence.badSectorCount !== null ||
        integrityEvidence.badAreaCount !== null ||
        integrityEvidence.badSectorRanges !== null
      ) {
        throw new DomainInvariantError(
          "Unknown Archive Integrity evidence is invalid",
        );
      }
      integrityPolicyVersion = null;
    } else if (integrityEvidence.integrity === "clean_read") {
      integrityPolicyVersion = requireNonEmpty(
        integrityEvidence.policyVersion,
        "integrityEvidence.policyVersion",
      );
      if (
        integrityPolicyVersion.length > 128 ||
        integrityEvidence.badSectorCount !== 0 ||
        integrityEvidence.badAreaCount !== 0 ||
        !Array.isArray(integrityEvidence.badSectorRanges) ||
        integrityEvidence.badSectorRanges.length !== 0
      ) {
        throw new DomainInvariantError(
          "Clean-read Archive Integrity evidence is invalid",
        );
      }
    } else if (integrityEvidence.integrity === "incomplete_read") {
      if (!initial) throw new DomainInvariantError(
        "Incomplete-read evidence requires an admitted dvd-recovery-evidence-v1 Archive Job",
      );
      integrityPolicyVersion = DVD_RECOVERY_EVIDENCE_FORMAT;
    } else {
      integrityPolicyVersion = requireNonEmpty(
        integrityEvidence.policyVersion,
        "integrityEvidence.policyVersion",
      );
      const validatedEvidence =
        createWatchableSalvageArchiveIntegrityEvidence(
          integrityPolicyVersion,
          integrityEvidence.badSectorRanges,
          integrityEvidence.badSectorCountsByTitle,
        );
      if (
        validatedEvidence.badSectorCount !==
          integrityEvidence.badSectorCount ||
        validatedEvidence.badAreaCount !== integrityEvidence.badAreaCount
      ) {
        throw new DomainInvariantError(
          "Watchable-salvage Archive Integrity evidence is invalid",
        );
      }
      badSectorCountsByTitle = validatedEvidence.badSectorCountsByTitle;
    }
    const requireCurrentClaim = (
      querySource: Pick<typeof database, "select">,
    ) => {
      const checkedAt = now();
      const current = querySource
        .select({
          archiveRequestId: archiveJobs.archiveRequestId,
          detectedDiscId: archiveJobs.detectedDiscId,
          discKind: detectedDiscs.discKind,
          fingerprint: detectedDiscs.fingerprint,
          rearchiveSourceArchiveId:
            archiveRequests.rearchiveSourceArchiveId,
          jobEvidenceFormat: archiveJobs.evidenceFormat,
          requestEvidenceFormat: archiveRequests.evidenceFormat,
          sourceInspectionId: archiveJobs.discInspectionId,
          sourceInspectionTotalBytes: discInspections.totalBytes,
        })
        .from(archiveJobs)
        .innerJoin(
          archiveRequests,
          eq(archiveRequests.id, archiveJobs.archiveRequestId),
        )
        .innerJoin(
          detectedDiscs,
          eq(detectedDiscs.id, archiveJobs.detectedDiscId),
        )
        .leftJoin(
          discInspections,
          and(
            eq(discInspections.id, archiveJobs.discInspectionId),
            eq(
              discInspections.detectedDiscId,
              archiveJobs.detectedDiscId,
            ),
            eq(discInspections.status, "completed"),
          ),
        )
        .where(
          and(
            eq(archiveJobs.id, claim.id),
            eq(archiveJobs.detectedDiscId, claim.detectedDiscId),
            eq(archiveJobs.status, "running"),
            eq(archiveJobs.claimToken, claim.claimToken),
            eq(archiveRequests.status, "running"),
            gt(
              archiveJobs.updatedAt,
              new Date(
                checkedAt.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
              ),
            ),
          ),
        )
        .get();
      if (current === undefined) {
        throw new StaleJobAttemptError("archive job", claim.id);
      }
      if (initial && (current.jobEvidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT ||
        current.requestEvidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT ||
        current.fingerprint !== initial.imageFingerprint || current.discKind !== "dvd"))
        throw new DomainInvariantError("Initial DVD save does not match the marked source job");
      if (
        current.sourceInspectionId === null ||
        current.sourceInspectionTotalBytes === null ||
        current.sourceInspectionTotalBytes !==
          boundaryEvidence.reportedSizeBytes
      ) {
        throw new DomainInvariantError(
          "Archive Boundary Evidence does not match the source Disc Inspection",
        );
      }
      return current;
    };
    const currentDisc = requireCurrentClaim(database);
    if (currentDisc.discKind === "dvd") {
      reconcileLegacyDvdArchiveContentId(
        currentDisc.fingerprint,
        sizeBytes,
        requireCurrentClaim,
      );
    }
    const timestamp = now();
    const completed = database.transaction((transaction) => {
      const current = requireCurrentClaim(transaction);
      const disc = requireRow(
        transaction
          .select()
          .from(detectedDiscs)
          .where(eq(detectedDiscs.id, current.detectedDiscId))
          .get(),
        "detected disc",
        current.detectedDiscId,
      );
      const rearchiveSource =
        current.rearchiveSourceArchiveId === null
          ? null
          : requireRow(
              transaction
                .select()
                .from(originalDiscArchives)
                .where(eq(
                  originalDiscArchives.id,
                  current.rearchiveSourceArchiveId,
                ))
                .get(),
              "original disc archive",
              current.rearchiveSourceArchiveId,
            );
      if (
        rearchiveSource !== null &&
        !originalArchiveMatchesFingerprintOrContentIdAlias(
          rearchiveSource.id,
          disc.fingerprint,
          transaction,
        )
      ) {
        throw new DomainInvariantError(
          "Re-archive source does not match the Archive Job disc identity",
        );
      }
      if (
        rearchiveSource === null &&
        findOriginalArchiveByFingerprintOrContentIdAlias(
          disc.fingerprint,
          transaction,
        )
      ) {
        throw new DomainInvariantError(
          "DVD content already has Original Disc Archive provenance",
        );
      }
      requireLegacyDvdArchiveIdentitiesResolved(
        disc.discKind,
        disc.fingerprint,
        transaction,
      );
      const archive = requireRow(
        transaction
          .insert(originalDiscArchives)
          .values({
            id: initial ? initial.originalDiscArchiveId as OriginalDiscArchiveId : newId<OriginalDiscArchiveId>(),
            detectedDiscId: disc.id,
            rearchiveSourceArchiveId: rearchiveSource?.id ?? null,
            discKind: disc.discKind,
            archiveFormat: "iso",
            archivePath,
            fingerprint: disc.fingerprint,
            boundaryPolicyVersion: boundaryEvidence.policyVersion,
            boundaryReportedSizeBytes:
              boundaryEvidence.reportedSizeBytes,
            boundaryPublishedSizeBytes:
              boundaryEvidence.publishedSizeBytes,
            boundaryExcludedSectorCount:
              boundaryEvidence.excludedSectorCount,
            ...boundaryProofColumns,
            integrity: initial ? "unknown" : integrityEvidence.integrity,
            integrityPolicyVersion: initial ? null : integrityPolicyVersion,
            badSectorCount: initial ? null : integrityEvidence.badSectorCount,
            badAreaCount: initial ? null : integrityEvidence.badAreaCount,
            badSectorRanges: initial ? null : integrityEvidence.badSectorRanges,
            badSectorCountsByTitle,
            legacyCutoverPending:
              transaction
                .select({
                  sidecarPath: legacyCutoverStagedSidecars.sidecarPath,
                })
                .from(legacyCutoverStagedSidecars)
                .where(
                  legacyCutoverFenceCondition(
                    disc.fingerprint,
                    archivePath,
                  ),
                )
                .limit(1)
                .get() !== undefined,
            sizeBytes,
            archivedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .returning()
          .get(),
        "original disc archive",
        disc.id,
      );
      transaction
        .update(detectedDiscs)
        .set({ status: "archived", updatedAt: timestamp })
        .where(eq(detectedDiscs.fingerprint, disc.fingerprint))
        .run();
      const requestFulfillmentScope = !initial && rearchiveSource === null
        ? exists(
            transaction
              .select({ id: detectedDiscs.id })
              .from(detectedDiscs)
              .where(
                and(
                  eq(detectedDiscs.id, archiveRequests.detectedDiscId),
                  eq(detectedDiscs.fingerprint, disc.fingerprint),
                ),
              ),
          )
        : eq(archiveRequests.id, current.archiveRequestId);
      if (initial) {
        transaction.insert(dvdArchiveEvidenceManifests).values({
          ...initial, originalDiscArchiveId: archive.id, createdAt: timestamp,
        }).run();
      }
      const job = requireRow(
        transaction
          .update(archiveJobs)
          .set({
            originalDiscArchiveId: archive.id,
            status: "completed",
            ...archiveTerminalProgressPatchForClaim(
              claim.id,
              claim.claimToken,
            ),
            progressPhase: "finalizing",
            progressPercent: 100,
            progressBytes: sizeBytes,
            lastProgressAt: timestamp,
            completedAt: timestamp,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
            ),
          )
          .returning()
          .get(),
        "archive job",
        claim.id,
      );
      transaction
        .update(archiveRequests)
        .set({
          status: "fulfilled",
          fulfilledAt: timestamp,
          updatedAt: timestamp,
        })
        .where(
          and(
            inArray(archiveRequests.status, [
              "pending",
              "running",
              "needs_attention",
            ]),
            requestFulfillmentScope,
          ),
        )
        .run();
      if (initial) {
        transaction.insert(dvdArchiveEvidenceHeaders).values({
          originalDiscArchiveId: archive.id, sourceArchiveJobId: job.id,
          evidenceFormat: initial.evidenceFormat,
          boundaryPolicyVersion: initial.boundaryPolicyVersion,
          boundaryReportedSizeBytes: initial.boundaryReportedSizeBytes,
          boundaryPublishedSizeBytes: initial.boundaryPublishedSizeBytes,
          boundaryEvidenceDigest: initial.boundaryEvidenceDigest,
          sectorSizeBytes: initial.sectorSizeBytes,
          acceptedEndLbaExclusive: initial.acceptedEndLbaExclusive,
          currentManifestId: initial.id, currentManifestRevision: 1,
          currentManifestDigest: initial.manifestDigest,
          createdAt: timestamp, updatedAt: timestamp,
        }).run();
        if (initial.sourceSampleManifest !== undefined) {
          const sourceSampleManifest = validateDvdSourceSampleManifest(
            initial.sourceSampleManifest,
          );
          if (
            sourceSampleManifest.sourceMetadataFingerprint !==
              initial.imageFingerprint ||
            sourceSampleManifest.acceptedEndLbaExclusive !==
              initial.acceptedEndLbaExclusive ||
            sourceSampleManifest.checkpointRevision !== 1 ||
            sourceSampleManifest.checkpointDigest !== initial.manifestDigest
          ) {
            throw new DomainInvariantError(
              "DVD source sample manifest does not match the initial checkpoint",
            );
          }
          transaction.insert(dvdSourceSampleManifests).values({
            originalDiscArchiveId: archive.id,
            manifest: sourceSampleManifest,
            createdAt: timestamp,
          }).run();
        }
        transaction.update(originalDiscArchives).set({
          integrity: integrityEvidence.integrity, integrityEvidenceRevision: 1,
          integrityPolicyVersion, badSectorCount: integrityEvidence.badSectorCount,
          badAreaCount: integrityEvidence.badAreaCount, badSectorRanges: integrityEvidence.badSectorRanges,
        }).where(eq(originalDiscArchives.id, archive.id)).run();
        const recoveryId = newId<import("../types.js").ArchiveRecoveryId>();
        transaction.insert(archiveRecoveries).values({
          id: recoveryId,
          originalDiscArchiveId: archive.id,
          attemptId: newId<import("../types.js").ArchiveRecoveryAttemptId>(),
          attemptOrdinal: 1,
          status: initial.unrecoveredSourceRanges.length ? "eligible" : "completed",
          pauseReason: null,
          passHistory: [],
          createdAt: timestamp, updatedAt: timestamp,
        }).run();
      }
      recordNotificationOutcome(createNotificationEventWriter(transaction, now), {
        kind: "archive_saved",
        sourceEventId: `archive-job:${job.id}:completed`,
        archiveJobId: job.id,
        label: disc.volumeLabel,
        remainingSource: (integrityEvidence.badSectorCount ?? 0) > 0,
      });
      return job;
    }, { behavior: "immediate" });
    archiveProgress.delete(claim.id);
    return completed;
  }

  function recordCompletedDvdStructuralAssessment(input: {
    checkpoint: DvdStructuralCheckpoint;
    findings: readonly import("../dvd-structural-assessment.js")
      .DvdStructuralFindingInput[];
    imagePath: string;
  }) {
    const assessment = createDvdStructuralAssessment(input);
    const timestamp = now();
    return database.transaction((transaction) => {
      requireDvdStructuralCheckpoint(transaction, assessment.checkpoint);
      const archive = transaction.select({
        archivePath: originalDiscArchives.archivePath,
      }).from(originalDiscArchives).where(eq(
        originalDiscArchives.id,
        assessment.checkpoint.originalDiscArchiveId,
      )).get();
      if (archive?.archivePath !== input.imagePath) {
        throw new DvdCheckpointReadFault(
          "DVD_EVIDENCE_CHANGED_DURING_READ",
        );
      }
      transaction.insert(dvdStructuralAssessments).values({
        id: assessment.id,
        originalDiscArchiveId: assessment.checkpoint.originalDiscArchiveId,
        manifestId: assessment.checkpoint.manifestId,
        manifestRevision: assessment.checkpoint.manifestRevision,
        manifestDigest: assessment.checkpoint.manifestDigest,
        acceptedEndLbaExclusive:
          assessment.checkpoint.acceptedEndLbaExclusive,
        policyVersion: assessment.policyVersion,
        validity: assessment.validity,
        findings: assessment.findings,
        createdAt: timestamp,
      }).onConflictDoNothing().run();
      const persistedRow = transaction.select()
        .from(dvdStructuralAssessments)
        .where(eq(dvdStructuralAssessments.id, assessment.id)).get();
      if (persistedRow === undefined) {
        throw new DomainInvariantError(
          "DVD structural assessment was not recorded",
        );
      }
      const persisted = toDvdStructuralAssessment(persistedRow);
      const attemptRow = transaction.insert(dvdStructuralCheckAttempts)
        .values({
          originalDiscArchiveId: assessment.checkpoint.originalDiscArchiveId,
          manifestId: assessment.checkpoint.manifestId,
          manifestRevision: assessment.checkpoint.manifestRevision,
          manifestDigest: assessment.checkpoint.manifestDigest,
          acceptedEndLbaExclusive:
            assessment.checkpoint.acceptedEndLbaExclusive,
          outcome: "completed",
          assessmentId: assessment.id,
          findings: assessment.findings,
          failureCode: null,
          failureMessage: null,
          createdAt: timestamp,
        }).returning().get();
      if (attemptRow === undefined) {
        throw new DomainInvariantError(
          "DVD structural check attempt was not recorded",
        );
      }
      const attempt = toDvdStructuralCheckAttempt(attemptRow);
      if (attempt.outcome !== "completed") {
        throw new DomainInvariantError(
          "DVD structural check attempt outcome is invalid",
        );
      }
      return { attempt, assessment: persisted };
    });
  }

  function recordFailedDvdStructuralAttempt(input: {
    checkpoint: DvdStructuralCheckpoint;
    reason: { code: string; message: string };
  }) {
    const reason = validateDvdStructuralFailureReason(input.reason);
    const timestamp = now();
    return database.transaction((transaction) => {
      requireDvdStructuralCheckpoint(transaction, input.checkpoint);
      const row = transaction.insert(dvdStructuralCheckAttempts).values({
        originalDiscArchiveId: input.checkpoint.originalDiscArchiveId,
        manifestId: input.checkpoint.manifestId,
        manifestRevision: input.checkpoint.manifestRevision,
        manifestDigest: input.checkpoint.manifestDigest,
        acceptedEndLbaExclusive:
          input.checkpoint.acceptedEndLbaExclusive,
        outcome: "failed",
        assessmentId: null,
        findings: null,
        failureCode: reason.code,
        failureMessage: reason.message,
        createdAt: timestamp,
      }).returning().get();
      if (row === undefined) {
        throw new DomainInvariantError(
          "DVD structural check failure was not recorded",
        );
      }
      const attempt = toDvdStructuralCheckAttempt(row);
      if (attempt.outcome !== "failed") {
        throw new DomainInvariantError(
          "DVD structural check failure outcome is invalid",
        );
      }
      return attempt;
    });
  }

  async function withDvdCheckpointRead<Checkpoint, Prepared, Result>(
    id: OriginalDiscArchiveId,
    ownership: import("../types.js").DvdCheckpointReadOwnership,
    readCheckpoint: (input: {
      originalsLibraryPath: string;
      archive: OriginalDiscArchive;
      header: DvdArchiveEvidenceHeader | null;
      jobs: readonly ArchiveJob[];
      assertImageOwnership(): void;
    }) => Promise<Checkpoint | null>,
    inspect: (
      checkpoint: Checkpoint,
      handle: import("../types.js").DvdCheckpointReadHandle,
      imagePath: string,
    ) => Promise<Prepared>,
    commit: (
      checkpoint: Checkpoint,
      prepared: Prepared,
      imagePath: string,
    ) => Result,
  ): Promise<{
    checkpoint: Checkpoint;
    result: Result;
  } | null> {
    type OwnedReadState = null | {
      state: "prepared";
      checkpoint: Checkpoint;
      imagePath: string;
      prepared: Prepared;
    } | {
      state: "committed";
      checkpoint: Checkpoint;
      result: Result;
    };
    const readSnapshot = () => access.readConsistentSnapshot((reader) => {
      const archive = reader.catalog.listOriginalDiscArchives({ ids: [id] })[0];
      if (!archive) throw new RecordNotFoundError("Original Disc Archive", id);
      const recovery = reader.catalog.findArchiveRecovery(id);
      return {
        archive,
        header: reader.catalog.findDvdArchiveEvidenceHeader(id),
        jobs: reader.archiveJobs.listForArchive(id),
        reconciliation: recovery === null
          ? null
          : reader.dvdRecoveryReconciliations.findLatestForRecovery(
              recovery.id,
            ),
      };
    });
    const admissionSnapshot = readSnapshot();
    if (dvdRecoveryEvidenceFormatForArchive(
      admissionSnapshot.header,
      admissionSnapshot.jobs,
    ) === null) return null;
    if (
      admissionSnapshot.reconciliation !== null &&
      admissionSnapshot.reconciliation.status !== "completed"
    ) {
      throw new DvdCheckpointReadFault(
        admissionSnapshot.reconciliation.failureCode ?? "CONSISTENCY_FAULT",
      );
    }
    if (normalizedOriginalsLibraryPath === undefined) {
      throw new DvdCheckpointReadFault("DVD_EVIDENCE_STORAGE_UNAVAILABLE", {
        storageFault: true,
      });
    }
    const owned = await ownership.withConsistentRead<OwnedReadState>({
      archiveId: id,
      imagePath: admissionSnapshot.archive.archivePath,
      originalsLibraryPath: normalizedOriginalsLibraryPath,
      signal: new AbortController().signal,
      task: async (handle) => {
        handle.assertOwned();
        const snapshot = readSnapshot();
        if (
          canonicalPublicationJson(snapshot) !==
            canonicalPublicationJson(admissionSnapshot)
        ) {
          throw new DvdCheckpointReadFault(
            "DVD_EVIDENCE_CHANGED_DURING_READ",
          );
        }
        const checkpoint = await readCheckpoint({
          originalsLibraryPath: normalizedOriginalsLibraryPath,
          ...snapshot,
          assertImageOwnership: handle.assertOwned,
        });
        if (checkpoint === null) {
          throw new DvdCheckpointReadFault("DVD_EVIDENCE_NOT_RECORDED");
        }
        const imagePath = snapshot.archive.archivePath;
        if (imagePath === null) {
          throw new DvdCheckpointReadFault(
            "DVD_EVIDENCE_CHECKPOINT_UNAVAILABLE",
          );
        }
        handle.assertOwned();
        const prepared = await inspect(checkpoint, handle, imagePath);
        handle.assertOwned();
        if (
          canonicalPublicationJson(readSnapshot()) !==
            canonicalPublicationJson(snapshot)
        ) {
          throw new DvdCheckpointReadFault(
            "DVD_EVIDENCE_CHANGED_DURING_READ",
          );
        }
        return {
          state: "prepared" as const,
          checkpoint,
          imagePath,
          prepared,
        };
      },
      commit: (prepared, handle) => {
        if (prepared === null) return null;
        if (prepared.state !== "prepared") {
          throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
        }
        handle.assertOwned();
        return {
          state: "committed" as const,
          checkpoint: prepared.checkpoint,
          result: commit(
            prepared.checkpoint,
            prepared.prepared,
            prepared.imagePath,
          ),
        };
      },
    });
    if (owned === null) return null;
    if (owned.state !== "committed") {
      throw new DvdCheckpointReadFault("CONSISTENCY_FAULT");
    }
    return { checkpoint: owned.checkpoint, result: owned.result };
  }

  function presentDvdTitleIdentityObservation(
    row: typeof dvdTitleIdentityObservations.$inferSelect,
    set: typeof dvdTitleIdentitySets.$inferSelect,
  ): DvdTitleIdentityObservation {
    return {
      id: row.id,
      titleIdentityId: row.titleIdentityId,
      checkpoint: {
        manifestId: set.manifestId,
        manifestRevision: set.manifestRevision,
        manifestDigest: set.manifestDigest,
      },
      displayTitleNumber: row.displayTitleNumber,
      navigation: row.navigation,
      selectedPath: row.selectedPath,
      angleNumber: row.angleNumber,
      angleCount: row.angleCount,
      chapterStart: row.chapterStart,
      chapterEnd: row.chapterEnd,
      chapterCount: row.chapterCount,
      sourceExtents: row.sourceExtents,
      contentDigest: row.contentDigest,
      continuity: {
        result: row.continuityResult,
        policyVersion: row.continuityPolicyVersion,
        previousObservationId: row.previousObservationId,
      },
      createdAt: row.createdAt,
    };
  }

  function assertPersistedDvdTitleIdentitySet(
    set: typeof dvdTitleIdentitySets.$inferSelect,
    rows: readonly (typeof dvdTitleIdentityObservations.$inferSelect)[],
    acceptedEndLbaExclusive: number,
    validatedManifestIds = new Set<string>(),
  ): void {
    if (validatedManifestIds.has(set.manifestId)) return;
    if (set.policyVersion !== DVD_TITLE_IDENTITY_CONTINUITY_VERSION) {
      throw new DomainInvariantError(
        "Title Identity evidence uses an unsupported continuity policy",
      );
    }
    const manifest = database.select({
      originalDiscArchiveId:
        dvdArchiveEvidenceManifests.originalDiscArchiveId,
      revision: dvdArchiveEvidenceManifests.revision,
      manifestDigest: dvdArchiveEvidenceManifests.manifestDigest,
    }).from(dvdArchiveEvidenceManifests).where(eq(
      dvdArchiveEvidenceManifests.id,
      set.manifestId,
    )).get();
    if (
      manifest === undefined ||
      manifest.originalDiscArchiveId !== set.originalDiscArchiveId ||
      manifest.revision !== set.manifestRevision ||
      manifest.manifestDigest !== set.manifestDigest
    ) {
      throw new DomainInvariantError(
        "Title Identity checkpoint set does not match its evidence manifest",
      );
    }
    const observations = rows.map((row) => {
      const identity = database.select({
        originalDiscArchiveId: dvdTitleIdentities.originalDiscArchiveId,
      }).from(dvdTitleIdentities).where(eq(
        dvdTitleIdentities.id,
        row.titleIdentityId,
      )).get();
      if (
        row.manifestId !== set.manifestId || identity === undefined ||
        identity.originalDiscArchiveId !== set.originalDiscArchiveId
      ) {
        throw new DomainInvariantError(
          "Title Identity observation does not belong to its checkpoint set",
        );
      }
      if (row.continuityPolicyVersion !== set.policyVersion) {
        throw new DomainInvariantError(
          "Title Identity observation policy does not match its checkpoint set",
        );
      }
      const normalized = normalizeDvdTitleIdentityObservation({
        displayTitleNumber: row.displayTitleNumber,
        navigation: row.navigation,
        selectedPath: row.selectedPath,
        angleNumber: row.angleNumber,
        angleCount: row.angleCount,
        chapterStart: row.chapterStart,
        chapterEnd: row.chapterEnd,
        chapterCount: row.chapterCount,
        sourceExtents: row.sourceExtents,
      }, acceptedEndLbaExclusive);
      if (dvdTitleIdentityContentDigest(normalized) !== row.contentDigest) {
        throw new DomainInvariantError(
          "Title Identity observation content digest does not match its evidence",
        );
      }
      return { ...normalized, contentDigest: row.contentDigest };
    });
    if (
      dvdTitleIdentityObservationSetDigest(observations) !==
        set.observationSetDigest
    ) {
      throw new DomainInvariantError(
        "Title Identity observation-set digest does not match its evidence",
      );
    }
    validatedManifestIds.add(set.manifestId);
    for (const row of rows) {
      if (row.previousObservationId === null) continue;
      const previous = database.select()
        .from(dvdTitleIdentityObservations)
        .where(eq(
          dvdTitleIdentityObservations.id,
          row.previousObservationId,
        )).get();
      if (
        previous === undefined ||
        previous.titleIdentityId !== row.titleIdentityId
      ) {
        throw new DomainInvariantError(
          "Title Identity continuity predecessor does not belong to the same identity",
        );
      }
      const previousSet = database.select().from(dvdTitleIdentitySets).where(eq(
        dvdTitleIdentitySets.manifestId,
        previous.manifestId,
      )).get();
      if (
        previousSet === undefined ||
        previousSet.originalDiscArchiveId !== set.originalDiscArchiveId ||
        previousSet.manifestRevision >= set.manifestRevision
      ) {
        throw new DomainInvariantError(
          "Title Identity continuity predecessor is not from an earlier checkpoint",
        );
      }
      const previousRows = database.select()
        .from(dvdTitleIdentityObservations)
        .where(eq(
          dvdTitleIdentityObservations.manifestId,
          previousSet.manifestId,
        )).all();
      assertPersistedDvdTitleIdentitySet(
        previousSet,
        previousRows,
        acceptedEndLbaExclusive,
        validatedManifestIds,
      );
    }

    const previousSets = database.select().from(dvdTitleIdentitySets)
      .where(and(
        eq(
          dvdTitleIdentitySets.originalDiscArchiveId,
          set.originalDiscArchiveId,
        ),
        lt(dvdTitleIdentitySets.manifestRevision, set.manifestRevision),
      ))
      .orderBy(desc(dvdTitleIdentitySets.manifestRevision))
      .all();
    const previousRows = [] as Array<
      typeof dvdTitleIdentityObservations.$inferSelect
    >;
    const seenPreviousIdentityIds = new Set<DvdTitleIdentityId>();
    for (const previousSet of previousSets) {
      const candidateRows = database.select()
        .from(dvdTitleIdentityObservations)
        .where(eq(
          dvdTitleIdentityObservations.manifestId,
          previousSet.manifestId,
        ))
        .orderBy(asc(dvdTitleIdentityObservations.id))
        .all();
      assertPersistedDvdTitleIdentitySet(
        previousSet,
        candidateRows,
        acceptedEndLbaExclusive,
        validatedManifestIds,
      );
      for (const candidate of candidateRows) {
        if (seenPreviousIdentityIds.has(candidate.titleIdentityId)) continue;
        seenPreviousIdentityIds.add(candidate.titleIdentityId);
        previousRows.push(candidate);
      }
    }
    const continuityPlans = planDvdTitleIdentityContinuity(
      observations,
      previousRows,
      previousSets.length > 0,
    );
    for (const [index, row] of rows.entries()) {
      const plan = continuityPlans[index]!;
      const expectedPrevious = plan.previousIndex === null
        ? undefined
        : previousRows[plan.previousIndex];
      if (
        row.continuityResult !== plan.result ||
        row.previousObservationId !== (expectedPrevious?.id ?? null) ||
        (expectedPrevious !== undefined &&
          row.titleIdentityId !== expectedPrevious.titleIdentityId) ||
        (expectedPrevious === undefined &&
          seenPreviousIdentityIds.has(row.titleIdentityId))
      ) {
        throw new DomainInvariantError(
          "Title Identity continuity claim does not match its evidence",
        );
      }
    }
  }

  function readDvdTitleIdentityReviewSetDeepAudit(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): DvdTitleIdentityReviewSet | null {
    const header = database.select().from(dvdArchiveEvidenceHeaders).where(eq(
      dvdArchiveEvidenceHeaders.originalDiscArchiveId,
      originalDiscArchiveId,
    )).get();
    if (header === undefined) return null;
    const set = database.select().from(dvdTitleIdentitySets).where(and(
      eq(
        dvdTitleIdentitySets.originalDiscArchiveId,
        originalDiscArchiveId,
      ),
      eq(dvdTitleIdentitySets.manifestId, header.currentManifestId),
      eq(
        dvdTitleIdentitySets.manifestRevision,
        header.currentManifestRevision,
      ),
      eq(dvdTitleIdentitySets.manifestDigest, header.currentManifestDigest),
    )).get();
    if (set === undefined) return null;

    const currentRows = database.select().from(dvdTitleIdentityObservations)
      .where(eq(dvdTitleIdentityObservations.manifestId, set.manifestId))
      .orderBy(
        asc(dvdTitleIdentityObservations.displayTitleNumber),
        asc(dvdTitleIdentityObservations.id),
      ).all();
    assertPersistedDvdTitleIdentitySet(
      set,
      currentRows,
      header.acceptedEndLbaExclusive,
    );
    const bindingRows = database.select({
      titleIdentityId: dvdTitleIdentitySelectionBindings.titleIdentityId,
      discSelectionId: dvdTitleIdentitySelectionBindings.discSelectionId,
      selectionOriginalDiscArchiveId:
        discSelections.originalDiscArchiveId,
      selectionMediaItemId: discSelections.mediaItemId,
      selectionKind: discSelections.kind,
      selectionTitleNumber: discSelections.titleNumber,
      selectionChapterStart: discSelections.chapterStart,
      selectionChapterEnd: discSelections.chapterEnd,
      lastObservationId:
        dvdTitleIdentitySelectionBindings.lastObservationId,
      lastObservationTitleIdentityId:
        dvdTitleIdentityObservations.titleIdentityId,
      lastObservationManifestId:
        dvdTitleIdentityObservations.manifestId,
      state: dvdTitleIdentitySelectionBindings.state,
    }).from(dvdTitleIdentitySelectionBindings)
      .innerJoin(
        dvdTitleIdentities,
        eq(
          dvdTitleIdentities.id,
          dvdTitleIdentitySelectionBindings.titleIdentityId,
        ),
      )
      .innerJoin(
        discSelections,
        eq(
          discSelections.id,
          dvdTitleIdentitySelectionBindings.discSelectionId,
        ),
      )
      .innerJoin(
        dvdTitleIdentityObservations,
        eq(
          dvdTitleIdentityObservations.id,
          dvdTitleIdentitySelectionBindings.lastObservationId,
        ),
      )
      .where(and(
        eq(
          dvdTitleIdentities.originalDiscArchiveId,
          originalDiscArchiveId,
        ),
        eq(discSelections.isCatalogActive, true),
      ))
      .orderBy(
        asc(dvdTitleIdentitySelectionBindings.titleIdentityId),
        asc(dvdTitleIdentitySelectionBindings.discSelectionId),
      ).all();
    for (const binding of bindingRows) {
      const observationSet = database.select().from(dvdTitleIdentitySets)
        .where(eq(
          dvdTitleIdentitySets.manifestId,
          binding.lastObservationManifestId,
        )).get();
      const latestObservation = database.select({
        id: dvdTitleIdentityObservations.id,
      }).from(dvdTitleIdentityObservations)
        .innerJoin(
          dvdTitleIdentitySets,
          eq(
            dvdTitleIdentitySets.manifestId,
            dvdTitleIdentityObservations.manifestId,
          ),
        )
        .where(and(
          eq(
            dvdTitleIdentityObservations.titleIdentityId,
            binding.titleIdentityId,
          ),
          lte(
            dvdTitleIdentitySets.manifestRevision,
            set.manifestRevision,
          ),
        ))
        .orderBy(desc(dvdTitleIdentitySets.manifestRevision))
        .limit(1)
        .get();
      if (
        binding.selectionOriginalDiscArchiveId !== originalDiscArchiveId ||
        binding.lastObservationTitleIdentityId !== binding.titleIdentityId ||
        observationSet === undefined ||
        observationSet.originalDiscArchiveId !== originalDiscArchiveId ||
        observationSet.manifestRevision > set.manifestRevision ||
        latestObservation?.id !== binding.lastObservationId
      ) {
        throw new DomainInvariantError(
          "Title Identity selection binding does not match its archive evidence",
        );
      }
    }
    const bindingsByIdentity = new Map<
      DvdTitleIdentityId,
      typeof bindingRows
    >();
    for (const binding of bindingRows) {
      const rows = bindingsByIdentity.get(binding.titleIdentityId) ?? [];
      rows.push(binding);
      bindingsByIdentity.set(binding.titleIdentityId, rows);
    }

    const currentIdentityIds = new Set(
      currentRows.map((row) => row.titleIdentityId),
    );
    const archiveIdentityIds = database.select({
      id: dvdTitleIdentities.id,
    }).from(dvdTitleIdentities).where(eq(
      dvdTitleIdentities.originalDiscArchiveId,
      originalDiscArchiveId,
    )).all().map(({ id }) => id);
    const missingIdentityIds = archiveIdentityIds.filter((id) =>
      !currentIdentityIds.has(id)
    );
    const priorRows = missingIdentityIds.length === 0
      ? []
      : database.select().from(dvdTitleIdentityObservations).where(inArray(
        dvdTitleIdentityObservations.titleIdentityId,
        missingIdentityIds,
      )).all();
    const priorSets = priorRows.length === 0
      ? []
      : database.select().from(dvdTitleIdentitySets).where(inArray(
        dvdTitleIdentitySets.manifestId,
        [...new Set(priorRows.map((row) => row.manifestId))],
      )).all();
    for (const priorSet of priorSets) {
      const allPriorRows = database.select()
        .from(dvdTitleIdentityObservations)
        .where(eq(
          dvdTitleIdentityObservations.manifestId,
          priorSet.manifestId,
        )).all();
      assertPersistedDvdTitleIdentitySet(
        priorSet,
        allPriorRows,
        header.acceptedEndLbaExclusive,
      );
    }
    const setByManifest = new Map([
      [set.manifestId, set],
      ...priorSets.map((priorSet) => [priorSet.manifestId, priorSet] as const),
    ]);
    const items: DvdTitleIdentityReviewSetItem[] = currentRows.map((row) => {
      const observation = presentDvdTitleIdentityObservation(row, set);
      const bindings = bindingsByIdentity.get(row.titleIdentityId) ?? [];
      return {
        titleIdentityId: row.titleIdentityId,
        presentAtCurrentCheckpoint: true,
        observation,
        reviewContinuity: observation.continuity,
        mappingState: bindings.some((binding) =>
            binding.state === "needs_mapping_review"
          )
          ? "needs_mapping_review"
          : bindings.length > 0
          ? "mapped"
          : "unmapped",
        discSelectionMappings: bindings.map((binding) => ({
          discSelectionId: binding.discSelectionId,
          discSelectionIdentity: dvdTitleIdentityDiscSelectionDigest({
            discSelectionId: binding.discSelectionId,
            mediaItemId: binding.selectionMediaItemId,
            sourceIdentity: deserializeDiscSelectionSourceIdentity({
              kind: binding.selectionKind,
              titleNumber: binding.selectionTitleNumber,
              chapterStart: binding.selectionChapterStart,
              chapterEnd: binding.selectionChapterEnd,
            }),
          }),
          mappingState: binding.state,
        })),
      };
    });
    const latestMissingRows = new Map<
      DvdTitleIdentityId,
      typeof dvdTitleIdentityObservations.$inferSelect
    >();
    for (const row of priorRows) {
      const current = latestMissingRows.get(row.titleIdentityId);
      const rowSet = setByManifest.get(row.manifestId)!;
      const currentSet = current === undefined
        ? undefined
        : setByManifest.get(current.manifestId);
      if (
        current === undefined || currentSet === undefined ||
        rowSet.manifestRevision > currentSet.manifestRevision
      ) {
        latestMissingRows.set(row.titleIdentityId, row);
      }
    }
    for (const row of latestMissingRows.values()) {
      const priorSet = setByManifest.get(row.manifestId);
      if (priorSet === undefined) {
        throw new DomainInvariantError(
          "Title Identity observation is missing its checkpoint set",
        );
      }
      const observation = presentDvdTitleIdentityObservation(row, priorSet);
      const bindings = bindingsByIdentity.get(row.titleIdentityId) ?? [];
      items.push({
        titleIdentityId: row.titleIdentityId,
        presentAtCurrentCheckpoint: false,
        observation,
        reviewContinuity: {
          result: "uncertain",
          policyVersion: DVD_TITLE_IDENTITY_CONTINUITY_VERSION,
          previousObservationId: observation.id,
        },
        mappingState: bindings.length > 0
          ? "needs_mapping_review"
          : "unmapped",
        discSelectionMappings: bindings.map((binding) => ({
          discSelectionId: binding.discSelectionId,
          discSelectionIdentity: dvdTitleIdentityDiscSelectionDigest({
            discSelectionId: binding.discSelectionId,
            mediaItemId: binding.selectionMediaItemId,
            sourceIdentity: deserializeDiscSelectionSourceIdentity({
              kind: binding.selectionKind,
              titleNumber: binding.selectionTitleNumber,
              chapterStart: binding.selectionChapterStart,
              chapterEnd: binding.selectionChapterEnd,
            }),
          }),
          mappingState: "needs_mapping_review" as const,
        })),
      });
    }
    items.sort((left, right) =>
      Number(right.presentAtCurrentCheckpoint) -
        Number(left.presentAtCurrentCheckpoint) ||
      left.observation.displayTitleNumber -
        right.observation.displayTitleNumber ||
      left.titleIdentityId.localeCompare(right.titleIdentityId)
    );
    const checkpoint = {
      manifestId: set.manifestId,
      manifestRevision: set.manifestRevision,
      manifestDigest: set.manifestDigest,
    };
    return {
      originalDiscArchiveId,
      evidenceFormat: DVD_RECOVERY_EVIDENCE_FORMAT,
      checkpoint,
      policyVersion: set.policyVersion,
      reviewSetIdentity: dvdTitleIdentityReviewSetDigest(checkpoint, items),
      items,
      createdAt: set.createdAt,
    };
  }

  function readDvdTitleIdentityReviewSet(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): DvdTitleIdentityReviewSet | null {
    return readDvdTitleIdentityReviewSetDeepAudit(originalDiscArchiveId);
  }

  function readDvdCatalogReviewWorkflowEvidence(
    archives: readonly {
      originalDiscArchiveId: OriginalDiscArchiveId;
      evidenceHeader: DvdArchiveEvidenceHeader | null;
    }[],
  ): ReadonlyMap<OriginalDiscArchiveId, DvdCatalogReviewWorkflowEvidence> {
    const archiveById = new Map(archives.map((archive) => [
      archive.originalDiscArchiveId,
      archive,
    ] as const));
    for (const { originalDiscArchiveId, evidenceHeader } of archives) {
      if (
        evidenceHeader !== null &&
        evidenceHeader.originalDiscArchiveId !== originalDiscArchiveId
      ) {
        throw new DomainInvariantError(
          "Catalog Review workflow evidence header belongs to another archive",
        );
      }
    }
    const uniqueIds = [...archiveById.keys()];
    if (uniqueIds.length > DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT) {
      throw new DomainInvariantError(
        `Catalog Review workflow reads are limited to ${DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT} archives`,
      );
    }
    if (uniqueIds.length === 0) return new Map();

    const catalogReviewRows = database.select({
      id: originalDiscArchives.id,
      outcome: originalDiscArchives.catalogReviewOutcome,
      updatedAt: originalDiscArchives.updatedAt,
    }).from(originalDiscArchives).where(inArray(
      originalDiscArchives.id,
      uniqueIds,
    )).all();
    const catalogReviewByArchiveId = new Map(catalogReviewRows.map((row) => [
      row.id,
      {
        catalogRevision: row.updatedAt.toISOString(),
        outcome: row.outcome,
      },
    ] as const));
    const catalogReview = (id: OriginalDiscArchiveId) => requireRow(
      catalogReviewByArchiveId.get(id),
      "original disc archive",
      id,
    );
    const sourceJobIds = archives.flatMap(({ evidenceHeader }) =>
      evidenceHeader === null ? [] : [evidenceHeader.sourceArchiveJobId]
    );
    const jobs = database.select().from(archiveJobs).where(and(
      inArray(archiveJobs.originalDiscArchiveId, uniqueIds),
      or(
        ...(sourceJobIds.length === 0
          ? []
          : [inArray(archiveJobs.id, sourceJobIds)]),
        and(
          eq(archiveJobs.evidenceFormat, DVD_RECOVERY_EVIDENCE_FORMAT),
          notExists(
            database.select({ id: earlierCatalogWorkflowArchiveJobs.id })
              .from(earlierCatalogWorkflowArchiveJobs).where(and(
                eq(
                  earlierCatalogWorkflowArchiveJobs.originalDiscArchiveId,
                  archiveJobs.originalDiscArchiveId,
                ),
                eq(
                  earlierCatalogWorkflowArchiveJobs.evidenceFormat,
                  DVD_RECOVERY_EVIDENCE_FORMAT,
                ),
                or(
                  lt(
                    earlierCatalogWorkflowArchiveJobs.createdAt,
                    archiveJobs.createdAt,
                  ),
                  and(
                    eq(
                      earlierCatalogWorkflowArchiveJobs.createdAt,
                      archiveJobs.createdAt,
                    ),
                    lt(
                      earlierCatalogWorkflowArchiveJobs.id,
                      archiveJobs.id,
                    ),
                  ),
                ),
              )),
          ),
        ),
      ),
    ))
      .orderBy(asc(archiveJobs.createdAt), asc(archiveJobs.id)).all();
    const jobsByArchiveId = new Map<OriginalDiscArchiveId, typeof jobs>();
    for (const job of jobs) {
      if (job.originalDiscArchiveId === null) continue;
      const grouped = jobsByArchiveId.get(job.originalDiscArchiveId) ?? [];
      grouped.push(job);
      jobsByArchiveId.set(job.originalDiscArchiveId, grouped);
    }
    const workflowJobs = (id: OriginalDiscArchiveId) => {
      const candidates = jobsByArchiveId.get(id) ?? [];
      const header = archiveById.get(id)?.evidenceHeader ?? null;
      const selected = header === null
        ? candidates[0]
        : candidates.find(({ id: jobId }) =>
          jobId === header.sourceArchiveJobId
        );
      return selected === undefined ? [] : [selected];
    };
    if (!hasDvdRecoveryEvidenceSchema) {
      return new Map(uniqueIds.map((id) => [id, {
        catalogReview: catalogReview(id),
        archiveJobs: workflowJobs(id),
        evidenceHeader: archiveById.get(id)?.evidenceHeader ?? null,
        recovery: null,
        titleIdentity: null,
        titleDamage: {
          state: "unavailable",
          currentAssessmentIdentity: null,
          acceptanceRequired: false,
        },
      }]));
    }

    const recoveryRows = database.select({
      recovery: archiveRecoveries,
      work: archiveRecoveryWork,
    }).from(archiveRecoveries).leftJoin(
      archiveRecoveryWork,
      eq(archiveRecoveryWork.archiveRecoveryId, archiveRecoveries.id),
    ).where(inArray(
      archiveRecoveries.originalDiscArchiveId,
      uniqueIds,
    )).all();
    const recoveryByArchiveId = new Map(recoveryRows.map(({ recovery, work }) => [
      recovery.originalDiscArchiveId,
      { ...recovery, work },
    ] as const));
    const markedIds = uniqueIds.filter((id) =>
      dvdRecoveryEvidenceFormatForArchive(
        archiveById.get(id)?.evidenceHeader ?? null,
        workflowJobs(id),
      ) !== null
    );
    if (markedIds.length === 0) {
      return new Map(uniqueIds.map((id) => [id, {
        catalogReview: catalogReview(id),
        archiveJobs: workflowJobs(id),
        evidenceHeader: archiveById.get(id)?.evidenceHeader ?? null,
        recovery: recoveryByArchiveId.get(id) ?? null,
        titleIdentity: null,
        titleDamage: {
          state: "unavailable",
          currentAssessmentIdentity: null,
          acceptanceRequired: false,
        },
      }]));
    }

    const currentManifestIds = archives.flatMap(({ evidenceHeader }) =>
      evidenceHeader === null ? [] : [evidenceHeader.currentManifestId]
    );
    const currentSetRows = currentManifestIds.length === 0
      ? []
      : database.select().from(dvdTitleIdentitySets).where(inArray(
        dvdTitleIdentitySets.manifestId,
        currentManifestIds,
      )).all();
    const currentSetByArchiveId = new Map(currentSetRows.map((set) => [
      set.originalDiscArchiveId,
      set,
    ] as const));
    const currentIdentityRows = currentManifestIds.length === 0
      ? []
      : database.select({
        observationId: dvdTitleIdentityObservations.id,
        manifestId: dvdTitleIdentityObservations.manifestId,
        titleIdentityId: dvdTitleIdentityObservations.titleIdentityId,
      }).from(dvdTitleIdentityObservations).where(inArray(
        dvdTitleIdentityObservations.manifestId,
        currentManifestIds,
      )).limit(MAX_DVD_TITLES * markedIds.length + 1).all();
    const currentIdentityCountByManifestId = new Map<string, number>();
    for (const { manifestId } of currentIdentityRows) {
      currentIdentityCountByManifestId.set(
        manifestId,
        (currentIdentityCountByManifestId.get(manifestId) ?? 0) + 1,
      );
    }
    if (
      currentIdentityRows.length > MAX_DVD_TITLES * markedIds.length ||
      [...currentIdentityCountByManifestId.values()].some((value) =>
        value > MAX_DVD_TITLES
      )
    ) {
      throw new DomainInvariantError(
        `Title Identity observations exceed the ${MAX_DVD_TITLES}-title checkpoint limit`,
      );
    }
    const bindingRows = database.select({
      originalDiscArchiveId: dvdTitleIdentities.originalDiscArchiveId,
      titleIdentityId: dvdTitleIdentitySelectionBindings.titleIdentityId,
      discSelectionId: dvdTitleIdentitySelectionBindings.discSelectionId,
      selectionOriginalDiscArchiveId:
        discSelections.originalDiscArchiveId,
      selectionMediaItemId: discSelections.mediaItemId,
      selectionKind: discSelections.kind,
      selectionTitleNumber: discSelections.titleNumber,
      selectionChapterStart: discSelections.chapterStart,
      selectionChapterEnd: discSelections.chapterEnd,
      lastObservationId:
        dvdTitleIdentitySelectionBindings.lastObservationId,
      lastObservationTitleIdentityId:
        dvdTitleIdentityObservations.titleIdentityId,
      lastObservationOriginalDiscArchiveId:
        dvdTitleIdentitySets.originalDiscArchiveId,
      lastObservationManifestRevision:
        dvdTitleIdentitySets.manifestRevision,
      state: dvdTitleIdentitySelectionBindings.state,
    }).from(dvdTitleIdentitySelectionBindings).innerJoin(
      dvdTitleIdentities,
      eq(
        dvdTitleIdentities.id,
        dvdTitleIdentitySelectionBindings.titleIdentityId,
      ),
    ).innerJoin(
      discSelections,
      eq(
        discSelections.id,
        dvdTitleIdentitySelectionBindings.discSelectionId,
      ),
    ).innerJoin(
      dvdTitleIdentityObservations,
      eq(
        dvdTitleIdentityObservations.id,
        dvdTitleIdentitySelectionBindings.lastObservationId,
      ),
    ).innerJoin(
      dvdTitleIdentitySets,
      eq(
        dvdTitleIdentitySets.manifestId,
        dvdTitleIdentityObservations.manifestId,
      ),
    ).where(and(
      inArray(dvdTitleIdentities.originalDiscArchiveId, markedIds),
      eq(discSelections.isCatalogActive, true),
    )).orderBy(
      asc(dvdTitleIdentitySelectionBindings.titleIdentityId),
      asc(dvdTitleIdentitySelectionBindings.discSelectionId),
    ).limit(MAX_DVD_TITLES * markedIds.length + 1).all();
    const bindingCountByArchiveId = new Map<OriginalDiscArchiveId, number>();
    for (const { originalDiscArchiveId } of bindingRows) {
      bindingCountByArchiveId.set(
        originalDiscArchiveId,
        (bindingCountByArchiveId.get(originalDiscArchiveId) ?? 0) + 1,
      );
    }
    if (
      bindingRows.length > MAX_DVD_TITLES * markedIds.length ||
      [...bindingCountByArchiveId.values()].some((value) =>
        value > MAX_DVD_TITLES
      )
    ) {
      throw new DomainInvariantError(
        `New-format DVD archives cannot exceed ${MAX_DVD_TITLES} active Disc Selections`,
      );
    }
    const currentIdentityIds = new Set(currentIdentityRows.map(
      ({ titleIdentityId }) => titleIdentityId,
    ));
    const currentObservationIds = new Set(currentIdentityRows.map(
      ({ observationId }) => observationId,
    ));
    const relevantObservationIds = [...new Set([
      ...currentObservationIds,
      ...bindingRows.map(({ lastObservationId }) => lastObservationId),
    ])];
    const latestObservationRows = relevantObservationIds.flatMap(
      (_id, offset) => {
        if (offset % 400 !== 0) return [];
        return database.select({
          observation: dvdTitleIdentityObservations,
          set: dvdTitleIdentitySets,
          identityOriginalDiscArchiveId:
            dvdTitleIdentities.originalDiscArchiveId,
          manifestOriginalDiscArchiveId:
            dvdArchiveEvidenceManifests.originalDiscArchiveId,
          manifestRevision: dvdArchiveEvidenceManifests.revision,
          manifestDigest: dvdArchiveEvidenceManifests.manifestDigest,
        }).from(dvdTitleIdentityObservations).innerJoin(
          dvdTitleIdentitySets,
          eq(
            dvdTitleIdentitySets.manifestId,
            dvdTitleIdentityObservations.manifestId,
          ),
        ).innerJoin(
          dvdTitleIdentities,
          eq(
            dvdTitleIdentities.id,
            dvdTitleIdentityObservations.titleIdentityId,
          ),
        ).innerJoin(
          dvdArchiveEvidenceManifests,
          eq(
            dvdArchiveEvidenceManifests.id,
            dvdTitleIdentitySets.manifestId,
          ),
        ).where(inArray(
          dvdTitleIdentityObservations.id,
          relevantObservationIds.slice(offset, offset + 400),
        )).all();
      },
    ).filter(({ observation }) =>
      currentObservationIds.has(observation.id) ||
      !currentIdentityIds.has(observation.titleIdentityId)
    );
    const referencedPreviousObservationIds = [...new Set(
      latestObservationRows.flatMap(({ observation }) =>
        observation.previousObservationId === null
          ? []
          : [observation.previousObservationId]
      ),
    )];
    const referencedPreviousObservationRows =
      referencedPreviousObservationIds.flatMap((_id, offset) => {
        if (offset % 400 !== 0) return [];
        return database.select({
          observation: dvdTitleIdentityObservations,
          set: dvdTitleIdentitySets,
          identityOriginalDiscArchiveId:
            dvdTitleIdentities.originalDiscArchiveId,
          manifestOriginalDiscArchiveId:
            dvdArchiveEvidenceManifests.originalDiscArchiveId,
          manifestRevision: dvdArchiveEvidenceManifests.revision,
          manifestDigest: dvdArchiveEvidenceManifests.manifestDigest,
        }).from(dvdTitleIdentityObservations).innerJoin(
          dvdTitleIdentitySets,
          eq(
            dvdTitleIdentitySets.manifestId,
            dvdTitleIdentityObservations.manifestId,
          ),
        ).innerJoin(
          dvdTitleIdentities,
          eq(
            dvdTitleIdentities.id,
            dvdTitleIdentityObservations.titleIdentityId,
          ),
        ).innerJoin(
          dvdArchiveEvidenceManifests,
          eq(
            dvdArchiveEvidenceManifests.id,
            dvdTitleIdentitySets.manifestId,
          ),
        ).where(inArray(
          dvdTitleIdentityObservations.id,
          referencedPreviousObservationIds.slice(offset, offset + 400),
        )).all();
      });
    const previousObservationRows = referencedPreviousObservationRows;
    const bindingsByIdentity = new Map<
      DvdTitleIdentityId,
      typeof bindingRows
    >();
    for (const binding of bindingRows) {
      const grouped = bindingsByIdentity.get(binding.titleIdentityId) ?? [];
      grouped.push(binding);
      bindingsByIdentity.set(binding.titleIdentityId, grouped);
    }

    type WorkflowObservationRow = (typeof latestObservationRows)[number];
    function validateWorkflowObservation(
      row: WorkflowObservationRow,
      header: DvdArchiveEvidenceHeader,
    ) {
      if (
        row.set.policyVersion !== DVD_TITLE_IDENTITY_CONTINUITY_VERSION ||
        row.observation.continuityPolicyVersion !== row.set.policyVersion
      ) {
        throw new DomainInvariantError(
          "Title Identity observation policy does not match its checkpoint set",
        );
      }
      if (
        row.observation.manifestId !== row.set.manifestId ||
        row.identityOriginalDiscArchiveId !== row.set.originalDiscArchiveId
      ) {
        throw new DomainInvariantError(
          "Title Identity observation does not belong to its checkpoint set",
        );
      }
      if (
        row.manifestOriginalDiscArchiveId !==
          row.set.originalDiscArchiveId ||
        row.manifestRevision !== row.set.manifestRevision ||
        row.manifestDigest !== row.set.manifestDigest
      ) {
        throw new DomainInvariantError(
          "Title Identity checkpoint set does not match its evidence manifest",
        );
      }
      const normalized = normalizeDvdTitleIdentityObservation({
        displayTitleNumber: row.observation.displayTitleNumber,
        navigation: row.observation.navigation,
        selectedPath: row.observation.selectedPath,
        angleNumber: row.observation.angleNumber,
        angleCount: row.observation.angleCount,
        chapterStart: row.observation.chapterStart,
        chapterEnd: row.observation.chapterEnd,
        chapterCount: row.observation.chapterCount,
        sourceExtents: row.observation.sourceExtents,
      }, header.acceptedEndLbaExclusive);
      if (
        dvdTitleIdentityContentDigest(normalized) !==
          row.observation.contentDigest
      ) {
        throw new DomainInvariantError(
          "Title Identity observation content digest does not match its evidence",
        );
      }
      return { ...normalized, contentDigest: row.observation.contentDigest };
    }

    const titleIdentityByArchiveId = new Map<
      OriginalDiscArchiveId,
      DvdCatalogReviewWorkflowEvidence["titleIdentity"]
    >();
    for (const id of markedIds) {
      const header = archiveById.get(id)?.evidenceHeader;
      if (header === null || header === undefined) continue;
      const currentSet = currentSetByArchiveId.get(id);
      if (currentSet === undefined) continue;
      if (
        currentSet.manifestId !== header.currentManifestId ||
        currentSet.manifestRevision !== header.currentManifestRevision ||
        currentSet.manifestDigest !== header.currentManifestDigest
      ) {
        throw new DomainInvariantError(
          "Title Identity checkpoint set does not match the current checkpoint",
        );
      }
      const latestRows = latestObservationRows.filter(({ set }) =>
        set.originalDiscArchiveId === id
      );
      const currentRows = latestRows.filter(({ set }) =>
        set.manifestId === currentSet.manifestId
      ).sort((left, right) =>
        left.observation.displayTitleNumber -
          right.observation.displayTitleNumber ||
        left.observation.id.localeCompare(right.observation.id)
      );
      const normalizedCurrent = currentRows.map((row) =>
        validateWorkflowObservation(row, header)
      );
      if (
        dvdTitleIdentityObservationSetDigest(normalizedCurrent) !==
          currentSet.observationSetDigest
      ) {
        throw new DomainInvariantError(
          "Title Identity observation-set digest does not match its evidence",
        );
      }
      const previousRows = previousObservationRows.filter(({ set }) =>
        set.originalDiscArchiveId === id
      ).sort((left, right) =>
        right.set.manifestRevision - left.set.manifestRevision ||
        left.observation.id.localeCompare(right.observation.id)
      );
      const previousById = new Map(previousRows.map((row) => [
        row.observation.id,
        row,
      ] as const));
      for (const row of currentRows) {
        if (row.observation.previousObservationId === null) continue;
        const previous = previousById.get(
          row.observation.previousObservationId,
        );
        if (previous === undefined) {
          throw new DomainInvariantError(
            "Title Identity continuity claim does not match its evidence",
          );
        }
        validateWorkflowObservation(previous, header);
        if (
          previous.observation.titleIdentityId !==
            row.observation.titleIdentityId ||
          previous.set.originalDiscArchiveId !== id ||
          previous.set.manifestRevision >= currentSet.manifestRevision
        ) {
          throw new DomainInvariantError(
            "Title Identity continuity predecessor does not belong to the same identity",
          );
        }
      }
      const latestByIdentity = new Map(latestRows.map((row) => [
        row.observation.titleIdentityId,
        row,
      ] as const));
      for (const binding of bindingRows.filter(({ originalDiscArchiveId }) =>
        originalDiscArchiveId === id
      )) {
        if (
          binding.selectionOriginalDiscArchiveId !== id ||
          binding.lastObservationTitleIdentityId !==
            binding.titleIdentityId ||
          binding.lastObservationOriginalDiscArchiveId !== id ||
          binding.lastObservationManifestRevision >
            currentSet.manifestRevision ||
          latestByIdentity.get(binding.titleIdentityId)?.observation.id !==
            binding.lastObservationId
        ) {
          throw new DomainInvariantError(
            "Title Identity selection binding does not match its archive evidence",
          );
        }
      }
      const items: DvdTitleIdentityReviewSetItem[] = latestRows.map((row) => {
        validateWorkflowObservation(row, header);
        const presentAtCurrentCheckpoint =
          row.set.manifestId === currentSet.manifestId;
        const observation = presentDvdTitleIdentityObservation(
          row.observation,
          row.set,
        );
        const bindings = bindingsByIdentity.get(
          row.observation.titleIdentityId,
        ) ?? [];
        return {
          titleIdentityId: row.observation.titleIdentityId,
          presentAtCurrentCheckpoint,
          observation,
          reviewContinuity: presentAtCurrentCheckpoint
            ? observation.continuity
            : {
              result: "uncertain" as const,
              policyVersion: DVD_TITLE_IDENTITY_CONTINUITY_VERSION,
              previousObservationId: observation.id,
            },
          mappingState: presentAtCurrentCheckpoint
            ? bindings.some(({ state }) => state === "needs_mapping_review")
              ? "needs_mapping_review"
              : bindings.length > 0
              ? "mapped"
              : "unmapped"
            : bindings.length > 0
            ? "needs_mapping_review"
            : "unmapped",
          discSelectionMappings: bindings.map((binding) => ({
            discSelectionId: binding.discSelectionId,
            discSelectionIdentity: dvdTitleIdentityDiscSelectionDigest({
              discSelectionId: binding.discSelectionId,
              mediaItemId: binding.selectionMediaItemId,
              sourceIdentity: deserializeDiscSelectionSourceIdentity({
                kind: binding.selectionKind,
                titleNumber: binding.selectionTitleNumber,
                chapterStart: binding.selectionChapterStart,
                chapterEnd: binding.selectionChapterEnd,
              }),
            }),
            mappingState: presentAtCurrentCheckpoint
              ? binding.state
              : "needs_mapping_review" as const,
          })),
        };
      });
      items.sort((left, right) =>
        Number(right.presentAtCurrentCheckpoint) -
          Number(left.presentAtCurrentCheckpoint) ||
        left.observation.displayTitleNumber -
          right.observation.displayTitleNumber ||
        left.titleIdentityId.localeCompare(right.titleIdentityId)
      );
      const checkpoint = {
        manifestId: currentSet.manifestId,
        manifestRevision: currentSet.manifestRevision,
        manifestDigest: currentSet.manifestDigest,
      };
      const mappingItems = dvdTitleIdentityCatalogMappingItems(items);
      titleIdentityByArchiveId.set(id, {
        catalogMappingProjectionId:
          dvdTitleIdentityCatalogMappingProjectionDigest(
            checkpoint,
            mappingItems,
          ),
        currentMappingStates: mappingItems.map(({ mappingState }) =>
          mappingState
        ),
        currentDefaultAngleTitleCount: items.filter((item) =>
          item.presentAtCurrentCheckpoint &&
          item.observation.angleNumber === 1
        ).length,
      });
    }

    const structuralCheckpoints = markedIds.flatMap((id) => {
      const header = archiveById.get(id)?.evidenceHeader;
      return header === null || header === undefined
        ? []
        : [{ originalDiscArchiveId: id, manifestId: header.currentManifestId }];
    });
    const structuralSequenceRows = structuralCheckpoints.length === 0
      ? []
      : sqlite.prepare(`
        WITH current_checkpoints (
          original_disc_archive_id,
          manifest_id
        ) AS (
          VALUES ${structuralCheckpoints.map(() => "(?, ?)").join(", ")}
        )
        SELECT
          current_checkpoints.original_disc_archive_id AS originalDiscArchiveId,
          (
            SELECT attempt.sequence
            FROM dvd_structural_check_attempts AS attempt
            WHERE attempt.original_disc_archive_id =
                current_checkpoints.original_disc_archive_id
              AND attempt.manifest_id = current_checkpoints.manifest_id
              AND attempt.outcome = 'completed'
            ORDER BY attempt.sequence DESC
            LIMIT 1
          ) AS sequence
        FROM current_checkpoints
      `).all(...structuralCheckpoints.flatMap((checkpoint) => [
        checkpoint.originalDiscArchiveId,
        checkpoint.manifestId,
      ])) as Array<{
        originalDiscArchiveId: OriginalDiscArchiveId;
        sequence: number | null;
      }>;
    const structuralSequences = structuralSequenceRows.flatMap(({ sequence }) =>
      sequence === null ? [] : [sequence]
    );
    const structuralRows = structuralSequences.length === 0
      ? []
      : database.select({
        attempt: dvdStructuralCheckAttempts,
        assessment: dvdStructuralAssessments,
      }).from(dvdStructuralCheckAttempts).innerJoin(
        dvdStructuralAssessments,
        eq(
          dvdStructuralAssessments.id,
          dvdStructuralCheckAttempts.assessmentId,
        ),
      ).where(inArray(
        dvdStructuralCheckAttempts.sequence,
        structuralSequences,
      )).all();
    const currentStructuralByArchiveId = new Map<
      OriginalDiscArchiveId,
      DvdStructuralAssessmentRecord
    >();
    for (const { attempt, assessment } of structuralRows) {
      const header = archiveById.get(
        attempt.originalDiscArchiveId,
      )?.evidenceHeader;
      const validatedAttempt = toDvdStructuralCheckAttempt(attempt);
      const validatedAssessment = toDvdStructuralAssessment(assessment);
      if (
        validatedAttempt.outcome !== "completed" ||
        validatedAttempt.assessmentIdentity !== validatedAssessment.id ||
        validatedAssessment.checkpoint.originalDiscArchiveId !==
          attempt.originalDiscArchiveId
      ) {
        throw new DomainInvariantError(
          "Latest DVD structural assessment is inconsistent",
        );
      }
      if (
        header !== null && header !== undefined &&
        validatedAssessment.checkpoint.manifestId ===
          header.currentManifestId &&
        validatedAssessment.checkpoint.manifestRevision ===
          header.currentManifestRevision &&
        validatedAssessment.checkpoint.manifestDigest ===
          header.currentManifestDigest &&
        validatedAssessment.checkpoint.acceptedEndLbaExclusive ===
          header.acceptedEndLbaExclusive
      ) {
        currentStructuralByArchiveId.set(
          attempt.originalDiscArchiveId,
          validatedAssessment,
        );
      }
    }
    const damageSequenceRows = sqlite.prepare(`
      WITH archive_ids (original_disc_archive_id) AS (
        VALUES ${markedIds.map(() => "(?)").join(", ")}
      )
      SELECT
        archive_ids.original_disc_archive_id AS originalDiscArchiveId,
        (
          SELECT attempt.sequence
          FROM dvd_title_damage_assessment_attempts AS attempt
          WHERE attempt.original_disc_archive_id =
              archive_ids.original_disc_archive_id
          ORDER BY attempt.sequence DESC
          LIMIT 1
        ) AS sequence
      FROM archive_ids
    `).all(...markedIds) as Array<{
      originalDiscArchiveId: OriginalDiscArchiveId;
      sequence: number | null;
    }>;
    const damageSequences = damageSequenceRows.flatMap(({ sequence }) =>
      sequence === null ? [] : [sequence]
    );
    const damageRows = damageSequences.length === 0
      ? []
      : database.select({
        attempt: dvdTitleDamageAssessmentAttempts,
        assessment: dvdTitleDamageAssessments,
      }).from(dvdTitleDamageAssessmentAttempts).innerJoin(
        dvdTitleDamageAssessments,
        eq(
          dvdTitleDamageAssessments.id,
          dvdTitleDamageAssessmentAttempts.assessmentId,
        ),
      ).where(inArray(
        dvdTitleDamageAssessmentAttempts.sequence,
        damageSequences,
      )).all();
    const latestDamageArchiveIds = new Set(damageRows.map(({ attempt }) =>
      attempt.originalDiscArchiveId
    ));
    const potentiallyCurrentDamageRows = damageRows.filter(({
      attempt,
      assessment,
    }) => {
      const header = archiveById.get(
        attempt.originalDiscArchiveId,
      )?.evidenceHeader;
      const titleIdentity = titleIdentityByArchiveId.get(
        attempt.originalDiscArchiveId,
      );
      const structural = currentStructuralByArchiveId.get(
        attempt.originalDiscArchiveId,
      );
      return header !== null && header !== undefined &&
        titleIdentity !== null && titleIdentity !== undefined &&
        structural !== undefined &&
        assessment.originalDiscArchiveId === attempt.originalDiscArchiveId &&
        assessment.manifestId === header.currentManifestId &&
        assessment.manifestRevision === header.currentManifestRevision &&
        assessment.manifestDigest === header.currentManifestDigest &&
        assessment.acceptedEndLbaExclusive ===
          header.acceptedEndLbaExclusive &&
        assessment.catalogMappingProjectionId !== null &&
        assessment.catalogMappingProjectionId ===
          titleIdentity.catalogMappingProjectionId &&
        assessment.structuralAssessmentIdentity === structural.id;
    });
    const damageManifestIds = [...new Set(potentiallyCurrentDamageRows.map(
      ({ assessment }) => assessment.manifestId,
    ))];
    const damageStructuralAssessmentIds = [...new Set(
      potentiallyCurrentDamageRows.map(
        ({ assessment }) => assessment.structuralAssessmentIdentity,
      ),
    )];
    const damageManifests = damageManifestIds.length === 0
      ? []
      : database.select().from(dvdArchiveEvidenceManifests).where(inArray(
        dvdArchiveEvidenceManifests.id,
        damageManifestIds,
      )).all();
    const damageStructuralAssessments =
      damageStructuralAssessmentIds.length === 0
        ? []
        : database.select().from(dvdStructuralAssessments).where(inArray(
          dvdStructuralAssessments.id,
          damageStructuralAssessmentIds,
        )).all();
    const damageManifestIdSet = new Set(damageManifestIds);
    const damageObservationRows = latestObservationRows.filter(({
      observation,
    }) => damageManifestIdSet.has(observation.manifestId)).map(({
      observation,
      identityOriginalDiscArchiveId,
    }) => ({
      observation,
      titleIdentityOriginalDiscArchiveId: identityOriginalDiscArchiveId,
    }));
    const damageObservationCountByManifestId = new Map<string, number>();
    for (const { observation } of damageObservationRows) {
      damageObservationCountByManifestId.set(
        observation.manifestId,
        (damageObservationCountByManifestId.get(observation.manifestId) ?? 0) +
          1,
      );
    }
    if ([...damageObservationCountByManifestId.values()].some((count) =>
      count > MAX_DVD_TITLES
    )) {
      throw new DomainInvariantError(
        `Title Damage observations exceed the ${MAX_DVD_TITLES}-title checkpoint limit`,
      );
    }
    const damageManifestById = new Map(damageManifests.map((manifest) => [
      manifest.id,
      manifest,
    ] as const));
    const damageStructuralAssessmentById = new Map(
      damageStructuralAssessments.map((assessment) => [
        assessment.id,
        assessment,
      ] as const),
    );
    const damageObservationsByManifestId = new Map<
      string,
      Array<typeof dvdTitleIdentityObservations.$inferSelect>
    >();
    const damageTitleIdentityArchiveIds = new Map<
      string,
      OriginalDiscArchiveId
    >();
    for (
      const {
        observation,
        titleIdentityOriginalDiscArchiveId,
      } of damageObservationRows
    ) {
      const observations = damageObservationsByManifestId.get(
        observation.manifestId,
      ) ?? [];
      observations.push(observation);
      damageObservationsByManifestId.set(observation.manifestId, observations);
      damageTitleIdentityArchiveIds.set(
        observation.titleIdentityId,
        titleIdentityOriginalDiscArchiveId,
      );
    }
    const latestDamageByArchiveId = new Map<
      OriginalDiscArchiveId,
      {
        record: DvdTitleDamageAssessmentRecord;
        catalogMappingProjectionId: string | null;
      }
    >();
    for (const { attempt, assessment } of potentiallyCurrentDamageRows) {
      if (!latestDamageByArchiveId.has(attempt.originalDiscArchiveId)) {
        latestDamageByArchiveId.set(
          attempt.originalDiscArchiveId,
          {
            record: toDvdTitleDamageAssessment(assessment, {
              manifest: damageManifestById.get(assessment.manifestId),
              structuralAssessment: damageStructuralAssessmentById.get(
                assessment.structuralAssessmentIdentity,
              ),
              observations: damageObservationsByManifestId.get(
                assessment.manifestId,
              ) ?? [],
              titleIdentityArchiveIds: damageTitleIdentityArchiveIds,
            }),
            catalogMappingProjectionId:
              assessment.catalogMappingProjectionId,
          },
        );
      }
    }

    const titleDamageByArchiveId = new Map<
      OriginalDiscArchiveId,
      DvdCatalogReviewWorkflowEvidence["titleDamage"]
    >();
    for (const id of markedIds) {
      const header = archiveById.get(id)?.evidenceHeader ?? null;
      const titleIdentity = titleIdentityByArchiveId.get(id) ?? null;
      const structural = currentStructuralByArchiveId.get(id);
      const latestDamage = latestDamageByArchiveId.get(id);
      const isCurrent = header !== null && titleIdentity !== null &&
        structural !== undefined && latestDamage !== undefined &&
        latestDamage.record.checkpoint.manifestId ===
          header.currentManifestId &&
        latestDamage.record.checkpoint.manifestRevision ===
          header.currentManifestRevision &&
        latestDamage.record.checkpoint.manifestDigest ===
          header.currentManifestDigest &&
        latestDamage.record.checkpoint.acceptedEndLbaExclusive ===
          header.acceptedEndLbaExclusive &&
        latestDamage.catalogMappingProjectionId !== null &&
        latestDamage.catalogMappingProjectionId ===
          titleIdentity.catalogMappingProjectionId &&
        latestDamage.record.sourceContinuity !== null &&
        latestDamage.record.structuralAssessmentIdentity === structural.id;
      titleDamageByArchiveId.set(id, {
        state: header === null
          ? "unavailable"
          : isCurrent
          ? "current"
          : !latestDamageArchiveIds.has(id)
          ? "pending"
          : "outdated",
        currentAssessmentIdentity: isCurrent ? latestDamage.record.id : null,
        acceptanceRequired: isCurrent && latestDamage !== undefined
          ? dvdTitleDamageAssessmentRequiresAcceptance(latestDamage.record)
          : false,
      });
    }

    return new Map(uniqueIds.map((id) => [id, {
      catalogReview: catalogReview(id),
      archiveJobs: workflowJobs(id),
      evidenceHeader: archiveById.get(id)?.evidenceHeader ?? null,
      recovery: recoveryByArchiveId.get(id) ?? null,
      titleIdentity: titleIdentityByArchiveId.get(id) ?? null,
      titleDamage: titleDamageByArchiveId.get(id) ?? {
        state: "unavailable",
        currentAssessmentIdentity: null,
        acceptanceRequired: false,
      },
    }]));
  }

  function projectDvdRecoveryCheckpoint(
    input: Omit<DvdRecoveryCheckpointProjection, "claim"> & {
      claim?: ClaimedArchiveRecoveryWork;
    },
  ): DvdArchiveEvidenceHeader {
    const { claim, manifest, recoveryRead } = input;
    assertDvdArchiveRecoveryReadEvidenceDigest(
      recoveryRead,
      recoveryRead.evidenceDigest,
    );
    assertDvdArchiveEvidenceManifestDigests(manifest);
    if (
      manifest.originalDiscArchiveId !== recoveryRead.originalDiscArchiveId ||
      (claim !== undefined &&
        claim.originalDiscArchiveId !== manifest.originalDiscArchiveId) ||
      manifest.revision !== recoveryRead.fromManifestRevision + 1 ||
      manifest.previousManifestId !== recoveryRead.fromManifestId ||
      manifest.recoveryReadId !== recoveryRead.id ||
      manifest.recoveryReadEvidenceDigest !== recoveryRead.evidenceDigest ||
      (claim !== undefined && (
        claim.verificationId === null ||
        recoveryRead.verificationId !== claim.verificationId ||
        (recoveryRead.discConfirmationId ?? null) !==
          (claim.discConfirmationId ?? null)
      ))
    ) {
      throw new DomainInvariantError(
        "DVD recovery checkpoint does not match its recovery read",
      );
    }

    const archiveId = manifest.originalDiscArchiveId as OriginalDiscArchiveId;
    database.transaction((transaction) => {
      if (claim !== undefined) {
        requireCurrentArchiveRecoveryClaim(transaction, claim);
      }
      if (recoveryRead.verificationId !== undefined) {
        const verification = transaction.select().from(dvdDiscVerifications)
          .where(eq(
            dvdDiscVerifications.id,
            recoveryRead.verificationId as DvdDiscVerificationId,
          )).get();
        const confirmation = recoveryRead.discConfirmationId === null ||
            recoveryRead.discConfirmationId === undefined
          ? undefined
          : transaction.select().from(dvdDiscConfirmations).where(eq(
              dvdDiscConfirmations.id,
              recoveryRead.discConfirmationId as DvdDiscConfirmationId,
            )).get();
        if (
          verification === undefined ||
          verification.originalDiscArchiveId !== archiveId ||
          (recoveryRead.discConfirmationId != null &&
            confirmation === undefined) ||
          (claim !== undefined &&
            confirmation !== undefined &&
            confirmation.expiredAt !== null) ||
          (confirmation === undefined
            ? verification.status !== "completed" ||
              verification.outcome !== "match"
            : !dvdDiscConfirmationMatchesVerification(
                toDvdDiscVerification(verification),
                toDvdDiscConfirmation(confirmation),
              ))
        ) {
          throw new DomainInvariantError(
            "DVD recovery read source authorization is invalid",
          );
        }
      }
      const current = requireRow(
        transaction
          .select({
            header: dvdArchiveEvidenceHeaders,
            manifest: dvdArchiveEvidenceManifests,
            archive: originalDiscArchives,
            recovery: archiveRecoveries,
          })
          .from(dvdArchiveEvidenceHeaders)
          .innerJoin(
            dvdArchiveEvidenceManifests,
            eq(
              dvdArchiveEvidenceManifests.id,
              dvdArchiveEvidenceHeaders.currentManifestId,
            ),
          )
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            ),
          )
          .innerJoin(
            archiveRecoveries,
            eq(
              archiveRecoveries.originalDiscArchiveId,
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            ),
          )
          .where(eq(
            dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            archiveId,
          ))
          .get(),
        "DVD Archive Evidence",
        archiveId,
      );

      if (
        current.header.currentManifestRevision === manifest.revision &&
        current.header.currentManifestId === manifest.id &&
        current.header.currentManifestDigest === manifest.manifestDigest
      ) {
        return;
      }
      const staleReasons = [
        current.header.currentManifestId !== recoveryRead.fromManifestId
          ? "manifest identity" : null,
        current.header.currentManifestRevision !==
            recoveryRead.fromManifestRevision
          ? "manifest revision" : null,
        current.header.currentManifestDigest !== manifest.previousManifestDigest
          ? "previous digest" : null,
        current.manifest.manifestDigest !== current.header.currentManifestDigest
          ? "projected digest" : null,
        current.manifest.originalDiscArchiveId !== archiveId
          ? "archive identity" : null,
        !(["eligible", "running", "stopping", "faulted"] as const).includes(
            current.recovery.status as
              | "eligible"
              | "running"
              | "stopping"
              | "faulted",
          ) && !(current.recovery.status === "paused" &&
            current.recovery.pauseReason === "storage_fault")
          ? "recovery status" : null,
        current.archive.integrityEvidenceRevision !==
            current.header.currentManifestRevision
          ? "integrity revision" : null,
      ].filter((reason) => reason !== null);
      if (staleReasons.length > 0) {
        throw new DomainInvariantError(
          `DVD recovery checkpoint base revision is stale or inconsistent (${staleReasons.join(", ")})`,
        );
      }
      if (
        manifest.evidenceFormat !== current.manifest.evidenceFormat ||
        manifest.imageFingerprint !== current.manifest.imageFingerprint ||
        manifest.sectorSizeBytes !== current.manifest.sectorSizeBytes ||
        manifest.acceptedEndLbaExclusive !==
          current.manifest.acceptedEndLbaExclusive ||
        manifest.boundaryPolicyVersion !==
          current.manifest.boundaryPolicyVersion ||
        manifest.boundaryReportedSizeBytes !==
          current.manifest.boundaryReportedSizeBytes ||
        manifest.boundaryPublishedSizeBytes !==
          current.manifest.boundaryPublishedSizeBytes ||
        manifest.boundaryEvidenceDigest !==
          current.manifest.boundaryEvidenceDigest
      ) {
        throw new DomainInvariantError(
          "DVD recovery checkpoint changed immutable archive evidence",
        );
      }
      assertDvdEvidenceRangeTransition(
        current.manifest.unrecoveredSourceRanges,
        manifest.unrecoveredSourceRanges,
        recoveryRead,
      );
      const sourceRange = current.manifest.unrecoveredSourceRanges.find(
        (range) =>
          recoveryRead.startLba >= range.startLba &&
          recoveryRead.startLba < range.startLba + range.sectorCount,
      );
      if (sourceRange === undefined) {
        throw new DomainInvariantError(
          "DVD recovery read has no predecessor source range",
        );
      }
      const meaningfulTransition = recoveryRead.outcome === "recovered" ||
        sourceRange.classification === "skipped_untested";

      const timestamp = new Date(Math.max(
        now().getTime(),
        current.header.updatedAt.getTime() + 1,
        current.archive.updatedAt.getTime() + 1,
        current.recovery.updatedAt.getTime() + 1,
      ));
      transaction.insert(dvdArchiveRecoveryReads).values({
        ...recoveryRead,
        originalDiscArchiveId: archiveId,
        fromClassification: sourceRange.classification,
        meaningfulTransition,
        verificationId: recoveryRead.verificationId as
          | DvdDiscVerificationId
          | undefined,
        discConfirmationId: recoveryRead.discConfirmationId as
          | DvdDiscConfirmationId
          | null
          | undefined,
        createdAt: timestamp,
      }).run();
      transaction.insert(dvdArchiveEvidenceManifests).values({
        ...manifest,
        originalDiscArchiveId: archiveId,
        createdAt: timestamp,
      }).run();
      transaction.update(dvdArchiveEvidenceHeaders).set({
        currentManifestId: manifest.id,
        currentManifestRevision: manifest.revision,
        currentManifestDigest: manifest.manifestDigest,
        updatedAt: timestamp,
      }).where(and(
        eq(dvdArchiveEvidenceHeaders.originalDiscArchiveId, archiveId),
        eq(
          dvdArchiveEvidenceHeaders.currentManifestId,
          recoveryRead.fromManifestId,
        ),
        eq(
          dvdArchiveEvidenceHeaders.currentManifestRevision,
          recoveryRead.fromManifestRevision,
        ),
      )).run();

      const badSectorRanges = manifest.unrecoveredSourceRanges.map(
        ({ startLba, sectorCount }) => ({ startLba, sectorCount }),
      );
      const badSectorCount = badSectorRanges.reduce(
        (count, range) => count + range.sectorCount,
        0,
      );
      transaction.update(originalDiscArchives).set({
        integrity: badSectorCount === 0 ? "clean_read" : "incomplete_read",
        integrityEvidenceRevision: manifest.revision,
        integrityPolicyVersion: "dvd-recovery-evidence-v1",
        badSectorCount,
        badAreaCount: badSectorRanges.length,
        badSectorRanges,
        updatedAt: timestamp,
      }).where(eq(originalDiscArchives.id, archiveId)).run();
      const recoveryWork = transaction.select().from(archiveRecoveryWork)
        .where(and(
          eq(archiveRecoveryWork.archiveRecoveryId, current.recovery.id),
          eq(archiveRecoveryWork.attemptId, current.recovery.attemptId),
          eq(archiveRecoveryWork.status, "claimed"),
          ...(claim === undefined
            ? []
            : [eq(archiveRecoveryWork.claimToken, claim.claimToken)]),
        )).get();
      const recoveryStatus = current.recovery.status === "stopping" ||
          current.recovery.status === "faulted" ||
          current.recovery.status === "paused"
        ? current.recovery.status
        : recoveryWork !== undefined
          ? "running"
          : badSectorCount === 0
            ? "completed"
            : "eligible";
      transaction.update(archiveRecoveries).set({
        status: recoveryStatus,
        updatedAt: timestamp,
      }).where(eq(
        archiveRecoveries.originalDiscArchiveId,
        archiveId,
      )).run();
      if (recoveryStatus === "completed" && current.recovery.status !== "completed") {
        recordArchiveRecoveryOutcome(
          transaction,
          current.recovery,
          "recovery_completed",
        );
      }
      if (recoveryWork !== undefined) {
        const observationFields = [
          recoveryWork.passObservationCount,
          recoveryWork.passPositiveIntervalCount,
        ];
        const hasAnyObservationState = observationFields.some((value) =>
          value !== null
        ) || recoveryWork.passMinimumIntervalMs !== null ||
          recoveryWork.passMaximumIntervalMs !== null ||
          recoveryWork.passLastObservedAt !== null;
        const hasPassObservationBoundary =
          recoveryWork.passStartedAt !== null &&
          recoveryWork.passStartedManifestRevision !== null;
        if (hasAnyObservationState && !hasPassObservationBoundary) {
          throw new DomainInvariantError(
            "Archive Recovery pass observation state has no checkpoint boundary",
          );
        }
        let observationUpdate = {};
        if (hasPassObservationBoundary) {
          const observationCount = recoveryWork.passObservationCount;
          const positiveIntervalCount =
            recoveryWork.passPositiveIntervalCount;
          if (
            observationCount === null || positiveIntervalCount === null ||
            recoveryRead.fromManifestRevision <
              recoveryWork.passStartedManifestRevision!
          ) {
            throw new DomainInvariantError(
              "Archive Recovery pass observation state is inconsistent",
            );
          }
          const intervalMs = timestamp.getTime() -
            (recoveryWork.passLastObservedAt ?? recoveryWork.passStartedAt!)
              .getTime();
          const positiveInterval = intervalMs > 0;
          observationUpdate = {
            passObservationCount: observationCount + 1,
            passPositiveIntervalCount:
              positiveIntervalCount + (positiveInterval ? 1 : 0),
            passMinimumIntervalMs: positiveInterval
              ? Math.min(
                recoveryWork.passMinimumIntervalMs ?? intervalMs,
                intervalMs,
              )
              : recoveryWork.passMinimumIntervalMs,
            passMaximumIntervalMs: positiveInterval
              ? Math.max(
                recoveryWork.passMaximumIntervalMs ?? intervalMs,
                intervalMs,
              )
              : recoveryWork.passMaximumIntervalMs,
            passLastObservedAt: timestamp,
          };
        }
        transaction.update(archiveRecoveryWork).set({
          passCursorLba: recoveryRead.startLba,
          passRecoveredSectorCount: recoveryRead.outcome === "recovered"
            ? sql`${archiveRecoveryWork.passRecoveredSectorCount} + 1`
            : archiveRecoveryWork.passRecoveredSectorCount,
          ...observationUpdate,
          updatedAt: timestamp,
        }).where(and(
          eq(
            archiveRecoveryWork.archiveRecoveryId,
            recoveryWork.archiveRecoveryId,
          ),
          eq(archiveRecoveryWork.status, "claimed"),
          ...(claim === undefined
            ? []
            : [eq(archiveRecoveryWork.claimToken, claim.claimToken)]),
        )).run();
      }
    }, { behavior: "immediate" });

    const projected = access.catalog.findDvdArchiveEvidenceHeader(archiveId);
    if (projected === null) {
      throw new RecordNotFoundError("DVD Archive Evidence", archiveId);
    }
    return projected;
  }

  function titleDamageStructuralFindings(
    assessment: DvdStructuralAssessmentRecord,
  ) {
    const dvdNavigation = assessment.findings.find((finding) =>
      finding.checkKind === "dvd_navigation"
    );
    const titleEnumeration = assessment.findings.find((finding) =>
      finding.checkKind === "title_enumeration"
    );
    if (dvdNavigation === undefined || titleEnumeration === undefined) {
      throw new DomainInvariantError(
        "Title Damage Assessment is missing structural dependencies",
      );
    }
    return {
      dvdNavigation: dvdNavigation.outcome,
      titleEnumeration: titleEnumeration.outcome,
    };
  }

  function readDvdTitleDamageSourceContinuity(
    originalDiscArchiveId: OriginalDiscArchiveId,
    manifestRevision: number,
  ): DvdTitleDamageSourceContinuityInput {
    const recoveredRanges = sqlite.prepare(`
      with ordered_reads as (
        select
          disc_confirmation_id,
          start_lba,
          start_lba - row_number() over (
            partition by disc_confirmation_id
            order by start_lba
          ) as range_key
        from dvd_archive_recovery_reads
        where original_disc_archive_id = ?
          and from_manifest_revision < ?
          and outcome = 'recovered'
          and disc_confirmation_id is not null
      )
      select
        disc_confirmation_id,
        min(start_lba) as start_lba,
        count(*) as sector_count
      from ordered_reads
      group by disc_confirmation_id, range_key
      order by disc_confirmation_id, start_lba
    `).all(
      originalDiscArchiveId,
      manifestRevision,
    ) as unknown as Array<{
      disc_confirmation_id: DvdDiscConfirmationId;
      start_lba: number;
      sector_count: number;
    }>;
    const confirmationIds = [...new Set(recoveredRanges.map((range) =>
      range.disc_confirmation_id
    ))];
    const confirmations = confirmationIds.length === 0
      ? []
      : database.select().from(dvdDiscConfirmations).where(inArray(
          dvdDiscConfirmations.id,
          confirmationIds,
        )).all().map(toDvdDiscConfirmation);
    const confirmationById = new Map(confirmations.map((confirmation) => [
      confirmation.id,
      confirmation,
    ]));
    const byConfirmation = new Map<
      DvdDiscConfirmationId,
      {
        confirmation: DvdDiscConfirmation;
        recoveredSourceRanges: Array<{
          startLba: number;
          sectorCount: number;
        }>;
      }
    >();
    for (const range of recoveredRanges) {
      const confirmation = confirmationById.get(range.disc_confirmation_id);
      if (
        confirmation === undefined ||
        confirmation.originalDiscArchiveId !== originalDiscArchiveId ||
        confirmation.checkpointRevision >= manifestRevision
      ) {
        throw new DomainInvariantError(
          "Title Damage Assessment source-continuity provenance is inconsistent",
        );
      }
      const current = byConfirmation.get(confirmation.id) ?? {
        confirmation,
        recoveredSourceRanges: [],
      };
      current.recoveredSourceRanges.push({
        startLba: Number(range.start_lba),
        sectorCount: Number(range.sector_count),
      });
      byConfirmation.set(confirmation.id, current);
    }
    return {
      policyVersion: DVD_TITLE_DAMAGE_SOURCE_CONTINUITY_POLICY_VERSION,
      provenance: [...byConfirmation.values()].map((entry) => ({
        discConfirmationId: entry.confirmation.id,
        archiveRecoveryId: entry.confirmation.archiveRecoveryId,
        archiveRecoveryAttemptId:
          entry.confirmation.archiveRecoveryAttemptId,
        verificationId: entry.confirmation.verificationId,
        verificationOutcome: entry.confirmation.verificationOutcome,
        verificationResultDigest:
          entry.confirmation.verificationResultDigest,
        confirmationCheckpoint: {
          manifestRevision: entry.confirmation.checkpointRevision,
          manifestDigest: entry.confirmation.checkpointDigest,
        },
        recoveredSourceRanges: entry.recoveredSourceRanges,
      })),
    };
  }

  type DvdTitleDamageDecodeEvidence = {
    manifest: typeof dvdArchiveEvidenceManifests.$inferSelect | undefined;
    structuralAssessment:
      | typeof dvdStructuralAssessments.$inferSelect
      | undefined;
    observations: readonly (typeof dvdTitleIdentityObservations.$inferSelect)[];
    titleIdentityArchiveIds: ReadonlyMap<string, OriginalDiscArchiveId>;
  };

  function titleDamageMappings(
    originalDiscArchiveId: OriginalDiscArchiveId,
    manifestId: string,
    mappings: readonly PersistedDvdTitleDamageMappingInput[],
    evidence?: Pick<
      DvdTitleDamageDecodeEvidence,
      "observations" | "titleIdentityArchiveIds"
    >,
  ): DvdTitleDamageMappingInput[] {
    const observations = evidence?.observations ?? database.select()
      .from(dvdTitleIdentityObservations)
      .where(eq(dvdTitleIdentityObservations.manifestId, manifestId))
      .all();
    const observationById = new Map(observations.map((observation) => [
      observation.id,
      observation,
    ]));
    if (
      observations.length !== mappings.length ||
      new Set(mappings.map((mapping) =>
        mapping.titleIdentityObservationId
      )).size !== mappings.length
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment must cover every current Title Identity observation once",
      );
    }
    return mappings.map((mapping) => {
      const observation = observationById.get(
        mapping.titleIdentityObservationId,
      );
      if (observation === undefined) {
        throw new DomainInvariantError(
          "Title Damage Assessment references a different checkpoint observation",
        );
      }
      const identityArchiveId = evidence === undefined
        ? database.select({
          originalDiscArchiveId: dvdTitleIdentities.originalDiscArchiveId,
        }).from(dvdTitleIdentities).where(eq(
          dvdTitleIdentities.id,
          observation.titleIdentityId,
        )).get()?.originalDiscArchiveId
        : evidence.titleIdentityArchiveIds.get(observation.titleIdentityId);
      if (identityArchiveId !== originalDiscArchiveId) {
        throw new DomainInvariantError(
          "Title Damage Assessment references another archive's Title Identity",
        );
      }
      return {
        titleIdentityId: observation.titleIdentityId,
        titleIdentityObservationId: observation.id,
        displayTitleNumber: observation.displayTitleNumber,
        selection: {
          selectedPath: observation.selectedPath,
          angleNumber: observation.angleNumber,
          chapterStart: observation.chapterStart,
          chapterEnd: observation.chapterEnd,
        },
        sourceReferences: mapping.sourceReferences,
        mappingCoverage: mapping.mappingCoverage,
        timingEvidence: mapping.timingEvidence ?? null,
      };
    });
  }

  function createValidatedDvdTitleDamageAssessment(
    input: Parameters<typeof createDvdTitleDamageAssessment>[0],
    sourceExtentsByObservation: ReadonlyMap<
      string,
      readonly { startLba: number; sectorCount: number }[]
    >,
  ) {
    const assessment = createDvdTitleDamageAssessment(input);
    for (const item of assessment.items) {
      if (
        canonicalPublicationJson(item.uniqueSourceRanges) !==
          canonicalPublicationJson(
            sourceExtentsByObservation.get(
              item.titleIdentityObservationId,
            ),
          )
      ) {
        throw new DomainInvariantError(
          "Title Damage Assessment source map does not match its Title Identity observation",
        );
      }
    }
    return assessment;
  }

  function toDvdTitleDamageAssessment(
    row: typeof dvdTitleDamageAssessments.$inferSelect,
    evidence?: DvdTitleDamageDecodeEvidence,
  ): DvdTitleDamageAssessmentRecord {
    const manifest = evidence?.manifest ??
      (evidence === undefined
        ? database.select().from(dvdArchiveEvidenceManifests)
          .where(eq(dvdArchiveEvidenceManifests.id, row.manifestId)).get()
        : undefined);
    if (
      manifest === undefined ||
      manifest.originalDiscArchiveId !== row.originalDiscArchiveId ||
      manifest.revision !== row.manifestRevision ||
      manifest.manifestDigest !== row.manifestDigest ||
      manifest.acceptedEndLbaExclusive !== row.acceptedEndLbaExclusive ||
      manifest.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment checkpoint evidence is inconsistent",
      );
    }
    const structuralAssessment = evidence === undefined
      ? findDvdStructuralAssessment(row.structuralAssessmentIdentity)
      : evidence.structuralAssessment === undefined
      ? null
      : toDvdStructuralAssessment(evidence.structuralAssessment);
    if (structuralAssessment === null) {
      throw new DomainInvariantError(
        "DVD structural check attempt has no assessment",
      );
    }
    if (
      structuralAssessment.checkpoint.originalDiscArchiveId !==
        row.originalDiscArchiveId ||
      structuralAssessment.checkpoint.manifestId !== row.manifestId ||
      structuralAssessment.checkpoint.manifestRevision !==
        row.manifestRevision ||
      structuralAssessment.checkpoint.manifestDigest !== row.manifestDigest ||
      structuralAssessment.checkpoint.acceptedEndLbaExclusive !==
        row.acceptedEndLbaExclusive
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment structural evidence is inconsistent",
      );
    }
    const observations = evidence?.observations ?? database.select()
      .from(dvdTitleIdentityObservations).where(eq(
        dvdTitleIdentityObservations.manifestId,
        row.manifestId,
      )).all();
    const sourceExtentsById = new Map(observations.map((observation) => [
      observation.id,
      observation.sourceExtents,
    ]));
    const assessment = createValidatedDvdTitleDamageAssessment({
      checkpoint: {
        originalDiscArchiveId: row.originalDiscArchiveId,
        manifestId: row.manifestId,
        manifestRevision: row.manifestRevision,
        manifestDigest: row.manifestDigest,
        acceptedEndLbaExclusive: row.acceptedEndLbaExclusive,
      },
      titleIdentityReviewSetIdentity: row.titleIdentityReviewSetIdentity,
      catalogMappingProjectionId: row.catalogMappingProjectionId,
      structuralAssessmentIdentity: row.structuralAssessmentIdentity,
      structuralFindings: titleDamageStructuralFindings(structuralAssessment),
      unrecoveredSourceRanges: manifest.unrecoveredSourceRanges,
      sourceContinuity: row.sourceContinuity,
      titles: titleDamageMappings(
        row.originalDiscArchiveId,
        row.manifestId,
        row.titleMappings,
        evidence,
      ),
    }, sourceExtentsById);
    if (
      assessment.id !== row.id ||
      assessment.policyVersion !== row.policyVersion
    ) {
      throw new DomainInvariantError(
        "Persisted Title Damage Assessment is invalid",
      );
    }
    return { ...assessment, createdAt: row.createdAt };
  }

  function inspectDvdTitleDamageAssessment(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ) {
    const archive = access.catalog.listOriginalDiscArchives({
      ids: [originalDiscArchiveId],
    })[0];
    if (archive === undefined) {
      throw new RecordNotFoundError(
        "Original Disc Archive",
        originalDiscArchiveId,
      );
    }
    const header = database.select().from(dvdArchiveEvidenceHeaders).where(eq(
      dvdArchiveEvidenceHeaders.originalDiscArchiveId,
      originalDiscArchiveId,
    )).get();
    const unavailable = (code: string, message: string) => ({
      schemaVersion: 1 as const,
      policyVersion: DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION,
      originalDiscArchiveId,
      state: "unavailable" as const,
      checkpoint: null,
      currentAssessmentIdentity: null,
      assessment: null,
      unavailableReasons: [{ code, message }],
    });
    const marked = dvdRecoveryEvidenceFormatForArchive(
      header,
      access.archiveJobs.listForArchive(originalDiscArchiveId),
    );
    if (marked === null) {
      return unavailable(
        "UNSUPPORTED_EVIDENCE_FORMAT",
        "Title Damage Assessment requires dvd-recovery-evidence-v1.",
      );
    }
    if (header === undefined) {
      return unavailable(
        "CONSISTENCY_FAULT",
        "The committed DVD checkpoint is unavailable.",
      );
    }
    const checkpoint = {
      originalDiscArchiveId,
      manifestId: header.currentManifestId,
      manifestRevision: header.currentManifestRevision,
      manifestDigest: header.currentManifestDigest,
      acceptedEndLbaExclusive: header.acceptedEndLbaExclusive,
    };
    const reviewSet = readDvdTitleIdentityReviewSet(originalDiscArchiveId);
    const catalogMappingProjectionId = reviewSet === null
      ? null
      : dvdTitleIdentityCatalogMappingProjectionDigest(
        reviewSet.checkpoint,
        reviewSet.items,
      );
    const structural = inspectDvdStructuralAssessment(originalDiscArchiveId);
    const latestRow = database.select({ assessment: dvdTitleDamageAssessments })
      .from(dvdTitleDamageAssessmentAttempts)
      .innerJoin(
        dvdTitleDamageAssessments,
        eq(
          dvdTitleDamageAssessments.id,
          dvdTitleDamageAssessmentAttempts.assessmentId,
        ),
      )
      .where(eq(
        dvdTitleDamageAssessmentAttempts.originalDiscArchiveId,
        originalDiscArchiveId,
      ))
      .orderBy(desc(dvdTitleDamageAssessmentAttempts.sequence)).limit(1)
      .get()?.assessment;
    const currentRow = latestRow !== undefined &&
        reviewSet !== null &&
        structural.state === "current" &&
        structural.currentAssessmentIdentity !== null &&
        latestRow.originalDiscArchiveId === originalDiscArchiveId &&
        latestRow.manifestId === header.currentManifestId &&
        latestRow.manifestRevision === header.currentManifestRevision &&
        latestRow.manifestDigest === header.currentManifestDigest &&
        latestRow.acceptedEndLbaExclusive ===
          header.acceptedEndLbaExclusive &&
        latestRow.titleIdentityReviewSetIdentity ===
          reviewSet.reviewSetIdentity &&
        latestRow.catalogMappingProjectionId !== null &&
        latestRow.catalogMappingProjectionId === catalogMappingProjectionId &&
        latestRow.sourceContinuity !== null &&
        latestRow.titleMappings.every((mapping) =>
          mapping.timingEvidence != null
        ) &&
        latestRow.structuralAssessmentIdentity ===
          structural.currentAssessmentIdentity
      ? latestRow
      : undefined;
    const assessmentRow = currentRow ?? latestRow;
    const reasons = [] as Array<{ code: string; message: string }>;
    if (reviewSet === null) {
      reasons.push({
        code: "TITLE_IDENTITY_NOT_RECORDED",
        message: "Title Identity observations are not recorded for this checkpoint.",
      });
    }
    if (structural.state !== "current") {
      reasons.push({
        code: structural.state === "outdated"
          ? "STRUCTURAL_ASSESSMENT_OUTDATED"
          : "STRUCTURAL_ASSESSMENT_PENDING",
        message: structural.state === "outdated"
          ? "The latest Structural Assessment belongs to an older checkpoint."
          : "A current Structural Assessment is not recorded.",
      });
    }
    if (currentRow === undefined) {
      reasons.push({
        code: assessmentRow === undefined
          ? "TITLE_DAMAGE_ASSESSMENT_NOT_RECORDED"
          : "TITLE_DAMAGE_ASSESSMENT_OUTDATED",
        message: assessmentRow === undefined
          ? "A Title Damage Assessment is not recorded for this checkpoint."
          : "The latest Title Damage Assessment does not match current evidence.",
      });
    }
    return {
      schemaVersion: 1 as const,
      policyVersion: DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION,
      originalDiscArchiveId,
      state: currentRow !== undefined
        ? "current" as const
        : assessmentRow !== undefined
        ? "outdated" as const
        : "pending" as const,
      checkpoint,
      currentAssessmentIdentity: currentRow?.id ?? null,
      assessment: assessmentRow === undefined
        ? null
        : toDvdTitleDamageAssessment(assessmentRow),
      unavailableReasons: reasons,
    };
  }

  function recordDvdTitleDamageAssessment(
    input: RecordDvdTitleDamageAssessmentInput,
  ): DvdTitleDamageAssessmentRecord {
    if (input.titles.some((title) => title.timingEvidence == null)) {
      throw new DomainInvariantError(
        "Current Title Damage Assessment requires timing evidence",
      );
    }
    const archive = access.catalog.listOriginalDiscArchives({
      ids: [input.originalDiscArchiveId],
    })[0];
    if (archive === undefined) {
      throw new RecordNotFoundError(
        "Original Disc Archive",
        input.originalDiscArchiveId,
      );
    }
    const catalogRevision = archive.updatedAt;
    const header = access.catalog.findDvdArchiveEvidenceHeader(
      input.originalDiscArchiveId,
    );
    if (
      header === null ||
      header.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment requires a committed recovery checkpoint",
      );
    }
    if (
      header.currentManifestId !== input.checkpoint.manifestId ||
      header.currentManifestRevision !== input.checkpoint.manifestRevision ||
      header.currentManifestDigest !== input.checkpoint.manifestDigest
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment does not match the current committed checkpoint",
      );
    }
    const reviewSet = readDvdTitleIdentityReviewSet(
      input.originalDiscArchiveId,
    );
    if (
      reviewSet === null ||
      reviewSet.reviewSetIdentity !==
        input.titleIdentityReviewSetIdentity ||
      reviewSet.checkpoint.manifestId !== input.checkpoint.manifestId ||
      reviewSet.checkpoint.manifestRevision !==
        input.checkpoint.manifestRevision ||
      reviewSet.checkpoint.manifestDigest !== input.checkpoint.manifestDigest
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment does not match the current Title Identity review set",
      );
    }
    const catalogMappingProjectionId =
      dvdTitleIdentityCatalogMappingProjectionDigest(
        reviewSet.checkpoint,
        reviewSet.items,
      );
    const structural = findDvdStructuralAssessment(
      input.structuralAssessmentIdentity,
    );
    if (
      structural.checkpoint.originalDiscArchiveId !==
        input.originalDiscArchiveId ||
      structural.checkpoint.manifestId !== input.checkpoint.manifestId ||
      structural.checkpoint.manifestRevision !==
        input.checkpoint.manifestRevision ||
      structural.checkpoint.manifestDigest !== input.checkpoint.manifestDigest
    ) {
      throw new DomainInvariantError(
        "Title Damage Assessment does not match its Structural Assessment",
      );
    }
    const sourceExtentsByObservation = new Map(
      reviewSet.items.filter((item) => item.presentAtCurrentCheckpoint)
        .map((item) => [
          item.observation.id,
          item.observation.sourceExtents,
        ]),
    );
    const sourceContinuity = readDvdTitleDamageSourceContinuity(
      input.originalDiscArchiveId,
      header.currentManifestRevision,
    );
    const assessment = createValidatedDvdTitleDamageAssessment({
      checkpoint: {
        originalDiscArchiveId: input.originalDiscArchiveId,
        manifestId: header.currentManifestId,
        manifestRevision: header.currentManifestRevision,
        manifestDigest: header.currentManifestDigest,
        acceptedEndLbaExclusive: header.acceptedEndLbaExclusive,
      },
      titleIdentityReviewSetIdentity: reviewSet.reviewSetIdentity,
      catalogMappingProjectionId,
      structuralAssessmentIdentity: structural.id,
      structuralFindings: titleDamageStructuralFindings(
        structural,
      ),
      unrecoveredSourceRanges: header.unrecoveredSourceRanges,
      sourceContinuity,
      titles: titleDamageMappings(
        input.originalDiscArchiveId,
        header.currentManifestId,
        input.titles,
      ),
    }, sourceExtentsByObservation);
    const createdAt = now();
    database.transaction((transaction) => {
      const currentArchive = transaction.select({
        updatedAt: originalDiscArchives.updatedAt,
      }).from(originalDiscArchives).where(eq(
        originalDiscArchives.id,
        input.originalDiscArchiveId,
      )).get();
      const currentHeader = transaction.select()
        .from(dvdArchiveEvidenceHeaders)
        .where(eq(
          dvdArchiveEvidenceHeaders.originalDiscArchiveId,
          input.originalDiscArchiveId,
        )).get();
      const currentStructural = transaction.select({
        assessmentIdentity: dvdStructuralCheckAttempts.assessmentId,
      }).from(dvdStructuralCheckAttempts).where(and(
        eq(
          dvdStructuralCheckAttempts.originalDiscArchiveId,
          input.originalDiscArchiveId,
        ),
        eq(
          dvdStructuralCheckAttempts.manifestId,
          input.checkpoint.manifestId,
        ),
        eq(
          dvdStructuralCheckAttempts.manifestRevision,
          input.checkpoint.manifestRevision,
        ),
        eq(
          dvdStructuralCheckAttempts.manifestDigest,
          input.checkpoint.manifestDigest,
        ),
        eq(dvdStructuralCheckAttempts.outcome, "completed"),
      )).orderBy(desc(dvdStructuralCheckAttempts.sequence)).limit(1).get();
      const currentTitleSet = transaction.select({
        manifestId: dvdTitleIdentitySets.manifestId,
      }).from(dvdTitleIdentitySets).where(and(
        eq(
          dvdTitleIdentitySets.originalDiscArchiveId,
          input.originalDiscArchiveId,
        ),
        eq(
          dvdTitleIdentitySets.manifestId,
          input.checkpoint.manifestId,
        ),
      )).get();
      if (
        currentArchive?.updatedAt.getTime() !== catalogRevision.getTime() ||
        currentHeader?.currentManifestId !== input.checkpoint.manifestId ||
        currentHeader.currentManifestRevision !==
          input.checkpoint.manifestRevision ||
        currentHeader.currentManifestDigest !==
          input.checkpoint.manifestDigest ||
        currentStructural?.assessmentIdentity !==
            input.structuralAssessmentIdentity ||
        currentTitleSet === undefined
      ) {
        throw new DomainInvariantError(
          "Title Damage Assessment evidence changed before persistence",
        );
      }
      transaction.insert(dvdTitleDamageAssessments).values({
        id: assessment.id,
        originalDiscArchiveId: input.originalDiscArchiveId,
        manifestId: input.checkpoint.manifestId,
        manifestRevision: input.checkpoint.manifestRevision,
        manifestDigest: input.checkpoint.manifestDigest,
        acceptedEndLbaExclusive: header.acceptedEndLbaExclusive,
        titleIdentityReviewSetIdentity:
          input.titleIdentityReviewSetIdentity,
        catalogMappingProjectionId,
        structuralAssessmentIdentity:
          input.structuralAssessmentIdentity,
        policyVersion: assessment.policyVersion,
        titleMappings: input.titles,
        sourceContinuity,
        createdAt,
      }).onConflictDoNothing({
        target: dvdTitleDamageAssessments.id,
      }).run();
      transaction.insert(dvdTitleDamageAssessmentAttempts).values({
        originalDiscArchiveId: input.originalDiscArchiveId,
        assessmentId: assessment.id,
        createdAt,
      }).run();
    }, { behavior: "immediate" });
    const persisted = database.select().from(dvdTitleDamageAssessments)
      .where(eq(dvdTitleDamageAssessments.id, assessment.id)).get();
    if (persisted === undefined) {
      throw new DomainInvariantError(
        "Title Damage Assessment was not recorded",
      );
    }
    return toDvdTitleDamageAssessment(persisted);
  }

  function listActiveEncodeJobsForDiscSelections(
    requestedDiscSelectionIds: readonly DiscSelectionId[],
    statuses: readonly EncodeJobStatus[],
    resultLimit?: number,
  ) {
    const discSelectionIds = [...new Set(requestedDiscSelectionIds)];
    if (discSelectionIds.length > ACTIVE_ENCODE_JOB_DISC_SELECTION_LIMIT) {
      throw new DomainInvariantError(
        `Active Encode Job lookup is limited to ${ACTIVE_ENCODE_JOB_DISC_SELECTION_LIMIT} Disc Selections`,
      );
    }
    if (discSelectionIds.length === 0) return [];
    const query = database.select().from(encodeJobs)
      .where(and(
        inArray(encodeJobs.discSelectionId, discSelectionIds),
        inArray(encodeJobs.status, statuses),
      ))
      .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id));
    return resultLimit === undefined
      ? query.all()
      : query.limit(resultLimit).all();
  }

  const access: LegacySidecarDataAccess = {
    damagePreviews: createDamagePreviewAccess(sqlite, now),
    encodeOutputInspectionReceipts: createEncodeOutputInspectionReceiptAccess(sqlite, now),
    async withDvdCheckpoint(id, ownership, task, commit) {
      const read = await withDvdCheckpointRead(id, ownership, readCommittedDvdCheckpoint, task, (checkpoint, prepared) => commit ? commit(checkpoint, prepared) : prepared);
      return read?.result ?? null;
    },
    async readDvdCheckpoint(id, ownership) {
      const read = await withDvdCheckpointRead(
        id,
        ownership,
        readCommittedDvdCheckpoint,
        async () => undefined,
        () => undefined,
      );
      return read?.checkpoint ?? null;
    },
    async readDvdInitialCheckpoint(id, ownership) {
      const read = await withDvdCheckpointRead(
        id,
        ownership,
        readCommittedDvdInitialCheckpoint,
        async (evidence) => evidence,
        (_evidence, prepared) => prepared,
      );
      return read?.result ?? null;
    },
    async withDvdInitialCheckpoint(id, ownership, task) {
      const read = await withDvdCheckpointRead(
        id,
        ownership,
        readCommittedDvdInitialCheckpoint,
        async (evidence, handle) =>
          task({ evidence, assertOwned: handle.assertOwned }),
        (_evidence, prepared) => prepared,
      );
      return read?.result ?? null;
    },
    async withDvdCurrentCheckpoint(id, ownership, task) {
      try {
        const read = await withDvdCheckpointRead(
          id,
          ownership,
          readCommittedDvdCurrentCheckpoint,
          async (checkpoint, handle) =>
            task({ checkpoint, assertOwned: handle.assertOwned }),
          (_checkpoint, prepared) => prepared,
        );
        return read?.result ?? null;
      } catch (error) {
        if (
          error instanceof DomainInvariantError &&
          error.name === "DomainInvariantError"
        ) {
          throw new DvdCheckpointReadFault(
            "DVD_PUBLICATION_CHECKPOINT_CONFLICT",
            { cause: error },
          );
        }
        throw error;
      }
    },
    notifications: createNotificationAccess(database, now),
    dvdRecovery: {
      projectCheckpoint(input) {
        return projectDvdRecoveryCheckpoint(input);
      },
      reconcileCheckpoint(input) {
        return projectDvdRecoveryCheckpoint(input);
      },
    },
    async assessDvdStructure(id, ownership, assess) {
      const read = await withDvdCheckpointRead(
        id,
        ownership,
        readCommittedDvdCheckpoint,
        async (manifest, handle, imagePath) =>
          assess(manifest, handle, imagePath),
        (manifest, prepared, imagePath) => {
          const checkpoint = {
            originalDiscArchiveId: id,
            manifestId: manifest.id,
            manifestRevision: manifest.revision,
            manifestDigest: manifest.manifestDigest,
            acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
          };
          if (prepared.outcome === "failed") {
            return {
              outcome: "failed" as const,
              attempt: recordFailedDvdStructuralAttempt({
                checkpoint,
                reason: prepared.reason,
              }),
            };
          }
          const completed = recordCompletedDvdStructuralAssessment({
            checkpoint: {
              ...checkpoint,
            },
            findings: prepared.findings,
            imagePath,
          });
          return { outcome: "completed" as const, ...completed };
        },
      );
      return read?.result ?? null;
    },
    async assessDvdTitleDamage(id, ownership, assess) {
      const read = await withDvdCheckpointRead(
        id,
        ownership,
        readCommittedDvdCheckpoint,
        async (manifest, handle) => {
          const titleIdentity = readDvdTitleIdentityReviewSet(id);
          const structural = inspectDvdStructuralAssessment(id);
          if (
            titleIdentity === null ||
            titleIdentity.checkpoint.manifestId !== manifest.id ||
            titleIdentity.checkpoint.manifestRevision !== manifest.revision ||
            titleIdentity.checkpoint.manifestDigest !==
              manifest.manifestDigest ||
            structural.state !== "current" ||
            structural.currentAssessmentIdentity === null
          ) {
            throw new DomainInvariantError(
              "Title Damage Assessment requires current title and structural evidence",
            );
          }
          const titles = await assess({
            checkpoint: titleIdentity.checkpoint,
            titleIdentity,
            structuralAssessmentIdentity:
              structural.currentAssessmentIdentity,
          }, handle);
          handle.assertOwned();
          return {
            titleIdentityReviewSetIdentity:
              titleIdentity.reviewSetIdentity,
            structuralAssessmentIdentity:
              structural.currentAssessmentIdentity,
            titles,
          };
        },
        (manifest, prepared) => recordDvdTitleDamageAssessment({
          originalDiscArchiveId: id,
          checkpoint: {
            manifestId: manifest.id,
            manifestRevision: manifest.revision,
            manifestDigest: manifest.manifestDigest,
          },
          ...prepared,
        }),
      );
      return read?.result ?? null;
    },
    dvdStructuralAssessments: {
      recordFailed(input) {
        return recordFailedDvdStructuralAttempt(input);
      },
      inspect: inspectDvdStructuralAssessment,
    },
    dvdTitleDamageAssessments: {
      inspect: inspectDvdTitleDamageAssessment,
    },
    dvdRecoveryStorage: {
      readCurrent: readCurrentDvdRecoveryStoragePreflight,
      record(input) {
        assertDvdRecoveryStoragePreflightInput(input);
        const checkedAt = now();
        database.insert(dvdRecoveryStoragePreflights).values({
          scope: "originals_library",
          ...input,
          checkedAt,
        }).onConflictDoUpdate({
          target: dvdRecoveryStoragePreflights.scope,
          set: { ...input, checkedAt },
        }).run();
        const recorded = readCurrentDvdRecoveryStoragePreflight();
        if (recorded === null) {
          throw new DomainInvariantError(
            "DVD recovery storage preflight was not recorded",
          );
        }
        return recorded;
      },
    },
    archiveRecoveryWork: {
      findEncodeWorkConflict(id) {
        const recovery = findArchiveRecoveryRecord(database, {
          archiveRecoveryId: id,
        });
        if (recovery === null) {
          throw new RecordNotFoundError("Archive Recovery", id);
        }
        const current = encodeWorkConflictCurrent(database, recovery);
        return current.encodeJobs.length === 0 ? null : current;
      },
      findNextStopping() {
        const candidate = database.select({ id: archiveRecoveries.id })
          .from(archiveRecoveries)
          .where(eq(archiveRecoveries.status, "stopping"))
          .orderBy(
            asc(archiveRecoveries.updatedAt),
            asc(archiveRecoveries.id),
          )
          .limit(1)
          .get();
        return candidate === undefined
          ? null
          : findArchiveRecoveryRecord(database, {
              archiveRecoveryId: candidate.id,
            });
      },
      findNextInterrupted(workerId) {
        requireNonEmpty(workerId, "workerId");
        const expiredBefore = new Date(
          now().getTime() - DVD_RECOVERY_PASS_CLAIM_LEASE_MS,
        );
        const candidate = database.select({ id: archiveRecoveries.id })
          .from(archiveRecoveries)
          .innerJoin(
            archiveRecoveryWork,
            eq(archiveRecoveryWork.archiveRecoveryId, archiveRecoveries.id),
          )
          .where(and(
            eq(archiveRecoveries.status, "running"),
            eq(archiveRecoveryWork.status, "claimed"),
            lt(archiveRecoveryWork.claimedAt, expiredBefore),
          ))
          .orderBy(
            asc(archiveRecoveryWork.claimedAt),
            asc(archiveRecoveries.id),
          )
          .limit(1)
          .get();
        return candidate === undefined
          ? null
          : findArchiveRecoveryRecord(database, {
              archiveRecoveryId: candidate.id,
            });
      },
      claimNextVerifiedCandidate(workerId) {
        const claimedBy = requireNonEmpty(workerId, "workerId");
        return database.transaction((transaction) => {
          expireInvalidDvdDiscConfirmations(transaction, claimedBy);
          const timestamp = now();
          const candidate = transaction.select({
            recoveryId: archiveRecoveries.id,
            verificationId: dvdDiscVerifications.id,
            confirmationId: dvdDiscConfirmations.id,
          }).from(archiveRecoveries)
            .innerJoin(
              dvdDiscVerifications,
              eq(
                dvdDiscVerifications.archiveRecoveryId,
                archiveRecoveries.id,
              ),
            )
            .innerJoin(
              dvdArchiveEvidenceHeaders,
              eq(
                dvdArchiveEvidenceHeaders.originalDiscArchiveId,
                archiveRecoveries.originalDiscArchiveId,
              ),
            )
            .leftJoin(
              dvdDiscConfirmations,
              eq(
                dvdDiscConfirmations.verificationId,
                dvdDiscVerifications.id,
              ),
            )
            .where(and(
              eq(archiveRecoveries.status, "eligible"),
              notExists(transaction.select({ id: damagePreviews.id }).from(damagePreviews).where(and(
                eq(damagePreviews.originalDiscArchiveId, archiveRecoveries.originalDiscArchiveId),
                damagePreviewHoldsRecovery,
              ))),
              eq(
                dvdDiscVerifications.archiveRecoveryAttemptId,
                archiveRecoveries.attemptId,
              ),
              eq(dvdDiscVerifications.status, "completed"),
              isNotNull(dvdDiscVerifications.workerExecutionId),
              or(
                eq(dvdDiscVerifications.outcome, "match"),
                and(
                  inArray(
                    dvdDiscVerifications.outcome,
                    ["mismatch", "inconclusive"],
                  ),
                  isNotNull(dvdDiscConfirmations.id),
                  isNull(dvdDiscConfirmations.expiredAt),
                  eq(
                    dvdDiscConfirmations.archiveRecoveryId,
                    archiveRecoveries.id,
                  ),
                  eq(
                    dvdDiscConfirmations.archiveRecoveryAttemptId,
                    archiveRecoveries.attemptId,
                  ),
                  eq(
                    dvdDiscConfirmations.originalDiscArchiveId,
                    archiveRecoveries.originalDiscArchiveId,
                  ),
                  eq(
                    dvdDiscConfirmations.discInspectionId,
                    dvdDiscVerifications.discInspectionId,
                  ),
                  eq(
                    dvdDiscConfirmations.detectedDiscId,
                    dvdDiscVerifications.detectedDiscId,
                  ),
                  eq(
                    dvdDiscConfirmations.mediaGeneration,
                    dvdDiscVerifications.mediaGeneration,
                  ),
                  eq(
                    dvdDiscConfirmations.verificationWorkerExecutionId,
                    claimedBy,
                  ),
                  eq(
                    dvdDiscConfirmations.verificationOutcome,
                    dvdDiscVerifications.outcome,
                  ),
                  eq(
                    dvdDiscConfirmations.checkpointRevision,
                    dvdDiscVerifications.checkpointRevision,
                  ),
                  eq(
                    dvdDiscConfirmations.checkpointDigest,
                    dvdDiscVerifications.checkpointDigest,
                  ),
                ),
              ),
              or(
                and(
                  eq(
                    dvdArchiveEvidenceHeaders.currentManifestRevision,
                    dvdDiscVerifications.checkpointRevision,
                  ),
                  eq(
                    dvdArchiveEvidenceHeaders.currentManifestDigest,
                    dvdDiscVerifications.checkpointDigest,
                  ),
                ),
                and(
                  gt(
                    dvdArchiveEvidenceHeaders.currentManifestRevision,
                    dvdDiscVerifications.checkpointRevision,
                  ),
                  exists(
                    transaction.select({
                      archiveRecoveryId:
                        archiveRecoveryWork.archiveRecoveryId,
                    }).from(archiveRecoveryWork).where(and(
                      eq(
                        archiveRecoveryWork.archiveRecoveryId,
                        archiveRecoveries.id,
                      ),
                      eq(
                        archiveRecoveryWork.attemptId,
                        archiveRecoveries.attemptId,
                      ),
                      eq(archiveRecoveryWork.status, "requested"),
                      eq(
                        archiveRecoveryWork.verificationId,
                        dvdDiscVerifications.id,
                      ),
                      or(
                        and(
                          eq(dvdDiscVerifications.outcome, "match"),
                          isNull(archiveRecoveryWork.discConfirmationId),
                        ),
                        eq(
                          archiveRecoveryWork.discConfirmationId,
                          dvdDiscConfirmations.id,
                        ),
                      ),
                    )),
                  ),
                ),
              ),
              notExists(
                transaction.select({ id: laterDvdDiscVerificationRecords.id })
                  .from(laterDvdDiscVerificationRecords)
                  .where(and(
                    eq(
                      laterDvdDiscVerificationRecords.archiveRecoveryId,
                      archiveRecoveries.id,
                    ),
                    gt(
                      laterDvdDiscVerificationRecords.attemptOrdinal,
                      dvdDiscVerifications.attemptOrdinal,
                    ),
                  )),
              ),
              notExists(
                transaction.select({
                  archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
                }).from(archiveRecoveryWork).where(and(
                  eq(
                    archiveRecoveryWork.archiveRecoveryId,
                    archiveRecoveries.id,
                  ),
                  eq(archiveRecoveryWork.status, "claimed"),
                )),
              ),
              notExists(
                transaction.select({ id: encodeJobs.id })
                  .from(encodeJobs)
                  .innerJoin(
                    discSelections,
                    eq(discSelections.id, encodeJobs.discSelectionId),
                  )
                  .where(and(
                    eq(
                      discSelections.originalDiscArchiveId,
                      archiveRecoveries.originalDiscArchiveId,
                    ),
                    inArray(
                      encodeJobs.status,
                      ACTIVE_ENCODE_WORK_STATUSES,
                    ),
                  )),
              ),
              notExists(
                transaction.select({ id: dvdRecoveryReconciliations.id })
                  .from(dvdRecoveryReconciliations)
                  .where(and(
                    eq(
                      dvdRecoveryReconciliations.archiveRecoveryId,
                      archiveRecoveries.id,
                    ),
                    ne(dvdRecoveryReconciliations.status, "completed"),
                    notExists(
                      transaction.select({
                        id: laterDvdRecoveryReconciliationRecords.id,
                      }).from(laterDvdRecoveryReconciliationRecords).where(and(
                        eq(
                          laterDvdRecoveryReconciliationRecords
                            .archiveRecoveryId,
                          archiveRecoveries.id,
                        ),
                        gt(
                          laterDvdRecoveryReconciliationRecords.attemptOrdinal,
                          dvdRecoveryReconciliations.attemptOrdinal,
                        ),
                      )),
                    ),
                  )),
              ),
            ))
            .orderBy(
              asc(archiveRecoveries.updatedAt),
              asc(archiveRecoveries.id),
            )
            .limit(1)
            .get();
          if (candidate === undefined) return null;
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: candidate.recoveryId,
          });
          const verification = transaction.select().from(dvdDiscVerifications)
            .where(eq(dvdDiscVerifications.id, candidate.verificationId))
            .get();
          const confirmation = candidate.confirmationId === null
            ? undefined
            : transaction.select().from(dvdDiscConfirmations).where(eq(
                dvdDiscConfirmations.id,
                candidate.confirmationId,
              )).get();
          if (recovery === null || verification === undefined) {
            throw new DomainInvariantError(
              "DVD Recovery candidate disappeared during claim",
            );
          }
          requireNoActiveEncodeWork(transaction, recovery);
          requireNoPendingDvdRecoveryReconciliation(
            transaction,
            recovery.id,
          );
          const passStart = archiveRecoveryPassStart(
            transaction,
            recovery,
            timestamp,
          );
          const claimToken = newId<ArchiveRecoveryClaimToken>();
          const claimed = recovery.work === null
            ? transaction.insert(archiveRecoveryWork).values({
              archiveRecoveryId: recovery.id,
              originalDiscArchiveId: recovery.originalDiscArchiveId,
              attemptId: recovery.attemptId,
              status: "claimed",
              verificationId: verification.id,
              discConfirmationId: confirmation?.id ?? null,
              requestedAt: null,
              claimedBy,
              claimToken,
              claimedAt: timestamp,
              ...passStart,
              createdAt: timestamp,
              updatedAt: timestamp,
            }).returning().get()
            : transaction.update(archiveRecoveryWork).set({
              status: "claimed",
              verificationId: verification.id,
              discConfirmationId: confirmation?.id ?? null,
              claimedBy,
              claimToken,
              claimedAt: timestamp,
              ...passStart,
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
              eq(archiveRecoveryWork.attemptId, recovery.attemptId),
              eq(archiveRecoveryWork.status, "requested"),
            )).returning().get();
          if (
            claimed === undefined ||
            claimed.status !== "claimed" ||
            claimed.claimedBy === null ||
            claimed.claimToken === null ||
            claimed.claimedAt === null
          ) {
            throw new DomainInvariantError(
              "DVD Recovery verified candidate could not be claimed",
            );
          }
          const running = transaction.update(archiveRecoveries).set({
            status: "running",
            updatedAt: timestamp,
          }).where(and(
            eq(archiveRecoveries.id, recovery.id),
            eq(archiveRecoveries.attemptId, recovery.attemptId),
            eq(archiveRecoveries.status, "eligible"),
          )).returning({ id: archiveRecoveries.id }).get();
          if (running === undefined) {
            throw new DomainInvariantError(
              "DVD Recovery verified candidate could not start",
            );
          }
          return {
            recovery: requireRow(
              findArchiveRecoveryRecord(transaction, {
                archiveRecoveryId: recovery.id,
              }) ?? undefined,
              "Archive Recovery",
              recovery.id,
            ),
            verification: toDvdDiscVerification(verification),
            confirmation: confirmation === undefined
              ? null
              : toDvdDiscConfirmation(confirmation),
            claim: claimed as ClaimedArchiveRecoveryWork,
          };
        }, { behavior: "immediate" });
      },
      request(id) {
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: id,
          });
          if (recovery === null) {
            throw new RecordNotFoundError("Archive Recovery", id);
          }
          if (recovery.status !== "eligible") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "requested",
            );
          }
          if (recovery.work?.status === "claimed") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery work",
              "claimed",
              "requested",
            );
          }
          if (recovery.work !== null) return recovery.work;
          requireNoActiveEncodeWork(transaction, recovery);
          const timestamp = now();
          return requireRow(
            transaction
              .insert(archiveRecoveryWork)
              .values({
                archiveRecoveryId: recovery.id,
                originalDiscArchiveId: recovery.originalDiscArchiveId,
                attemptId: recovery.attemptId,
                status: "requested",
                verificationId: null,
                requestedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "Archive Recovery work",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      claim(id, workerId) {
        const claimedBy = requireNonEmpty(workerId, "workerId");
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: id,
          });
          if (recovery === null) {
            throw new RecordNotFoundError("Archive Recovery", id);
          }
          if (recovery.status !== "eligible") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "claimed",
            );
          }
          if (recovery.work?.status === "claimed") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery work",
              "claimed",
              "claimed",
            );
          }
          requireNoActiveEncodeWork(transaction, recovery);
          const timestamp = now();
          const claimToken = newId<ArchiveRecoveryClaimToken>();
          const passStart = archiveRecoveryPassStart(
            transaction,
            recovery,
            timestamp,
          );
          const claimed = recovery.work === null
            ? transaction
              .insert(archiveRecoveryWork)
              .values({
                archiveRecoveryId: recovery.id,
                originalDiscArchiveId: recovery.originalDiscArchiveId,
                attemptId: recovery.attemptId,
                status: "claimed",
                verificationId: null,
                requestedAt: null,
                claimedBy,
                claimToken,
                claimedAt: timestamp,
                ...passStart,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get()
            : transaction
              .update(archiveRecoveryWork)
              .set({
                status: "claimed",
                verificationId: null,
                claimedBy,
                claimToken,
                claimedAt: timestamp,
                ...passStart,
                updatedAt: timestamp,
              })
              .where(and(
                eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
                eq(archiveRecoveryWork.status, "requested"),
              ))
              .returning()
              .get();
          if (
            claimed === undefined ||
            claimed.status !== "claimed" ||
            claimed.claimedBy === null ||
            claimed.claimToken === null ||
            claimed.claimedAt === null
          ) {
            throw new DomainInvariantError(
              "Archive Recovery work could not be claimed",
            );
          }
          return claimed as ClaimedArchiveRecoveryWork;
        }, { behavior: "immediate" });
      },
      assertClaim(claim) {
        return requireCurrentArchiveRecoveryClaim(database, claim);
      },
      beginInterruptedTakeover(claim, workerId) {
        const claimedBy = requireNonEmpty(workerId, "workerId");
        const expiredBefore = new Date(
          now().getTime() - DVD_RECOVERY_PASS_CLAIM_LEASE_MS,
        );
        return database.transaction((transaction) => {
          const current = transaction.select().from(archiveRecoveryWork)
            .where(and(
              eq(
                archiveRecoveryWork.archiveRecoveryId,
                claim.archiveRecoveryId,
              ),
              eq(archiveRecoveryWork.attemptId, claim.attemptId),
              eq(archiveRecoveryWork.status, "claimed"),
              eq(archiveRecoveryWork.claimToken, claim.claimToken),
              lt(archiveRecoveryWork.claimedAt, expiredBefore),
              exists(
                transaction.select({ id: archiveRecoveries.id })
                  .from(archiveRecoveries)
                  .where(and(
                    eq(archiveRecoveries.id, claim.archiveRecoveryId),
                    eq(archiveRecoveries.attemptId, claim.attemptId),
                    eq(archiveRecoveries.status, "running"),
                  )),
              ),
            )).get();
          if (current === undefined) return null;
          const timestamp = now();
          const takeover = transaction.update(archiveRecoveryWork).set({
            claimedBy,
            claimToken: newId<ArchiveRecoveryClaimToken>(),
            claimedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(
              archiveRecoveryWork.archiveRecoveryId,
              claim.archiveRecoveryId,
            ),
            eq(archiveRecoveryWork.attemptId, claim.attemptId),
            eq(archiveRecoveryWork.status, "claimed"),
            eq(archiveRecoveryWork.claimToken, claim.claimToken),
            lt(archiveRecoveryWork.claimedAt, expiredBefore),
          )).returning().get();
          if (
            takeover === undefined ||
            takeover.status !== "claimed" ||
            takeover.claimedBy === null ||
            takeover.claimToken === null ||
            takeover.claimedAt === null
          ) return null;
          return takeover as ClaimedArchiveRecoveryWork;
        }, { behavior: "immediate" });
      },
      deferInterruptedTakeover(claim) {
        return database.update(archiveRecoveryWork).set({
          claimedAt: new Date(0),
          updatedAt: now(),
        }).where(and(
          eq(archiveRecoveryWork.archiveRecoveryId, claim.archiveRecoveryId),
          eq(archiveRecoveryWork.attemptId, claim.attemptId),
          eq(archiveRecoveryWork.status, "claimed"),
          eq(archiveRecoveryWork.claimToken, claim.claimToken),
        )).returning({
          archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
        }).get() !== undefined;
      },
      renewClaim(claim) {
        const timestamp = now();
        return database.update(archiveRecoveryWork).set({
          claimedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(
          eq(archiveRecoveryWork.archiveRecoveryId, claim.archiveRecoveryId),
          eq(archiveRecoveryWork.attemptId, claim.attemptId),
          eq(archiveRecoveryWork.status, "claimed"),
          eq(archiveRecoveryWork.claimToken, claim.claimToken),
          exists(
            database.select({ id: archiveRecoveries.id })
              .from(archiveRecoveries)
              .where(and(
                eq(archiveRecoveries.id, claim.archiveRecoveryId),
                eq(archiveRecoveries.attemptId, claim.attemptId),
                eq(archiveRecoveries.status, "running"),
              )),
          ),
        )).returning({
          archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
        }).get() !== undefined;
      },
      admitSourceRead(claim, expectedDevicePath, identity) {
        return database.transaction((transaction) => {
          const recovery = requireCurrentArchiveRecoveryClaim(
            transaction,
            claim,
          );
          const confirmationId = recovery.work?.discConfirmationId ?? null;
          if (confirmationId !== null) {
            expireInvalidDvdDiscConfirmations(
              transaction,
              claim.claimedBy,
              confirmationId,
            );
          }
          if (recovery.status !== "running") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "source_read",
            );
          }
          // Admission and preview submission use the same immediate transaction boundary.
          // A helper may be ready, but cannot read after a planned pause commits.
          if (access.damagePreviews.pendingForRecovery(recovery.originalDiscArchiveId)) throw new ArchiveRecoveryPreviewPauseError();
          requireNoPendingDvdRecoveryReconciliation(
            transaction,
            recovery.id,
          );
          const verificationId = recovery.work?.verificationId;
          const verification = verificationId === null ||
              verificationId === undefined
            ? undefined
            : transaction.select().from(dvdDiscVerifications).where(eq(
                dvdDiscVerifications.id,
                verificationId,
              )).get();
          const confirmation = confirmationId === null
            ? undefined
            : transaction.select().from(dvdDiscConfirmations).where(eq(
                dvdDiscConfirmations.id,
                confirmationId,
              )).get();
          const inspection = verification === undefined
            ? undefined
            : transaction.select().from(discInspections).where(eq(
                discInspections.id,
                verification.discInspectionId,
              )).get();
          const drive = inspection === undefined
            ? undefined
            : transaction.select().from(opticalDrives).where(eq(
                opticalDrives.id,
                inspection.opticalDriveId,
              )).get();
          if (
            verification === undefined ||
            (verification.outcome === "match"
              ? confirmation !== undefined
              : confirmation === undefined ||
                dvdConfirmedRecoveryWriteAuthority(
                    toDvdDiscVerification(verification),
                    toDvdDiscConfirmation(confirmation),
                  ) === null) ||
            !dvdDiscVerificationInsertionIsCurrent(
              verification,
              inspection,
            ) ||
            drive === undefined ||
            !drive.isPresent ||
            !drive.isEnabled ||
            drive.devicePath !== expectedDevicePath
          ) {
            return null;
          }
          if (
            identity.devicePath !== drive.devicePath ||
            !/^\d+$/.test(identity.deviceId) ||
            !/^\d+$/.test(identity.inode)
          ) {
            throw new DomainInvariantError(
              "DVD Recovery source device identity is invalid",
            );
          }
          requireRow(
            transaction.update(archiveRecoveryWork).set({
              admittedDevicePath: identity.devicePath,
              admittedDeviceId: identity.deviceId,
              admittedDeviceInode: identity.inode,
              updatedAt: now(),
            }).where(and(
              eq(
                archiveRecoveryWork.archiveRecoveryId,
                claim.archiveRecoveryId,
              ),
              eq(archiveRecoveryWork.status, "claimed"),
              eq(archiveRecoveryWork.claimToken, claim.claimToken),
            )).returning({
              archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
            }).get(),
            "Archive Recovery work",
            claim.archiveRecoveryId,
          );
          return findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: recovery.id,
          });
        }, { behavior: "immediate" });
      },
      bindVerification(claim, authority) {
        return database.transaction((transaction) => {
          const recovery = requireCurrentArchiveRecoveryClaim(
            transaction,
            claim,
          );
          const verification = transaction.select()
            .from(dvdDiscVerifications)
            .where(eq(dvdDiscVerifications.id, authority.verificationId))
            .get();
          const latestVerification = transaction.select({
            id: dvdDiscVerifications.id,
          }).from(dvdDiscVerifications).where(eq(
            dvdDiscVerifications.archiveRecoveryId,
            recovery.id,
          )).orderBy(desc(dvdDiscVerifications.attemptOrdinal)).limit(1).get();
          const header = transaction.select()
            .from(dvdArchiveEvidenceHeaders)
            .where(eq(
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
              recovery.originalDiscArchiveId,
            ))
            .get();
          if (
            recovery.status !== "eligible" ||
            verification === undefined ||
            latestVerification?.id !== verification.id ||
            verification.status !== "completed" ||
            verification.outcome !== "match" ||
            verification.archiveRecoveryId !== recovery.id ||
            verification.archiveRecoveryAttemptId !== recovery.attemptId ||
            verification.originalDiscArchiveId !==
              recovery.originalDiscArchiveId ||
            verification.id !== authority.verificationId ||
            verification.archiveRecoveryAttemptId !==
              authority.archiveRecoveryAttemptId ||
            verification.discInspectionId !== authority.discInspectionId ||
            verification.detectedDiscId !== authority.detectedDiscId ||
            verification.mediaGeneration !== authority.mediaGeneration ||
            verification.workerExecutionId !==
              authority.verificationWorkerExecutionId ||
            verification.checkpointRevision !==
              authority.checkpointRevision ||
            verification.checkpointDigest !== authority.checkpointDigest ||
            header === undefined ||
            header.currentManifestRevision !== authority.checkpointRevision ||
            header.currentManifestDigest !== authority.checkpointDigest
          ) {
            throw new StaleJobAttemptError(
              "Archive Recovery verification",
              claim.archiveRecoveryId,
            );
          }
          const timestamp = now();
          const bound = transaction.update(archiveRecoveryWork).set({
            verificationId: verification.id,
            updatedAt: timestamp,
          }).where(and(
            eq(archiveRecoveryWork.archiveRecoveryId, claim.archiveRecoveryId),
            eq(archiveRecoveryWork.claimToken, claim.claimToken),
            isNull(archiveRecoveryWork.verificationId),
          )).returning().get();
          if (
            bound === undefined || bound.status !== "claimed" ||
            bound.claimedBy === null || bound.claimToken === null ||
            bound.claimedAt === null
          ) {
            throw new StaleJobAttemptError(
              "Archive Recovery work",
              claim.archiveRecoveryId,
            );
          }
          transaction.update(archiveRecoveries).set({
            status: "running",
            updatedAt: timestamp,
          }).where(and(
            eq(archiveRecoveries.id, recovery.id),
            eq(archiveRecoveries.attemptId, recovery.attemptId),
            eq(archiveRecoveries.status, "eligible"),
          )).run();
          return bound as ClaimedArchiveRecoveryWork;
        }, { behavior: "immediate" });
      },
      requestResume(input) {
        const semanticInput = canonicalPublicationJson({
          archiveRecoveryId: input.archiveRecoveryId,
          attemptId: input.attemptId,
          checkpointRevision: input.checkpointRevision,
          checkpointDigest: input.checkpointDigest,
          speedMode: input.speedMode,
        });
        return database.transaction((transaction) => {
          const operation = "archive_recovery.resume";
          const replay = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeArchiveRecoveryResumeReceipt,
          );
          if (replay !== undefined) return replay;
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (recovery === null) {
            throw new RecordNotFoundError(
              "Archive Recovery",
              input.archiveRecoveryId,
            );
          }
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleArchiveRecoveryAttemptError({
              archiveRecoveryId: recovery.id,
              attemptId: recovery.attemptId,
            });
          }
          if (recovery.status !== "paused" && recovery.status !== "stopped") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "waiting_for_disc",
            );
          }
          if (input.speedMode !== "normal" && input.speedMode !== "low") {
            throw new DomainInvariantError(
              "Archive Recovery Resume speed mode is invalid",
            );
          }
          const header = requireRow(
            transaction.select().from(dvdArchiveEvidenceHeaders).where(eq(
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
              recovery.originalDiscArchiveId,
            )).get(),
            "DVD Archive Evidence",
            recovery.originalDiscArchiveId,
          );
          if (
            header.currentManifestRevision !== input.checkpointRevision ||
            header.currentManifestDigest !== input.checkpointDigest
          ) {
            throw new StaleArchiveRecoveryCheckpointError({
              archiveRecoveryId: recovery.id,
              checkpoint: {
                revision: header.currentManifestRevision,
                digest: header.currentManifestDigest,
              },
            });
          }
          const storage = transaction.select().from(
            dvdRecoveryStoragePreflights,
          ).where(eq(
            dvdRecoveryStoragePreflights.scope,
            "originals_library",
          )).get();
          const storageReason = dvdRecoveryStorageBlockingReason(
            storage === undefined
              ? null
              : {
                  contractVersion: storage.contractVersion as
                    typeof DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
                  status: storage.status,
                  reasonCode: storage.reasonCode,
                  facts: storage.facts,
                  checkedAt: storage.checkedAt,
                },
          );
          if (storageReason !== null) {
            throw new DvdRecoveryStorageUnavailableError(
              storageReason.code,
              storageReason.message,
            );
          }
          requireNoPendingDvdRecoveryReconciliation(transaction, recovery.id);
          requireNoActiveEncodeWork(transaction, recovery);
          if (recovery.work?.status === "claimed") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery work",
              "claimed",
              "requested",
            );
          }
          transaction.delete(archiveRecoveryWork).where(eq(
            archiveRecoveryWork.archiveRecoveryId,
            recovery.id,
          )).run();
          const timestamp = now();
          const attemptId = newId<ArchiveRecoveryAttemptId>();
          const lastPass = recovery.passHistory.at(-1);
          const passNumber = (lastPass?.passNumber ?? 0) + 1;
          const passDirection = lastPass?.direction === "forward"
            ? "reverse" as const
            : "forward" as const;
          const resumeOperationId = newId<ArchiveRecoveryResumeOperationId>();
          requireRow(
            transaction.update(archiveRecoveries).set({
              attemptId,
              attemptOrdinal: recovery.attemptOrdinal + 1,
              status: "waiting_for_disc",
              pauseReason: null,
              resumeOperationId,
              resumeRequestedAt: timestamp,
              resumeCheckpointRevision: input.checkpointRevision,
              resumeCheckpointDigest: input.checkpointDigest,
              speedMode: input.speedMode,
              speedRequestResult: null,
              stopOperationId: null,
              stopRequestedAt: null,
              stoppedAt: null,
              faultCode: null,
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              inArray(archiveRecoveries.status, ["paused", "stopped"]),
            )).returning({ id: archiveRecoveries.id }).get(),
            "Archive Recovery",
            recovery.id,
          );
          requireRow(
            transaction.insert(archiveRecoveryWork).values({
              archiveRecoveryId: recovery.id,
              originalDiscArchiveId: recovery.originalDiscArchiveId,
              attemptId,
              status: "requested",
              verificationId: null,
              requestedAt: timestamp,
              passNumber,
              passDirection,
              createdAt: timestamp,
              updatedAt: timestamp,
            }).returning({
              archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
            }).get(),
            "Archive Recovery work",
            recovery.id,
          );
          let resumed = requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
          const insertion = currentResumeInsertion(transaction, resumed);
          if (insertion !== null) {
            resumed = activateResumeInsertion(
              transaction,
              resumed,
              insertion,
              timestamp,
            );
          }
          const receipt = {
            ...resumed,
            resumeOperationId,
            resumeRequestedAt: timestamp,
            resumeCheckpointRevision: input.checkpointRevision,
            resumeCheckpointDigest: input.checkpointDigest,
            speedMode: input.speedMode,
          } as ArchiveRecoveryResumeReceipt;
          return recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            receipt,
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      replayResume(input) {
        const semanticInput = canonicalPublicationJson({
          archiveRecoveryId: input.archiveRecoveryId,
          attemptId: input.attemptId,
          checkpointRevision: input.checkpointRevision,
          checkpointDigest: input.checkpointDigest,
          speedMode: input.speedMode,
        });
        return database.transaction((transaction) =>
          readMutationInvocation(
            transaction,
            input.mutationKey,
            "archive_recovery.resume",
            semanticInput,
            decodeArchiveRecoveryResumeReceipt,
          ) ?? null);
      },
      activateWaitingResume() {
        return database.transaction((transaction) => {
          const candidates = transaction.select({ id: archiveRecoveries.id })
            .from(archiveRecoveries)
            .where(eq(archiveRecoveries.status, "waiting_for_disc"))
            .orderBy(
              asc(archiveRecoveries.updatedAt),
              asc(archiveRecoveries.id),
            ).all();
          for (const candidate of candidates) {
            const recovery = findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: candidate.id,
            });
            if (
              recovery === null || recovery.resumeOperationId === null ||
              recovery.work?.status !== "requested"
            ) continue;
            const insertion = currentResumeInsertion(transaction, recovery);
            if (insertion === null) continue;
            const latest = transaction.select({
              discInspectionId: dvdDiscVerifications.discInspectionId,
            }).from(dvdDiscVerifications).where(eq(
              dvdDiscVerifications.archiveRecoveryId,
              recovery.id,
            )).orderBy(desc(dvdDiscVerifications.attemptOrdinal)).limit(1)
              .get();
            if (latest?.discInspectionId === insertion.id) continue;
            requireNoActiveEncodeWork(transaction, recovery);
            requireNoPendingDvdRecoveryReconciliation(
              transaction,
              recovery.id,
            );
            return activateResumeInsertion(
              transaction,
              recovery,
              insertion,
              now(),
            );
          }
          return null;
        }, { behavior: "immediate" });
      },
      recordSpeedRequestResult(input) {
        if (
          input.mode !== "normal" && input.mode !== "low" ||
          !["accepted", "rejected", "ignored"].includes(input.outcome) ||
          input.attemptedSpeeds.length === 0 ||
          input.attemptedSpeeds.some((speed) =>
            !Number.isSafeInteger(speed) || speed < 0 || speed > 255
          ) ||
          input.selectedSpeed !== null &&
            (!Number.isSafeInteger(input.selectedSpeed) ||
              input.selectedSpeed < 0 || input.selectedSpeed > 255) ||
          input.observedSpeed !== null &&
            (!Number.isSafeInteger(input.observedSpeed) ||
              input.observedSpeed < 0 || input.observedSpeed > 255)
        ) {
          throw new DomainInvariantError(
            "Archive Recovery speed request result is invalid",
          );
        }
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (
            recovery === null || recovery.attemptId !== input.attemptId ||
            recovery.speedMode !== input.mode ||
            recovery.status !== "eligible" ||
            recovery.work?.verificationId === null ||
            recovery.work?.verificationId === undefined
          ) {
            throw new StaleJobAttemptError(
              "Archive Recovery speed request",
              input.attemptId,
            );
          }
          const verification = transaction.select().from(
            dvdDiscVerifications,
          ).where(eq(
            dvdDiscVerifications.id,
            recovery.work.verificationId,
          )).get();
          if (
            verification === undefined ||
            verification.archiveRecoveryAttemptId !== input.attemptId ||
            verification.discInspectionId !== input.discInspectionId
          ) {
            throw new StaleJobAttemptError(
              "Archive Recovery speed request insertion",
              input.attemptId,
            );
          }
          requireRow(
            transaction.update(archiveRecoveries).set({
              speedRequestResult: input,
              updatedAt: now(),
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, input.attemptId),
              eq(archiveRecoveries.status, "eligible"),
            )).returning({ id: archiveRecoveries.id }).get(),
            "Archive Recovery",
            recovery.id,
          );
          transaction.update(dvdDiscVerifications).set({
            startedAt: now(),
            updatedAt: now(),
          }).where(and(
            eq(dvdDiscVerifications.id, verification.id),
            eq(dvdDiscVerifications.status, "running"),
          )).run();
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      requestStop(input) {
        const semanticInput = canonicalPublicationJson({
          archiveRecoveryId: input.archiveRecoveryId,
          attemptId: input.attemptId,
        });
        return database.transaction((transaction) => {
          const operation = "archive_recovery.stop";
          const replay = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeArchiveRecoveryStopReceipt,
          );
          if (replay !== undefined) return replay;
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (recovery === null) {
            throw new RecordNotFoundError(
              "Archive Recovery",
              input.archiveRecoveryId,
            );
          }
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleArchiveRecoveryAttemptError({
              archiveRecoveryId: recovery.id,
              attemptId: recovery.attemptId,
            });
          }
          if (
            recovery.status !== "eligible" &&
            recovery.status !== "waiting_for_disc" &&
            recovery.status !== "running" &&
            recovery.status !== "paused"
          ) {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "stopping",
            );
          }
          requireNoActiveEncodeWork(transaction, recovery);
          const timestamp = now();
          if (recovery.work === null) {
            requireRow(
              transaction.insert(archiveRecoveryWork).values({
                archiveRecoveryId: recovery.id,
                originalDiscArchiveId: recovery.originalDiscArchiveId,
                attemptId: recovery.attemptId,
                status: "requested",
                verificationId: null,
                requestedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              }).returning({
                archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
              }).get(),
              "Archive Recovery work",
              recovery.id,
            );
          }
          const stopped = requireRow(
            transaction.update(archiveRecoveries).set({
              status: "stopping",
              stopOperationId:
                newId<ArchiveRecoveryStopOperationId>(),
              stopRequestedAt: timestamp,
              stoppedAt: null,
              faultCode: null,
              pauseReason: null,
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              inArray(archiveRecoveries.status, [
                "eligible",
                "waiting_for_disc",
                "running",
                "paused",
              ]),
            )).returning().get(),
            "Archive Recovery",
            recovery.id,
          );
          transaction.update(dvdDiscVerifications).set({
            status: "failed",
            completedAt: timestamp,
            failureCode: "DISC_VERIFICATION_UNAVAILABLE",
            updatedAt: timestamp,
          }).where(and(
            eq(dvdDiscVerifications.archiveRecoveryId, recovery.id),
            eq(
              dvdDiscVerifications.archiveRecoveryAttemptId,
              recovery.attemptId,
            ),
            eq(dvdDiscVerifications.status, "queued"),
          )).run();
          return recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            {
              ...stopped,
              status: "stopping" as const,
              stopOperationId: stopped.stopOperationId!,
              stopRequestedAt: stopped.stopRequestedAt!,
              work: findArchiveRecoveryRecord(transaction, {
                archiveRecoveryId: stopped.id,
              })?.work ?? null,
            },
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      prepareStop(input) {
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (recovery === null) {
            throw new RecordNotFoundError(
              "Archive Recovery",
              input.archiveRecoveryId,
            );
          }
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleArchiveRecoveryAttemptError({
              archiveRecoveryId: recovery.id,
              attemptId: recovery.attemptId,
            });
          }
          if (
            recovery.status !== "stopping" ||
            recovery.stopOperationId !== input.stopOperationId
          ) {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "stopping",
            );
          }
          const timestamp = now();
          if (
            recovery.work?.status === "claimed" &&
            recovery.work.claimedAt !== null &&
            recovery.work.claimedAt.getTime() >=
              timestamp.getTime() - DVD_RECOVERY_PASS_CLAIM_LEASE_MS &&
            (
              input.quiescedClaim === undefined ||
              input.quiescedClaim.archiveRecoveryId !== recovery.id ||
              input.quiescedClaim.attemptId !== recovery.attemptId ||
              input.quiescedClaim.claimToken !== recovery.work.claimToken
            )
          ) return false;
          transaction.update(dvdDiscVerifications).set({
            status: "failed",
            completedAt: timestamp,
            failureCode: "DISC_VERIFICATION_UNAVAILABLE",
            updatedAt: timestamp,
          }).where(and(
            eq(dvdDiscVerifications.archiveRecoveryId, recovery.id),
            eq(
              dvdDiscVerifications.archiveRecoveryAttemptId,
              recovery.attemptId,
            ),
            eq(dvdDiscVerifications.status, "queued"),
          )).run();
          const expiredBefore = new Date(
            timestamp.getTime() - DVD_DISC_VERIFICATION_CLAIM_LEASE_MS,
          );
          const expired = transaction.select().from(dvdDiscVerifications)
            .where(and(
              eq(dvdDiscVerifications.archiveRecoveryId, recovery.id),
              eq(
                dvdDiscVerifications.archiveRecoveryAttemptId,
                recovery.attemptId,
              ),
              eq(dvdDiscVerifications.status, "running"),
              lt(dvdDiscVerifications.claimedAt, expiredBefore),
            )).all();
          for (const verification of expired) {
            const claimToken = verification.claimToken;
            if (claimToken === null) {
              throw new DomainInvariantError(
                "Running DVD Disc Verification has no claim token",
              );
            }
            const evaluated = evaluatePersistedDvdDiscVerification(
              transaction,
              verification,
              {
                findings: verification.findings,
                budgetExhausted: verification.budgetExhausted,
                interrupted: true,
              },
            );
            transaction.update(dvdDiscVerifications).set({
              status: "completed",
              outcome: evaluated.outcome,
              reasons: evaluated.reasons,
              claimToken: null,
              claimedAt: null,
              completedAt: timestamp,
              updatedAt: timestamp,
            }).where(and(
              eq(dvdDiscVerifications.id, verification.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).run();
          }
          return transaction.select({ id: dvdDiscVerifications.id })
            .from(dvdDiscVerifications)
            .where(and(
              eq(dvdDiscVerifications.archiveRecoveryId, recovery.id),
              eq(
                dvdDiscVerifications.archiveRecoveryAttemptId,
                recovery.attemptId,
              ),
              inArray(dvdDiscVerifications.status, ["queued", "running"]),
            )).limit(1).get() === undefined;
        }, { behavior: "immediate" });
      },
      completeStop(input) {
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (recovery === null) {
            throw new RecordNotFoundError(
              "Archive Recovery",
              input.archiveRecoveryId,
            );
          }
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleArchiveRecoveryAttemptError({
              archiveRecoveryId: recovery.id,
              attemptId: recovery.attemptId,
            });
          }
          if (
            recovery.status !== "stopping" ||
            recovery.stopOperationId !== input.stopOperationId
          ) {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "stopped",
            );
          }
          const activeVerification = transaction.select({
            id: dvdDiscVerifications.id,
          }).from(dvdDiscVerifications).where(and(
            eq(dvdDiscVerifications.archiveRecoveryId, recovery.id),
            eq(
              dvdDiscVerifications.archiveRecoveryAttemptId,
              recovery.attemptId,
            ),
            inArray(dvdDiscVerifications.status, ["queued", "running"]),
          )).limit(1).get();
          if (activeVerification !== undefined) {
            throw new DomainInvariantError(
              "Archive Recovery Stop requires settled DVD Disc Verification",
            );
          }
          const timestamp = now();
          transaction.delete(archiveRecoveryWork).where(and(
            eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
            eq(archiveRecoveryWork.attemptId, recovery.attemptId),
          )).run();
          transaction.update(archiveRecoveries).set({
            status: "stopped",
            stoppedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(archiveRecoveries.id, recovery.id),
            eq(archiveRecoveries.attemptId, recovery.attemptId),
            eq(archiveRecoveries.stopOperationId, input.stopOperationId),
            eq(archiveRecoveries.status, "stopping"),
          )).run();
          const disc = requireRow(
            transaction.select({ volumeLabel: detectedDiscs.volumeLabel })
              .from(originalDiscArchives).innerJoin(
                detectedDiscs,
                eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
              ).where(eq(
                originalDiscArchives.id,
                recovery.originalDiscArchiveId,
              )).get(),
            "Original Disc Archive",
            recovery.originalDiscArchiveId,
          );
          recordNotificationOutcome(createNotificationEventWriter(transaction, now), {
            kind: "recovery_stopped",
            sourceEventId: `recovery-stop:${input.stopOperationId}`,
            originalDiscArchiveId: recovery.originalDiscArchiveId,
            label: disc.volumeLabel,
            remainingSource: currentDvdUnrecoveredSourceRanges(
              transaction,
              recovery.originalDiscArchiveId,
            ).length > 0,
          });
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      deferStop(input) {
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (recovery === null) {
            throw new RecordNotFoundError(
              "Archive Recovery",
              input.archiveRecoveryId,
            );
          }
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleArchiveRecoveryAttemptError({
              archiveRecoveryId: recovery.id,
              attemptId: recovery.attemptId,
            });
          }
          if (
            recovery.status !== "stopping" ||
            recovery.stopOperationId !== input.stopOperationId
          ) {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "stopping",
            );
          }
          const latestStopping = transaction.select({
            updatedAt: archiveRecoveries.updatedAt,
          }).from(archiveRecoveries).where(eq(
            archiveRecoveries.status,
            "stopping",
          )).orderBy(desc(archiveRecoveries.updatedAt)).limit(1).get();
          const timestamp = new Date(Math.max(
            now().getTime(),
            recovery.updatedAt.getTime() + 1,
            (latestStopping?.updatedAt.getTime() ?? 0) + 1,
          ));
          requireRow(
            transaction.update(archiveRecoveries).set({
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              eq(archiveRecoveries.stopOperationId, input.stopOperationId),
              eq(archiveRecoveries.status, "stopping"),
            )).returning({ id: archiveRecoveries.id }).get(),
            "Archive Recovery",
            recovery.id,
          );
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      markStopFault(input) {
        requireNonEmpty(input.faultCode, "faultCode");
        const faultCode: ArchiveRecoveryFaultCode = input.faultCode;
        return database.transaction((transaction) => {
          const recovery = findArchiveRecoveryRecord(transaction, {
            archiveRecoveryId: input.archiveRecoveryId,
          });
          if (recovery === null) {
            throw new RecordNotFoundError(
              "Archive Recovery",
              input.archiveRecoveryId,
            );
          }
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleArchiveRecoveryAttemptError({
              archiveRecoveryId: recovery.id,
              attemptId: recovery.attemptId,
            });
          }
          if (
            recovery.status !== "stopping" ||
            recovery.stopOperationId !== input.stopOperationId
          ) {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "faulted",
            );
          }
          const timestamp = now();
          requireRow(
            transaction.update(archiveRecoveries).set({
              status: "faulted",
              stoppedAt: null,
              faultCode,
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              eq(archiveRecoveries.stopOperationId, input.stopOperationId),
              eq(archiveRecoveries.status, "stopping"),
            )).returning({ id: archiveRecoveries.id }).get(),
            "Archive Recovery",
            recovery.id,
          );
          recordArchiveRecoveryOutcome(
            transaction,
            recovery,
            "recovery_attention",
            `stop:${input.stopOperationId}`,
          );
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      settlePass(claim) {
        return database.transaction((transaction) => {
          const recovery = requireCurrentArchiveRecoveryClaim(
            transaction,
            claim,
          );
          if (
            recovery.status !== "running" &&
            recovery.status !== "completed"
          ) {
            return recovery;
          }
          const timestamp = now();
          const { outcome, history } = archiveRecoveryPassSettlement(
            transaction,
            recovery,
            timestamp,
          );
          const work = recovery.work;
          if (work === null) {
            throw new DomainInvariantError(
              "Archive Recovery pass has no durable work",
            );
          }
          if (outcome === "completed") {
            recordArchiveRecoveryOutcome(
              transaction,
              recovery,
              "recovery_completed",
            );
            transaction.delete(archiveRecoveryWork).where(and(
              eq(
                archiveRecoveryWork.archiveRecoveryId,
                claim.archiveRecoveryId,
              ),
              eq(archiveRecoveryWork.claimToken, claim.claimToken),
            )).run();
          } else {
            if (outcome === "productive") {
              queueNextArchiveRecoveryPassVerification(
                transaction,
                recovery,
                timestamp,
              );
            }
            transaction.update(archiveRecoveryWork).set({
              status: "requested",
              verificationId: outcome === "productive"
                ? null
                : work.verificationId,
              requestedAt: timestamp,
              claimedBy: null,
              claimToken: null,
              claimedAt: null,
              admittedDevicePath: null,
              admittedDeviceId: null,
              admittedDeviceInode: null,
              ...(outcome === "productive"
                ? {
                    passNumber: work.passNumber + 1,
                    passDirection: work.passDirection === "forward"
                      ? "reverse" as const
                      : "forward" as const,
                    passStartedAt: null,
                    passStartedManifestRevision: null,
                    passInitialUnrecoveredSectorCount: null,
                    passRecoveredSectorCount: 0,
                    passObservationCount: null,
                    passPositiveIntervalCount: null,
                    passMinimumIntervalMs: null,
                    passMaximumIntervalMs: null,
                    passLastObservedAt: null,
                    passCursorLba: null,
                  }
                : {}),
              updatedAt: timestamp,
            }).where(and(
              eq(
                archiveRecoveryWork.archiveRecoveryId,
                claim.archiveRecoveryId,
              ),
              eq(archiveRecoveryWork.claimToken, claim.claimToken),
            )).run();
          }
          transaction.update(archiveRecoveries).set({
            status: outcome === "completed"
              ? "completed"
              : outcome === "productive"
                ? "eligible"
                : "paused",
            pauseReason: outcome === "no_progress" ? "no_progress" : null,
            passHistory: history,
            updatedAt: timestamp,
          }).where(and(
            eq(archiveRecoveries.id, recovery.id),
            eq(archiveRecoveries.attemptId, recovery.attemptId),
            inArray(archiveRecoveries.status, ["running", "completed"]),
          )).run();
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      markFault(input) {
        requireNonEmpty(input.faultCode, "faultCode");
        const faultCode = input.faultCode;
        return database.transaction((transaction) => {
          const recovery = requireCurrentArchiveRecoveryClaim(
            transaction,
            input.claim,
          );
          if (recovery.status === "stopping") {
            return recovery;
          }
          if (recovery.status !== "running") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "faulted",
            );
          }
          const timestamp = now();
          const storageFault = input.storageFault;
          requireRow(
            transaction.update(archiveRecoveries).set({
              status: storageFault ? "paused" : "faulted",
              faultCode: storageFault ? null : faultCode,
              pauseReason: storageFault ? "storage_fault" : null,
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              eq(archiveRecoveries.status, "running"),
            )).returning({ id: archiveRecoveries.id }).get(),
            "Archive Recovery",
            recovery.id,
          );
          recordArchiveRecoveryOutcome(
            transaction,
            recovery,
            "recovery_attention",
          );
          if (!input.retainWork) {
            requireRow(
              transaction.delete(archiveRecoveryWork).where(and(
                eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
                eq(archiveRecoveryWork.attemptId, recovery.attemptId),
                eq(
                  archiveRecoveryWork.claimToken,
                  input.claim.claimToken,
                ),
              )).returning({
                archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
              }).get(),
              "Archive Recovery work",
              recovery.id,
            );
          }
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      releaseAfterReconciliation(input) {
        return database.transaction((transaction) => {
          const recovery = requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: input.archiveRecoveryId,
            }) ?? undefined,
            "Archive Recovery",
            input.archiveRecoveryId,
          );
          if (recovery.attemptId !== input.attemptId) {
            throw new StaleJobAttemptError(
              "Archive Recovery work",
              input.archiveRecoveryId,
            );
          }
          if (recovery.status === "stopping" || recovery.work === null) {
            return recovery;
          }
          const timestamp = now();
          const settlement = recovery.status === "running"
            ? archiveRecoveryCompletionAfterInterruption(
                transaction,
                recovery,
                timestamp,
              )
            : null;
          const removed = transaction.delete(archiveRecoveryWork).where(and(
            eq(
              archiveRecoveryWork.archiveRecoveryId,
              input.archiveRecoveryId,
            ),
            eq(archiveRecoveryWork.attemptId, input.attemptId),
            inArray(archiveRecoveryWork.status, ["requested", "claimed"]),
          )).returning().get();
          if (removed === undefined) {
            throw new StaleJobAttemptError(
              "Archive Recovery work",
              input.archiveRecoveryId,
            );
          }
          if (recovery.status === "running" && settlement !== null) {
            transaction.update(archiveRecoveries).set({
              status: settlement.status,
              ...(settlement.history === null
                ? {}
                : { passHistory: settlement.history }),
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              eq(archiveRecoveries.status, "running"),
            )).run();
          }
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: input.archiveRecoveryId,
            }) ?? undefined,
            "Archive Recovery",
            input.archiveRecoveryId,
          );
        }, { behavior: "immediate" });
      },
      requeue(claim) {
        return database.transaction((transaction) => {
          const recovery = requireCurrentArchiveRecoveryClaim(
            transaction,
            claim,
          );
          if (recovery.status === "stopping") return recovery;
          if (recovery.status !== "running") {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.status,
              "eligible",
            );
          }
          const timestamp = now();
          const settlement = archiveRecoveryCompletionAfterInterruption(
            transaction,
            recovery,
            timestamp,
          );
          if (settlement.status === "completed") {
            requireRow(
              transaction.delete(archiveRecoveryWork).where(and(
                eq(
                  archiveRecoveryWork.archiveRecoveryId,
                  claim.archiveRecoveryId,
                ),
                eq(archiveRecoveryWork.status, "claimed"),
                eq(archiveRecoveryWork.claimToken, claim.claimToken),
              )).returning({
                archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
              }).get(),
              "Archive Recovery work",
              claim.archiveRecoveryId,
            );
          } else {
            requireRow(
              transaction.update(archiveRecoveryWork).set({
                status: "requested",
                requestedAt: timestamp,
                claimedBy: null,
                claimToken: null,
                claimedAt: null,
                admittedDevicePath: null,
                admittedDeviceId: null,
                admittedDeviceInode: null,
                updatedAt: timestamp,
              }).where(and(
                eq(
                  archiveRecoveryWork.archiveRecoveryId,
                  claim.archiveRecoveryId,
                ),
                eq(archiveRecoveryWork.status, "claimed"),
                eq(archiveRecoveryWork.claimToken, claim.claimToken),
              )).returning({
                archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
              }).get(),
              "Archive Recovery work",
              claim.archiveRecoveryId,
            );
          }
          requireRow(
            transaction.update(archiveRecoveries).set({
              status: settlement.status,
              ...(settlement.history === null
                ? {}
                : { passHistory: settlement.history }),
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recovery.id),
              eq(archiveRecoveries.attemptId, recovery.attemptId),
              eq(archiveRecoveries.status, "running"),
            )).returning({ id: archiveRecoveries.id }).get(),
            "Archive Recovery",
            recovery.id,
          );
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: recovery.id,
            }) ?? undefined,
            "Archive Recovery",
            recovery.id,
          );
        }, { behavior: "immediate" });
      },
      release(claim) {
        return database.transaction((transaction) => {
          const recoveryAfterCompletion = findArchiveRecoveryRecord(
            transaction,
            {
              archiveRecoveryId: claim.archiveRecoveryId,
              originalDiscArchiveId: claim.originalDiscArchiveId,
            },
          );
          if (
            recoveryAfterCompletion?.status === "stopped" &&
            recoveryAfterCompletion.attemptId === claim.attemptId &&
            recoveryAfterCompletion.work === null
          ) {
            return recoveryAfterCompletion;
          }
          const recoveryBeforeRelease = requireCurrentArchiveRecoveryClaim(
            transaction,
            claim,
          );
          if (recoveryBeforeRelease.status === "stopping") {
            return recoveryBeforeRelease;
          }
          const timestamp = now();
          const settlement = recoveryBeforeRelease.status === "running"
            ? archiveRecoveryCompletionAfterInterruption(
                transaction,
                recoveryBeforeRelease,
                timestamp,
              )
            : null;
          const removed = transaction
            .delete(archiveRecoveryWork)
            .where(and(
              eq(
                archiveRecoveryWork.archiveRecoveryId,
                claim.archiveRecoveryId,
              ),
              eq(archiveRecoveryWork.status, "claimed"),
              eq(archiveRecoveryWork.claimToken, claim.claimToken),
            ))
            .returning()
            .get();
          if (removed === undefined) {
            throw new StaleJobAttemptError(
              "Archive Recovery work",
              claim.archiveRecoveryId,
            );
          }
          if (
            recoveryBeforeRelease.status === "running" && settlement !== null
          ) {
            transaction.update(archiveRecoveries).set({
              status: settlement.status,
              ...(settlement.history === null
                ? {}
                : { passHistory: settlement.history }),
              updatedAt: timestamp,
            }).where(and(
              eq(archiveRecoveries.id, recoveryBeforeRelease.id),
              eq(archiveRecoveries.attemptId, recoveryBeforeRelease.attemptId),
              eq(archiveRecoveries.status, "running"),
            )).run();
          }
          return requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: claim.archiveRecoveryId,
            }) ?? undefined,
            "Archive Recovery",
            claim.archiveRecoveryId,
          );
        }, { behavior: "immediate" });
      },
    },
    dvdRecoveryReconciliations: {
      submit(input) {
        const semanticInput = dvdRecoveryReconciliationSemanticInput(input);
        return database.transaction((transaction) => {
          const operation = "dvd_recovery_reconciliation.submit";
          const previous = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeDvdRecoveryReconciliationOutcome,
          );
          if (previous !== undefined) {
            const current = transaction.select()
              .from(dvdRecoveryReconciliations)
              .where(eq(dvdRecoveryReconciliations.id, previous.id))
              .get();
            return current === undefined
              ? previous
              : toDvdRecoveryReconciliation(current);
          }
          const recovery = requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: input.archiveRecoveryId,
            }) ?? undefined,
            "Archive Recovery",
            input.archiveRecoveryId,
          );
          if (
            recovery.status === "running" || recovery.status === "stopping" ||
            ((recovery.status === "eligible" ||
                recovery.status === "paused" ||
                recovery.status === "waiting_for_disc") &&
              recovery.work?.status === "requested")
          ) {
            throw new InvalidStatusTransitionError(
              "Archive Recovery",
              recovery.work?.status === "requested"
                ? "requested"
                : recovery.status,
              "DVD recovery reconciliation",
            );
          }
          const active = transaction.select({
            id: dvdRecoveryReconciliations.id,
          }).from(dvdRecoveryReconciliations).where(and(
            eq(
              dvdRecoveryReconciliations.archiveRecoveryId,
              recovery.id,
            ),
            inArray(dvdRecoveryReconciliations.status, ["queued", "running"]),
          )).get();
          if (active !== undefined) {
            throw new InvalidStatusTransitionError(
              "DVD recovery reconciliation",
              "active",
              "queued",
            );
          }
          const id = newId<DvdRecoveryReconciliationId>();
          const timestamp = now();
          const attemptOrdinal = requireRow(
            transaction.select({
              value: sql<number>`coalesce(max(${dvdRecoveryReconciliations.attemptOrdinal}), 0) + 1`,
            }).from(dvdRecoveryReconciliations).where(eq(
              dvdRecoveryReconciliations.archiveRecoveryId,
              recovery.id,
            )).get(),
            "DVD recovery reconciliation attempt sequence",
            recovery.id,
          ).value;
          const row = requireRow(
            transaction.insert(dvdRecoveryReconciliations).values({
              id,
              archiveRecoveryId: recovery.id,
              attemptOrdinal,
              originalDiscArchiveId: recovery.originalDiscArchiveId,
              status: "queued",
              phase: "queued",
              createdAt: timestamp,
              updatedAt: timestamp,
            }).returning().get(),
            "DVD recovery reconciliation",
            id,
          );
          recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            row,
            timestamp,
          );
          return toDvdRecoveryReconciliation(row);
        }, { behavior: "immediate" });
      },
      find(id) {
        const row = database.select().from(dvdRecoveryReconciliations)
          .where(eq(dvdRecoveryReconciliations.id, id)).get();
        return row === undefined ? null : toDvdRecoveryReconciliation(row);
      },
      findLatestForRecovery(id) {
        const row = database.select().from(dvdRecoveryReconciliations)
          .where(eq(dvdRecoveryReconciliations.archiveRecoveryId, id))
          .orderBy(desc(dvdRecoveryReconciliations.attemptOrdinal))
          .limit(1).get();
        return row === undefined ? null : toDvdRecoveryReconciliation(row);
      },
      list(options) {
        const limit = requirePositiveSafeInteger(options.limit, "limit");
        if (limit > 1_000) {
          throw new DomainInvariantError(
            "DVD recovery reconciliation reads are limited to 1000 records",
          );
        }
        return database.select().from(dvdRecoveryReconciliations)
          .orderBy(
            desc(dvdRecoveryReconciliations.createdAt),
            desc(dvdRecoveryReconciliations.id),
          ).limit(limit).all().map(toDvdRecoveryReconciliation);
      },
      listActive() {
        return database.select().from(dvdRecoveryReconciliations)
          .where(inArray(
            dvdRecoveryReconciliations.status,
            ["queued", "running"],
          ))
          .orderBy(
            asc(dvdRecoveryReconciliations.createdAt),
            asc(dvdRecoveryReconciliations.id),
          ).all().map(toDvdRecoveryReconciliation);
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - DVD_RECOVERY_RECONCILIATION_CLAIM_LEASE_MS,
        );
        return database.update(dvdRecoveryReconciliations).set({
          status: "queued",
          phase: "queued",
          workerExecutionId: null,
          claimToken: null,
          claimedAt: null,
          startedAt: null,
          updatedAt: timestamp,
        }).where(and(
          eq(dvdRecoveryReconciliations.status, "running"),
          lt(dvdRecoveryReconciliations.claimedAt, expiredBefore),
        )).returning({ id: dvdRecoveryReconciliations.id }).all().length;
      },
      claimNext(workerExecutionId) {
        const execution = requireNonEmpty(
          workerExecutionId.trim(),
          "DVD recovery reconciliation worker execution ID",
        );
        if (execution.length > 256) {
          throw new DomainInvariantError(
            "DVD recovery reconciliation worker execution ID is too long",
          );
        }
        return database.transaction((transaction) => {
          const next = transaction.select().from(dvdRecoveryReconciliations)
            .where(eq(dvdRecoveryReconciliations.status, "queued"))
            .orderBy(
              asc(dvdRecoveryReconciliations.createdAt),
              asc(dvdRecoveryReconciliations.id),
            ).limit(1).get();
          if (next === undefined) return null;
          const timestamp = now();
          const claimed = transaction.update(dvdRecoveryReconciliations).set({
            status: "running",
            phase: "examining",
            workerExecutionId: execution,
            claimToken: newId<DvdRecoveryReconciliationClaimToken>(),
            claimedAt: timestamp,
            startedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(dvdRecoveryReconciliations.id, next.id),
            eq(dvdRecoveryReconciliations.status, "queued"),
          )).returning().get();
          return claimed === undefined
            ? null
            : toClaimedDvdRecoveryReconciliation(claimed);
        }, { behavior: "immediate" });
      },
      renewClaim(claim) {
        const timestamp = now();
        return database.update(dvdRecoveryReconciliations).set({
          claimedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(
          eq(dvdRecoveryReconciliations.id, claim.id),
          eq(dvdRecoveryReconciliations.status, "running"),
          eq(dvdRecoveryReconciliations.claimToken, claim.claimToken),
        )).returning({ id: dvdRecoveryReconciliations.id }).get() !== undefined;
      },
      requeue(claim) {
        const timestamp = now();
        const row = database.update(dvdRecoveryReconciliations).set({
          status: "queued",
          phase: "queued",
          workerExecutionId: null,
          claimToken: null,
          claimedAt: null,
          startedAt: null,
          updatedAt: timestamp,
        }).where(and(
          eq(dvdRecoveryReconciliations.id, claim.id),
          eq(dvdRecoveryReconciliations.status, "running"),
          eq(dvdRecoveryReconciliations.claimToken, claim.claimToken),
        )).returning().get();
        return row === undefined ? null : toDvdRecoveryReconciliation(row);
      },
      setPhase(claim, phase) {
        const timestamp = now();
        const row = database.update(dvdRecoveryReconciliations).set({
          phase,
          claimedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(
          eq(dvdRecoveryReconciliations.id, claim.id),
          eq(dvdRecoveryReconciliations.status, "running"),
          eq(dvdRecoveryReconciliations.claimToken, claim.claimToken),
        )).returning().get();
        if (row === undefined) {
          throw new StaleJobAttemptError(
            "DVD recovery reconciliation",
            claim.id,
          );
        }
        return toClaimedDvdRecoveryReconciliation(row);
      },
      complete(claim, result) {
        const evidence = result.evidence;
        if (
          evidence.authoritativeCheckpoint.revision !==
            evidence.databaseProjectionAfter.revision ||
          evidence.authoritativeCheckpoint.manifestId !==
            evidence.databaseProjectionAfter.manifestId ||
          evidence.authoritativeCheckpoint.manifestDigest !==
            evidence.databaseProjectionAfter.manifestDigest
        ) {
          throw new DomainInvariantError(
            "DVD recovery reconciliation evidence is not converged",
          );
        }
        const timestamp = now();
        const row = database.update(dvdRecoveryReconciliations).set({
          status: "completed",
          phase: "completed",
          outcome: result.outcome,
          evidence,
          claimToken: null,
          claimedAt: null,
          completedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(
          eq(dvdRecoveryReconciliations.id, claim.id),
          eq(dvdRecoveryReconciliations.status, "running"),
          eq(dvdRecoveryReconciliations.claimToken, claim.claimToken),
        )).returning().get();
        if (row === undefined) {
          throw new StaleJobAttemptError(
            "DVD recovery reconciliation",
            claim.id,
          );
        }
        return toDvdRecoveryReconciliation(row);
      },
      fail(claim, failureCode) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const row = transaction.update(dvdRecoveryReconciliations).set({
            status: "failed",
            phase: "completed",
            failureCode,
            claimToken: null,
            claimedAt: null,
            completedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(dvdRecoveryReconciliations.id, claim.id),
            eq(dvdRecoveryReconciliations.status, "running"),
            eq(dvdRecoveryReconciliations.claimToken, claim.claimToken),
          )).returning().get();
          if (row === undefined) return null;
          const recovery = requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: row.archiveRecoveryId,
            }) ?? undefined,
            "Archive Recovery",
            row.archiveRecoveryId,
          );
          recordArchiveRecoveryOutcome(
            transaction, recovery, "recovery_attention", `reconciliation:${row.id}`,
          );
          return toDvdRecoveryReconciliation(row);
        }, { behavior: "immediate" });
      },
    },
    dvdDiscConfirmations: {
      replaySubmission(input) {
        const { mutationKey, ...semantic } = input;
        return database.transaction((transaction) =>
          readMutationInvocation(
            transaction,
            mutationKey,
            "dvd_disc_confirmation.record",
            dvdDiscConfirmationSemanticInput(semantic),
            decodeDvdDiscConfirmationOutcome,
          ) ?? null);
      },
      record(input) {
        const { mutationKey, ...semantic } = input;
        const semanticInput = dvdDiscConfirmationSemanticInput(semantic);
        return database.transaction((transaction) => {
          const operation = "dvd_disc_confirmation.record";
          const previous = readMutationInvocation(
            transaction,
            mutationKey,
            operation,
            semanticInput,
            decodeDvdDiscConfirmationOutcome,
          );
          if (previous !== undefined) return previous;
          if (input.acknowledgeMixedSource !== true) {
            throw new DomainInvariantError(
              "Mixed-source risk must be explicitly acknowledged",
            );
          }
          const storageRow = transaction.select()
            .from(dvdRecoveryStoragePreflights)
            .where(eq(
              dvdRecoveryStoragePreflights.scope,
              "originals_library",
            )).get();
          const storageReason = dvdRecoveryStorageBlockingReason(
            storageRow === undefined
              ? null
              : {
                  contractVersion: storageRow.contractVersion as
                    typeof DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
                  status: storageRow.status,
                  reasonCode: storageRow.reasonCode,
                  facts: storageRow.facts,
                  checkedAt: storageRow.checkedAt,
                },
          );
          if (storageReason !== null) {
            throw new DvdRecoveryStorageUnavailableError(
              storageReason.code,
              storageReason.message,
            );
          }
          const recovery = requireRow(
            findArchiveRecoveryRecord(transaction, {
              archiveRecoveryId: input.archiveRecoveryId,
            }) ?? undefined,
            "archive recovery",
            input.archiveRecoveryId,
          );
          const waitingResumeConfirmation =
            recovery.status === "waiting_for_disc" &&
            recovery.resumeOperationId !== null &&
            recovery.work?.status === "requested" &&
            recovery.work.verificationId === input.verificationId;
          if (recovery.status !== "eligible" && !waitingResumeConfirmation) {
            throw new InvalidStatusTransitionError(
              "archive recovery",
              recovery.status,
              "DVD Disc Confirmation",
            );
          }
          const archive = requireRow(
            transaction.select().from(originalDiscArchives).where(eq(
              originalDiscArchives.id,
              recovery.originalDiscArchiveId,
            )).get(),
            "original disc archive",
            recovery.originalDiscArchiveId,
          );
          const header = transaction.select().from(dvdArchiveEvidenceHeaders)
            .where(eq(
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
              recovery.originalDiscArchiveId,
            )).get();
          const verification = transaction.select().from(dvdDiscVerifications)
            .where(eq(dvdDiscVerifications.id, input.verificationId)).get();
          const latestVerification = transaction.select()
            .from(dvdDiscVerifications)
            .where(eq(
              dvdDiscVerifications.archiveRecoveryId,
              recovery.id,
            ))
            .orderBy(desc(dvdDiscVerifications.attemptOrdinal))
            .limit(1)
            .get();
          const inspection = verification === undefined
            ? undefined
            : transaction.select().from(discInspections).where(eq(
                discInspections.id,
                verification.discInspectionId,
              )).get();
          const latestInspection = latestVerification === undefined
            ? undefined
            : transaction.select().from(discInspections).where(eq(
                discInspections.id,
                latestVerification.discInspectionId,
              )).get();
          const currentInspection = latestInspection === undefined
            ? undefined
            : transaction.select().from(discInspections).where(and(
                eq(
                  discInspections.opticalDriveId,
                  latestInspection.opticalDriveId,
                ),
                eq(discInspections.isCurrent, true),
                eq(discInspections.status, "completed"),
                isNotNull(discInspections.detectedDiscId),
              )).orderBy(desc(discInspections.updatedAt)).limit(1).get();
          const verificationResultDigest = verification === undefined ||
              verification.status !== "completed" ||
              verification.outcome === null ||
              verification.workerExecutionId === null ||
              verification.archiveRecoveryAttemptId === null
            ? null
            : createDvdDiscVerificationResultDigest(
                toDvdDiscVerification(verification),
              );
          const latestVerificationResultDigest =
            latestVerification === undefined ||
              latestVerification.status !== "completed" ||
              latestVerification.outcome === null ||
              latestVerification.workerExecutionId === null ||
              latestVerification.archiveRecoveryAttemptId === null
              ? null
              : createDvdDiscVerificationResultDigest(
                  toDvdDiscVerification(latestVerification),
                );
          const currentIdentities = {
            archiveRecoveryId: recovery.id,
            originalDiscArchiveId: recovery.originalDiscArchiveId,
            archiveRecoveryAttemptId: recovery.attemptId,
            checkpoint: header === undefined ? null : {
              revision: header.currentManifestRevision,
              digest: header.currentManifestDigest,
            },
            insertion: currentInspection === undefined ||
                currentInspection.detectedDiscId === null
              ? null
              : {
                  discInspectionId: currentInspection.id,
                  detectedDiscId: currentInspection.detectedDiscId,
                  mediaGeneration: currentInspection.mediaGeneration,
                },
            verificationId: latestVerification?.id ?? null,
            verificationWorkerExecutionId:
              latestVerification?.workerExecutionId ?? null,
            verificationResultDigest: latestVerificationResultDigest,
          };
          const reasons: Array<{
            code:
              | "RECOVERY_ATTEMPT_CHANGED"
              | "DISC_INSERTION_CHANGED"
              | "WORKER_EXECUTION_CHANGED"
              | "DISC_CHECKPOINT_CHANGED"
              | "DISC_VERIFICATION_CHANGED"
              | "DISC_VERIFICATION_RESULT_CHANGED";
            message: string;
          }> = [];
          if (
            recovery.originalDiscArchiveId !== input.originalDiscArchiveId ||
            recovery.attemptId !== input.archiveRecoveryAttemptId
          ) reasons.push({
            code: "RECOVERY_ATTEMPT_CHANGED",
            message: "The Archive Recovery attempt changed after preview.",
          });
          if (
            header === undefined ||
            header.currentManifestRevision !== input.checkpointRevision ||
            header.currentManifestDigest !== input.checkpointDigest ||
            verification?.checkpointRevision !== input.checkpointRevision ||
            verification.checkpointDigest !== input.checkpointDigest
          ) reasons.push({
            code: "DISC_CHECKPOINT_CHANGED",
            message: "The archive checkpoint changed after preview.",
          });
          if (
            verification === undefined ||
            latestVerification?.id !== verification.id ||
            verification.archiveRecoveryId !== recovery.id ||
            verification.archiveRecoveryAttemptId !== recovery.attemptId ||
            verification.archiveRecoveryAttemptId !==
              input.archiveRecoveryAttemptId ||
            verification.originalDiscArchiveId !== archive.id ||
            verification.id !== input.verificationId ||
            verification.outcome !== input.verificationOutcome ||
            verification.status !== "completed"
          ) reasons.push({
            code: "DISC_VERIFICATION_CHANGED",
            message: "The reviewed DVD Disc Verification changed after preview.",
          });
          if (
            verification?.workerExecutionId !==
              input.verificationWorkerExecutionId
          ) reasons.push({
            code: "WORKER_EXECUTION_CHANGED",
            message: "The verification worker execution changed after preview.",
          });
          if (verificationResultDigest !== input.verificationResultDigest) {
            reasons.push({
              code: "DISC_VERIFICATION_RESULT_CHANGED",
              message: "The reviewed DVD Disc Verification result changed after preview.",
            });
          }
          if (
            verification === undefined ||
            inspection === undefined ||
            !dvdDiscVerificationInsertionIsCurrent(verification, inspection) ||
            verification.discInspectionId !== input.discInspectionId ||
            verification.detectedDiscId !== input.detectedDiscId ||
            verification.mediaGeneration !== input.mediaGeneration
          ) reasons.push({
            code: "DISC_INSERTION_CHANGED",
            message: "The current DVD insertion changed after preview.",
          });
          if (reasons.length > 0) {
            throw new StaleDvdDiscConfirmationError(
              reasons,
              currentIdentities,
            );
          }
          requireNoActiveEncodeWork(transaction, recovery);
          const existing = transaction.select().from(dvdDiscConfirmations)
            .where(eq(
              dvdDiscConfirmations.verificationId,
              input.verificationId,
            )).get();
          if (existing?.expiredAt !== null && existing !== undefined) {
            throw new StaleDvdDiscConfirmationError([{
              code: existing.expiryReason ?? "DISC_VERIFICATION_CHANGED",
              message:
                "The prior DVD Disc Confirmation expired; run a new verification before confirming again.",
            }], currentIdentities);
          }
          const timestamp = now();
          const confirmation = existing ?? requireRow(
            transaction.insert(dvdDiscConfirmations).values({
              id: newId<DvdDiscConfirmationId>(),
              archiveRecoveryId: recovery.id,
              archiveRecoveryAttemptId: recovery.attemptId,
              originalDiscArchiveId: archive.id,
              verificationId: input.verificationId,
              discInspectionId: input.discInspectionId,
              detectedDiscId: input.detectedDiscId,
              mediaGeneration: input.mediaGeneration,
              verificationWorkerExecutionId:
                input.verificationWorkerExecutionId,
              verificationOutcome: input.verificationOutcome,
              verificationResultDigest: input.verificationResultDigest,
              checkpointRevision: input.checkpointRevision,
              checkpointDigest: input.checkpointDigest,
              acknowledgedMixedSource: true,
              createdAt: timestamp,
            }).returning().get(),
            "DVD Disc Confirmation",
            input.verificationId,
          );
          if (waitingResumeConfirmation) {
            requireRow(
              transaction.update(archiveRecoveryWork).set({
                discConfirmationId: confirmation.id,
                updatedAt: timestamp,
              }).where(and(
                eq(archiveRecoveryWork.archiveRecoveryId, recovery.id),
                eq(archiveRecoveryWork.attemptId, recovery.attemptId),
                eq(archiveRecoveryWork.status, "requested"),
                eq(
                  archiveRecoveryWork.verificationId,
                  input.verificationId,
                ),
              )).returning({
                archiveRecoveryId: archiveRecoveryWork.archiveRecoveryId,
              }).get(),
              "Archive Recovery work",
              recovery.id,
            );
            requireRow(
              transaction.update(archiveRecoveries).set({
                status: "eligible",
                updatedAt: timestamp,
              }).where(and(
                eq(archiveRecoveries.id, recovery.id),
                eq(archiveRecoveries.attemptId, recovery.attemptId),
                eq(archiveRecoveries.status, "waiting_for_disc"),
              )).returning({ id: archiveRecoveries.id }).get(),
              "Archive Recovery",
              recovery.id,
            );
          }
          return recordMutationInvocation(
            transaction,
            mutationKey,
            operation,
            semanticInput,
            toDvdDiscConfirmation(confirmation),
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      find(id) {
        const row = database.select().from(dvdDiscConfirmations)
          .where(eq(dvdDiscConfirmations.id, id)).get();
        return row === undefined ? null : toDvdDiscConfirmation(row);
      },
      findLatestForRecovery(id) {
        const row = database.select({ confirmation: dvdDiscConfirmations })
          .from(dvdDiscConfirmations)
          .innerJoin(
            dvdDiscVerifications,
            eq(
              dvdDiscVerifications.id,
              dvdDiscConfirmations.verificationId,
            ),
          )
          .where(eq(dvdDiscConfirmations.archiveRecoveryId, id))
          .orderBy(
            desc(dvdDiscVerifications.attemptOrdinal),
            desc(dvdDiscConfirmations.createdAt),
            desc(dvdDiscConfirmations.id),
          )
          .limit(1).get();
        return row === undefined
          ? null
          : toDvdDiscConfirmation(row.confirmation);
      },
      listForRecovery(id) {
        return database.select().from(dvdDiscConfirmations)
          .where(eq(dvdDiscConfirmations.archiveRecoveryId, id))
          .orderBy(asc(dvdDiscConfirmations.createdAt), asc(dvdDiscConfirmations.id))
          .all().map(toDvdDiscConfirmation);
      },
      listProvenanceForRecovery(id) {
        return database.transaction((transaction) => {
          const rows = transaction.select({
            confirmation: dvdDiscConfirmations,
            recoveredSectorCount: sql<number>`coalesce(sum(case when ${dvdArchiveRecoveryReads.outcome} = 'recovered' then 1 else 0 end), 0)`.mapWith(Number),
            failedReadCount: sql<number>`coalesce(sum(case when ${dvdArchiveRecoveryReads.outcome} = 'failed' then 1 else 0 end), 0)`.mapWith(Number),
            firstRecoveredLba: sql<number | null>`min(case when ${dvdArchiveRecoveryReads.outcome} = 'recovered' then ${dvdArchiveRecoveryReads.startLba} end)`.mapWith((value) => value === null ? null : Number(value)),
            lastRecoveredLba: sql<number | null>`max(case when ${dvdArchiveRecoveryReads.outcome} = 'recovered' then ${dvdArchiveRecoveryReads.startLba} end)`.mapWith((value) => value === null ? null : Number(value)),
          }).from(dvdDiscConfirmations).leftJoin(
            dvdArchiveRecoveryReads,
            eq(
              dvdArchiveRecoveryReads.discConfirmationId,
              dvdDiscConfirmations.id,
            ),
          ).where(eq(dvdDiscConfirmations.archiveRecoveryId, id)).groupBy(
            dvdDiscConfirmations.id,
          ).orderBy(
            asc(dvdDiscConfirmations.createdAt),
            asc(dvdDiscConfirmations.id),
          ).limit(DVD_DISC_CONFIRMATION_PROVENANCE_LIMIT + 1).all();
          const selected = rows.slice(
            0,
            DVD_DISC_CONFIRMATION_PROVENANCE_LIMIT,
          );
          const rangesByConfirmation = new Map<
            DvdDiscConfirmationId,
            Array<{ startLba: number; sectorCount: number }>
          >();
          const confirmationsWithTruncatedRanges = new Set<
            DvdDiscConfirmationId
          >();
          if (selected.length > 0) {
            const confirmationIds = selected.map((row) =>
              row.confirmation.id
            );
            const recoveredRanges = sqlite.prepare(`
              with ordered_reads as (
                select
                  disc_confirmation_id,
                  start_lba,
                  start_lba - row_number() over (
                    partition by disc_confirmation_id
                    order by start_lba
                  ) as range_key
                from dvd_archive_recovery_reads
                where disc_confirmation_id in (
                  ${confirmationIds.map(() => "?").join(", ")}
                )
                  and outcome = 'recovered'
              ), grouped_ranges as (
                select
                  disc_confirmation_id,
                  min(start_lba) as start_lba,
                  count(*) as sector_count
                from ordered_reads
                group by disc_confirmation_id, range_key
              ), ranked_ranges as (
                select
                  disc_confirmation_id,
                  start_lba,
                  sector_count,
                  row_number() over (
                    partition by disc_confirmation_id
                    order by start_lba
                  ) as range_rank
                from grouped_ranges
              )
              select
                disc_confirmation_id,
                start_lba,
                sector_count,
                range_rank
              from ranked_ranges
              where range_rank <= ?
              order by disc_confirmation_id, start_lba
            `).all(
              ...confirmationIds,
              DVD_DISC_CONFIRMATION_RECOVERED_RANGE_LIMIT + 1,
            ) as unknown as Array<{
              disc_confirmation_id: DvdDiscConfirmationId;
              start_lba: number;
              sector_count: number;
              range_rank: number;
            }>;
            for (const range of recoveredRanges) {
              if (
                range.range_rank >
                  DVD_DISC_CONFIRMATION_RECOVERED_RANGE_LIMIT
              ) {
                confirmationsWithTruncatedRanges.add(
                  range.disc_confirmation_id,
                );
              } else {
                const ranges = rangesByConfirmation.get(
                  range.disc_confirmation_id,
                ) ?? [];
                ranges.push({
                  startLba: range.start_lba,
                  sectorCount: range.sector_count,
                });
                rangesByConfirmation.set(
                  range.disc_confirmation_id,
                  ranges,
                );
              }
            }
          }
          const imageUsesConfirmedSource = transaction.select({
            id: dvdArchiveRecoveryReads.id,
          }).from(dvdArchiveRecoveryReads).innerJoin(
            dvdDiscConfirmations,
            eq(
              dvdDiscConfirmations.id,
              dvdArchiveRecoveryReads.discConfirmationId,
            ),
          ).where(and(
            eq(dvdDiscConfirmations.archiveRecoveryId, id),
            eq(dvdArchiveRecoveryReads.outcome, "recovered"),
          )).limit(1).get() !== undefined;
          return {
            items: selected.map(
              (row) => ({
                confirmation: toDvdDiscConfirmation(row.confirmation),
                recoveredSectorCount: row.recoveredSectorCount,
                failedReadCount: row.failedReadCount,
                firstRecoveredLba: row.firstRecoveredLba,
                lastRecoveredLba: row.lastRecoveredLba,
                recoveredRanges:
                  rangesByConfirmation.get(row.confirmation.id) ?? [],
                recoveredRangesTruncated:
                  confirmationsWithTruncatedRanges.has(row.confirmation.id),
              }),
            ),
            imageUsesConfirmedSource,
            truncated: rows.length > DVD_DISC_CONFIRMATION_PROVENANCE_LIMIT,
          };
        });
      },
      expire(id, reason) {
        return database.update(dvdDiscConfirmations).set({
          expiredAt: now(),
          expiryReason: reason,
        }).where(and(
          eq(dvdDiscConfirmations.id, id),
          isNull(dvdDiscConfirmations.expiredAt),
        )).returning({ id: dvdDiscConfirmations.id }).get() !== undefined;
      },
      expireForWorkerExecution(workerExecutionId, confirmationId) {
        return database.transaction((transaction) =>
          expireInvalidDvdDiscConfirmations(
            transaction,
            workerExecutionId,
            confirmationId,
          ), {
            behavior: "immediate",
          });
      },
    },
    dvdDiscVerifications: {
      replaySubmission(input) {
        const semanticInput = dvdDiscVerificationSemanticInput(input);
        return database.transaction((transaction) =>
          readMutationInvocation(
            transaction,
            input.mutationKey,
            "dvd_disc_verification.submit",
            semanticInput,
            decodeDvdDiscVerificationOutcome,
          ) ?? null);
      },
      submit(input) {
        const semanticInput = dvdDiscVerificationSemanticInput(input);
        return database.transaction((transaction) => {
          const operation = "dvd_disc_verification.submit";
          const previous = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeDvdDiscVerificationOutcome,
          );
          if (previous !== undefined) return previous;
          const recovery = requireRow(
            transaction.select().from(archiveRecoveries)
              .where(eq(archiveRecoveries.id, input.archiveRecoveryId)).get(),
            "archive recovery",
            input.archiveRecoveryId,
          );
          if (recovery.status !== "eligible") {
            throw new InvalidStatusTransitionError(
              "archive recovery",
              recovery.status,
              "DVD Disc Verification",
            );
          }
          const header = requireRow(
            transaction.select().from(dvdArchiveEvidenceHeaders)
              .where(eq(
                dvdArchiveEvidenceHeaders.originalDiscArchiveId,
                recovery.originalDiscArchiveId,
              )).get(),
            "DVD Archive Evidence",
            recovery.originalDiscArchiveId,
          );
          if (!dvdDiscVerificationCheckpointIsCurrent(input, {
            revision: header.currentManifestRevision,
            digest: header.currentManifestDigest,
          })) {
            throw new StaleDvdDiscVerificationError(
              "DISC_CHECKPOINT_CHANGED",
            );
          }
          const archive = requireRow(
            transaction.select().from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, recovery.originalDiscArchiveId))
              .get(),
            "original disc archive",
            recovery.originalDiscArchiveId,
          );
          const inspection = requireRow(
            transaction.select().from(discInspections)
              .where(eq(discInspections.id, input.discInspectionId)).get(),
            "disc inspection",
            input.discInspectionId,
          );
          if (
            !inspection.isCurrent ||
            inspection.status !== "completed" ||
            inspection.detectedDiscId === null
          ) {
            throw new StaleDvdDiscVerificationError(
              "DISC_INSERTION_CHANGED",
            );
          }
          const observedDisc = requireRow(
            transaction.select().from(detectedDiscs)
              .where(eq(detectedDiscs.id, inspection.detectedDiscId)).get(),
            "detected disc",
            inspection.detectedDiscId,
          );
          const active = transaction
            .select({ id: dvdDiscVerifications.id })
            .from(dvdDiscVerifications)
            .where(and(
              eq(
                dvdDiscVerifications.archiveRecoveryId,
                recovery.id,
              ),
              inArray(dvdDiscVerifications.status, ["queued", "running"]),
            ))
            .get();
          if (active !== undefined) {
            throw new InvalidStatusTransitionError(
              "DVD Disc Verification",
              "active",
              "queued",
            );
          }
          const timestamp = now();
          const storedSourceManifest = transaction
            .select({ manifest: dvdSourceSampleManifests.manifest })
            .from(dvdSourceSampleManifests)
            .where(eq(
              dvdSourceSampleManifests.originalDiscArchiveId,
              recovery.originalDiscArchiveId,
            ))
            .get()?.manifest;
          const sourceManifest = storedSourceManifest === undefined
            ? null
            : validateDvdSourceSampleManifest(storedSourceManifest);
          validateDvdDiscVerificationManifestBinding(sourceManifest, {
            sourceMetadataFingerprint: archive.fingerprint,
          }, header);
          const row = insertQueuedDvdDiscVerification(transaction, {
            archiveRecoveryId: recovery.id,
            archiveRecoveryAttemptId: recovery.attemptId,
            originalDiscArchiveId: recovery.originalDiscArchiveId,
            discInspectionId: inspection.id,
            detectedDiscId: observedDisc.id,
            mediaGeneration: inspection.mediaGeneration,
            sourceMetadataFingerprint:
              sourceManifest?.sourceMetadataFingerprint ?? archive.fingerprint,
            observedMetadataFingerprint: observedDisc.fingerprint,
            checkpointRevision: header.currentManifestRevision,
            checkpointDigest: header.currentManifestDigest,
          }, timestamp);
          recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            row,
            timestamp,
          );
          return toDvdDiscVerification(row);
        }, { behavior: "immediate" });
      },
      find(id) {
        const row = database.select().from(dvdDiscVerifications)
          .where(eq(dvdDiscVerifications.id, id)).get();
        return row === undefined ? null : toDvdDiscVerification(row);
      },
      findLatestForRecovery(id) {
        const row = database.select().from(dvdDiscVerifications)
          .where(eq(dvdDiscVerifications.archiveRecoveryId, id))
          .orderBy(
            desc(dvdDiscVerifications.attemptOrdinal),
          ).limit(1).get();
        return row === undefined ? null : toDvdDiscVerification(row);
      },
      listForRecoveryAttempt(id, attemptId) {
        return database.select().from(dvdDiscVerifications).where(and(
          eq(dvdDiscVerifications.archiveRecoveryId, id),
          eq(dvdDiscVerifications.archiveRecoveryAttemptId, attemptId),
        )).orderBy(
          asc(dvdDiscVerifications.attemptOrdinal),
        ).all().map(toDvdDiscVerification);
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - DVD_DISC_VERIFICATION_CLAIM_LEASE_MS,
        );
        return database.transaction((transaction) => {
          const expired = transaction.select().from(dvdDiscVerifications)
            .where(and(
              eq(dvdDiscVerifications.status, "running"),
              lt(dvdDiscVerifications.claimedAt, expiredBefore),
            )).all();
          for (const verification of expired) {
            const claimToken = verification.claimToken;
            if (claimToken === null) {
              throw new DomainInvariantError(
                "Running DVD Disc Verification has no claim token",
              );
            }
            const evaluated = evaluatePersistedDvdDiscVerification(
              transaction,
              verification,
              {
                findings: verification.findings,
                budgetExhausted: verification.budgetExhausted,
                interrupted: true,
              },
            );
            const completed = transaction.update(dvdDiscVerifications).set({
              status: "completed",
              outcome: evaluated.outcome,
              reasons: evaluated.reasons,
              claimToken: null,
              claimedAt: null,
              completedAt: timestamp,
              updatedAt: timestamp,
            }).where(and(
              eq(dvdDiscVerifications.id, verification.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).returning().get();
            if (completed !== undefined) {
              settleGeneratedContinuationVerification(
                transaction,
                completed,
                evaluated,
                timestamp,
              );
            }
          }
          return expired.length;
        }, { behavior: "immediate" });
      },
      claimNext(workerExecutionId) {
        const execution = requireNonEmpty(
          workerExecutionId.trim(),
          "DVD Disc Verification worker execution ID",
        );
        if (execution.length > 256) {
          throw new DomainInvariantError(
            "DVD Disc Verification worker execution ID is too long",
          );
        }
        return database.transaction((transaction) => {
          const next = transaction.select({
            verification: dvdDiscVerifications,
          }).from(dvdDiscVerifications).innerJoin(
            archiveRecoveries,
            and(
              eq(
                archiveRecoveries.id,
                dvdDiscVerifications.archiveRecoveryId,
              ),
              eq(
                archiveRecoveries.attemptId,
                dvdDiscVerifications.archiveRecoveryAttemptId,
              ),
            ),
          ).where(and(
            eq(dvdDiscVerifications.status, "queued"),
            eq(archiveRecoveries.status, "eligible"),
          ))
            .orderBy(
              asc(dvdDiscVerifications.createdAt),
              asc(dvdDiscVerifications.id),
            ).limit(1).get()?.verification;
          if (next === undefined) return null;
          const timestamp = now();
          const claimed = transaction.update(dvdDiscVerifications).set({
            status: "running",
            workerExecutionId: execution,
            claimToken: newId<DvdDiscVerificationClaimToken>(),
            claimedAt: timestamp,
            startedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(dvdDiscVerifications.id, next.id),
            eq(dvdDiscVerifications.status, "queued"),
          )).returning().get();
          return claimed === undefined
            ? null
            : toDvdDiscVerification(claimed);
        }, { behavior: "immediate" });
      },
      renewClaim(claim) {
        if (claim.claimToken === null) return false;
        const claimToken = claim.claimToken;
        return database.transaction((transaction) => {
          const current = transaction.select().from(dvdDiscVerifications)
            .where(and(
              eq(dvdDiscVerifications.id, claim.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).get();
          if (current === undefined) return false;
          const recovery = transaction.select().from(archiveRecoveries)
            .where(eq(archiveRecoveries.id, current.archiveRecoveryId)).get();
          if (
            recovery?.status !== "eligible" ||
            recovery.attemptId !== current.archiveRecoveryAttemptId
          ) return false;
          const timestamp = now();
          return transaction.update(dvdDiscVerifications).set({
            claimedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(dvdDiscVerifications.id, claim.id),
            eq(dvdDiscVerifications.status, "running"),
            eq(dvdDiscVerifications.claimToken, claimToken),
          )).returning({ id: dvdDiscVerifications.id }).get() !== undefined;
        }, { behavior: "immediate" });
      },
      admitSourceRead(claim, identity) {
        if (claim.claimToken === null || claim.status !== "running") {
          return false;
        }
        const claimToken = claim.claimToken;
        return database.transaction((transaction) => {
          const current = transaction.select().from(dvdDiscVerifications)
            .where(and(
              eq(dvdDiscVerifications.id, claim.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).get();
          if (current === undefined) return false;
          const recovery = transaction.select().from(archiveRecoveries)
            .where(eq(archiveRecoveries.id, current.archiveRecoveryId)).get();
          if (
            recovery?.status !== "eligible" ||
            recovery.attemptId !== current.archiveRecoveryAttemptId
          ) return false;
          const inspection = transaction.select().from(discInspections)
            .where(eq(discInspections.id, current.discInspectionId)).get();
          const drive = inspection === undefined
            ? undefined
            : transaction.select().from(opticalDrives).where(eq(
              opticalDrives.id,
              inspection.opticalDriveId,
            )).get();
          if (
            !dvdDiscVerificationInsertionIsCurrent(current, inspection) ||
            drive === undefined ||
            !drive.isPresent ||
            !drive.isEnabled
          ) return false;
          const timestamp = now();
          const renewed = transaction.update(dvdDiscVerifications).set({
            claimedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(
            eq(dvdDiscVerifications.id, claim.id),
            eq(dvdDiscVerifications.status, "running"),
            eq(dvdDiscVerifications.claimToken, claimToken),
          )).returning({ id: dvdDiscVerifications.id }).get();
          if (renewed === undefined) return false;
          if (
            identity.devicePath !== drive.devicePath ||
            !/^\d+$/.test(identity.deviceId) ||
            !/^\d+$/.test(identity.inode)
          ) {
            throw new DomainInvariantError(
              "DVD Disc Verification source device identity is invalid",
            );
          }
          requireRow(
            transaction.update(dvdDiscVerifications).set({
              admittedDevicePath: identity.devicePath,
              admittedDeviceId: identity.deviceId,
              admittedDeviceInode: identity.inode,
              updatedAt: now(),
            }).where(and(
              eq(dvdDiscVerifications.id, claim.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).returning({ id: dvdDiscVerifications.id }).get(),
            "DVD Disc Verification",
            claim.id,
          );
          return true;
        }, { behavior: "immediate" });
      },
      appendFinding(claim, finding) {
        if (claim.claimToken === null || claim.status !== "running") {
          throw new StaleJobAttemptError("DVD Disc Verification", claim.id);
        }
        const claimToken = claim.claimToken;
        return database.transaction((transaction) => {
          const current = transaction.select().from(dvdDiscVerifications)
            .where(eq(dvdDiscVerifications.id, claim.id)).get();
          if (
            current?.status !== "running" ||
            current.claimToken !== claimToken
          ) {
            throw new StaleJobAttemptError(
              "DVD Disc Verification",
              claim.id,
            );
          }
          const recovery = transaction.select().from(archiveRecoveries)
            .where(eq(archiveRecoveries.id, current.archiveRecoveryId)).get();
          if (
            recovery?.status !== "eligible" ||
            recovery.attemptId !== current.archiveRecoveryAttemptId
          ) {
            throw new StaleJobAttemptError(
              "DVD Disc Verification",
              claim.id,
            );
          }
          const { manifest } = readDvdDiscVerificationEvidence(
            transaction,
            current,
          );
          const findings = [...current.findings, finding];
          validateDvdDiscVerificationFindings(manifest, findings);
          const timestamp = now();
          return toDvdDiscVerification(requireRow(
            transaction.update(dvdDiscVerifications).set({
              findings,
              claimedAt: timestamp,
              updatedAt: timestamp,
            }).where(and(
              eq(dvdDiscVerifications.id, claim.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).returning().get(),
            "DVD Disc Verification",
            claim.id,
          ));
        }, { behavior: "immediate" });
      },
      complete(claim, result) {
        if (claim.claimToken === null || claim.status !== "running") {
          throw new StaleJobAttemptError("DVD Disc Verification", claim.id);
        }
        const claimToken = claim.claimToken;
        return database.transaction((transaction) => {
          const current = transaction.select().from(dvdDiscVerifications)
            .where(eq(dvdDiscVerifications.id, claim.id)).get();
          if (
            current?.status !== "running" ||
            current.claimToken !== claimToken
          ) {
            throw new StaleJobAttemptError(
              "DVD Disc Verification",
              claim.id,
            );
          }
          const recovery = transaction.select().from(archiveRecoveries)
            .where(eq(archiveRecoveries.id, current.archiveRecoveryId)).get();
          if (
            recovery?.status !== "eligible" ||
            recovery.attemptId !== current.archiveRecoveryAttemptId
          ) {
            throw new StaleJobAttemptError(
              "DVD Disc Verification",
              claim.id,
            );
          }
          if (
            canonicalPublicationJson(current.findings) !==
              canonicalPublicationJson(result.findings)
          ) {
            throw new DomainInvariantError(
              "DVD Disc Verification findings were not durably recorded",
            );
          }
          const evaluated = evaluatePersistedDvdDiscVerification(
            transaction,
            current,
            {
              findings: result.findings,
              budgetExhausted: result.budgetExhausted,
              interrupted: result.interrupted,
              insertionChanged: result.insertionChanged,
              checkpointChanged: result.checkpointChanged,
            },
          );
          const timestamp = now();
          const completed = requireRow(
            transaction.update(dvdDiscVerifications).set({
              status: "completed",
              outcome: evaluated.outcome,
              reasons: evaluated.reasons,
              findings: result.findings,
              budgetExhausted: result.budgetExhausted,
              claimToken: null,
              claimedAt: null,
              completedAt: timestamp,
              updatedAt: timestamp,
            }).where(and(
              eq(dvdDiscVerifications.id, claim.id),
              eq(dvdDiscVerifications.status, "running"),
              eq(dvdDiscVerifications.claimToken, claimToken),
            )).returning().get(),
            "DVD Disc Verification",
            claim.id,
          );
          settleGeneratedContinuationVerification(
            transaction,
            completed,
            evaluated,
            timestamp,
          );
          return toDvdDiscVerification(completed);
        }, { behavior: "immediate" });
      },
      fail(claim) {
        if (claim.claimToken === null) return null;
        const claimToken = claim.claimToken;
        return database.transaction((transaction) => {
          const timestamp = now();
          const row = transaction.update(dvdDiscVerifications).set({
            status: "failed",
            claimToken: null,
            claimedAt: null,
            completedAt: timestamp,
            failureCode: "DISC_VERIFICATION_UNAVAILABLE",
            updatedAt: timestamp,
          }).where(and(
            eq(dvdDiscVerifications.id, claim.id),
            eq(dvdDiscVerifications.status, "running"),
            eq(dvdDiscVerifications.claimToken, claimToken),
          )).returning().get();
          if (row === undefined) return null;
          settleGeneratedContinuationVerification(
            transaction,
            row,
            null,
            timestamp,
          );
          return toDvdDiscVerification(row);
        }, { behavior: "immediate" });
      },
    },
    readConsistentSnapshot(read) {
      const snapshotAccess: ConsistentReadAccess = {
        damagePreviews: { find: (id) => access.damagePreviews.find(id), list: (id) => access.damagePreviews.list(id) },
        dvdTitleDamageAssessments: {
          inspect: inspectDvdTitleDamageAssessment,
        },
        dvdStructuralAssessments: {
          inspect: inspectDvdStructuralAssessment,
        },
        dvdRecoveryStorage: {
          readCurrent: readCurrentDvdRecoveryStoragePreflight,
        },
        dvdRecoveryReconciliations: {
          find: (id) => access.dvdRecoveryReconciliations.find(id),
          findLatestForRecovery: (id) =>
            access.dvdRecoveryReconciliations.findLatestForRecovery(id),
          list: (options) => access.dvdRecoveryReconciliations.list(options),
          listActive: () => access.dvdRecoveryReconciliations.listActive(),
        },
        catalog: {
          listOpticalDrives: (options) =>
            access.catalog.listOpticalDrives(options),
          listDetectedDiscs: (statuses, options) =>
            access.catalog.listDetectedDiscs(statuses, options),
          listOriginalDiscArchives: (options) =>
            access.catalog.listOriginalDiscArchives(options),
          findDvdArchiveEvidenceHeader: (id) =>
            access.catalog.findDvdArchiveEvidenceHeader(id),
          findDvdArchiveEvidenceHeaders: (ids) =>
            access.catalog.findDvdArchiveEvidenceHeaders(ids),
          readDvdTitleIdentityReviewSet: (id) =>
            access.catalog.readDvdTitleIdentityReviewSet(id),
          readDvdCatalogReviewWorkflowEvidence: (ids) =>
            access.catalog.readDvdCatalogReviewWorkflowEvidence(ids),
          listCatalogReviewEvidenceChoices: (id, options) =>
            access.catalog.listCatalogReviewEvidenceChoices(id, options),
          inspectDvdTitleDamageDecision: (id) =>
            access.catalog.inspectDvdTitleDamageDecision(id),
          findArchiveRecovery: (id) =>
            access.catalog.findArchiveRecovery(id),
          findArchiveRecoveryById: (id) =>
            access.catalog.findArchiveRecoveryById(id),
          readDvdArchiveRecoveryRangeEvidence: (id, options) =>
            access.catalog.readDvdArchiveRecoveryRangeEvidence(id, options),
          listArchiveRecoveries: (options) =>
            access.catalog.listArchiveRecoveries(options),
          findDvdSourceSampleManifest: (id) =>
            access.catalog.findDvdSourceSampleManifest(id),
          listCatalogReviewArchives: (options) =>
            access.catalog.listCatalogReviewArchives(options),
          listMediaItems: (options) => access.catalog.listMediaItems(options),
          listMediaItemMaintenance: (options) =>
            access.catalog.listMediaItemMaintenance(options),
          previewMediaItemUpdate: (id, input) =>
            access.catalog.previewMediaItemUpdate(id, input),
          inspectMediaItemImpact: (id) => access.catalog.inspectMediaItemImpact(id),
          findTmdbIdentityByMediaItemId: (id) =>
            access.catalog.findTmdbIdentityByMediaItemId(id),
          searchMediaItems: (options) =>
            access.catalog.searchMediaItems(options),
          listDiscSelections: (options) =>
            access.catalog.listDiscSelections(options),
          readRearchiveMappingProposal: (originalDiscArchiveId) =>
            access.catalog.readRearchiveMappingProposal(
              originalDiscArchiveId,
            ),
          previewRearchiveMappingProposal: (input) =>
            access.catalog.previewRearchiveMappingProposal(input),
          planRearchiveAcceptance: (input) =>
            access.catalog.planRearchiveAcceptance(input),
          listRearchiveEncodeReplacementPlans: (options) =>
            access.catalog.listRearchiveEncodeReplacementPlans(options),
          getCatalogReviewCoverage: (originalDiscArchiveId) =>
            access.catalog.getCatalogReviewCoverage(originalDiscArchiveId),
          getCatalogReviewActionAvailability: (originalDiscArchiveId) =>
            access.catalog.getCatalogReviewActionAvailability(originalDiscArchiveId),
          listDiscSelectionSupersessions: (options) =>
            access.catalog.listDiscSelectionSupersessions(options),
          listCorrectedEncodeReplacementPlans: (options) =>
            access.catalog.listCorrectedEncodeReplacementPlans(options),
          listDiscSelectionActionAvailability: (options) =>
            access.catalog.listDiscSelectionActionAvailability(options),
        },
        encodingProfiles: {
          list: (input) => access.encodingProfiles.list(input),
        },
        discInspections: {
          list: (options) => access.discInspections.list(options),
          listAttempts: (id) => access.discInspections.listAttempts(id),
        },
        archiveRequests: {
          find: (id) => access.archiveRequests.find(id),
          list: (statuses, options) =>
            access.archiveRequests.list(statuses, options),
          listForDetectedDisc: (id) =>
            access.archiveRequests.listForDetectedDisc(id),
          listForRearchiveSources: (ids) =>
            access.archiveRequests.listForRearchiveSources(ids),
          listRelevantForDetectedDiscs: (detectedDiscIds) =>
            access.archiveRequests.listRelevantForDetectedDiscs(
              detectedDiscIds,
            ),
          waitingStatus: (id) => access.archiveRequests.waitingStatus(id),
        },
        archiveJobs: {
          find: (id) => access.archiveJobs.find(id),
          list: (statuses, options) => access.archiveJobs.list(statuses, options),
          listForInspection: (id) => access.archiveJobs.listForInspection(id),
          listForArchive: (id) => access.archiveJobs.listForArchive(id),
          listLatestForRequests: (archiveRequestIds) =>
            access.archiveJobs.listLatestForRequests(archiveRequestIds),
        },
        encodeJobs: {
          listClaimSnapshots: (id, options) => access.encodeJobs.listClaimSnapshots(id, options),
          listValidationFailedOutputs: (id, page) => access.encodeJobs.listValidationFailedOutputs(id, page),
          find: (id) => access.encodeJobs.find(id),
          list: (statuses, options) => access.encodeJobs.list(statuses, options),
          listForDiscSelection: (id) =>
            access.encodeJobs.listForDiscSelection(id),
          listActiveForDiscSelections: (options) =>
            access.encodeJobs.listActiveForDiscSelections(options),
          listDvdTitleDamageAcceptanceWithdrawalWork: (options) =>
            access.encodeJobs
              .listDvdTitleDamageAcceptanceWithdrawalWork(options),
          listActiveForOriginalDiscArchives: (options) =>
            access.encodeJobs.listActiveForOriginalDiscArchives(options),
          hasReservedOutputPathConflict: (job) =>
            access.encodeJobs.hasReservedOutputPathConflict(job),
          hasReservedOutputPath: (outputPath) =>
            access.encodeJobs.hasReservedOutputPath(outputPath),
          resolveQueueLogicalJobs: (options) =>
            access.encodeJobs.resolveQueueLogicalJobs(options),
          listQueueDiscSelections: (options) =>
            access.encodeJobs.listQueueDiscSelections(options),
          listDiscSelectionCorrectionEncodeJobLinks: (options) =>
            access.encodeJobs.listDiscSelectionCorrectionEncodeJobLinks(
              options,
            ),
          listDiscSelectionCorrectionRetainedOutputSummaries: (options) =>
            access.encodeJobs
              .listDiscSelectionCorrectionRetainedOutputSummaries(options),
          listCorrectionLinks: (ids) =>
            access.encodeJobs.listCorrectionLinks(ids),
          listFailureReports: (ids) =>
            access.encodeJobs.listFailureReports(ids),
          listRetainedOutputSummaries: (ids, options) =>
            access.encodeJobs.listRetainedOutputSummaries(ids, options),
          listRetainedOutputSummaryPageBySource: (ids, options) =>
            access.encodeJobs.listRetainedOutputSummaryPageBySource(
              ids,
              options,
            ),
          listRetainedOutputHistoryPage: (id, options) =>
            access.encodeJobs.listRetainedOutputHistoryPage(id, options),
        },
        workerIncidents: {
          find: (id) => access.workerIncidents.find(id),
          list: (options) => access.workerIncidents.list(options),
        },
        filesystemVerification: {
          find: (id) => access.filesystemVerification.find(id),
          list: (options) => access.filesystemVerification.list(options),
          listActive: () => access.filesystemVerification.listActive(),
        },
        archiveAudits: {
          find: (id) => access.archiveAudits.find(id),
          list: (options) => access.archiveAudits.list(options),
          listActive: () => access.archiveAudits.listActive(),
        },
      };
      sqlite.exec("SAVEPOINT consistent_read_snapshot");
      try {
        const result = read(snapshotAccess);
        if (result instanceof Promise) {
          throw new DomainInvariantError(
            "Consistent snapshot reads must be synchronous",
          );
        }
        sqlite.exec("RELEASE consistent_read_snapshot");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK TO consistent_read_snapshot");
        sqlite.exec("RELEASE consistent_read_snapshot");
        throw error;
      }
    },

    readEncodeOutputInspectionSnapshot(read) {
      return access.readConsistentSnapshot((snapshot) =>
        read({
          ...snapshot,
          encodeJobs: {
            ...snapshot.encodeJobs,
            findOutputValidation: (id, identity, validatedAt) =>
              access.encodeJobs.findOutputValidation(id, identity, validatedAt),
            findRetainedOutput: (id) =>
              access.encodeJobs.findRetainedOutput(id),
            findValidationFailedOutput: (id) => access.encodeJobs.findValidationFailedOutput(id),
          },
        })
      );
    },

    checkHealth() {
      const version = sqlite
        .prepare("select sqlite_version() as version")
        .get() as { version: string };
      const journal = sqlite.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      const timeout = sqlite.prepare("PRAGMA busy_timeout").get() as {
        timeout: number;
      };

      return {
        status: "ok",
        sqliteVersion: version.version,
        journalMode: journal.journal_mode,
        busyTimeoutMs: timeout.timeout,
      };
    },

    catalog: {
      reconcileOpticalDrives(discovered) {
        const timestamp = now();

        return database.transaction((transaction) => {
          const existingDrives = transaction
            .select({
              id: opticalDrives.id,
              devicePath: opticalDrives.devicePath,
              configurationDefaultResolved:
                opticalDrives.configurationDefaultResolved,
              isConfiguredTarget: opticalDrives.isConfiguredTarget,
              isPresent: opticalDrives.isPresent,
              serialNumber: opticalDrives.serialNumber,
              vendor: opticalDrives.vendor,
              product: opticalDrives.product,
            })
            .from(opticalDrives)
            .all();
          const plan = planOpticalDriveReconciliation(
            discovered,
            existingDrives,
          );
          if (plan.configuredTargetPath !== undefined) {
            transaction
              .update(opticalDrives)
              .set({ isConfiguredTarget: false })
              .where(eq(opticalDrives.isConfiguredTarget, true))
              .run();
          }
          transaction
            .update(opticalDrives)
            .set({ isPresent: false, updatedAt: timestamp })
            .where(eq(opticalDrives.isPresent, true))
            .run();

          for (const decision of plan.drives) {
            const { drive } = decision;
            if (decision.existingId !== undefined) {
              transaction
                .update(opticalDrives)
                .set({
                  devicePath: drive.devicePath,
                  displayName: drive.displayName,
                  vendor: drive.vendor ?? null,
                  product: drive.product ?? null,
                  serialNumber: drive.serialNumber ?? null,
                  ...(drive.isConfiguredDevice
                    ? { isConfiguredTarget: true }
                    : {}),
                  ...decision.authorizationUpdate,
                  isPresent: true,
                  lastSeenAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(eq(opticalDrives.id, decision.existingId))
                .run();
            } else {
              transaction.insert(opticalDrives).values({
                id: newId<OpticalDriveId>(),
                devicePath: drive.devicePath,
                displayName: drive.displayName,
                vendor: drive.vendor,
                product: drive.product,
                serialNumber: drive.serialNumber,
                ...decision.insertAuthorization,
                isConfiguredTarget: drive.isConfiguredDevice,
                isPresent: true,
                lastSeenAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              }).run();
            }
          }

          return transaction
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .orderBy(asc(opticalDrives.devicePath))
            .all();
        }, { behavior: "immediate" });
      },

      upsertOpticalDrive(input) {
        const timestamp = now();
        const devicePath = requireNonEmpty(input.devicePath, "devicePath");
        return database.transaction((transaction) => {
          const existing = transaction
            .select({ id: opticalDrives.id })
            .from(opticalDrives)
            .where(eq(opticalDrives.devicePath, devicePath))
            .orderBy(
              desc(opticalDrives.isPresent),
              desc(opticalDrives.lastSeenAt),
            )
            .limit(1)
            .get();
          if (existing !== undefined) {
            const updated = transaction
              .update(opticalDrives)
              .set({
                displayName: input.displayName,
                vendor: input.vendor,
                product: input.product,
                serialNumber: input.serialNumber,
                isEnabled: input.isEnabled,
                ...(input.isEnabled !== undefined
                  ? { configurationDefaultResolved: true }
                  : {}),
                isPresent: input.isPresent,
                lastSeenAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(opticalDrives.id, existing.id))
              .returning(opticalDriveSelection)
              .get();
            return requireRow(updated, "optical drive", devicePath);
          }
          const inserted = transaction
            .insert(opticalDrives)
            .values({
              id: newId<OpticalDriveId>(),
              devicePath,
              displayName: input.displayName,
              vendor: input.vendor,
              product: input.product,
              serialNumber: input.serialNumber,
              isEnabled: input.isEnabled ?? false,
              configurationDefaultResolved: true,
              isPresent: input.isPresent,
              lastSeenAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning(opticalDriveSelection)
            .get();
          return requireRow(inserted, "optical drive", devicePath);
        }, { behavior: "immediate" });
      },

      listOpticalDrives(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const condition = options?.ids
          ? inArray(opticalDrives.id, [...options.ids])
          : undefined;
        if (options?.historicalLimit !== undefined) {
          const current = database
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .where(
              and(
                condition,
                or(
                  eq(opticalDrives.isPresent, true),
                  eq(opticalDrives.isEnabled, true),
                ),
              ),
            )
            .all();
          const history = database
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .where(
              and(
                condition,
                eq(opticalDrives.isPresent, false),
                eq(opticalDrives.isEnabled, false),
              ),
            )
            .orderBy(
              desc(opticalDrives.lastSeenAt),
              desc(opticalDrives.id),
            )
            .limit(
              requirePositiveSafeInteger(
                options.historicalLimit,
                "historicalLimit",
              ),
            )
            .all();
          return [...current, ...history].sort((left, right) =>
            left.devicePath.localeCompare(right.devicePath),
          );
        }
        if (options?.limit !== undefined) {
          return database
            .select(opticalDriveSelection)
            .from(opticalDrives)
            .where(condition)
            .orderBy(desc(opticalDrives.lastSeenAt), desc(opticalDrives.id))
            .limit(requirePositiveSafeInteger(options.limit, "limit"))
            .all()
            .reverse();
        }
        return database
          .select(opticalDriveSelection)
          .from(opticalDrives)
          .where(condition)
          .orderBy(asc(opticalDrives.devicePath))
          .all();
      },

      registerDetectedDisc(input) {
        const timestamp = now();
        const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
        const scanData = normalizeDetectedDiscScan({
          discKind: input.discKind,
          fingerprint,
          scanData: input.scanData,
        });
        if (input.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            fingerprint,
            input.sizeBytes,
          );
        }
        return database.transaction((transaction) => {
          const contentIdentityArchive =
            findOriginalArchiveByFingerprintOrContentIdAlias(
              fingerprint,
              transaction,
            );
          const matchingObservation = transaction
            .select({ discKind: detectedDiscs.discKind })
            .from(detectedDiscs)
            .where(eq(detectedDiscs.fingerprint, fingerprint))
            .get();
          const existing = transaction
            .select({
              id: detectedDiscs.id,
              discKind: detectedDiscs.discKind,
              scanData: detectedDiscs.scanData,
              status: detectedDiscs.status,
              volumeLabel: detectedDiscs.volumeLabel,
              detectedAt: detectedDiscs.detectedAt,
              updatedAt: detectedDiscs.updatedAt,
            })
            .from(detectedDiscs)
            .where(
              and(
                eq(detectedDiscs.opticalDriveId, input.opticalDriveId),
                eq(detectedDiscs.fingerprint, fingerprint),
              ),
            )
            .get();
          const { observationChanged, statusChanged } =
            evaluateDetectedDiscRediscovery({
              discKind: input.discKind,
              existing,
              fingerprintObservationDiscKind: matchingObservation?.discKind,
              isNewMediumObservation: input.isNewMediumObservation,
              contentIdentityArchive,
              scanData,
              volumeLabel: input.volumeLabel,
            });

          transaction
            .insert(detectedDiscs)
            .values({
              id: newId<DetectedDiscId>(),
              opticalDriveId: input.opticalDriveId,
              discKind: input.discKind,
              fingerprint,
              volumeLabel: input.volumeLabel,
              scanData,
              status: contentIdentityArchive ? "archived" : "detected",
              detectedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .onConflictDoNothing({
              target: [detectedDiscs.opticalDriveId, detectedDiscs.fingerprint],
            })
            .run();

          const registered = transaction
            .update(detectedDiscs)
            .set({
              discKind: input.discKind,
              volumeLabel: input.volumeLabel,
              scanData,
              ...(contentIdentityArchive
                ? { status: "archived" as const }
                : {}),
              ...(observationChanged
                ? { detectedAt: timestamp, updatedAt: timestamp }
                : statusChanged
                  ? { updatedAt: timestamp }
                  : {}),
            })
            .where(
              and(
                eq(detectedDiscs.opticalDriveId, input.opticalDriveId),
                eq(detectedDiscs.fingerprint, fingerprint),
                contentIdentityArchive
                  ? undefined
                  : or(
                      eq(detectedDiscs.discKind, input.discKind),
                      and(
                        ne(detectedDiscs.status, "archived"),
                        notExists(
                          transaction
                            .select({ id: originalDiscArchives.id })
                            .from(originalDiscArchives)
                            .where(
                              eq(
                                originalDiscArchives.detectedDiscId,
                                detectedDiscs.id,
                              ),
                            ),
                        ),
                      ),
                    ),
              ),
            )
            .returning()
            .get();
          if (!registered) {
            throw new DomainInvariantError(
              "Rediscovery cannot change a Detected Disc kind with archive provenance",
            );
          }
          if (contentIdentityArchive) {
            transaction
              .update(archiveRequests)
              .set({
                status: "fulfilled",
                fulfilledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  inArray(archiveRequests.status, [
                    "pending",
                    "needs_attention",
                  ]),
                  isNull(archiveRequests.rearchiveSourceArchiveId),
                  exists(
                    transaction
                      .select({ id: detectedDiscs.id })
                      .from(detectedDiscs)
                      .where(
                        and(
                          eq(detectedDiscs.id, archiveRequests.detectedDiscId),
                          eq(detectedDiscs.fingerprint, fingerprint),
                        ),
                      ),
                  ),
                ),
              )
              .run();
          }
          return registered;
        }, { behavior: "immediate" });
      },

      listDetectedDiscs(statuses, options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        return listDetectedDiscRecords(statuses, options);
      },

      updateDetectedDiscStatus(id, status) {
        if (status === "approved") {
          createArchiveRequest({ detectedDiscId: id });
          return requireRow(
            database
              .select()
              .from(detectedDiscs)
              .where(eq(detectedDiscs.id, id))
              .get(),
            "detected disc",
            id,
          );
        }
        const allowedFrom = Object.entries(detectedDiscTransitions)
          .filter(([, targets]) => targets.includes(status))
          .map(([source]) => source as DetectedDiscStatus);
        return database.transaction((transaction) => {
          const updated = transaction
            .update(detectedDiscs)
            .set({ status, updatedAt: now() })
            .where(
              and(
                eq(detectedDiscs.id, id),
                inArray(detectedDiscs.status, allowedFrom),
              ),
            )
            .returning()
            .get();
          if (!updated) {
            const current = requireRow(
              transaction
                .select()
                .from(detectedDiscs)
                .where(eq(detectedDiscs.id, id))
                .get(),
              "detected disc",
              id,
            );
            throw new InvalidStatusTransitionError(
              "detected disc",
              current.status,
              status,
            );
          }
          const timestamp = now();
          transaction
            .update(archiveRequests)
            .set({
              status: "cancelled",
              cancellationRequestedAt: timestamp,
              cancelledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveRequests.detectedDiscId, id),
                inArray(archiveRequests.status, ["pending", "needs_attention"]),
              ),
            )
            .run();
          return updated;
        });
      },

      createOriginalDiscArchive(input) {
        const timestamp = now();
        const fingerprint = requireNonEmpty(input.fingerprint, "fingerprint");
        const archivePath = requireNonEmpty(input.archivePath, "archivePath");
        if (input.discKind === "dvd") {
          reconcileLegacyDvdArchiveContentId(
            fingerprint,
            input.sizeBytes,
          );
        }
        return database.transaction((transaction) => {
          if (
            findOriginalArchiveByFingerprintOrContentIdAlias(
              fingerprint,
              transaction,
            )
          ) {
            throw new DomainInvariantError(
              "DVD content already has Original Disc Archive provenance",
            );
          }
          requireLegacyDvdArchiveIdentitiesResolved(
            input.discKind,
            fingerprint,
            transaction,
          );
          const transitioned = transaction
            .update(detectedDiscs)
            .set({ status: "archived", updatedAt: timestamp })
            .where(
              and(
                eq(detectedDiscs.id, input.detectedDiscId),
                eq(detectedDiscs.status, "approved"),
                eq(detectedDiscs.discKind, input.discKind),
                eq(detectedDiscs.fingerprint, fingerprint),
              ),
            )
            .returning({ id: detectedDiscs.id })
            .get();
          if (!transitioned) {
            const disc = requireRow(
              transaction
                .select()
                .from(detectedDiscs)
                .where(eq(detectedDiscs.id, input.detectedDiscId))
                .get(),
              "detected disc",
              input.detectedDiscId,
            );
            if (disc.status !== "approved") {
              throw new InvalidStatusTransitionError(
                "detected disc",
                disc.status,
                "archived",
              );
            }
            if (disc.discKind !== input.discKind) {
              throw new DomainInvariantError(
                "Original Disc Archive kind must match its Detected Disc",
              );
            }
            if (disc.fingerprint !== fingerprint) {
              throw new DomainInvariantError(
                "Original Disc Archive fingerprint must match its Detected Disc",
              );
            }
            throw new InvalidStatusTransitionError(
              "detected disc",
              "approved",
              "archived",
            );
          }

          const archive = requireRow(
            transaction
              .insert(originalDiscArchives)
              .values({
                id: newId<OriginalDiscArchiveId>(),
                detectedDiscId: input.detectedDiscId,
                discKind: input.discKind,
                archiveFormat: input.archiveFormat,
                archivePath,
                fingerprint,
                legacyCutoverPending:
                  transaction
                    .select({
                      sidecarPath:
                        legacyCutoverStagedSidecars.sidecarPath,
                    })
                    .from(legacyCutoverStagedSidecars)
                    .where(legacyCutoverFenceCondition(
                      fingerprint,
                      archivePath,
                    ))
                    .limit(1)
                    .get() !== undefined,
                sizeBytes: input.sizeBytes,
                archivedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "original disc archive",
            input.detectedDiscId,
          );
          transaction
            .update(detectedDiscs)
            .set({ status: "archived", updatedAt: timestamp })
            .where(eq(detectedDiscs.fingerprint, fingerprint))
            .run();
          transaction
            .update(archiveRequests)
            .set({
              status: "fulfilled",
              fulfilledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                inArray(archiveRequests.status, ["pending", "needs_attention"]),
                exists(
                  transaction
                    .select({ id: detectedDiscs.id })
                    .from(detectedDiscs)
                    .where(
                      and(
                        eq(detectedDiscs.id, archiveRequests.detectedDiscId),
                        eq(detectedDiscs.fingerprint, fingerprint),
                      ),
                    ),
                ),
              ),
            )
            .run();
          return archive;
        });
      },

      listOriginalDiscArchives(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        if (options?.cursor !== undefined && options.limit === undefined) {
          throw new DomainInvariantError(
            "Original Disc Archive cursor requires a bounded limit",
          );
        }
        if (options?.cursor !== undefined && options.offset !== undefined) {
          throw new DomainInvariantError(
            "Original Disc Archive cursor cannot be combined with an offset",
          );
        }
        const conditions = [
          options?.ids
            ? inArray(originalDiscArchives.id, [...options.ids])
            : undefined,
          options?.detectedDiscId
            ? eq(originalDiscArchives.detectedDiscId, options.detectedDiscId)
            : undefined,
          options?.rearchiveSourceArchiveId
            ? eq(
                originalDiscArchives.rearchiveSourceArchiveId,
                options.rearchiveSourceArchiveId,
              )
            : undefined,
          options?.uncatalogedOnly
            ? notExists(
                database
                  .select({ id: discSelections.id })
                  .from(discSelections)
                  .where(
                    and(
                      eq(
                        discSelections.originalDiscArchiveId,
                        originalDiscArchives.id,
                      ),
                      eq(discSelections.isCatalogActive, true),
                    ),
                  ),
              )
            : undefined,
          options?.needsCatalogReviewOnly
            ? eq(originalDiscArchives.catalogReviewOutcome, "needs_review")
            : undefined,
          options?.cursor
            ? or(
                options.cursor.direction === "older"
                  ? lt(
                      originalDiscArchives.archivedAt,
                      options.cursor.archivedAt,
                    )
                  : gt(
                      originalDiscArchives.archivedAt,
                      options.cursor.archivedAt,
                    ),
                and(
                  eq(
                    originalDiscArchives.archivedAt,
                    options.cursor.archivedAt,
                  ),
                  options.cursor.direction === "older"
                    ? lt(originalDiscArchives.id, options.cursor.id)
                    : gt(originalDiscArchives.id, options.cursor.id),
                ),
              )
            : undefined,
        ].filter((condition) => condition !== undefined);
        const condition =
          conditions.length > 0 ? and(...conditions) : undefined;
        const isBounded = options?.limit !== undefined;
        const readsNewer = options?.cursor?.direction === "newer";
        const query = database
          .select()
          .from(originalDiscArchives)
          .where(condition)
          .orderBy(
            ...(isBounded
              ? readsNewer
                ? [
                    asc(originalDiscArchives.archivedAt),
                    asc(originalDiscArchives.id),
                  ]
                : [
                    desc(originalDiscArchives.archivedAt),
                    desc(originalDiscArchives.id),
                  ]
              : [asc(originalDiscArchives.archivedAt)]),
          );
        const rows = listWithBoundedOffset(
          query,
          options,
          "Original Disc Archive",
        );
        return isBounded && !readsNewer ? rows.reverse() : rows;
      },

      findDvdArchiveEvidenceHeaders(ids) {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length > DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT) {
          throw new DomainInvariantError(
            `DVD Archive Evidence header reads are limited to ${DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT} archives`,
          );
        }
        if (!hasDvdRecoveryEvidenceSchema || uniqueIds.length === 0) {
          return new Map();
        }

        const rows = database
          .select({
            originalDiscArchiveId:
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            sourceArchiveJobId: dvdArchiveEvidenceHeaders.sourceArchiveJobId,
            evidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
            boundaryEvidenceDigest:
              dvdArchiveEvidenceHeaders.boundaryEvidenceDigest,
            sectorSizeBytes: dvdArchiveEvidenceHeaders.sectorSizeBytes,
            acceptedEndLbaExclusive:
              dvdArchiveEvidenceHeaders.acceptedEndLbaExclusive,
            currentManifestId: dvdArchiveEvidenceHeaders.currentManifestId,
            currentManifestRevision:
              dvdArchiveEvidenceHeaders.currentManifestRevision,
            currentManifestDigest:
              dvdArchiveEvidenceHeaders.currentManifestDigest,
            resolvedCurrentManifestId: dvdArchiveEvidenceManifests.id,
            headerBoundaryPolicyVersion:
              dvdArchiveEvidenceHeaders.boundaryPolicyVersion,
            headerBoundaryReportedSizeBytes:
              dvdArchiveEvidenceHeaders.boundaryReportedSizeBytes,
            headerBoundaryPublishedSizeBytes:
              dvdArchiveEvidenceHeaders.boundaryPublishedSizeBytes,
            unrecoveredSourceRanges:
              dvdArchiveEvidenceManifests.unrecoveredSourceRanges,
            manifestOriginalDiscArchiveId:
              dvdArchiveEvidenceManifests.originalDiscArchiveId,
            manifestRevision: dvdArchiveEvidenceManifests.revision,
            previousManifestId:
              dvdArchiveEvidenceManifests.previousManifestId,
            previousManifestDigest:
              previousDvdArchiveEvidenceManifests.manifestDigest,
            previousManifestOriginalDiscArchiveId:
              previousDvdArchiveEvidenceManifests.originalDiscArchiveId,
            previousManifestRevision:
              previousDvdArchiveEvidenceManifests.revision,
            previousManifestUnrecoveredSourceRanges:
              previousDvdArchiveEvidenceManifests.unrecoveredSourceRanges,
            recoveryReadId: dvdArchiveEvidenceManifests.recoveryReadId,
            manifestEvidenceFormat:
              dvdArchiveEvidenceManifests.evidenceFormat,
            manifestImageFingerprint:
              dvdArchiveEvidenceManifests.imageFingerprint,
            manifestSectorSizeBytes:
              dvdArchiveEvidenceManifests.sectorSizeBytes,
            manifestAcceptedEndLbaExclusive:
              dvdArchiveEvidenceManifests.acceptedEndLbaExclusive,
            manifestBoundaryPolicyVersion:
              dvdArchiveEvidenceManifests.boundaryPolicyVersion,
            manifestBoundaryReportedSizeBytes:
              dvdArchiveEvidenceManifests.boundaryReportedSizeBytes,
            manifestBoundaryPublishedSizeBytes:
              dvdArchiveEvidenceManifests.boundaryPublishedSizeBytes,
            manifestBoundaryEvidenceDigest:
              dvdArchiveEvidenceManifests.boundaryEvidenceDigest,
            unrecoveredSourceRangesDigest:
              dvdArchiveEvidenceManifests.unrecoveredSourceRangesDigest,
            manifestDigest: dvdArchiveEvidenceManifests.manifestDigest,
            recoveryReadOriginalDiscArchiveId:
              dvdArchiveRecoveryReads.originalDiscArchiveId,
            recoveryReadFromManifestId:
              dvdArchiveRecoveryReads.fromManifestId,
            recoveryReadFromManifestRevision:
              dvdArchiveRecoveryReads.fromManifestRevision,
            recoveryReadStartLba: dvdArchiveRecoveryReads.startLba,
            recoveryReadSectorCount: dvdArchiveRecoveryReads.sectorCount,
            recoveryReadOutcome: dvdArchiveRecoveryReads.outcome,
            recoveryReadVerificationId:
              dvdArchiveRecoveryReads.verificationId,
            recoveryReadDiscConfirmationId:
              dvdArchiveRecoveryReads.discConfirmationId,
            recoveryReadEvidenceDigest:
              dvdArchiveRecoveryReads.evidenceDigest,
            archiveDetectedDiscId: originalDiscArchives.detectedDiscId,
            resolvedOriginalDiscArchiveId: originalDiscArchives.id,
            archiveRearchiveSourceArchiveId:
              originalDiscArchives.rearchiveSourceArchiveId,
            archiveDiscKind: originalDiscArchives.discKind,
            archiveFingerprint: originalDiscArchives.fingerprint,
            archiveSizeBytes: originalDiscArchives.sizeBytes,
            boundaryPolicyVersion:
              originalDiscArchives.boundaryPolicyVersion,
            boundaryReportedSizeBytes:
              originalDiscArchives.boundaryReportedSizeBytes,
            boundaryPublishedSizeBytes:
              originalDiscArchives.boundaryPublishedSizeBytes,
            boundaryExcludedSectorCount:
              originalDiscArchives.boundaryExcludedSectorCount,
            boundaryFirstExcludedLba:
              originalDiscArchives.boundaryFirstExcludedLba,
            boundaryMaximumReferencedLba:
              originalDiscArchives.boundaryMaximumReferencedLba,
            boundaryReadFailureClassifierVersion:
              originalDiscArchives.boundaryReadFailureClassifierVersion,
            boundaryReadFailureScsiStatus:
              originalDiscArchives.boundaryReadFailureScsiStatus,
            boundaryReadFailureHostStatus:
              originalDiscArchives.boundaryReadFailureHostStatus,
            boundaryReadFailureDriverStatus:
              originalDiscArchives.boundaryReadFailureDriverStatus,
            boundaryReadFailureSenseResponseCode:
              originalDiscArchives.boundaryReadFailureSenseResponseCode,
            boundaryReadFailureSenseKey:
              originalDiscArchives.boundaryReadFailureSenseKey,
            boundaryReadFailureAsc:
              originalDiscArchives.boundaryReadFailureAsc,
            boundaryReadFailureAscq:
              originalDiscArchives.boundaryReadFailureAscq,
            sourceJobOriginalDiscArchiveId: archiveJobs.originalDiscArchiveId,
            resolvedSourceJobId: archiveJobs.id,
            sourceJobDetectedDiscId: archiveJobs.detectedDiscId,
            sourceJobEvidenceFormat: archiveJobs.evidenceFormat,
            sourceJobStatus: archiveJobs.status,
            sourceRequestDetectedDiscId: archiveRequests.detectedDiscId,
            sourceRequestId: archiveRequests.id,
            sourceRequestRearchiveSourceArchiveId:
              archiveRequests.rearchiveSourceArchiveId,
            sourceRequestEvidenceFormat: archiveRequests.evidenceFormat,
            sourceRequestStatus: archiveRequests.status,
            requestedDiscKind: requestedDetectedDiscRecords.discKind,
            requestedDiscFingerprint:
              requestedDetectedDiscRecords.fingerprint,
            requestedDiscScanData: requestedDetectedDiscRecords.scanData,
            requestedDiscStatus: requestedDetectedDiscRecords.status,
            archiveDiscFingerprint:
              evidenceArchiveDetectedDiscRecords.fingerprint,
            archiveDiscScanData: evidenceArchiveDetectedDiscRecords.scanData,
            requestDeclaredByteCountMatches: sql<boolean>`not exists (
              select 1
              from archive_jobs as provenance_attempt
              inner join disc_inspections as provenance_inspection
                on provenance_inspection.id = provenance_attempt.disc_inspection_id
              where provenance_attempt.archive_request_id = ${archiveRequests.id}
                and provenance_inspection.total_bytes is not null
                and provenance_inspection.total_bytes <>
                  ${dvdArchiveEvidenceHeaders.boundaryReportedSizeBytes}
            )`,
            sourceInspectionDetectedDiscId: discInspections.detectedDiscId,
            sourceInspectionId: discInspections.id,
            sourceInspectionStatus: discInspections.status,
            sourceInspectionTotalBytes: discInspections.totalBytes,
            createdAt: dvdArchiveEvidenceHeaders.createdAt,
            updatedAt: dvdArchiveEvidenceHeaders.updatedAt,
          })
          .from(dvdArchiveEvidenceHeaders)
          .leftJoin(
            dvdArchiveEvidenceManifests,
            eq(
              dvdArchiveEvidenceManifests.id,
              dvdArchiveEvidenceHeaders.currentManifestId,
            ),
          )
          .leftJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            ),
          )
          .leftJoin(
            archiveJobs,
            eq(archiveJobs.id, dvdArchiveEvidenceHeaders.sourceArchiveJobId),
          )
          .leftJoin(
            archiveRequests,
            eq(archiveRequests.id, archiveJobs.archiveRequestId),
          )
          .leftJoin(
            evidenceArchiveDetectedDiscRecords,
            eq(
              evidenceArchiveDetectedDiscRecords.id,
              originalDiscArchives.detectedDiscId,
            ),
          )
          .leftJoin(
            requestedDetectedDiscRecords,
            eq(requestedDetectedDiscRecords.id, archiveRequests.detectedDiscId),
          )
          .leftJoin(
            discInspections,
            eq(discInspections.id, archiveJobs.discInspectionId),
          )
          .leftJoin(
            previousDvdArchiveEvidenceManifests,
            eq(
              previousDvdArchiveEvidenceManifests.id,
              dvdArchiveEvidenceManifests.previousManifestId,
            ),
          )
          .leftJoin(
            dvdArchiveRecoveryReads,
            eq(
              dvdArchiveRecoveryReads.id,
              dvdArchiveEvidenceManifests.recoveryReadId,
            ),
          )
          .where(inArray(dvdArchiveEvidenceHeaders.originalDiscArchiveId, uniqueIds))
          .all();
        const evidenceByArchiveId = new Map<
          OriginalDiscArchiveId,
          DvdArchiveEvidenceHeader
        >();

        for (const row of rows) {
          if (
            row.resolvedCurrentManifestId === null ||
            row.resolvedOriginalDiscArchiveId === null ||
            row.resolvedSourceJobId === null ||
            row.sourceRequestId === null ||
            row.sourceInspectionId === null ||
            row.archiveDiscFingerprint === null ||
            row.requestedDiscKind === null ||
            row.requestedDiscFingerprint === null ||
            row.requestedDiscStatus === null ||
            row.manifestOriginalDiscArchiveId === null ||
            row.manifestRevision === null ||
            row.manifestEvidenceFormat === null ||
            row.manifestImageFingerprint === null ||
            row.manifestSectorSizeBytes === null ||
            row.manifestAcceptedEndLbaExclusive === null ||
            row.manifestBoundaryPolicyVersion === null ||
            row.manifestBoundaryReportedSizeBytes === null ||
            row.manifestBoundaryPublishedSizeBytes === null ||
            row.manifestBoundaryEvidenceDigest === null ||
            row.unrecoveredSourceRanges === null ||
            row.unrecoveredSourceRangesDigest === null ||
            row.manifestDigest === null
          ) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence authoritative links are incomplete",
            );
          }
          const boundaryEvidence = archiveBoundaryEvidenceFromRecord(row);
          if (boundaryEvidence === null) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence has no Archive Boundary Evidence",
            );
          }
          assertDvdArchiveBoundaryEvidenceDigest(
            boundaryEvidence,
            row.boundaryEvidenceDigest,
          );
          assertDvdArchiveBoundaryEvidenceDigest(
            boundaryEvidence,
            row.manifestBoundaryEvidenceDigest,
          );

          const archiveTitleMap = decodeDvdTitleMap(
            row.archiveDiscScanData,
          );
          const requestedTitleMap = decodeDvdTitleMap(
            row.requestedDiscScanData,
          );
          const requestMatchesPublishedDisc =
            row.sourceRequestDetectedDiscId === row.archiveDetectedDiscId ||
            (
              row.requestDeclaredByteCountMatches &&
              row.requestedDiscKind === "dvd" &&
              row.requestedDiscStatus === requiredArchiveRequestDiscStatus({
                rearchiveSourceArchiveId:
                  row.sourceRequestRearchiveSourceArchiveId,
              }) &&
              (
                row.sourceRequestRearchiveSourceArchiveId === null
                  ? row.archiveDiscFingerprint === row.archiveFingerprint &&
                    row.requestedDiscFingerprint ===
                      row.archiveDiscFingerprint &&
                    archiveTitleMap?.contentId ===
                      row.archiveDiscFingerprint &&
                    requestedTitleMap?.contentId ===
                      row.archiveDiscFingerprint
                  : row.archiveRearchiveSourceArchiveId ===
                    row.sourceRequestRearchiveSourceArchiveId
              )
            );
          if (
            row.archiveDiscKind !== "dvd" ||
            row.archiveDiscFingerprint !== row.archiveFingerprint ||
            row.sourceJobOriginalDiscArchiveId !==
              row.originalDiscArchiveId ||
            row.sourceJobDetectedDiscId !== row.archiveDetectedDiscId ||
            row.sourceJobEvidenceFormat !== row.evidenceFormat ||
            row.sourceJobStatus !== "completed" ||
            !requestMatchesPublishedDisc ||
            row.sourceRequestEvidenceFormat !== row.evidenceFormat ||
            row.sourceRequestStatus !== "fulfilled" ||
            row.sourceInspectionDetectedDiscId !==
              row.archiveDetectedDiscId ||
            row.sourceInspectionStatus !== "completed" ||
            row.sourceInspectionTotalBytes !==
              row.headerBoundaryReportedSizeBytes
          ) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence source job provenance is invalid",
            );
          }

          let recoveryReadEvidenceDigest: string | null = null;
          let recoveryRead:
            | { startLba: number; outcome: "recovered" | "failed" }
            | null = null;
          if (row.recoveryReadId !== null) {
            if (
              row.recoveryReadOriginalDiscArchiveId === null ||
              row.recoveryReadFromManifestId === null ||
              row.recoveryReadFromManifestRevision === null ||
              row.recoveryReadStartLba === null ||
              row.recoveryReadSectorCount === null ||
              row.recoveryReadOutcome === null ||
              row.recoveryReadEvidenceDigest === null
            ) {
              throw new DomainInvariantError(
                "Persisted DVD Archive Evidence recovery read is incomplete",
              );
            }
            const evidence = {
              originalDiscArchiveId: row.recoveryReadOriginalDiscArchiveId,
              fromManifestId: row.recoveryReadFromManifestId,
              fromManifestRevision: row.recoveryReadFromManifestRevision,
              startLba: row.recoveryReadStartLba,
              sectorCount: row.recoveryReadSectorCount,
              outcome: row.recoveryReadOutcome,
              ...(row.recoveryReadVerificationId === null
                ? {}
                : {
                    verificationId: row.recoveryReadVerificationId,
                    discConfirmationId:
                      row.recoveryReadDiscConfirmationId,
                  }),
            };
            assertDvdArchiveRecoveryReadEvidenceDigest(
              evidence,
              row.recoveryReadEvidenceDigest,
            );
            recoveryReadEvidenceDigest = row.recoveryReadEvidenceDigest;
            recoveryRead = evidence;
          }

          if (
            row.manifestOriginalDiscArchiveId !==
              row.originalDiscArchiveId ||
            row.manifestRevision !== row.currentManifestRevision ||
            row.manifestDigest !== row.currentManifestDigest ||
            row.manifestEvidenceFormat !== row.evidenceFormat ||
            row.manifestImageFingerprint !== row.archiveFingerprint ||
            row.manifestSectorSizeBytes !== row.sectorSizeBytes ||
            row.manifestAcceptedEndLbaExclusive !==
              row.acceptedEndLbaExclusive ||
            row.manifestBoundaryPolicyVersion !==
              row.headerBoundaryPolicyVersion ||
            row.manifestBoundaryReportedSizeBytes !==
              row.headerBoundaryReportedSizeBytes ||
            row.manifestBoundaryPublishedSizeBytes !==
              row.headerBoundaryPublishedSizeBytes ||
            row.archiveSizeBytes !==
              row.headerBoundaryPublishedSizeBytes ||
            row.boundaryPolicyVersion !==
              row.headerBoundaryPolicyVersion ||
            row.boundaryReportedSizeBytes !==
              row.headerBoundaryReportedSizeBytes ||
            row.boundaryPublishedSizeBytes !==
              row.headerBoundaryPublishedSizeBytes ||
            (row.manifestRevision === 1 &&
              (row.previousManifestOriginalDiscArchiveId !== null ||
                row.previousManifestRevision !== null ||
                row.recoveryReadOriginalDiscArchiveId !== null)) ||
            (row.manifestRevision > 1 &&
              (row.previousManifestOriginalDiscArchiveId !==
                  row.originalDiscArchiveId ||
                row.previousManifestRevision !== row.manifestRevision - 1 ||
                row.recoveryReadOriginalDiscArchiveId !==
                  row.originalDiscArchiveId ||
                row.recoveryReadFromManifestId !== row.previousManifestId ||
                row.recoveryReadFromManifestRevision !==
                  row.previousManifestRevision))
          ) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence header does not match its current manifest and archive",
            );
          }
          assertDvdArchiveEvidenceManifestDigests({
            originalDiscArchiveId: row.manifestOriginalDiscArchiveId,
            revision: row.manifestRevision,
            previousManifestId: row.previousManifestId,
            previousManifestDigest: row.previousManifestDigest,
            recoveryReadId: row.recoveryReadId,
            recoveryReadEvidenceDigest,
            evidenceFormat: row.manifestEvidenceFormat,
            imageFingerprint: row.manifestImageFingerprint,
            sectorSizeBytes: row.manifestSectorSizeBytes,
            acceptedEndLbaExclusive:
              row.manifestAcceptedEndLbaExclusive,
            boundaryPolicyVersion: row.manifestBoundaryPolicyVersion,
            boundaryReportedSizeBytes:
              row.manifestBoundaryReportedSizeBytes,
            boundaryPublishedSizeBytes:
              row.manifestBoundaryPublishedSizeBytes,
            boundaryEvidenceDigest: row.manifestBoundaryEvidenceDigest,
            unrecoveredSourceRanges: row.unrecoveredSourceRanges,
            unrecoveredSourceRangesDigest:
              row.unrecoveredSourceRangesDigest,
            manifestDigest: row.manifestDigest,
          });
          if (
            row.previousManifestUnrecoveredSourceRanges !== null &&
            recoveryRead !== null
          ) {
            assertDvdEvidenceRangeTransition(
              row.previousManifestUnrecoveredSourceRanges,
              row.unrecoveredSourceRanges,
              recoveryRead,
            );
          }

          evidenceByArchiveId.set(row.originalDiscArchiveId, {
            originalDiscArchiveId: row.originalDiscArchiveId,
            sourceArchiveJobId: row.sourceArchiveJobId,
            evidenceFormat: row.evidenceFormat,
            boundaryEvidenceDigest: row.boundaryEvidenceDigest,
            sectorSizeBytes: row.sectorSizeBytes,
            acceptedEndLbaExclusive: row.acceptedEndLbaExclusive,
            currentManifestId: row.currentManifestId,
            currentManifestRevision: row.currentManifestRevision,
            currentManifestDigest: row.currentManifestDigest,
            unrecoveredSourceRanges: row.unrecoveredSourceRanges,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }
        return evidenceByArchiveId;
      },

      auditDvdArchiveEvidenceChains(ids) {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length > DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT) {
          throw new DomainInvariantError(
            `DVD Archive Evidence header reads are limited to ${DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT} archives`,
          );
        }
        if (!hasDvdRecoveryEvidenceSchema || uniqueIds.length === 0) {
          return;
        }
        access.catalog.findDvdArchiveEvidenceHeaders(uniqueIds);

        const headerRows = database
          .select({
            originalDiscArchiveId:
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            sourceArchiveJobId: dvdArchiveEvidenceHeaders.sourceArchiveJobId,
            evidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
            boundaryEvidenceDigest:
              dvdArchiveEvidenceHeaders.boundaryEvidenceDigest,
            sectorSizeBytes: dvdArchiveEvidenceHeaders.sectorSizeBytes,
            acceptedEndLbaExclusive:
              dvdArchiveEvidenceHeaders.acceptedEndLbaExclusive,
            currentManifestId: dvdArchiveEvidenceHeaders.currentManifestId,
            currentManifestRevision:
              dvdArchiveEvidenceHeaders.currentManifestRevision,
            currentManifestDigest:
              dvdArchiveEvidenceHeaders.currentManifestDigest,
            headerBoundaryPolicyVersion:
              dvdArchiveEvidenceHeaders.boundaryPolicyVersion,
            headerBoundaryReportedSizeBytes:
              dvdArchiveEvidenceHeaders.boundaryReportedSizeBytes,
            headerBoundaryPublishedSizeBytes:
              dvdArchiveEvidenceHeaders.boundaryPublishedSizeBytes,
            archiveFingerprint: originalDiscArchives.fingerprint,
            archiveSizeBytes: originalDiscArchives.sizeBytes,
            boundaryPolicyVersion:
              originalDiscArchives.boundaryPolicyVersion,
            boundaryReportedSizeBytes:
              originalDiscArchives.boundaryReportedSizeBytes,
            boundaryPublishedSizeBytes:
              originalDiscArchives.boundaryPublishedSizeBytes,
            boundaryExcludedSectorCount:
              originalDiscArchives.boundaryExcludedSectorCount,
            boundaryFirstExcludedLba:
              originalDiscArchives.boundaryFirstExcludedLba,
            boundaryMaximumReferencedLba:
              originalDiscArchives.boundaryMaximumReferencedLba,
            boundaryReadFailureClassifierVersion:
              originalDiscArchives.boundaryReadFailureClassifierVersion,
            boundaryReadFailureScsiStatus:
              originalDiscArchives.boundaryReadFailureScsiStatus,
            boundaryReadFailureHostStatus:
              originalDiscArchives.boundaryReadFailureHostStatus,
            boundaryReadFailureDriverStatus:
              originalDiscArchives.boundaryReadFailureDriverStatus,
            boundaryReadFailureSenseResponseCode:
              originalDiscArchives.boundaryReadFailureSenseResponseCode,
            boundaryReadFailureSenseKey:
              originalDiscArchives.boundaryReadFailureSenseKey,
            boundaryReadFailureAsc:
              originalDiscArchives.boundaryReadFailureAsc,
            boundaryReadFailureAscq:
              originalDiscArchives.boundaryReadFailureAscq,
            createdAt: dvdArchiveEvidenceHeaders.createdAt,
            updatedAt: dvdArchiveEvidenceHeaders.updatedAt,
          })
          .from(dvdArchiveEvidenceHeaders)
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            ),
          )
          .where(inArray(dvdArchiveEvidenceHeaders.originalDiscArchiveId, uniqueIds))
          .all();
        if (headerRows.length === 0) return;

        const archiveIds = headerRows.map((row) => row.originalDiscArchiveId);
        const manifestRows = database
          .select({
            id: dvdArchiveEvidenceManifests.id,
            originalDiscArchiveId:
              dvdArchiveEvidenceManifests.originalDiscArchiveId,
            revision: dvdArchiveEvidenceManifests.revision,
            previousManifestId:
              dvdArchiveEvidenceManifests.previousManifestId,
            recoveryReadId: dvdArchiveEvidenceManifests.recoveryReadId,
            evidenceFormat: dvdArchiveEvidenceManifests.evidenceFormat,
            imageFingerprint: dvdArchiveEvidenceManifests.imageFingerprint,
            sectorSizeBytes: dvdArchiveEvidenceManifests.sectorSizeBytes,
            acceptedEndLbaExclusive:
              dvdArchiveEvidenceManifests.acceptedEndLbaExclusive,
            boundaryPolicyVersion:
              dvdArchiveEvidenceManifests.boundaryPolicyVersion,
            boundaryReportedSizeBytes:
              dvdArchiveEvidenceManifests.boundaryReportedSizeBytes,
            boundaryPublishedSizeBytes:
              dvdArchiveEvidenceManifests.boundaryPublishedSizeBytes,
            boundaryEvidenceDigest:
              dvdArchiveEvidenceManifests.boundaryEvidenceDigest,
            unrecoveredSourceRanges:
              dvdArchiveEvidenceManifests.unrecoveredSourceRanges,
            unrecoveredSourceRangesDigest:
              dvdArchiveEvidenceManifests.unrecoveredSourceRangesDigest,
            manifestDigest: dvdArchiveEvidenceManifests.manifestDigest,
            recoveryReadOriginalDiscArchiveId:
              dvdArchiveRecoveryReads.originalDiscArchiveId,
            recoveryReadFromManifestId:
              dvdArchiveRecoveryReads.fromManifestId,
            recoveryReadFromManifestRevision:
              dvdArchiveRecoveryReads.fromManifestRevision,
            recoveryReadStartLba: dvdArchiveRecoveryReads.startLba,
            recoveryReadSectorCount: dvdArchiveRecoveryReads.sectorCount,
            recoveryReadOutcome: dvdArchiveRecoveryReads.outcome,
            recoveryReadVerificationId:
              dvdArchiveRecoveryReads.verificationId,
            recoveryReadDiscConfirmationId:
              dvdArchiveRecoveryReads.discConfirmationId,
            recoveryReadEvidenceDigest:
              dvdArchiveRecoveryReads.evidenceDigest,
          })
          .from(dvdArchiveEvidenceManifests)
          .leftJoin(
            dvdArchiveRecoveryReads,
            eq(
              dvdArchiveRecoveryReads.id,
              dvdArchiveEvidenceManifests.recoveryReadId,
            ),
          )
          .where(inArray(dvdArchiveEvidenceManifests.originalDiscArchiveId, archiveIds))
          .orderBy(
            asc(dvdArchiveEvidenceManifests.originalDiscArchiveId),
            asc(dvdArchiveEvidenceManifests.revision),
          )
          .limit(DVD_ARCHIVE_EVIDENCE_AUDIT_MANIFEST_LIMIT + 1)
          .all();
        if (
          manifestRows.length > DVD_ARCHIVE_EVIDENCE_AUDIT_MANIFEST_LIMIT
        ) {
          throw new DomainInvariantError(
            `DVD Archive Evidence audits are limited to ${DVD_ARCHIVE_EVIDENCE_AUDIT_MANIFEST_LIMIT} manifests`,
          );
        }
        const manifestsByArchiveId = manifestRows.reduce((byArchiveId, row) => {
          const manifests = byArchiveId.get(row.originalDiscArchiveId) ?? [];
          manifests.push(row);
          byArchiveId.set(row.originalDiscArchiveId, manifests);
          return byArchiveId;
        }, new Map<OriginalDiscArchiveId, typeof manifestRows>());
        type EvidenceManifestRow = (typeof manifestRows)[number];

        for (const header of headerRows) {
          const boundaryEvidence = archiveBoundaryEvidenceFromRecord(header);
          if (boundaryEvidence === null) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence has no Archive Boundary Evidence",
            );
          }
          assertDvdArchiveBoundaryEvidenceDigest(
            boundaryEvidence,
            header.boundaryEvidenceDigest,
          );
          if (
            header.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT ||
            header.archiveSizeBytes !==
              header.headerBoundaryPublishedSizeBytes ||
            header.boundaryPolicyVersion !==
              header.headerBoundaryPolicyVersion ||
            header.boundaryReportedSizeBytes !==
              header.headerBoundaryReportedSizeBytes ||
            header.boundaryPublishedSizeBytes !==
              header.headerBoundaryPublishedSizeBytes
          ) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence header does not match its archive",
            );
          }

          const manifests = manifestsByArchiveId.get(
            header.originalDiscArchiveId,
          ) ?? [];
          const manifestsById = new Map(manifests.map((manifest) => [
            manifest.id,
            manifest,
          ]));
          let manifest: EvidenceManifestRow | undefined =
            manifestsById.get(header.currentManifestId);
          if (
            manifest === undefined ||
            manifest.revision !== header.currentManifestRevision ||
            manifest.manifestDigest !== header.currentManifestDigest
          ) {
            throw new DomainInvariantError(
              "Persisted DVD Archive Evidence header does not match its current manifest",
            );
          }
          const visitedManifestIds = new Set<string>();
          const transitions: Array<{
            previous: EvidenceManifestRow;
            current: EvidenceManifestRow;
            recoveryRead: {
              startLba: number;
              outcome: "recovered" | "failed";
            };
          }> = [];

          for (
            let expectedRevision = header.currentManifestRevision;
            expectedRevision >= 1;
            expectedRevision -= 1
          ) {
            if (
              manifest === undefined ||
              visitedManifestIds.has(manifest.id) ||
              manifest.originalDiscArchiveId !==
                header.originalDiscArchiveId ||
              manifest.revision !== expectedRevision ||
              manifest.evidenceFormat !== header.evidenceFormat ||
              manifest.imageFingerprint !== header.archiveFingerprint ||
              manifest.sectorSizeBytes !== header.sectorSizeBytes ||
              manifest.acceptedEndLbaExclusive !==
                header.acceptedEndLbaExclusive ||
              manifest.boundaryPolicyVersion !==
                header.headerBoundaryPolicyVersion ||
              manifest.boundaryReportedSizeBytes !==
                header.headerBoundaryReportedSizeBytes ||
              manifest.boundaryPublishedSizeBytes !==
                header.headerBoundaryPublishedSizeBytes ||
              manifest.boundaryEvidenceDigest !==
                header.boundaryEvidenceDigest
            ) {
              throw new DomainInvariantError(
                "Persisted DVD Archive Evidence manifest chain is invalid",
              );
            }
            visitedManifestIds.add(manifest.id);
            assertDvdArchiveBoundaryEvidenceDigest(
              boundaryEvidence,
              manifest.boundaryEvidenceDigest,
            );

            const previousManifest: EvidenceManifestRow | undefined =
              manifest.previousManifestId === null
              ? undefined
              : manifestsById.get(manifest.previousManifestId);
            let recoveryReadEvidenceDigest: string | null = null;
            let recoveryRead:
              | { startLba: number; outcome: "recovered" | "failed" }
              | null = null;
            if (manifest.recoveryReadId !== null) {
              if (
                manifest.recoveryReadOriginalDiscArchiveId === null ||
                manifest.recoveryReadFromManifestId === null ||
                manifest.recoveryReadFromManifestRevision === null ||
                manifest.recoveryReadStartLba === null ||
                manifest.recoveryReadSectorCount === null ||
                manifest.recoveryReadOutcome === null ||
                manifest.recoveryReadEvidenceDigest === null
              ) {
                throw new DomainInvariantError(
                  "Persisted DVD Archive Evidence recovery read is incomplete",
                );
              }
              const evidence = {
                originalDiscArchiveId:
                  manifest.recoveryReadOriginalDiscArchiveId,
                fromManifestId: manifest.recoveryReadFromManifestId,
                fromManifestRevision:
                  manifest.recoveryReadFromManifestRevision,
                startLba: manifest.recoveryReadStartLba,
                sectorCount: manifest.recoveryReadSectorCount,
                outcome: manifest.recoveryReadOutcome,
                ...(manifest.recoveryReadVerificationId === null
                  ? {}
                  : {
                      verificationId: manifest.recoveryReadVerificationId,
                      discConfirmationId:
                        manifest.recoveryReadDiscConfirmationId,
                    }),
              };
              assertDvdArchiveRecoveryReadEvidenceDigest(
                evidence,
                manifest.recoveryReadEvidenceDigest,
              );
              recoveryReadEvidenceDigest =
                manifest.recoveryReadEvidenceDigest;
              recoveryRead = evidence;
            }

            const linksAreValid = expectedRevision === 1
              ? manifest.previousManifestId === null &&
                manifest.recoveryReadId === null
              : previousManifest !== undefined &&
                manifest.recoveryReadId !== null &&
                manifest.recoveryReadOriginalDiscArchiveId ===
                  header.originalDiscArchiveId &&
                manifest.recoveryReadFromManifestId ===
                  previousManifest.id &&
                manifest.recoveryReadFromManifestRevision ===
                  previousManifest.revision &&
                previousManifest.originalDiscArchiveId ===
                  header.originalDiscArchiveId &&
                previousManifest.revision === expectedRevision - 1;
            if (!linksAreValid) {
              throw new DomainInvariantError(
                "Persisted DVD Archive Evidence predecessor and recovery links are invalid",
              );
            }

            assertDvdArchiveEvidenceManifestDigests({
              originalDiscArchiveId: manifest.originalDiscArchiveId,
              revision: manifest.revision,
              previousManifestId: manifest.previousManifestId,
              previousManifestDigest: previousManifest?.manifestDigest ?? null,
              recoveryReadId: manifest.recoveryReadId,
              recoveryReadEvidenceDigest,
              evidenceFormat: manifest.evidenceFormat,
              imageFingerprint: manifest.imageFingerprint,
              sectorSizeBytes: manifest.sectorSizeBytes,
              acceptedEndLbaExclusive:
                manifest.acceptedEndLbaExclusive,
              boundaryPolicyVersion: manifest.boundaryPolicyVersion,
              boundaryReportedSizeBytes:
                manifest.boundaryReportedSizeBytes,
              boundaryPublishedSizeBytes:
                manifest.boundaryPublishedSizeBytes,
              boundaryEvidenceDigest: manifest.boundaryEvidenceDigest,
              unrecoveredSourceRanges: manifest.unrecoveredSourceRanges,
              unrecoveredSourceRangesDigest:
                manifest.unrecoveredSourceRangesDigest,
              manifestDigest: manifest.manifestDigest,
            });
            if (
              previousManifest !== undefined &&
              recoveryRead !== null
            ) {
              transitions.push({
                previous: previousManifest,
                current: manifest,
                recoveryRead,
              });
            }
            manifest = previousManifest;
          }
          for (const transition of transitions) {
            assertDvdEvidenceRangeTransition(
              transition.previous.unrecoveredSourceRanges,
              transition.current.unrecoveredSourceRanges,
              transition.recoveryRead,
            );
          }
        }
        return;
      },

      findDvdArchiveEvidenceHeader(id) {
        return access.catalog.findDvdArchiveEvidenceHeaders([id]).get(id) ?? null;
      },

      recordDvdTitleIdentityObservations(input) {
        database.transaction((transaction) => {
          if (input.observations.length > MAX_DVD_TITLES) {
            throw new DomainInvariantError(
              `Title Identity observations are limited to ${MAX_DVD_TITLES} titles per checkpoint`,
            );
          }
          const header = transaction.select().from(dvdArchiveEvidenceHeaders)
            .where(eq(
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
              input.originalDiscArchiveId,
            )).get();
          if (header === undefined) {
            throw new DomainInvariantError(
              "Title Identity observations require a new-format DVD evidence checkpoint",
            );
          }
          if (
            header.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT ||
            header.currentManifestId !== input.checkpoint.manifestId ||
            header.currentManifestRevision !==
              input.checkpoint.manifestRevision ||
            header.currentManifestDigest !== input.checkpoint.manifestDigest
          ) {
            throw new DomainInvariantError(
              "Title Identity observations do not match the current committed checkpoint",
            );
          }
          const normalized = input.observations.map((observation) => {
            const value = normalizeDvdTitleIdentityObservation(
              observation,
              header.acceptedEndLbaExclusive,
            );
            return {
              ...value,
              contentDigest: dvdTitleIdentityContentDigest(value),
            };
          });
          const observationSetDigest =
            dvdTitleIdentityObservationSetDigest(normalized);
          const existingSet = transaction.select().from(dvdTitleIdentitySets)
            .where(eq(
              dvdTitleIdentitySets.manifestId,
              input.checkpoint.manifestId,
            )).get();
          if (existingSet !== undefined) {
            const existingRows = transaction.select()
              .from(dvdTitleIdentityObservations)
              .where(eq(
                dvdTitleIdentityObservations.manifestId,
                existingSet.manifestId,
              ))
              .orderBy(asc(dvdTitleIdentityObservations.id))
              .all();
            assertPersistedDvdTitleIdentitySet(
              existingSet,
              existingRows,
              header.acceptedEndLbaExclusive,
            );
            if (
              existingSet.originalDiscArchiveId !==
                input.originalDiscArchiveId ||
              existingSet.manifestRevision !==
                input.checkpoint.manifestRevision ||
              existingSet.manifestDigest !== input.checkpoint.manifestDigest ||
              existingSet.observationSetDigest !== observationSetDigest ||
              existingSet.policyVersion !==
                DVD_TITLE_IDENTITY_CONTINUITY_VERSION
            ) {
              throw new DomainInvariantError(
                "Title Identity observations conflict with the immutable checkpoint record",
              );
            }
            return;
          }

          const previousSets = transaction.select().from(dvdTitleIdentitySets)
            .where(and(
              eq(
                dvdTitleIdentitySets.originalDiscArchiveId,
                input.originalDiscArchiveId,
              ),
              lt(
                dvdTitleIdentitySets.manifestRevision,
                input.checkpoint.manifestRevision,
              ),
            ))
            .orderBy(desc(dvdTitleIdentitySets.manifestRevision))
            .all();
          const previousRows = [] as Array<
            typeof dvdTitleIdentityObservations.$inferSelect
          >;
          const seenPreviousIdentityIds = new Set<DvdTitleIdentityId>();
          const validatedPreviousManifestIds = new Set<string>();
          for (const previousSet of previousSets) {
            const rows = transaction.select()
              .from(dvdTitleIdentityObservations)
              .where(eq(
                dvdTitleIdentityObservations.manifestId,
                previousSet.manifestId,
              ))
              .orderBy(asc(dvdTitleIdentityObservations.id))
              .all();
            assertPersistedDvdTitleIdentitySet(
              previousSet,
              rows,
              header.acceptedEndLbaExclusive,
              validatedPreviousManifestIds,
            );
            for (const row of rows) {
              if (seenPreviousIdentityIds.has(row.titleIdentityId)) continue;
              seenPreviousIdentityIds.add(row.titleIdentityId);
              previousRows.push(row);
            }
          }
          const timestamp = now();
          const continuityPlans = planDvdTitleIdentityContinuity(
            normalized,
            previousRows,
            previousSets.length > 0,
          );
          const plans = normalized.map((observation, index) => {
            const continuity = continuityPlans[index]!;
            const previous = continuity.previousIndex === null
              ? undefined
              : previousRows[continuity.previousIndex];
            return {
              observation,
              observationId: newId<DvdTitleIdentityObservationId>(),
              titleIdentityId: previous?.titleIdentityId ??
                newId<DvdTitleIdentityId>(),
              previous,
              continuityResult: continuity.result,
            };
          });

          for (const plan of plans) {
            if (plan.previous === undefined) {
              transaction.insert(dvdTitleIdentities).values({
                id: plan.titleIdentityId,
                originalDiscArchiveId: input.originalDiscArchiveId,
                createdAt: timestamp,
              }).run();
            }
          }
          transaction.insert(dvdTitleIdentitySets).values({
            manifestId: input.checkpoint.manifestId,
            originalDiscArchiveId: input.originalDiscArchiveId,
            manifestRevision: input.checkpoint.manifestRevision,
            manifestDigest: input.checkpoint.manifestDigest,
            observationSetDigest,
            policyVersion: DVD_TITLE_IDENTITY_CONTINUITY_VERSION,
            createdAt: timestamp,
          }).run();
          for (const plan of plans) {
            transaction.insert(dvdTitleIdentityObservations).values({
              id: plan.observationId,
              manifestId: input.checkpoint.manifestId,
              titleIdentityId: plan.titleIdentityId,
              previousObservationId: plan.previous?.id ?? null,
              displayTitleNumber: plan.observation.displayTitleNumber,
              navigation: plan.observation.navigation,
              selectedPath: plan.observation.selectedPath,
              angleNumber: plan.observation.angleNumber,
              angleCount: plan.observation.angleCount,
              chapterStart: plan.observation.chapterStart,
              chapterEnd: plan.observation.chapterEnd,
              chapterCount: plan.observation.chapterCount,
              sourceExtents: plan.observation.sourceExtents,
              contentDigest: plan.observation.contentDigest,
              continuityResult: plan.continuityResult,
              continuityPolicyVersion:
                DVD_TITLE_IDENTITY_CONTINUITY_VERSION,
              createdAt: timestamp,
            }).run();
          }

          const archiveIdentityIds = transaction.select({
            id: dvdTitleIdentities.id,
          }).from(dvdTitleIdentities).where(eq(
            dvdTitleIdentities.originalDiscArchiveId,
            input.originalDiscArchiveId,
          )).all().map(({ id }) => id);
          const currentIdentityIds = new Set(
            plans.map((plan) => plan.titleIdentityId),
          );
          const missingIdentityIds = archiveIdentityIds.filter((id) =>
            !currentIdentityIds.has(id)
          );
          if (missingIdentityIds.length > 0) {
            transaction.update(dvdTitleIdentitySelectionBindings).set({
              state: "needs_mapping_review",
              updatedAt: timestamp,
            }).where(inArray(
              dvdTitleIdentitySelectionBindings.titleIdentityId,
              missingIdentityIds,
            )).run();
          }
          for (const plan of plans) {
            if (plan.previous === undefined) continue;
            transaction.update(dvdTitleIdentitySelectionBindings).set({
              lastObservationId: plan.observationId,
              ...(plan.continuityResult === "uncertain"
                ? { state: "needs_mapping_review" as const }
                : {}),
              updatedAt: timestamp,
            }).where(eq(
              dvdTitleIdentitySelectionBindings.titleIdentityId,
              plan.titleIdentityId,
            )).run();
          }

          if (
            previousSets.length === 0 &&
            input.checkpoint.manifestRevision === 1
          ) {
            const activeSelections = transaction.select().from(discSelections)
              .where(and(
                eq(
                  discSelections.originalDiscArchiveId,
                  input.originalDiscArchiveId,
                ),
                eq(discSelections.isCatalogActive, true),
              )).all().map(toDiscSelection);
            const boundSelectionIds = new Set(transaction.select({
              id: dvdTitleIdentitySelectionBindings.discSelectionId,
            }).from(dvdTitleIdentitySelectionBindings)
              .innerJoin(
                dvdTitleIdentities,
                eq(
                  dvdTitleIdentities.id,
                  dvdTitleIdentitySelectionBindings.titleIdentityId,
                ),
              )
              .where(eq(
                dvdTitleIdentities.originalDiscArchiveId,
                input.originalDiscArchiveId,
              )).all().map(({ id }) => id));
            for (const selection of activeSelections) {
              if (boundSelectionIds.has(selection.id)) continue;
              const matches = plans.filter((plan) =>
                discSelectionMatchesTitleObservation(
                  selection,
                  plan.observation,
                )
              );
              if (matches.length !== 1) continue;
              const match = matches[0]!;
              transaction.insert(dvdTitleIdentitySelectionBindings).values({
                titleIdentityId: match.titleIdentityId,
                discSelectionId: selection.id,
                lastObservationId: match.observationId,
                state: "mapped",
                createdAt: timestamp,
                updatedAt: timestamp,
              }).run();
            }
          }
          transaction.update(originalDiscArchives).set({
            updatedAt: nextCatalogMutationTimestamp(timestamp),
          }).where(eq(
            originalDiscArchives.id,
            input.originalDiscArchiveId,
          )).run();
        }, { behavior: "immediate" });
        const reviewSet = readDvdTitleIdentityReviewSetDeepAudit(
          input.originalDiscArchiveId,
        );
        if (reviewSet === null) {
          throw new DomainInvariantError(
            "Title Identity observation set was not recorded",
          );
        }
        return reviewSet;
      },

      readDvdTitleIdentityReviewSet(id) {
        return readDvdTitleIdentityReviewSet(id);
      },

      readDvdCatalogReviewWorkflowEvidence(ids) {
        return readDvdCatalogReviewWorkflowEvidence(ids);
      },

      findArchiveRecovery(id) {
        if (!hasDvdRecoveryEvidenceSchema) return null;
        return findArchiveRecoveryRecord(database, {
          originalDiscArchiveId: id,
        });
      },

      findArchiveRecoveryById(id) {
        if (!hasDvdRecoveryEvidenceSchema) return null;
        return findArchiveRecoveryRecord(database, {
          archiveRecoveryId: id,
        });
      },

      readDvdArchiveRecoveryRangeEvidence(id, options) {
        if (!hasDvdRecoveryEvidenceSchema) return null;
        const rangeOffset = options.rangeOffset;
        if (!Number.isSafeInteger(rangeOffset) || rangeOffset < 0) {
          throw new DomainInvariantError(
            "Archive Recovery range offset must be a non-negative safe integer",
          );
        }
        const rangeLimit = requirePositiveSafeInteger(
          options.rangeLimit,
          "Archive Recovery range limit",
        );
        if (rangeLimit > 100) {
          throw new DomainInvariantError(
            "Archive Recovery ranges are limited to 100 records",
          );
        }
        const recovery = findArchiveRecoveryRecord(database, {
          archiveRecoveryId: id,
        });
        if (recovery === null) return null;
        const checkpoint = access.catalog.findDvdArchiveEvidenceHeader(
          recovery.originalDiscArchiveId,
        );
        if (checkpoint === null) {
          throw new DomainInvariantError(
            "Archive Recovery has no committed DVD checkpoint",
          );
        }
        const currentManifest = database.select()
          .from(dvdArchiveEvidenceManifests)
          .where(and(
            eq(dvdArchiveEvidenceManifests.id, checkpoint.currentManifestId),
            eq(
              dvdArchiveEvidenceManifests.originalDiscArchiveId,
              recovery.originalDiscArchiveId,
            ),
          )).get();
        const initialManifest = database.select()
          .from(dvdArchiveEvidenceManifests)
          .where(and(
            eq(
              dvdArchiveEvidenceManifests.originalDiscArchiveId,
              recovery.originalDiscArchiveId,
            ),
            eq(dvdArchiveEvidenceManifests.revision, 1),
          )).get();
        if (
          currentManifest === undefined || initialManifest === undefined ||
          currentManifest.revision !== checkpoint.currentManifestRevision ||
          currentManifest.manifestDigest !== checkpoint.currentManifestDigest ||
          initialManifest.previousManifestId !== null ||
          initialManifest.recoveryReadId !== null ||
          initialManifest.evidenceFormat !== currentManifest.evidenceFormat ||
          initialManifest.imageFingerprint !==
            currentManifest.imageFingerprint ||
          initialManifest.sectorSizeBytes !== currentManifest.sectorSizeBytes ||
          initialManifest.acceptedEndLbaExclusive !==
            currentManifest.acceptedEndLbaExclusive ||
          initialManifest.boundaryPolicyVersion !==
            currentManifest.boundaryPolicyVersion ||
          initialManifest.boundaryReportedSizeBytes !==
            currentManifest.boundaryReportedSizeBytes ||
          initialManifest.boundaryPublishedSizeBytes !==
            currentManifest.boundaryPublishedSizeBytes ||
          initialManifest.boundaryEvidenceDigest !==
            currentManifest.boundaryEvidenceDigest
        ) {
          throw new DomainInvariantError(
            "DVD Archive Recovery initial range evidence is inconsistent",
          );
        }
        assertDvdArchiveEvidenceManifestDigests({
          originalDiscArchiveId: initialManifest.originalDiscArchiveId,
          revision: initialManifest.revision,
          previousManifestId: null,
          previousManifestDigest: null,
          recoveryReadId: null,
          recoveryReadEvidenceDigest: null,
          evidenceFormat: initialManifest.evidenceFormat,
          imageFingerprint: initialManifest.imageFingerprint,
          sectorSizeBytes: initialManifest.sectorSizeBytes,
          acceptedEndLbaExclusive:
            initialManifest.acceptedEndLbaExclusive,
          boundaryPolicyVersion: initialManifest.boundaryPolicyVersion,
          boundaryReportedSizeBytes:
            initialManifest.boundaryReportedSizeBytes,
          boundaryPublishedSizeBytes:
            initialManifest.boundaryPublishedSizeBytes,
          boundaryEvidenceDigest: initialManifest.boundaryEvidenceDigest,
          unrecoveredSourceRanges:
            initialManifest.unrecoveredSourceRanges,
          unrecoveredSourceRangesDigest:
            initialManifest.unrecoveredSourceRangesDigest,
          manifestDigest: initialManifest.manifestDigest,
        });
        if (currentManifest.revision > 1) {
          const previousManifest = currentManifest.previousManifestId === null
            ? undefined
            : database.select().from(dvdArchiveEvidenceManifests).where(eq(
              dvdArchiveEvidenceManifests.id,
              currentManifest.previousManifestId,
            )).get();
          const recoveryRead = currentManifest.recoveryReadId === null
            ? undefined
            : database.select().from(dvdArchiveRecoveryReads).where(eq(
              dvdArchiveRecoveryReads.id,
              currentManifest.recoveryReadId,
            )).get();
          if (
            previousManifest === undefined || recoveryRead === undefined ||
            previousManifest.originalDiscArchiveId !==
              recovery.originalDiscArchiveId ||
            previousManifest.revision + 1 !== currentManifest.revision ||
            recoveryRead.originalDiscArchiveId !==
              recovery.originalDiscArchiveId ||
            recoveryRead.fromManifestId !== previousManifest.id ||
            recoveryRead.fromManifestRevision !== previousManifest.revision
          ) {
            throw new DomainInvariantError(
              "DVD Archive Recovery current transition is inconsistent",
            );
          }
          const recoveryReadInput = {
            originalDiscArchiveId: recoveryRead.originalDiscArchiveId,
            fromManifestId: recoveryRead.fromManifestId,
            fromManifestRevision: recoveryRead.fromManifestRevision,
            startLba: recoveryRead.startLba,
            sectorCount: recoveryRead.sectorCount,
            outcome: recoveryRead.outcome,
            ...(recoveryRead.verificationId === null
              ? {}
              : {
                  verificationId: recoveryRead.verificationId,
                  discConfirmationId: recoveryRead.discConfirmationId,
                }),
          };
          assertDvdArchiveRecoveryReadEvidenceDigest(
            recoveryReadInput,
            recoveryRead.evidenceDigest,
          );
          assertDvdArchiveEvidenceManifestDigests({
            ...currentManifest,
            previousManifestDigest: previousManifest.manifestDigest,
            recoveryReadEvidenceDigest: recoveryRead.evidenceDigest,
          });
          assertDvdEvidenceRangeTransition(
            previousManifest.unrecoveredSourceRanges,
            currentManifest.unrecoveredSourceRanges,
            recoveryReadInput,
          );
          const sourceRange = previousManifest.unrecoveredSourceRanges.find(
            (range) =>
              recoveryRead.startLba >= range.startLba &&
              recoveryRead.startLba < range.startLba + range.sectorCount,
          );
          const meaningfulTransition = recoveryRead.outcome === "recovered" ||
            sourceRange?.classification === "skipped_untested";
          if (
            sourceRange === undefined ||
            recoveryRead.fromClassification !== sourceRange.classification ||
            recoveryRead.meaningfulTransition !== meaningfulTransition
          ) {
            throw new DomainInvariantError(
              "DVD Archive Recovery current transition metadata is inconsistent",
            );
          }
        }
        const rangeProjection = `
          WITH current_ranges AS (
            SELECT
              CAST(json_extract(range.value, '$.startLba') AS INTEGER)
                AS start_lba,
              CAST(json_extract(range.value, '$.sectorCount') AS INTEGER)
                AS sector_count,
              json_extract(range.value, '$.classification') AS classification
            FROM dvd_archive_evidence_manifests AS current_manifest,
              json_each(current_manifest.unrecovered_source_ranges) AS range
            WHERE current_manifest.id = ?
          ),
          initial_ranges AS (
            SELECT
              CAST(json_extract(range.value, '$.startLba') AS INTEGER)
                AS start_lba,
              CAST(json_extract(range.value, '$.sectorCount') AS INTEGER)
                AS sector_count,
              json_extract(range.value, '$.classification') AS classification
            FROM dvd_archive_evidence_manifests AS initial_manifest,
              json_each(initial_manifest.unrecovered_source_ranges) AS range
            WHERE initial_manifest.id = ?
          ),
          projection_integrity AS (
            SELECT count(*) AS invalid_count
            FROM current_ranges AS current_range
            WHERE NOT EXISTS (
              SELECT 1
              FROM initial_ranges AS initial_range
              WHERE current_range.start_lba >= initial_range.start_lba
                AND current_range.start_lba + current_range.sector_count <=
                  initial_range.start_lba + initial_range.sector_count
            )
          ),
          breakpoints AS (
            SELECT start_lba AS lba FROM initial_ranges
            UNION
            SELECT start_lba + sector_count AS lba FROM initial_ranges
            UNION
            SELECT start_lba AS lba FROM current_ranges
            UNION
            SELECT start_lba + sector_count AS lba FROM current_ranges
          ),
          ordered_breakpoints AS (
            SELECT
              lba AS start_lba,
              lead(lba) OVER (ORDER BY lba) AS end_lba
            FROM breakpoints
          ),
          projected_ranges AS (
            SELECT
              point.start_lba,
              point.end_lba - point.start_lba AS sector_count,
              coalesce((
                SELECT current_range.classification
                FROM current_ranges AS current_range
                WHERE point.start_lba >= current_range.start_lba
                  AND point.start_lba <
                    current_range.start_lba + current_range.sector_count
              ), 'recovered') AS classification
            FROM ordered_breakpoints AS point
            WHERE point.end_lba > point.start_lba
              AND EXISTS (
                SELECT 1
                FROM initial_ranges AS initial_range
                WHERE point.start_lba >= initial_range.start_lba
                  AND point.end_lba <=
                    initial_range.start_lba + initial_range.sector_count
              )
          ),
          ordered_ranges AS (
            SELECT
              *,
              lag(start_lba + sector_count) OVER (ORDER BY start_lba)
                AS previous_end_lba,
              lag(classification) OVER (ORDER BY start_lba)
                AS previous_classification
            FROM projected_ranges
          ),
          marked_ranges AS (
            SELECT
              *,
              CASE
                WHEN previous_end_lba = start_lba
                  AND previous_classification = classification
                THEN 0
                ELSE 1
              END AS starts_group
            FROM ordered_ranges
          ),
          grouped_ranges AS (
            SELECT
              *,
              sum(starts_group) OVER (ORDER BY start_lba) AS range_group
            FROM marked_ranges
          ),
          normalized_ranges AS (
            SELECT
              min(start_lba) AS start_lba,
              sum(sector_count) AS sector_count,
              classification
            FROM grouped_ranges
            GROUP BY range_group, classification
          )
        `;
        type RangeRow = {
          start_lba: number;
          sector_count: number;
          classification:
            | "skipped_untested"
            | "individually_failed"
            | "recovered";
          range_count: number;
          recovered_sector_count: number;
          invalid_count: number;
        };
        const rangeRows = sqlite.prepare(`${rangeProjection}
          SELECT
            start_lba,
            sector_count,
            classification,
            count(*) OVER () AS range_count,
            coalesce(sum(
              CASE WHEN classification = 'recovered' THEN sector_count ELSE 0 END
            ) OVER (), 0) AS recovered_sector_count,
            (SELECT invalid_count FROM projection_integrity) AS invalid_count
          FROM normalized_ranges
          ORDER BY start_lba
          LIMIT ? OFFSET ?
        `).all(
          checkpoint.currentManifestId,
          initialManifest.id,
          rangeLimit,
          rangeOffset,
        ) as unknown as RangeRow[];
        const rangeSummary = rangeRows[0] ?? sqlite.prepare(
          `${rangeProjection}
            SELECT
              count(*) AS range_count,
              coalesce(sum(
                CASE WHEN classification = 'recovered' THEN sector_count ELSE 0 END
              ), 0) AS recovered_sector_count,
              (SELECT invalid_count FROM projection_integrity) AS invalid_count
            FROM normalized_ranges
          `,
        ).get(
          checkpoint.currentManifestId,
          initialManifest.id,
        ) as unknown as Pick<
          RangeRow,
          "range_count" | "recovered_sector_count" | "invalid_count"
        >;
        if (Number(rangeSummary.invalid_count) !== 0) {
          throw new DomainInvariantError(
            "DVD Archive Recovery source range projection is inconsistent",
          );
        }
        type StoredTransitionManifest = {
          id: string;
          originalDiscArchiveId: string;
          revision: number;
          previousManifestId: string | null;
          recoveryReadId: string | null;
          evidenceFormat: "dvd-recovery-evidence-v1";
          imageFingerprint: string;
          sectorSizeBytes: number;
          acceptedEndLbaExclusive: number;
          boundaryPolicyVersion: string;
          boundaryReportedSizeBytes: number;
          boundaryPublishedSizeBytes: number;
          boundaryEvidenceDigest: string;
          unrecoveredSourceRanges: string;
          unrecoveredSourceRangesDigest: string;
          manifestDigest: string;
          previousManifestDigest: string | null;
          recoveryReadEvidenceDigest: string | null;
        };
        type TransitionRow = {
          current_manifest: string | null;
          previous_manifest: string | null;
          read_id: string;
          read_original_disc_archive_id: string;
          read_from_manifest_id: string;
          read_from_manifest_revision: number;
          start_lba: number;
          sector_count: number;
          outcome: "recovered" | "failed";
          from_classification:
            | "skipped_untested"
            | "individually_failed";
          meaningful_transition: number;
          verification_id: DvdDiscVerificationId | null;
          disc_confirmation_id: DvdDiscConfirmationId | null;
          evidence_digest: string;
          observed_at: number;
        };
        const transitionRows = sqlite.prepare(`
          WITH candidate_reads AS (
            SELECT *
            FROM dvd_archive_recovery_reads
            WHERE original_disc_archive_id = ?
              AND meaningful_transition = 1
              AND from_manifest_revision < ?
            ORDER BY from_manifest_revision DESC
            LIMIT ?
          )
          SELECT
            CASE WHEN manifest.id IS NULL THEN NULL ELSE json_object(
              'id', manifest.id,
              'originalDiscArchiveId', manifest.original_disc_archive_id,
              'revision', manifest.revision,
              'previousManifestId', manifest.previous_manifest_id,
              'recoveryReadId', manifest.recovery_read_id,
              'evidenceFormat', manifest.evidence_format,
              'imageFingerprint', manifest.image_fingerprint,
              'sectorSizeBytes', manifest.sector_size_bytes,
              'acceptedEndLbaExclusive', manifest.accepted_end_lba_exclusive,
              'boundaryPolicyVersion', manifest.boundary_policy_version,
              'boundaryReportedSizeBytes',
                manifest.boundary_reported_size_bytes,
              'boundaryPublishedSizeBytes',
                manifest.boundary_published_size_bytes,
              'boundaryEvidenceDigest', manifest.boundary_evidence_digest,
              'unrecoveredSourceRanges',
                manifest.unrecovered_source_ranges,
              'unrecoveredSourceRangesDigest',
                manifest.unrecovered_source_ranges_digest,
              'manifestDigest', manifest.manifest_digest,
              'previousManifestDigest', previous_manifest.manifest_digest,
              'recoveryReadEvidenceDigest', candidate_reads.evidence_digest
            ) END AS current_manifest,
            CASE WHEN previous_manifest.id IS NULL THEN NULL ELSE json_object(
              'id', previous_manifest.id,
              'originalDiscArchiveId',
                previous_manifest.original_disc_archive_id,
              'revision', previous_manifest.revision,
              'previousManifestId',
                previous_manifest.previous_manifest_id,
              'recoveryReadId', previous_manifest.recovery_read_id,
              'evidenceFormat', previous_manifest.evidence_format,
              'imageFingerprint', previous_manifest.image_fingerprint,
              'sectorSizeBytes', previous_manifest.sector_size_bytes,
              'acceptedEndLbaExclusive',
                previous_manifest.accepted_end_lba_exclusive,
              'boundaryPolicyVersion',
                previous_manifest.boundary_policy_version,
              'boundaryReportedSizeBytes',
                previous_manifest.boundary_reported_size_bytes,
              'boundaryPublishedSizeBytes',
                previous_manifest.boundary_published_size_bytes,
              'boundaryEvidenceDigest',
                previous_manifest.boundary_evidence_digest,
              'unrecoveredSourceRanges',
                previous_manifest.unrecovered_source_ranges,
              'unrecoveredSourceRangesDigest',
                previous_manifest.unrecovered_source_ranges_digest,
              'manifestDigest', previous_manifest.manifest_digest,
              'previousManifestDigest',
                previous_previous_manifest.manifest_digest,
              'recoveryReadEvidenceDigest',
                previous_recovery_read.evidence_digest
            ) END AS previous_manifest,
            candidate_reads.id AS read_id,
            candidate_reads.original_disc_archive_id AS
              read_original_disc_archive_id,
            candidate_reads.from_manifest_id AS read_from_manifest_id,
            candidate_reads.from_manifest_revision AS
              read_from_manifest_revision,
            candidate_reads.start_lba,
            candidate_reads.sector_count,
            candidate_reads.outcome,
            candidate_reads.from_classification,
            candidate_reads.meaningful_transition,
            candidate_reads.verification_id,
            candidate_reads.disc_confirmation_id,
            candidate_reads.evidence_digest,
            candidate_reads.created_at AS observed_at
          FROM candidate_reads
          LEFT JOIN dvd_archive_evidence_manifests AS manifest
            ON manifest.recovery_read_id = candidate_reads.id
          LEFT JOIN dvd_archive_evidence_manifests AS previous_manifest
            ON previous_manifest.id = candidate_reads.from_manifest_id
          LEFT JOIN dvd_archive_evidence_manifests AS
            previous_previous_manifest
            ON previous_previous_manifest.id =
              previous_manifest.previous_manifest_id
          LEFT JOIN dvd_archive_recovery_reads AS previous_recovery_read
            ON previous_recovery_read.id =
              previous_manifest.recovery_read_id
          ORDER BY candidate_reads.from_manifest_revision DESC
        `).all(
          recovery.originalDiscArchiveId,
          checkpoint.currentManifestRevision,
          DVD_RECOVERY_TRANSITION_SCAN_LIMIT + 1,
        ) as unknown as TransitionRow[];
        const transitionHistoryIsComplete =
          transitionRows.length <= DVD_RECOVERY_TRANSITION_SCAN_LIMIT;
        const readTransitionManifest = (
          encoded: string | null,
        ) => {
          if (encoded === null) {
            throw new DomainInvariantError(
              "DVD Archive Recovery transition manifest is missing",
            );
          }
          const stored = JSON.parse(encoded) as StoredTransitionManifest;
          const unrecoveredSourceRanges = JSON.parse(
            stored.unrecoveredSourceRanges,
          ) as DvdUnrecoveredSourceRange[];
          assertDvdArchiveEvidenceManifestDigests({
            ...stored,
            unrecoveredSourceRanges,
          });
          return { ...stored, unrecoveredSourceRanges };
        };
        const meaningfulTransitions = transitionRows
          .map((row) => {
            const previousManifest = readTransitionManifest(
              row.previous_manifest,
            );
            const currentTransitionManifest = readTransitionManifest(
              row.current_manifest,
            );
            const recoveryRead = {
              originalDiscArchiveId: row.read_original_disc_archive_id,
              fromManifestId: row.read_from_manifest_id,
              fromManifestRevision: row.read_from_manifest_revision,
              startLba: row.start_lba,
              sectorCount: row.sector_count,
              outcome: row.outcome,
              ...(row.verification_id === null
                ? {}
                : {
                    verificationId: row.verification_id,
                    discConfirmationId: row.disc_confirmation_id,
                  }),
            };
            if (
              currentTransitionManifest.revision !==
                  previousManifest.revision + 1 ||
              currentTransitionManifest.previousManifestId !==
                previousManifest.id ||
              currentTransitionManifest.recoveryReadId !== row.read_id ||
              currentTransitionManifest.originalDiscArchiveId !==
                recovery.originalDiscArchiveId ||
              previousManifest.originalDiscArchiveId !==
                recovery.originalDiscArchiveId ||
              row.read_original_disc_archive_id !==
                recovery.originalDiscArchiveId ||
              row.read_from_manifest_id !== previousManifest.id ||
              row.read_from_manifest_revision !== previousManifest.revision ||
              row.meaningful_transition !== 1
            ) {
              throw new DomainInvariantError(
                "DVD Archive Recovery transition history is inconsistent",
              );
            }
            assertDvdArchiveRecoveryReadEvidenceDigest(
              recoveryRead,
              row.evidence_digest,
            );
            assertDvdEvidenceRangeTransition(
              previousManifest.unrecoveredSourceRanges,
              currentTransitionManifest.unrecoveredSourceRanges,
              recoveryRead,
            );
            const previousRange = previousManifest.unrecoveredSourceRanges
              .find((range) =>
                row.start_lba >= range.startLba &&
                row.start_lba < range.startLba + range.sectorCount
              );
            const meaningfulTransition = row.outcome === "recovered" ||
              previousRange?.classification === "skipped_untested";
            if (
              previousRange === undefined ||
              previousRange.classification !== row.from_classification ||
              !meaningfulTransition
            ) {
              throw new DomainInvariantError(
                "DVD Archive Recovery transition has no valid prior source range",
              );
            }
            return {
              checkpointRevision: currentTransitionManifest.revision,
              startLba: row.start_lba,
              outcome: row.outcome,
              fromClassification: row.from_classification,
              observedAt: new Date(row.observed_at),
            };
          })
          .slice(0, DVD_RECOVERY_TRANSITION_SCAN_LIMIT)
          .reverse();
        let currentPassObservations: {
          count: number;
          positiveIntervalCount: number;
          minimumIntervalMs: number | null;
          maximumIntervalMs: number | null;
          lastObservedAt: Date | null;
        } | null = null;
        const work = recovery.work;
        const passStartedManifestRevision =
          work?.passStartedManifestRevision ?? null;
        if (
          passStartedManifestRevision !== null &&
          (
            !Number.isSafeInteger(passStartedManifestRevision) ||
            passStartedManifestRevision < 1 ||
            passStartedManifestRevision > checkpoint.currentManifestRevision
          )
        ) {
          throw new DomainInvariantError(
            "Archive Recovery pass checkpoint is inconsistent",
          );
        }
        if (work !== null) {
          const observationValues = [
            work.passObservationCount,
            work.passPositiveIntervalCount,
            work.passMinimumIntervalMs,
            work.passMaximumIntervalMs,
            work.passLastObservedAt,
          ];
          const hasAnyObservationState = observationValues.some((value) =>
            value !== null
          );
          const hasCompleteObservationBoundary =
            work.passStartedAt !== null &&
            passStartedManifestRevision !== null &&
            work.passInitialUnrecoveredSectorCount !== null &&
            work.passObservationCount !== null &&
            work.passPositiveIntervalCount !== null;
          if (hasAnyObservationState && !hasCompleteObservationBoundary) {
            throw new DomainInvariantError(
              "Archive Recovery pass observation state is inconsistent",
            );
          }
          if (hasCompleteObservationBoundary) {
            const count = work.passObservationCount!;
            const positiveIntervalCount =
              work.passPositiveIntervalCount!;
            const minimumIntervalMs = work.passMinimumIntervalMs;
            const maximumIntervalMs = work.passMaximumIntervalMs;
            const lastObservedAt = work.passLastObservedAt;
            const expectedObservationCount =
              checkpoint.currentManifestRevision -
              passStartedManifestRevision!;
            const intervalBoundsAreValid = positiveIntervalCount === 0
              ? minimumIntervalMs === null && maximumIntervalMs === null
              : minimumIntervalMs !== null &&
                maximumIntervalMs !== null &&
                Number.isSafeInteger(minimumIntervalMs) &&
                Number.isSafeInteger(maximumIntervalMs) &&
                minimumIntervalMs > 0 &&
                maximumIntervalMs >= minimumIntervalMs;
            if (
              !Number.isSafeInteger(count) || count < 0 ||
              !Number.isSafeInteger(positiveIntervalCount) ||
              positiveIntervalCount < 0 ||
              positiveIntervalCount > count ||
              count !== expectedObservationCount ||
              (count === 0) !== (lastObservedAt === null) ||
              !intervalBoundsAreValid ||
              (lastObservedAt !== null &&
                lastObservedAt.getTime() < work.passStartedAt!.getTime())
            ) {
              throw new DomainInvariantError(
                "Archive Recovery pass observation state is inconsistent",
              );
            }
            currentPassObservations = {
              count,
              positiveIntervalCount,
              minimumIntervalMs,
              maximumIntervalMs,
              lastObservedAt,
            };
          }
        }
        return {
          recovery,
          checkpoint,
          recoveredSectorCount: Number(
            rangeSummary.recovered_sector_count,
          ),
          currentPassObservations,
          transitions: {
            items: meaningfulTransitions,
            totalCount: transitionHistoryIsComplete
              ? meaningfulTransitions.length
              : null,
            truncated: !transitionHistoryIsComplete,
          },
          ranges: rangeRows.map((row) => ({
            startLba: Number(row.start_lba),
            sectorCount: Number(row.sector_count),
            classification: row.classification,
          })),
          rangeOffset,
          rangeCount: Number(rangeSummary.range_count),
        };
      },

      listArchiveRecoveries(options) {
        if (!hasDvdRecoveryEvidenceSchema) return [];
        const limit = requirePositiveSafeInteger(options.limit, "limit");
        if (limit > 100) {
          throw new DomainInvariantError(
            "Archive Recovery reads are limited to 100 records",
          );
        }
        const activeReconciliation = exists(
          database.select({ id: dvdRecoveryReconciliations.id })
            .from(dvdRecoveryReconciliations)
            .where(and(
              eq(
                dvdRecoveryReconciliations.archiveRecoveryId,
                archiveRecoveries.id,
              ),
              inArray(
                dvdRecoveryReconciliations.status,
                ["queued", "running"],
              ),
            )),
        );
        const requestedRecoveryPass = exists(
          database.select({ id: archiveRecoveryWork.archiveRecoveryId })
            .from(archiveRecoveryWork)
            .where(and(
              eq(
                archiveRecoveryWork.archiveRecoveryId,
                archiveRecoveries.id,
              ),
              eq(archiveRecoveryWork.status, "requested"),
            )),
        );
        const active = database.select({ id: archiveRecoveries.id })
          .from(archiveRecoveries)
          .where(or(
            inArray(archiveRecoveries.status, [
              "running",
              "paused",
              "stopping",
            ]),
            requestedRecoveryPass,
            activeReconciliation,
          ))
          .orderBy(desc(archiveRecoveries.updatedAt), desc(archiveRecoveries.id))
          .limit(limit)
          .all();
        const remaining = limit - active.length;
        const rows = remaining === 0
          ? active
          : [...active, ...database.select({ id: archiveRecoveries.id })
            .from(archiveRecoveries)
            .where(and(
              ne(archiveRecoveries.status, "running"),
              ne(archiveRecoveries.status, "paused"),
              ne(archiveRecoveries.status, "stopping"),
              notExists(
                database.select({
                  id: archiveRecoveryWork.archiveRecoveryId,
                }).from(archiveRecoveryWork).where(and(
                  eq(
                    archiveRecoveryWork.archiveRecoveryId,
                    archiveRecoveries.id,
                  ),
                  eq(archiveRecoveryWork.status, "requested"),
                )),
              ),
              notExists(
                database.select({ id: dvdRecoveryReconciliations.id })
                  .from(dvdRecoveryReconciliations)
                  .where(and(
                    eq(
                      dvdRecoveryReconciliations.archiveRecoveryId,
                      archiveRecoveries.id,
                    ),
                    inArray(
                      dvdRecoveryReconciliations.status,
                      ["queued", "running"],
                    ),
                  )),
              ),
            ))
            .orderBy(
              desc(archiveRecoveries.updatedAt),
              desc(archiveRecoveries.id),
            )
            .limit(remaining)
            .all()];
        return rows
          .map(({ id }) => findArchiveRecoveryRecord(database, {
            archiveRecoveryId: id,
          }))
          .filter((recovery): recovery is ArchiveRecovery => recovery !== null);
      },

      findDvdSourceSampleManifest(id) {
        if (!hasDvdRecoveryEvidenceSchema) return null;
        const row = database
          .select({ manifest: dvdSourceSampleManifests.manifest })
          .from(dvdSourceSampleManifests)
          .where(eq(dvdSourceSampleManifests.originalDiscArchiveId, id))
          .get();
        return row === undefined
          ? null
          : validateDvdSourceSampleManifest(row.manifest);
      },

      listCatalogReviewArchives(options) {
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > CATALOG_REVIEW_ARCHIVE_LIMIT
        ) {
          throw new DomainInvariantError(
            `Catalog Review archive limit must be between 1 and ${CATALOG_REVIEW_ARCHIVE_LIMIT}`,
          );
        }
        if (options.outcome !== undefined && options.view !== "reviewed") {
          throw new DomainInvariantError(
            "Catalog Review outcome filter requires the Reviewed view",
          );
        }
        const searchQuery = options.query === undefined
          ? undefined
          : requireNonEmpty(options.query, "query");
        if (searchQuery !== undefined && searchQuery.length > 256) {
          throw new DomainInvariantError(
            "Catalog Review search query must be at most 256 characters",
          );
        }
        const normalizedQuery = searchQuery === undefined
          ? undefined
          : normalizeMediaItemSearchTitle(searchQuery);
        if (normalizedQuery !== undefined && normalizedQuery.length === 0) {
          throw new DomainInvariantError(
            "Catalog Review search query must contain a letter or number",
          );
        }
        const searchPattern = normalizedQuery === undefined
          ? undefined
          : `%${normalizedQuery.replaceAll(" ", "%")}%`;
        const normalizedDiscLabel =
          sql`rip_dvd_normalize_media_item_title(${detectedDiscs.volumeLabel})`;
        const normalizedMediaTitle =
          sql`rip_dvd_normalize_media_item_title(${mediaItems.title})`;
        const conditions = [
          options.view === "needs_review"
            ? eq(originalDiscArchives.catalogReviewOutcome, "needs_review")
            : ne(originalDiscArchives.catalogReviewOutcome, "needs_review"),
          options.outcome === undefined
            ? undefined
            : eq(originalDiscArchives.catalogReviewOutcome, options.outcome),
          searchPattern === undefined
            ? undefined
            : or(
                sql`${normalizedDiscLabel} like ${searchPattern}`,
                exists(
                  database
                    .select({ id: discSelections.id })
                    .from(discSelections)
                    .innerJoin(
                      mediaItems,
                      eq(mediaItems.id, discSelections.mediaItemId),
                    )
                    .where(and(
                      eq(
                        discSelections.originalDiscArchiveId,
                        originalDiscArchives.id,
                      ),
                      eq(discSelections.isCatalogActive, true),
                      sql`${normalizedMediaTitle} like ${searchPattern}`,
                    )),
                ),
              ),
          options.cursor
            ? or(
                options.cursor.direction === "older"
                  ? lt(
                      originalDiscArchives.archivedAt,
                      options.cursor.archivedAt,
                    )
                  : gt(
                      originalDiscArchives.archivedAt,
                      options.cursor.archivedAt,
                    ),
                and(
                  eq(
                    originalDiscArchives.archivedAt,
                    options.cursor.archivedAt,
                  ),
                  options.cursor.direction === "older"
                    ? options.cursor.inclusive
                      ? lte(originalDiscArchives.id, options.cursor.id)
                      : lt(originalDiscArchives.id, options.cursor.id)
                    : options.cursor.inclusive
                      ? gte(originalDiscArchives.id, options.cursor.id)
                      : gt(originalDiscArchives.id, options.cursor.id),
                ),
              )
            : undefined,
        ].filter((condition) => condition !== undefined);
        const readsNewer = options.cursor?.direction === "newer";
        const rows = database
          .select({
            archive: originalDiscArchives,
            discLabel: detectedDiscs.volumeLabel,
          })
          .from(originalDiscArchives)
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
          )
          .where(and(...conditions))
          .orderBy(
            ...(readsNewer
              ? [
                  asc(originalDiscArchives.archivedAt),
                  asc(originalDiscArchives.id),
                ]
              : [
                  desc(originalDiscArchives.archivedAt),
                  desc(originalDiscArchives.id),
                ]),
          )
          .limit(options.limit)
          .all();
        const orderedRows = readsNewer ? rows : rows.reverse();
        return orderedRows.map(({ archive, discLabel }) => {
          const activeSelectionCondition = and(
            eq(discSelections.originalDiscArchiveId, archive.id),
            eq(discSelections.isCatalogActive, true),
          );
          const mappedMediaItemCount = database
            .select({ count: countDistinct(discSelections.mediaItemId) })
            .from(discSelections)
            .where(activeSelectionCondition)
            .get()?.count ?? 0;
          const mappedMediaItemTitles = database
            .selectDistinct({ title: mediaItems.title })
            .from(discSelections)
            .innerJoin(mediaItems, eq(mediaItems.id, discSelections.mediaItemId))
            .where(activeSelectionCondition)
            .orderBy(asc(mediaItems.title), asc(mediaItems.id))
            .limit(CATALOG_REVIEW_MAPPED_TITLE_SUMMARY_LIMIT)
            .all()
            .map(({ title }) => title);
          return {
            ...archive,
            discLabel: discLabel ?? "Unlabeled disc",
            mappedMediaItemCount,
            mappedMediaItemTitles,
          };
        });
      },

      completeCatalogReview(id, catalogRevision, outcome) {
        if (
          !(catalogRevision instanceof Date) ||
          !Number.isSafeInteger(catalogRevision.getTime())
        ) {
          throw new DomainInvariantError(
            "Catalog review revision must be a valid timestamp",
          );
        }
        if (
          outcome !== "reviewed_with_selections" &&
          outcome !== "archive_only"
        ) {
          throw new DomainInvariantError(
            "Catalog review outcome must be reviewed with selections or Archive only",
          );
        }
        const timestamp = now();
        const validatedArchive = outcome === "reviewed_with_selections"
          ? validateDiscSelectionsOutsideWriter(id, catalogRevision)
          : validateArchiveOnlyOutsideWriter(id, catalogRevision);
        return database.transaction((transaction) => {
          const archive = requireCurrentCatalogValidation(
            validatedArchive,
            transaction,
            true,
          );
          return completeCatalogReviewTransition(
            transaction,
            archive,
            catalogRevision,
            outcome,
            timestamp,
            { allowIdempotentCompletion: true },
          );
        }, { behavior: "immediate" });
      },

      completeCatalogReviewWithReplacements(
        id,
        catalogRevision,
        outcome,
        replacements,
        options,
      ) {
        if (
          !(catalogRevision instanceof Date) ||
          !Number.isSafeInteger(catalogRevision.getTime())
        ) {
          throw new DomainInvariantError(
            "Catalog review revision must be a valid timestamp",
          );
        }
        if (
          outcome !== "reviewed_with_selections" &&
          outcome !== "archive_only"
        ) {
          throw new DomainInvariantError(
            "Catalog review outcome must be reviewed with selections or Archive only",
          );
        }
        if (
          !Array.isArray(replacements) ||
          replacements.length > CORRECTED_ENCODE_REPLACEMENT_LIMIT
        ) {
          throw new DomainInvariantError(
            "Corrected Encode replacement plan is limited to 100 jobs",
          );
        }
        if (outcome === "archive_only" && replacements.length > 0) {
          throw new DomainInvariantError(
            "Archive-only Review cannot queue corrected replacement encodes",
          );
        }
        const predecessorIds = new Set<EncodeJobId>();
        for (const replacement of replacements) {
          if (predecessorIds.has(replacement.predecessorEncodeJobId)) {
            throw new DomainInvariantError(
              "Corrected Encode replacement plan contains a duplicate predecessor",
            );
          }
          predecessorIds.add(replacement.predecessorEncodeJobId);
          requireNonEmpty(replacement.outputPath, "outputPath");
          if (
            replacement.priority !== undefined &&
            !Number.isSafeInteger(replacement.priority)
          ) {
            throw new DomainInvariantError("priority must be a safe integer");
          }
        }
        const semanticInput = catalogReviewCompletionSemanticInput({
          id,
          catalogRevision,
          outcome,
          replacements,
        });
        const operation = "catalog_review.complete";
        if (options?.mutationKey !== undefined) {
          const replay = database.transaction((transaction) =>
            readMutationInvocation(
              transaction,
              options.mutationKey!,
              operation,
              semanticInput,
              decodeCatalogReviewCompletionOutcome,
            )
          );
          if (replay !== undefined) return replay;
        }
        const timestamp = now();
        const validatedArchive = outcome === "reviewed_with_selections"
          ? validateDiscSelectionsOutsideWriter(id, catalogRevision)
          : validateArchiveOnlyOutsideWriter(id, catalogRevision);
        return database.transaction((transaction) => {
          if (options?.mutationKey !== undefined) {
            const replay = readMutationInvocation(
              transaction,
              options.mutationKey,
              operation,
              semanticInput,
              decodeCatalogReviewCompletionOutcome,
            );
            if (replay !== undefined) return replay;
          }
          const archive = requireCurrentCatalogValidation(
            validatedArchive,
            transaction,
            true,
          );
          const evidenceEncodingCapability = replacements.length === 0
            ? null
            : requireDvdEvidenceReplacementEncodingAvailable(transaction, id);
          if (archive.updatedAt.getTime() !== catalogRevision.getTime()) {
            throw new StaleCatalogRevisionError(
              "Catalog review changed; reload before completing review",
            );
          }
          const candidates = replacements.map((input) => {
            const plan = requireRow(
              readCorrectedEncodeReplacementPlans({
                originalDiscArchiveId: id,
                predecessorEncodeJobId: input.predecessorEncodeJobId,
                limit: 1,
              })[0],
              "corrected Encode predecessor",
              input.predecessorEncodeJobId,
            );
            const predecessor = requireEncodeJob(
              transaction,
              plan.predecessorEncodeJobId,
            );
            const existingReplacement = transaction
              .select({ id: replacementEncodeJobRecords.id })
              .from(replacementEncodeJobRecords)
              .where(eq(
                replacementEncodeJobRecords.predecessorEncodeJobId,
                predecessor.id,
              ))
              .limit(1)
              .get();
            if (existingReplacement) {
              throw new DomainInvariantError(
                `Encode Job ${predecessor.id} already has a corrected replacement`,
              );
            }
            const validated = validateCorrectedEncodeReplacement(
              transaction,
              input,
              predecessor,
            );
            return {
              ...validated,
              plan,
            };
          });

          if (options?.mutationKey !== undefined &&
              options.previewToken === undefined) {
            throw new DomainInvariantError(
              "Catalog Review completion preview acknowledgement is required",
            );
          }
          if (options?.previewToken !== undefined) {
            const decision = transaction.select().from(mutationInvocations)
              .where(eq(mutationInvocations.key, options.previewToken)).get();
            if (decision?.operation !== "catalog_review.complete.preview" ||
                decision.semanticInput !== semanticInput) {
              throw new DomainInvariantError(
                "Catalog Review completion preview does not match the accepted plan",
              );
            }
            const saved = JSON.parse(decision.outcome) as {
              expectedPreviewEvidence?: unknown;
            };
            const availableReplacements =
              readAllCorrectedEncodeReplacementPlans(id);
            const previewEvidence = JSON.stringify({
              replacementConsequences: candidates.map((candidate) => ({
                ...candidate.input,
                replacementDiscSelectionId:
                  candidate.plan.replacementDiscSelectionId,
                predecessorStatus: candidate.plan.predecessorStatus,
                predecessorReady: candidate.plan.predecessorReady,
                replacesExistingOutput: candidate.replacesExistingOutput,
              })),
              availableReplacementPredecessorIds: availableReplacements.map(
                (replacement) => replacement.predecessorEncodeJobId,
              ),
              failedOutputReservationReleaseEncodeJobIds:
                availableReplacements
                  .filter((replacement) =>
                    replacement.releasesFailedOutputReservation
                  )
                  .map((replacement) => replacement.predecessorEncodeJobId),
            });
            if (saved.expectedPreviewEvidence !== previewEvidence) {
              throw new DomainInvariantError(
                "Catalog Review completion preview is stale",
              );
            }
          }
          const completed = completeCatalogReviewTransition(
            transaction,
            archive,
            catalogRevision,
            outcome,
            timestamp,
          );

          const replacementEncodeJobs: EncodeJob[] = [];
          if (evidenceEncodingCapability !== null) {
            for (const candidate of candidates) {
              const replacement = insertCorrectedEncodeReplacementJob(
                transaction,
                candidate,
                id,
                evidenceEncodingCapability,
                candidate.plan.replacementDiscSelectionId,
                timestamp,
              );
              replacementEncodeJobs.push(replacement);
            }
          }

          releaseCorrectedFailedReservationsStatement.run(
            id,
            timestamp.getTime(),
          );

          if (options?.previewToken !== undefined) {
            transaction.delete(mutationInvocations)
              .where(eq(mutationInvocations.key, options.previewToken)).run();
          }

          const result = { archive: completed, replacementEncodeJobs };
          return options?.mutationKey === undefined
            ? result
            : recordMutationInvocation(
                transaction,
                options.mutationKey,
                operation,
                semanticInput,
                result,
                timestamp,
              );
        }, { behavior: "immediate" });
      },

      recordCatalogReviewEvidenceChoice(input) {
        if (
          !(input.catalogRevision instanceof Date) ||
          !Number.isSafeInteger(input.catalogRevision.getTime()) ||
          !Number.isSafeInteger(input.checkpointRevision) ||
          input.checkpointRevision < 1 ||
          !/^[0-9a-f]{64}$/.test(input.checkpointDigest)
        ) {
          throw new DomainInvariantError(
            "Catalog Review choice evidence is invalid",
          );
        }
        const semanticInput = catalogReviewEvidenceChoiceSemanticInput(input);
        const operation = `catalog_review.${input.choice}`;
        return database.transaction((transaction) => {
          const replay = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeCatalogReviewEvidenceChoiceResult,
          );
          if (replay !== undefined) return replay;

          const archive = requireRow(
            transaction.select().from(originalDiscArchives).where(eq(
              originalDiscArchives.id,
              input.originalDiscArchiveId,
            )).get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          // Hold the write reservation while validating every manifest back to
          // revision 1, then read the exact checkpoint identity used below.
          access.catalog.auditDvdArchiveEvidenceChains([
            input.originalDiscArchiveId,
          ]);
          const header = requireRow(
            transaction.select().from(dvdArchiveEvidenceHeaders).where(eq(
              dvdArchiveEvidenceHeaders.originalDiscArchiveId,
              input.originalDiscArchiveId,
            )).get(),
            "DVD Archive Evidence",
            input.originalDiscArchiveId,
          );
          if (header.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT) {
            throw new DomainInvariantError(
              "Catalog Review evidence choice requires dvd-recovery-evidence-v1",
            );
          }
          const recovery = findArchiveRecoveryRecord(transaction, {
            originalDiscArchiveId: input.originalDiscArchiveId,
          });
          if (recovery === null || recovery.status === "faulted") {
            throw new DomainInvariantError(
              "Archive Recovery has no consistent current state",
            );
          }
          if (
            input.choice === "archive_only" &&
            recovery.status !== "stopped" &&
            recovery.status !== "completed"
          ) {
            throw new DomainInvariantError(
              "Archive Recovery must stop or complete before choosing archive-only",
            );
          }
          if (
            input.choice === "archive_only"
              ? archive.catalogReviewOutcome !== "needs_review"
              : archive.catalogReviewOutcome !== "archive_only"
          ) {
            throw new DomainInvariantError(
              input.choice === "archive_only"
                ? "Catalog Review is not open for an archive-only choice"
                : "Catalog Review is not archive-only",
            );
          }
          if (
            archive.updatedAt.getTime() !== input.catalogRevision.getTime() ||
            header.currentManifestRevision !== input.checkpointRevision ||
            header.currentManifestDigest !== input.checkpointDigest
          ) {
            throw new StaleCatalogRevisionError(
              "Catalog Review evidence changed; inspect it again before recording the choice",
            );
          }

          const recordedAt = now();
          const choiceId = newId<CatalogReviewChoiceId>();
          transaction.insert(catalogReviewEvidenceChoices).values({
            id: choiceId,
            originalDiscArchiveId: input.originalDiscArchiveId,
            choice: input.choice,
            catalogRevision: input.catalogRevision,
            checkpointRevision: header.currentManifestRevision,
            checkpointDigest: header.currentManifestDigest,
            archiveRecoveryId: recovery.id,
            archiveRecoveryAttemptId: recovery.attemptId,
            archiveRecoveryStatus: recovery.status,
            recordedAt,
          }).run();
          const resultingArchive = requireRow(
            transaction.update(originalDiscArchives).set({
              catalogReviewedAt: input.choice === "archive_only"
                ? recordedAt
                : null,
              catalogReviewOutcome: input.choice === "archive_only"
                ? "archive_only"
                : "needs_review",
              updatedAt: nextCatalogMutationTimestamp(recordedAt),
            }).where(and(
              eq(originalDiscArchives.id, input.originalDiscArchiveId),
              eq(originalDiscArchives.updatedAt, input.catalogRevision),
              eq(
                originalDiscArchives.catalogReviewOutcome,
                input.choice === "archive_only"
                  ? "needs_review"
                  : "archive_only",
              ),
            )).returning().get(),
            "current Catalog Review",
            input.originalDiscArchiveId,
          );
          const result: CatalogReviewEvidenceChoiceResult = {
            choiceId,
            choice: input.choice,
            originalDiscArchiveId: input.originalDiscArchiveId,
            catalogRevision: input.catalogRevision,
            checkpoint: {
              revision: header.currentManifestRevision,
              manifestDigest: header.currentManifestDigest,
            },
            recovery: {
              id: recovery.id,
              attemptId: recovery.attemptId,
              state: recovery.status,
            },
            resultingArchive,
            recordedAt,
          };
          return recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            result,
            recordedAt,
          );
        }, { behavior: "immediate" });
      },

      listCatalogReviewEvidenceChoices(id, options) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 ||
            options.limit > 101) {
          throw new DomainInvariantError(
            "Catalog Review choice history limit must be between 1 and 101",
          );
        }
        return database.select().from(catalogReviewEvidenceChoices).where(eq(
          catalogReviewEvidenceChoices.originalDiscArchiveId,
          id,
        )).orderBy(
          desc(catalogReviewEvidenceChoices.catalogRevision),
          desc(catalogReviewEvidenceChoices.id),
        ).limit(options.limit).all() satisfies CatalogReviewEvidenceChoiceRecord[];
      },

      recordCatalogReviewCompletionPreviewDecision(input) {
        if (!(input.catalogRevision instanceof Date) ||
            !Number.isSafeInteger(input.catalogRevision.getTime())) {
          throw new DomainInvariantError(
            "Catalog review revision must be a valid timestamp",
          );
        }
        database.insert(mutationInvocations).values({
          key: requireNonEmpty(input.previewToken, "previewToken"),
          operation: "catalog_review.complete.preview",
          semanticInput: catalogReviewCompletionSemanticInput({
            id: input.originalDiscArchiveId,
            catalogRevision: input.catalogRevision,
            outcome: input.outcome,
            replacements: input.replacements,
          }),
          outcome: JSON.stringify({
            expectedPreviewEvidence: input.expectedPreviewEvidence,
          }),
          createdAt: now(),
        }).run();
      },

      recordDvdTitleDamageAcceptancePreviewDecision(input) {
        database.insert(mutationInvocations).values({
          key: requireNonEmpty(input.previewToken, "previewToken"),
          operation: "dvd_title_damage_acceptance.preview",
          semanticInput: dvdTitleDamagePreviewSemanticInput(input),
          outcome: JSON.stringify({
            expectedPreviewEvidence: input.expectedPreviewEvidence,
            decisionSnapshot: input.decisionSnapshot,
          }),
          createdAt: now(),
        }).run();
      },

      recordDvdTitleDamageAcceptanceWithdrawalPreviewDecision(input) {
        database.insert(mutationInvocations).values({
          key: requireNonEmpty(input.previewToken, "previewToken"),
          operation: "dvd_title_damage_acceptance.withdraw.preview",
          semanticInput: dvdTitleDamageWithdrawalPreviewSemanticInput(input),
          outcome: JSON.stringify({ affectedWork: input.affectedWork }),
          createdAt: now(),
        }).run();
      },

      recordDvdTitleDamageDecision(input) {
        const operation = "dvd_title_damage_acceptance.accept";
        const semanticInput = dvdTitleDamageDecisionSemanticInput(input);
        return database.transaction((transaction) => {
          const replay = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeDvdTitleDamageDecision,
          );
          if (replay !== undefined) return replay;

          const operator = requireNonEmpty(input.operator, "operator").trim();
          if (operator.length > 128) {
            throw new DomainInvariantError(
              "Title Damage Acceptance operator must be at most 128 characters",
            );
          }
          const previewDecision = transaction.select()
            .from(mutationInvocations)
            .where(eq(mutationInvocations.key, input.previewToken))
            .get();
          if (
            previewDecision?.operation !==
              "dvd_title_damage_acceptance.preview" ||
            previewDecision.semanticInput !==
              dvdTitleDamagePreviewSemanticInput(input)
          ) {
            throw new DomainInvariantError(
              "Title Damage Acceptance preview does not match the submitted exact set",
            );
          }
          const preview = JSON.parse(previewDecision.outcome) as {
            expectedPreviewEvidence?: unknown;
            decisionSnapshot?: unknown;
          };
          const snapshot = preview.decisionSnapshot as
            | import("../types.js").DvdTitleDamageDecisionSnapshot
            | undefined;
          if (
            typeof preview.expectedPreviewEvidence !== "string" ||
            snapshot === undefined || snapshot.schemaVersion !== 1 ||
            !Array.isArray(snapshot.affectedWork)
          ) {
            throw new DomainInvariantError(
              "Title Damage Acceptance preview is invalid",
            );
          }
          const expectedMatches =
            input.checkpoint.revision === snapshot.current.checkpoint.revision &&
            input.checkpoint.digest ===
              snapshot.current.checkpoint.manifestDigest &&
            input.assessmentIdentity === snapshot.assessmentIdentity &&
            input.reviewSetIdentity === snapshot.reviewSetIdentity &&
            input.catalogMappingProjectionId ===
              snapshot.catalogMappingProjectionId &&
            input.reviewedContentIdentity ===
              snapshot.reviewedContentIdentity &&
            JSON.stringify([...input.excludedTitleIdentityIds].sort()) ===
              JSON.stringify(snapshot.excludedTitleIdentityIds) &&
            JSON.stringify([...input.mainFeatureResolutions].sort(
              (left, right) =>
                left.discSelectionId.localeCompare(right.discSelectionId),
            )) === JSON.stringify(snapshot.mainFeatureResolutions);
          if (!expectedMatches) {
            throw new DomainInvariantError(
              "Title Damage Acceptance expected identities do not match the preview",
            );
          }
          if (snapshot.acknowledgementRequired &&
              input.damageAcknowledgement !== true) {
            throw new DomainInvariantError(
              "Explicit damage acknowledgement is required for this exact set",
            );
          }

          const current = currentDvdTitleDamageDecisionIdentities(
            transaction,
            input.originalDiscArchiveId,
          );
          const recovery = snapshot.current.recovery;
          const currentAffectedWork = transaction.select({
            id: encodeJobs.id,
            discSelectionId: encodeJobs.discSelectionId,
            status: encodeJobs.status,
          }).from(encodeJobs).innerJoin(
            discSelections,
            eq(discSelections.id, encodeJobs.discSelectionId),
          ).where(and(
            eq(
              discSelections.originalDiscArchiveId,
              input.originalDiscArchiveId,
            ),
            eq(discSelections.isCatalogActive, true),
            inArray(encodeJobs.status, ACTIVE_ENCODE_WORK_STATUSES),
          )).orderBy(asc(encodeJobs.id))
            .limit(ACTIVE_ENCODE_JOB_RESULT_LIMIT + 1).all();
          const stale =
            current.catalogRevision !== snapshot.current.catalogRevision ||
            current.checkpoint?.revision !== input.checkpoint.revision ||
            current.checkpoint?.digest !== input.checkpoint.digest ||
            current.recovery?.id !== recovery.id ||
            current.recovery?.attemptId !== recovery.attemptId ||
            current.recovery?.state !== recovery.state ||
            (current.recovery?.state !== "stopped" &&
              current.recovery?.state !== "completed") ||
            current.assessmentIdentity !== input.assessmentIdentity ||
            current.reviewSetIdentity !== input.reviewSetIdentity ||
            current.catalogMappingProjectionId !==
              input.catalogMappingProjectionId ||
            JSON.stringify(currentAffectedWork) !==
              JSON.stringify(snapshot.affectedWork);
          if (stale) {
            throw new StaleDvdTitleDamageDecisionError(current);
          }

          const existing = inspectDvdTitleDamageDecision(
            input.originalDiscArchiveId,
            transaction,
          ).current;
          const assessmentAttempt = requireRow(
            transaction.select({
              sequence: dvdTitleDamageAssessmentAttempts.sequence,
              assessmentId: dvdTitleDamageAssessmentAttempts.assessmentId,
            }).from(dvdTitleDamageAssessmentAttempts).where(eq(
              dvdTitleDamageAssessmentAttempts.originalDiscArchiveId,
              input.originalDiscArchiveId,
            )).orderBy(desc(dvdTitleDamageAssessmentAttempts.sequence))
              .limit(1).get(),
            "current Title Damage Assessment attempt",
            input.assessmentIdentity,
          );
          if (assessmentAttempt.assessmentId !== input.assessmentIdentity) {
            throw new StaleDvdTitleDamageDecisionError(current);
          }
          const requestedTimestamp = now();
          const latestRecordedAt = transaction.select({
            recordedAt: dvdTitleDamageDecisions.recordedAt,
          }).from(dvdTitleDamageDecisions).where(eq(
            dvdTitleDamageDecisions.originalDiscArchiveId,
            input.originalDiscArchiveId,
          )).orderBy(desc(dvdTitleDamageDecisions.recordedAt)).limit(1)
            .get()?.recordedAt;
          const timestamp = latestRecordedAt !== undefined &&
              requestedTimestamp.getTime() <= latestRecordedAt.getTime()
            ? new Date(latestRecordedAt.getTime() + 1)
            : requestedTimestamp;
          const decision = existing !== null &&
              existing.reviewedContentIdentity ===
                input.reviewedContentIdentity &&
              existing.operator === operator &&
              existing.decision ===
                (snapshot.acknowledgementRequired
                  ? "accepted"
                  : "not_required")
            ? existing
            : toDvdTitleDamageDecision(requireRow(
              transaction.insert(dvdTitleDamageDecisions).values({
                id: newId<DvdTitleDamageDecisionId>(),
                originalDiscArchiveId: input.originalDiscArchiveId,
                decision: snapshot.acknowledgementRequired
                  ? "accepted"
                  : "not_required",
                acceptedDecisionId: null,
                operator,
                catalogRevision: new Date(snapshot.current.catalogRevision),
                checkpointRevision: input.checkpoint.revision,
                checkpointDigest: input.checkpoint.digest,
                assessmentIdentity: input.assessmentIdentity,
                assessmentAttemptSequence: assessmentAttempt.sequence,
                reviewSetIdentity: input.reviewSetIdentity,
                catalogMappingProjectionId:
                  input.catalogMappingProjectionId,
                reviewedContentIdentity: input.reviewedContentIdentity,
                excludedTitleIdentityIds:
                  snapshot.excludedTitleIdentityIds,
                mainFeatureResolutions: snapshot.mainFeatureResolutions,
                snapshot,
                recordedAt: timestamp,
              }).returning().get(),
              "Title Damage decision",
              input.originalDiscArchiveId,
            ));
          transaction.delete(mutationInvocations)
            .where(eq(mutationInvocations.key, input.previewToken))
            .run();
          return recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decision,
            timestamp,
          );
        }, { behavior: "immediate" });
      },

      withdrawDvdTitleDamageAcceptance(input) {
        const operation = "dvd_title_damage_acceptance.withdraw";
        const semanticInput = dvdTitleDamageWithdrawalSemanticInput(input);
        return database.transaction((transaction) => {
          const replay = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeDvdTitleDamageDecision,
          );
          if (replay !== undefined) return replay;

          const operator = requireNonEmpty(input.operator, "operator").trim();
          if (operator.length > 128) {
            throw new DomainInvariantError(
              "Title Damage Acceptance withdrawal operator must be at most 128 characters",
            );
          }
          const previewDecision = transaction.select()
            .from(mutationInvocations)
            .where(eq(mutationInvocations.key, input.previewToken))
            .get();
          if (
            previewDecision?.operation !==
              "dvd_title_damage_acceptance.withdraw.preview" ||
            previewDecision.semanticInput !==
              dvdTitleDamageWithdrawalPreviewSemanticInput(input)
          ) {
            throw new DomainInvariantError(
              "Title Damage Acceptance withdrawal preview does not match the accepted decision",
            );
          }

          const inspection = inspectDvdTitleDamageDecision(
            input.originalDiscArchiveId,
            transaction,
          );
          const accepted = inspection.current;
          if (
            accepted?.decision !== "accepted" ||
            accepted.id !== input.acceptedDecisionId
          ) {
            throw new StaleDvdTitleDamageAcceptanceWithdrawalError({
              state: inspection.state,
              decisionId: accepted?.id ?? null,
            });
          }
          const affectedWork = dvdTitleDamageWithdrawalAffectedWork(
            transaction,
            accepted,
          );
          const requestedTimestamp = now();
          const latestRecordedAt = transaction.select({
            recordedAt: dvdTitleDamageDecisions.recordedAt,
          }).from(dvdTitleDamageDecisions).where(eq(
            dvdTitleDamageDecisions.originalDiscArchiveId,
            input.originalDiscArchiveId,
          )).orderBy(desc(dvdTitleDamageDecisions.recordedAt)).limit(1)
            .get()?.recordedAt;
          const timestamp = latestRecordedAt !== undefined &&
              requestedTimestamp.getTime() <= latestRecordedAt.getTime()
            ? new Date(latestRecordedAt.getTime() + 1)
            : requestedTimestamp;
          const withdrawn = toDvdTitleDamageDecision(requireRow(
            transaction.insert(dvdTitleDamageDecisions).values({
              id: newId<DvdTitleDamageDecisionId>(),
              originalDiscArchiveId: accepted.originalDiscArchiveId,
              decision: "withdrawn",
              acceptedDecisionId: accepted.id,
              operator,
              catalogRevision: accepted.catalogRevision,
              checkpointRevision: accepted.checkpointRevision,
              checkpointDigest: accepted.checkpointDigest,
              assessmentIdentity: accepted.assessmentIdentity,
              assessmentAttemptSequence: accepted.assessmentAttemptSequence,
              reviewSetIdentity: accepted.reviewSetIdentity,
              catalogMappingProjectionId:
                accepted.catalogMappingProjectionId,
              reviewedContentIdentity: accepted.reviewedContentIdentity,
              excludedTitleIdentityIds:
                accepted.excludedTitleIdentityIds,
              mainFeatureResolutions: accepted.mainFeatureResolutions,
              snapshot: { ...accepted.snapshot, affectedWork },
              recordedAt: timestamp,
            }).returning().get(),
            "Title Damage Acceptance withdrawal",
            accepted.id,
          ));
          transaction.delete(mutationInvocations)
            .where(eq(mutationInvocations.key, input.previewToken))
            .run();
          return recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            withdrawn,
            timestamp,
          );
        }, { behavior: "immediate" });
      },

      inspectDvdTitleDamageDecision(id) {
        return inspectDvdTitleDamageDecision(id);
      },

      createMediaItem(input, options) {
        const timestamp = now();
        const id = newId<MediaItemId>();
        return database.transaction((transaction) => runMediaItemMutation(
          transaction,
          options?.mutationKey,
          "media_item.create",
          JSON.stringify(input),
          () => {
          const mediaItem = insertValidatedMediaItem(
            transaction,
            { ...input, id },
            timestamp,
          );
          ensureMediaItemTmdbIdentity(
            transaction,
            mediaItem,
            input.tmdbIdentity,
            timestamp,
          );
          return mediaItem;
          },
        ), { behavior: "immediate" });
      },

      createMappingProposal(input) {
        validateMappingProposalReviewTransition(input, "Mapping Proposal");
        const timestamp = now();
        const mediaItemId = newId<MediaItemId>();
        const discSelectionId = newId<DiscSelectionId>();
        const { mutationKey, ...semanticFields } = input;
        const semanticInput = JSON.stringify(semanticFields);
        return database.transaction((transaction) => {
          const replay = mutationKey === undefined ? undefined
            : readMutationInvocation(
              transaction,
              mutationKey,
              "mapping_proposal.movie",
              semanticInput,
              decodeMappingProposalOutcome<ReturnType<
                typeof access.catalog.createMappingProposal
              >>,
            );
          if (replay !== undefined) return replay;
          const currentArchive = requireRow(
            transaction
              .select({ updatedAt: originalDiscArchives.updatedAt })
              .from(originalDiscArchives)
              .where(eq(
                originalDiscArchives.id,
                input.originalDiscArchiveId,
              ))
              .get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          if (
            currentArchive.updatedAt.getTime() !==
              input.catalogRevision.getTime()
          ) {
            throw new StaleCatalogRevisionError(
              "Catalog review changed; reload before saving Mapping Proposal",
            );
          }

          const label = input.discSelection.label === undefined
            ? undefined
            : requireNonEmpty(input.discSelection.label, "label");

          const mediaItem = input.existingMediaItemId === undefined
            ? insertValidatedMediaItem(
                transaction,
                { ...input.mediaItem, id: mediaItemId },
                timestamp,
                { requireAssistedMappingShape: true },
              )
            : requireRow(
              transaction
                .select()
                .from(mediaItems)
                .where(eq(mediaItems.id, input.existingMediaItemId))
                .get(),
              "media item",
              input.existingMediaItemId,
            );
          if (input.existingMediaItemId === undefined) {
            ensureMediaItemTmdbIdentity(
              transaction,
              mediaItem,
              input.mediaItem.tmdbIdentity,
              timestamp,
            );
          } else {
            ensureMediaItemTmdbIdentity(
              transaction,
              mediaItem,
              input.existingMediaItemTmdbIdentity,
              timestamp,
            );
          }
          const discSelection = insertDiscSelection(
            transaction,
            {
              originalDiscArchiveId: input.originalDiscArchiveId,
              mediaItemId: mediaItem.id,
              sourceIdentity: input.discSelection.sourceIdentity,
              ...(label === undefined ? {} : { label }),
            },
            discSelectionId,
            timestamp,
            {
              rejectSourceOverlap: true,
              validateAgainstCurrentTitleIdentity: true,
            },
          );
          applyMappingProposalReviewTransition(
            transaction,
            input,
            timestamp,
          );
          const outcome = { mediaItem, discSelection };
          return mutationKey === undefined ? outcome : recordMutationInvocation(
            transaction,
            mutationKey,
            "mapping_proposal.movie",
            semanticInput,
            outcome,
            timestamp,
          );
        }, { behavior: "immediate" });
      },

      createEpisodicMappingProposal(input) {
        validateMappingProposalReviewTransition(
          input,
          "Episodic Mapping Proposal",
        );
        if (
          !Array.isArray(input.episodes) ||
          input.episodes.length === 0 ||
          input.episodes.length > MAX_DVD_TITLES
        ) {
          throw new DomainInvariantError(
            `Episodic Mapping Proposal requires between 1 and ${MAX_DVD_TITLES} Episodes`,
          );
        }
        const timestamp = now();
        const { mutationKey, ...semanticFields } = input;
        const semanticInput = JSON.stringify(semanticFields);
        return database.transaction((transaction) => {
          const replay = mutationKey === undefined ? undefined
            : readMutationInvocation(
              transaction,
              mutationKey,
              "mapping_proposal.episodic",
              semanticInput,
              decodeMappingProposalOutcome<ReturnType<
                typeof access.catalog.createEpisodicMappingProposal
              >>,
            );
          if (replay !== undefined) return replay;
          const currentArchive = requireRow(
            transaction
              .select({ updatedAt: originalDiscArchives.updatedAt })
              .from(originalDiscArchives)
              .where(eq(
                originalDiscArchives.id,
                input.originalDiscArchiveId,
              ))
              .get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          if (
            currentArchive.updatedAt.getTime() !==
              input.catalogRevision.getTime()
          ) {
            throw new StaleCatalogRevisionError(
              "Catalog review changed; reload before saving Episodic Mapping Proposal",
            );
          }

          const proposedTitleNumbers = [...new Set(input.episodes.map(
            (episode) => requirePositiveSafeInteger(
              episode.titleNumber,
              "Episode title number",
            ),
          ))];
          const overlapsPersistedSource = transaction
            .select({ id: discSelections.id })
            .from(discSelections)
            .where(and(
              eq(
                discSelections.originalDiscArchiveId,
                input.originalDiscArchiveId,
              ),
              eq(discSelections.isCatalogActive, true),
              inArray(discSelections.titleNumber, proposedTitleNumbers),
            ))
            .limit(1)
            .get();
          if (overlapsPersistedSource) {
            throw new DomainInvariantError(
              "Assisted Mapping cannot use an overlapping DVD source",
            );
          }
          const activeSourceTracker =
            createDiscSelectionSourceOverlapTracker();

          const createMediaItem = (
            candidate: Omit<Parameters<typeof validateMediaItem>[0], "id">,
          ) => {
            const id = newId<MediaItemId>();
            return insertValidatedMediaItem(
              transaction,
              { ...candidate, id },
              timestamp,
            );
          };
          const readMediaItem = (id: MediaItemId) => requireRow(
            transaction
              .select()
              .from(mediaItems)
              .where(eq(mediaItems.id, id))
              .get(),
            "media item",
            id,
          );

          const tvShow = input.tvShow.choice === "create_new"
            ? createMediaItem({
                kind: "tv_show",
                title: input.tvShow.title,
                year: input.tvShow.year,
              })
            : readMediaItem(input.tvShow.mediaItemId);
          if (tvShow.kind !== "tv_show") {
            throw new DomainInvariantError(
              "Episodic Mapping Proposal requires a TV Show",
            );
          }
          ensureMediaItemTmdbIdentity(
            transaction,
            tvShow,
            input.tvShow.tmdbIdentity,
            timestamp,
          );

          const season = input.season.choice === "create_new"
            ? createMediaItem({
                parentId: tvShow.id,
                kind: "season",
                title: input.season.title,
                seasonNumber: input.season.seasonNumber,
              })
            : readMediaItem(input.season.mediaItemId);
          if (
            season.kind !== "season" ||
            season.seasonNumber === null ||
            season.parentId !== tvShow.id
          ) {
            throw new DomainInvariantError(
              "Episodic Mapping Proposal requires a numbered Season beneath the selected TV Show",
            );
          }

          const episodes = input.episodes.map((episode) => {
            const mediaItem = episode.existingMediaItemId === undefined
              ? createMediaItem({
                  parentId: season.id,
                  kind: "episode",
                  title: episode.title,
                  episodeNumber: episode.episodeNumber,
                })
              : readMediaItem(episode.existingMediaItemId);
            if (
              mediaItem.kind !== "episode" ||
              mediaItem.parentId !== season.id ||
              mediaItem.episodeNumber !== episode.episodeNumber
            ) {
              throw new DomainInvariantError(
                "Episodic Mapping Proposal existing Episode must match the selected Season and episode number",
              );
            }
            validateAssistedMappingShape(transaction, {
              parentId: mediaItem.parentId,
              kind: mediaItem.kind,
              title: mediaItem.title,
              year: mediaItem.year,
              seasonNumber: mediaItem.seasonNumber,
              episodeNumber: mediaItem.episodeNumber,
            });
            const label = episode.label === undefined
              ? undefined
              : requireNonEmpty(episode.label, "label");
            const discSelection = insertDiscSelection(
              transaction,
              {
                originalDiscArchiveId: input.originalDiscArchiveId,
                mediaItemId: mediaItem.id,
                sourceIdentity: {
                  kind: "dvd_title",
                  titleNumber: episode.titleNumber,
                },
                ...(label === undefined ? {} : { label }),
              },
              newId<DiscSelectionId>(),
              timestamp,
              {
                activeSourceTracker,
                rejectSourceOverlap: true,
                validateAgainstCurrentTitleIdentity: true,
              },
            );
            return { mediaItem, discSelection };
          });
          applyMappingProposalReviewTransition(
            transaction,
            input,
            timestamp,
          );
          const outcome = { tvShow, season, episodes };
          return mutationKey === undefined ? outcome : recordMutationInvocation(
            transaction,
            mutationKey,
            "mapping_proposal.episodic",
            semanticInput,
            outcome,
            timestamp,
          );
        }, { behavior: "immediate" });
      },

      updateMediaItem(id, input, options) {
        return database.transaction((transaction) => runMediaItemMutation(
          transaction,
          options?.mutationKey,
          "media_item.update",
          JSON.stringify({ id, input, expectedUpdatedAt: options?.expectedUpdatedAt?.toISOString(),
            expectedReferencedArchiveCount: options?.expectedReferencedArchiveCount,
            expectedChildCount: options?.expectedChildCount,
            expectedImpactRevision: options?.expectedImpactRevision }),
          () => {
          const current = requireRow(
            transaction
              .select()
              .from(mediaItems)
              .where(eq(mediaItems.id, id))
              .get(),
            "media item",
            id,
          );
          requireMediaItemRevision(current, options?.expectedUpdatedAt);
          const maintenance = readMediaItemMaintenance([id], undefined, transaction)[0]!;
          const impact = inspectMediaItemImpact(id, transaction);
          requireMediaItemMaintenanceRevision(maintenance, options, impact.revision);
          if (options?.requirePreviewIfAffected && options.expectedUpdatedAt === undefined &&
              (impact.affectedArchiveCount > 0 ||
                (input.parentId !== undefined && input.parentId !== current.parentId) ||
                (input.kind !== undefined && input.kind !== current.kind))) {
            throw new DomainInvariantError("Preview and acknowledge the current Media Item revision");
          }
          const { parentId, kind, title, year, seasonNumber, episodeNumber } =
            projectMediaItemUpdate(transaction, current, input);
          return requireRow(
            transaction
              .update(mediaItems)
              .set({
                parentId, kind, title, year, seasonNumber, episodeNumber,
                updatedAt: new Date(Math.max(now().getTime(), current.updatedAt.getTime() + 1)),
              })
              .where(eq(mediaItems.id, id))
              .returning()
              .get(),
            "media item",
            id,
          );
          },
        ), { behavior: "immediate" });
      },

      deleteMediaItem(id, options) {
        return database.transaction((transaction) => runMediaItemMutation(
          transaction,
          options?.mutationKey,
          "media_item.delete",
          JSON.stringify({ id, expectedUpdatedAt: options?.expectedUpdatedAt?.toISOString(),
            expectedReferencedArchiveCount: options?.expectedReferencedArchiveCount,
            expectedChildCount: options?.expectedChildCount,
            expectedImpactRevision: options?.expectedImpactRevision }),
          () => {
          const current = requireRow(
            transaction
              .select()
              .from(mediaItems)
              .where(eq(mediaItems.id, id))
              .get(),
            "media item",
            id,
          );
          requireMediaItemRevision(current, options?.expectedUpdatedAt);
          const maintenance = readMediaItemMaintenance(
            [id],
            undefined,
            transaction,
          )[0]!;
          requireMediaItemMaintenanceRevision(maintenance, options,
            inspectMediaItemImpact(id, transaction).revision);
          if (maintenance.deletionAvailability.state === "unavailable") {
            throw new DomainInvariantError(
              `Media Item deletion is unavailable: ${
                maintenance.deletionAvailability.reason
              }`,
            );
          }
          requireRow(
            transaction
              .delete(mediaItems)
              .where(eq(mediaItems.id, id))
              .returning({ id: mediaItems.id })
              .get(),
            "media item",
            id,
          );
          return current;
          },
        ), { behavior: "immediate" });
      },

      previewMediaItemUpdate(id, input) {
        const current = requireRow(database.select().from(mediaItems)
          .where(eq(mediaItems.id, id)).get(), "media item", id);
        return projectMediaItemUpdate(database, current, input);
      },

      inspectMediaItemImpact(id) {
        return inspectMediaItemImpact(id);
      },

      listMediaItemMaintenance(options) {
        return readMediaItemMaintenance(
          options.ids,
          options.currentArchiveId,
        );
      },

      listMediaItems(options) {
        if (options?.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const query = database
          .select()
          .from(mediaItems)
          .where(
            and(
              options?.ids
                ? inArray(mediaItems.id, [...options.ids])
                : undefined,
              options?.parentId
                ? eq(mediaItems.parentId, options.parentId)
                : undefined,
            ),
          )
          .orderBy(
            asc(mediaItems.parentId),
            asc(mediaItems.createdAt),
            asc(mediaItems.id),
          );
        return listWithBoundedOffset(
          query,
          options,
          "Media Item",
        );
      },

      findMediaItemByTmdbIdentity(input) {
        if (!isValidTmdbIdentity(input)) {
          throw new DomainInvariantError("TMDB identity is invalid");
        }
        const match = database
          .select({ mediaItem: mediaItems })
          .from(mediaItemTmdbIdentities)
          .innerJoin(
            mediaItems,
            eq(mediaItems.id, mediaItemTmdbIdentities.mediaItemId),
          )
          .where(and(
            eq(mediaItemTmdbIdentities.mediaType, input.mediaType),
            eq(mediaItemTmdbIdentities.tmdbId, input.tmdbId),
          ))
          .get();
        return match?.mediaItem ?? null;
      },

      findTmdbIdentityByMediaItemId(id) {
        const identity = database
          .select({
            mediaType: mediaItemTmdbIdentities.mediaType,
            tmdbId: mediaItemTmdbIdentities.tmdbId,
          })
          .from(mediaItemTmdbIdentities)
          .where(eq(mediaItemTmdbIdentities.mediaItemId, id))
          .get();
        return identity ?? null;
      },

      searchMediaItems(options) {
        const searchQuery = requireNonEmpty(options.query, "query");
        if (searchQuery.length > 256) {
          throw new DomainInvariantError(
            "Media Item search query must be at most 256 characters",
          );
        }
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > MEDIA_ITEM_SEARCH_LIMIT
        ) {
          throw new DomainInvariantError(
            `Media Item search limit must be a safe integer between 1 and ${MEDIA_ITEM_SEARCH_LIMIT}`,
          );
        }
        const normalizedQuery = normalizeMediaItemSearchTitle(searchQuery);
        if (normalizedQuery.length === 0) {
          throw new DomainInvariantError(
            "Media Item search query must contain a letter or number",
          );
        }
        const pattern = `%${normalizedQuery.replaceAll(" ", "%")}%`;
        const normalizedTitle =
          sql`rip_dvd_normalize_media_item_title(${mediaItems.title})`;
        const query = database
          .select()
          .from(mediaItems)
          .where(sql`${normalizedTitle} like ${pattern}`)
          .orderBy(
            sql`case
              when ${mediaItems.title} = ${searchQuery} then 0
              when ${normalizedTitle} = ${normalizedQuery} then 1
              else 2
            end`,
            asc(mediaItems.title),
            asc(mediaItems.id),
          );
        return listWithBoundedOffset(query, options, "Media Item search");
      },

      createDiscSelection(input) {
        const timestamp = now();
        const id = newId<DiscSelectionId>();
        return discSelectionTransaction(
          (transaction) => {
            const selection = insertDiscSelection(
              transaction,
              input,
              id,
              timestamp,
              {
                validateAgainstCurrentTitleIdentity:
                  activeDiscSelectionUsesCurrentTitleIdentity,
              },
            );
            reopenCatalogReview(
              transaction,
              input.originalDiscArchiveId,
              timestamp,
            );
            return selection;
          },
          { behavior: "immediate" },
        );
      },

      updateDiscSelection(id, input) {
        const timestamp = now();
        if (
          input.mediaItemId === undefined &&
          input.sourceIdentity === undefined &&
          input.label === undefined
        ) {
          throw new DomainInvariantError(
            "Disc Selection update requires at least one change",
          );
        }
        return discSelectionTransaction((transaction) => {
          const current = requireRow(
            transaction
              .select()
              .from(discSelections)
              .where(and(
                eq(discSelections.id, id),
                eq(discSelections.isCatalogActive, true),
              ))
              .get(),
            "disc selection",
            id,
          );
          if (current.originalDiscArchiveId !== input.originalDiscArchiveId) {
            throw new DomainInvariantError(
              "A Disc Selection update cannot move between Original Disc Archives",
            );
          }
          const source = requireRow(
            transaction
              .select({
                legacyCutoverPending:
                  originalDiscArchives.legacyCutoverPending,
                scanData: detectedDiscs.scanData,
              })
              .from(originalDiscArchives)
              .innerJoin(
                detectedDiscs,
                eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
              )
              .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
              .get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          const validator = createArchivedDvdSelectionValidator(
            source.scanData,
          );
          const availability = readDiscSelectionActionAvailability({
            selection: current,
            scanData: source.scanData,
            legacyCutoverPending: source.legacyCutoverPending,
          }, transaction);
          switch (availability.state) {
            case "changes_unavailable":
              throw new DomainInvariantError(
                "Disc Selections cannot be changed while legacy cutover repair is pending",
              );
            case "needs_repair":
              throw new DomainInvariantError(
                `Disc Selection ${id} needs unsafe legacy repair, not ordinary update`,
              );
            case "locked_provenance":
              throw new DomainInvariantError(
                `Disc Selection ${id} cannot be updated because Encode Job history must keep its provenance (job ${availability.relatedEncodeJob.id})`,
              );
            case "correction_lineage":
              throw new DomainInvariantError(
                `Disc Selection ${id} belongs to immutable correction lineage and must be corrected by supersession`,
              );
            case "editable":
              break;
          }

          const changes: Partial<typeof discSelections.$inferInsert> = {
            updatedAt: timestamp,
          };
          if (input.mediaItemId !== undefined) {
            requireRow(
              transaction
                .select({ id: mediaItems.id })
                .from(mediaItems)
                .where(eq(mediaItems.id, input.mediaItemId))
                .get(),
              "media item",
              input.mediaItemId,
            );
            changes.mediaItemId = input.mediaItemId;
          }
          if (input.sourceIdentity !== undefined) {
            const sourcePersistence = serializeDiscSelectionSourceIdentity(
              activeDiscSelectionUsesCurrentTitleIdentity
                ? validateDiscSelectionSourceIdentity(
                  transaction,
                  input.originalDiscArchiveId,
                  source.scanData,
                  input.sourceIdentity,
                )
                : validator.validate(input.sourceIdentity),
            );
            Object.assign(changes, sourcePersistence);
          }
          if (input.label !== undefined) {
            if (input.label === null) {
              changes.label = null;
            } else {
              const label = requireNonEmpty(input.label, "label");
              if (label.length > 256) {
                throw new DomainInvariantError(
                  "Disc Selection label must be at most 256 characters",
                );
              }
              changes.label = label;
            }
          }

          const selection = toDiscSelection(requireRow(
            transaction
              .update(discSelections)
              .set(changes)
              .where(and(
                eq(discSelections.id, id),
                eq(discSelections.isCatalogActive, true),
              ))
              .returning()
              .get(),
            "disc selection",
            id,
          ));
          if (input.sourceIdentity !== undefined) {
            syncDvdTitleIdentitySelectionBinding(
              transaction,
              selection,
              timestamp,
            );
          }
          reopenCatalogReview(
            transaction,
            input.originalDiscArchiveId,
            timestamp,
          );
          return selection;
        }, { behavior: "immediate" });
      },

      correctDiscSelection(id, input) {
        const timestamp = now();
        const reason = input.reason === undefined
          ? null
          : requireNonEmpty(input.reason, "reason");
        if (reason !== null && reason.length > 1_000) {
          throw new DomainInvariantError(
            "Disc Selection correction reason must be at most 1000 characters",
          );
        }
        return discSelectionTransaction((transaction) => {
          const current = requireRow(
            transaction
              .select()
              .from(discSelections)
              .where(eq(discSelections.id, id))
              .get(),
            "disc selection",
            id,
          );
          if (!current.isCatalogActive) {
            throw new DomainInvariantError(
              `Disc Selection ${id} has already been superseded or deactivated`,
            );
          }
          if (current.originalDiscArchiveId !== input.originalDiscArchiveId) {
            throw new DomainInvariantError(
              "A Disc Selection correction cannot move between Original Disc Archives",
            );
          }
          const source = requireRow(
            transaction
              .select({
                legacyCutoverPending:
                  originalDiscArchives.legacyCutoverPending,
                scanData: detectedDiscs.scanData,
              })
              .from(originalDiscArchives)
              .innerJoin(
                detectedDiscs,
                eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
              )
              .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
              .get(),
            "original disc archive",
            input.originalDiscArchiveId,
          );
          if (source.legacyCutoverPending) {
            throw new DomainInvariantError(
              "Disc Selections cannot be changed while legacy cutover repair is pending",
            );
          }
          if (
            requiresLegacyDiscSelectionRepair(
              current,
              createArchivedDvdSelectionValidator(source.scanData),
            )
          ) {
            throw new DomainInvariantError(
              `Disc Selection ${id} needs unsafe legacy repair, not ordinary correction`,
            );
          }
          const historicalJob = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(eq(encodeJobs.discSelectionId, id))
            .limit(1)
            .get();
          const preservedLineage = hasDiscSelectionSupersession(
            id,
            transaction,
          );
          if (!historicalJob && !preservedLineage) {
            throw new DomainInvariantError(
              `Disc Selection ${id} has no Encode Job history and can be corrected directly`,
            );
          }
          reopenCatalogReview(
            transaction,
            input.originalDiscArchiveId,
            timestamp,
            input.catalogRevision,
            "Disc Selection correction",
          );
          requireRow(
            transaction
              .update(discSelections)
              .set({ isCatalogActive: false, updatedAt: timestamp })
              .where(and(
                eq(discSelections.id, id),
                eq(discSelections.isCatalogActive, true),
              ))
              .returning({ id: discSelections.id })
              .get(),
            "disc selection",
            id,
          );
          removeDvdTitleIdentitySelectionBinding(transaction, id);
          const replacementId = newId<DiscSelectionId>();
          const discSelection = insertDiscSelection(
            transaction,
            input,
            replacementId,
            timestamp,
            {
              validateAgainstCurrentTitleIdentity:
                activeDiscSelectionUsesCurrentTitleIdentity,
            },
          );
          const supersession = requireRow(
            transaction
              .insert(discSelectionSupersessions)
              .values({
                supersededDiscSelectionId: id,
                replacementDiscSelectionId: replacementId,
                reason,
                createdAt: timestamp,
              })
              .returning()
              .get(),
            "disc selection supersession",
            id,
          );
          const activeJobs = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(and(
              eq(encodeJobs.discSelectionId, id),
              inArray(encodeJobs.status, ["queued", "running"]),
            ))
            .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
            .all();
          for (const job of activeJobs) {
            requestEncodeJobCancellation(transaction, job.id, timestamp);
          }
          return {
            discSelection,
            supersession: supersession satisfies DiscSelectionSupersession,
          };
        }, { behavior: "immediate" });
      },

      repairDiscSelection(id, input) {
        const timestamp = now();
        return discSelectionTransaction(
          (transaction) => {
            const current = requireRow(
              transaction
                .select()
                .from(discSelections)
                .where(and(
                  eq(discSelections.id, id),
                  eq(discSelections.isCatalogActive, true),
                ))
                .get(),
              "disc selection",
              id,
            );
            if (
              current.originalDiscArchiveId !== input.originalDiscArchiveId
            ) {
              throw new DomainInvariantError(
                "A Disc Selection repair cannot move between Original Disc Archives",
              );
            }
            const activeJob = transaction
              .select({ id: encodeJobs.id, status: encodeJobs.status })
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.discSelectionId, id),
                  inArray(encodeJobs.status, [
                    "queued",
                    "running",
                    "cancellation_requested",
                  ]),
                ),
              )
              .limit(1)
              .get();
            if (activeJob) {
              throw new DomainInvariantError(
                `Disc Selection ${id} cannot be repaired while Encode Job ${activeJob.id} is ${activeJob.status}`,
              );
            }
            const historicalJob = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, id))
              .limit(1)
              .get();
            const preservedLineage = hasDiscSelectionSupersession(
              id,
              transaction,
            );
            if (preservedLineage) {
              throw new DomainInvariantError(
                `Disc Selection ${id} belongs to immutable correction lineage and must be corrected by supersession`,
              );
            }
            const source = requireRow(
              transaction
                .select({
                  discKind: originalDiscArchives.discKind,
                  legacyCutoverPending:
                    originalDiscArchives.legacyCutoverPending,
                  scanData: detectedDiscs.scanData,
                })
                .from(originalDiscArchives)
                .innerJoin(
                  detectedDiscs,
                  eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
                )
                .where(eq(originalDiscArchives.id, input.originalDiscArchiveId))
                .get(),
              "original disc archive",
              input.originalDiscArchiveId,
            );
            if (source.legacyCutoverPending) {
              throw new DomainInvariantError(
                "Disc Selections cannot be changed while legacy cutover repair is pending",
              );
            }
            requireRow(
              transaction
                .select({ id: mediaItems.id })
                .from(mediaItems)
                .where(eq(mediaItems.id, input.mediaItemId))
                .get(),
              "media item",
              input.mediaItemId,
            );
            if (source.discKind !== "dvd") {
              throw new DomainInvariantError(
                "DVD Disc Selections require a DVD Original Disc Archive",
              );
            }
            const validator = createArchivedDvdSelectionValidator(
              source.scanData,
            );
            const sourceIdentity = validateDiscSelectionSourceIdentity(
              transaction,
              input.originalDiscArchiveId,
              source.scanData,
              input.sourceIdentity,
            );
            const sourcePersistence =
              serializeDiscSelectionSourceIdentity(sourceIdentity);
            if (historicalJob) {
              if (!requiresLegacyDiscSelectionRepair(
                current,
                validator,
              )) {
                throw new DomainInvariantError(
                  `Disc Selection ${id} cannot be repaired because ordinary Encode Job history must keep its retry identity (job ${historicalJob.id})`,
                );
              }
            }
            removeDvdTitleIdentitySelectionBinding(transaction, id);
            let selectionRow: typeof discSelections.$inferSelect;
            if (historicalJob) {
              requireRow(
                transaction
                  .update(discSelections)
                  .set({
                    isCatalogActive: false,
                  })
                  .where(and(
                    eq(discSelections.id, id),
                    eq(discSelections.isCatalogActive, true),
                  ))
                  .returning({ id: discSelections.id })
                  .get(),
                "disc selection",
                id,
              );
              transaction
                .update(encodeJobs)
                .set({ reservesOutputPath: false })
                .where(and(
                  eq(encodeJobs.discSelectionId, id),
                  eq(encodeJobs.status, "failed"),
                ))
                .run();
              const replacementId = newId<DiscSelectionId>();
              selectionRow = requireRow(
                transaction
                  .insert(discSelections)
                  .values({
                    id: replacementId,
                    originalDiscArchiveId: input.originalDiscArchiveId,
                    mediaItemId: input.mediaItemId,
                    ...sourcePersistence,
                    label: input.label ?? null,
                    isCatalogActive: true,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .returning()
                  .get(),
                "disc selection",
                replacementId,
              );
            } else {
              selectionRow = requireRow(
                transaction
                  .update(discSelections)
                  .set({
                    mediaItemId: input.mediaItemId,
                    ...sourcePersistence,
                    label: input.label ?? null,
                    updatedAt: timestamp,
                  })
                  .where(and(
                    eq(discSelections.id, id),
                    eq(discSelections.isCatalogActive, true),
                  ))
                  .returning()
                  .get(),
                "disc selection",
                id,
              );
            }
            const selection = toDiscSelection(selectionRow);
            syncDvdTitleIdentitySelectionBinding(
              transaction,
              selection,
              timestamp,
            );
            reopenCatalogReview(
              transaction,
              input.originalDiscArchiveId,
              timestamp,
            );
            return selection;
          },
          { behavior: "immediate" },
        );
      },

      deleteDiscSelection(id) {
        const timestamp = now();
        return discSelectionTransaction(
          (transaction) => {
            const selection = requireRow(
              transaction
                .select()
                .from(discSelections)
                .where(and(
                  eq(discSelections.id, id),
                  eq(discSelections.isCatalogActive, true),
                ))
                .get(),
              "disc selection",
              id,
            );
            const archiveState = requireRow(
              transaction
                .select({
                  legacyCutoverPending:
                    originalDiscArchives.legacyCutoverPending,
                  scanData: detectedDiscs.scanData,
                })
                .from(originalDiscArchives)
                .innerJoin(
                  detectedDiscs,
                  eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
                )
                .where(eq(
                  originalDiscArchives.id,
                  selection.originalDiscArchiveId,
                ))
                .get(),
              "original disc archive",
              selection.originalDiscArchiveId,
            );
            if (archiveState.legacyCutoverPending) {
              throw new DomainInvariantError(
                "Disc Selections cannot be changed while legacy cutover repair is pending",
              );
            }
            const dependentJob = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(eq(encodeJobs.discSelectionId, id))
              .limit(1)
              .get();
            removeDvdTitleIdentitySelectionBinding(transaction, id);
            if (dependentJob) {
              if (!requiresLegacyDiscSelectionRepair(
                selection,
                createArchivedDvdSelectionValidator(archiveState.scanData),
              )) {
                throw new DomainInvariantError(
                  `Disc Selection ${id} cannot be deleted because Encode Job history must be preserved (job ${dependentJob.id})`,
                );
              }
              requireRow(
                transaction
                  .update(discSelections)
                  .set({ isCatalogActive: false })
                  .where(and(
                    eq(discSelections.id, id),
                    eq(discSelections.isCatalogActive, true),
                  ))
                  .returning({ id: discSelections.id })
                  .get(),
                "disc selection",
                id,
              );
              transaction
                .update(encodeJobs)
                .set({ reservesOutputPath: false })
                .where(and(
                  eq(encodeJobs.discSelectionId, id),
                  eq(encodeJobs.status, "failed"),
                ))
                .run();
            } else {
              const preservedSupersession = hasDiscSelectionSupersession(
                id,
                transaction,
              );
              if (preservedSupersession) {
                requireRow(
                  transaction
                    .update(discSelections)
                    .set({ isCatalogActive: false, updatedAt: timestamp })
                    .where(and(
                      eq(discSelections.id, id),
                      eq(discSelections.isCatalogActive, true),
                    ))
                    .returning({ id: discSelections.id })
                    .get(),
                  "disc selection",
                  id,
                );
              } else {
                requireRow(
                  transaction
                    .delete(discSelections)
                    .where(eq(discSelections.id, id))
                    .returning({ id: discSelections.id })
                    .get(),
                  "disc selection",
                  id,
                );
              }
            }
            reopenCatalogReview(
              transaction,
              selection.originalDiscArchiveId,
              timestamp,
            );
            return {
              ...toDiscSelection(selection),
              deletedEncodeJobs: 0,
              deletionComplete: true,
            };
          },
          { behavior: "immediate" },
        );
      },

      mutateDiscSelection(input) {
        return performDiscSelectionMutation(input, false);
      },

      previewDiscSelectionChange(input) {
        return performDiscSelectionMutation({ ...input, mutationKey: undefined }, true);
      },

      recordDiscSelectionPreviewDecision(input) {
        database.insert(mutationInvocations).values({
          key: input.previewToken,
          operation: "disc_selection.preview",
          semanticInput: discSelectionPreviewSemanticInput(input),
          outcome: JSON.stringify({
            expectedPreviewEvidenceHash: input.expectedPreviewEvidenceHash,
          }),
          createdAt: now(),
        }).run();
      },

      previewDiscSelectionMutation(originalDiscArchiveId, discSelectionId) {
        return database.transaction((transaction) => {
          const archive = requireRow(transaction.select({ updatedAt: originalDiscArchives.updatedAt })
            .from(originalDiscArchives)
            .where(eq(originalDiscArchives.id, originalDiscArchiveId)).get(),
          "original disc archive", originalDiscArchiveId);
          const selection = access.catalog.listDiscSelections({
            ids: [discSelectionId], originalDiscArchiveId,
          })[0];
          if (!selection) {
            throw new RecordNotFoundError("disc selection", discSelectionId);
          }
          const availability = access.catalog.listDiscSelectionActionAvailability({ ids: [discSelectionId] })[0];
          if (!availability) {
            throw new RecordNotFoundError("disc selection", discSelectionId);
          }
          const jobs = transaction.select({
            id: encodeJobs.id,
            status: encodeJobs.status,
            reservesOutputPath: encodeJobs.reservesOutputPath,
          })
            .from(encodeJobs).where(eq(encodeJobs.discSelectionId, discSelectionId))
            .all();
          const evidence = discSelectionMutationEvidence(jobs);
          return {
            catalogRevision: archive.updatedAt.toISOString(),
            discSelection: selection,
            actionAvailability: availability,
            ...evidence,
          };
        });
      },

      listDiscSelections(options) {
        if (
          options?.originalDiscArchiveId !== undefined &&
          options.originalDiscArchiveIds !== undefined
        ) {
          throw new DomainInvariantError(
            "Disc Selection lookup accepts one archive ID filter form",
          );
        }
        const originalDiscArchiveIds = options?.originalDiscArchiveIds ===
            undefined
          ? undefined
          : [...new Set(options.originalDiscArchiveIds)];
        if (
          originalDiscArchiveIds !== undefined &&
          originalDiscArchiveIds.length > DISC_SELECTION_ARCHIVE_LOOKUP_LIMIT
        ) {
          throw new DomainInvariantError(
            `Disc Selection lookup is limited to ${DISC_SELECTION_ARCHIVE_LOOKUP_LIMIT} archives`,
          );
        }
        if (
          (options?.ids !== undefined && options.ids.length === 0) ||
          originalDiscArchiveIds?.length === 0
        ) {
          return [];
        }
        const conditions = [
          options?.ids
            ? inArray(discSelections.id, [...options.ids])
            : undefined,
          options?.originalDiscArchiveId
            ? eq(
                discSelections.originalDiscArchiveId,
                options.originalDiscArchiveId,
              )
            : undefined,
          originalDiscArchiveIds === undefined
            ? undefined
            : inArray(
                discSelections.originalDiscArchiveId,
                originalDiscArchiveIds,
              ),
          options?.encodeEligibleOnly
            ? encodeEligibleDiscSelectionCondition()
            : options?.ids === undefined && !options?.includeHistorical
              ? eq(discSelections.isCatalogActive, true)
              : undefined,
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(discSelections)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id));
        const rows = listWithBoundedOffset(
          query,
          options,
          "Disc Selection",
        );
        return rows.map(toDiscSelection);
      },

      readRearchiveMappingProposal(originalDiscArchiveId) {
        return readRearchiveMappingProposal(
          database,
          originalDiscArchiveId,
        );
      },

      previewRearchiveMappingProposal(input) {
        return evaluateRearchiveMappingProposal(database, input, false);
      },

      saveRearchiveMappingProposal(input) {
        const { mutationKey, ...semanticFields } = input;
        const semanticInput = JSON.stringify(semanticFields);
        return database.transaction((transaction) => {
          const replay = readMutationInvocation(
            transaction,
            mutationKey,
            "rearchive_mapping_proposal.save",
            semanticInput,
            decodeRearchiveMappingProposalReview,
          );
          if (replay !== undefined) return replay;
          const preview = evaluateRearchiveMappingProposal(
            transaction,
            semanticFields,
            false,
          );
          if (preview.state !== "ready") {
            throw new DomainInvariantError(
              `Re-archive Mapping Proposal is ${preview.state}`,
            );
          }
          const timestamp = now();
          const updatedArchive = transaction
            .update(originalDiscArchives)
            .set({ updatedAt: nextCatalogMutationTimestamp(timestamp) })
            .where(and(
              eq(
                originalDiscArchives.id,
                input.originalDiscArchiveId,
              ),
              eq(originalDiscArchives.updatedAt, input.catalogRevision),
              eq(originalDiscArchives.catalogReviewOutcome, "needs_review"),
              isNull(originalDiscArchives.catalogReviewedAt),
            ))
            .returning({
              id: originalDiscArchives.id,
              updatedAt: originalDiscArchives.updatedAt,
            })
            .get();
          if (!updatedArchive) {
            throw new DomainInvariantError(
              "Re-archive Mapping Proposal is stale",
            );
          }
          const existing = transaction
            .select({ createdAt: rearchiveMappingProposals.createdAt })
            .from(rearchiveMappingProposals)
            .where(eq(
              rearchiveMappingProposals.targetArchiveId,
              input.originalDiscArchiveId,
            ))
            .get();
          if (existing !== undefined) {
            transaction
              .delete(rearchiveMappingProposals)
              .where(eq(
                rearchiveMappingProposals.targetArchiveId,
                input.originalDiscArchiveId,
              ))
              .run();
          }
          transaction.insert(rearchiveMappingProposals).values({
            targetArchiveId: input.originalDiscArchiveId,
            sourceArchiveId: preview.sourceArchive.id,
            sourceCatalogRevision: preview.sourceArchive.updatedAt,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: updatedArchive.updatedAt,
          }).run();
          if (preview.mappings.length > 0) {
            transaction.insert(rearchiveMappingProposalItems).values(
              preview.mappings.map((mapping, ordinal) => ({
                targetArchiveId: input.originalDiscArchiveId,
                sourceDiscSelectionId: mapping.sourceDiscSelectionId,
                mediaItemId: mapping.proposedMapping.mediaItemId,
                ordinal,
                ...serializeDiscSelectionSourceIdentity(
                  createDiscSelectionSourceIdentity(
                    mapping.proposedMapping.sourceIdentity,
                  ),
                ),
                label: mapping.proposedMapping.label,
                createdAt: timestamp,
                updatedAt: timestamp,
              })),
            ).run();
          }
          const outcome = readRearchiveMappingProposal(
            transaction,
            input.originalDiscArchiveId,
          );
          if (outcome === null) {
            throw new DomainInvariantError(
              "Saved Re-archive Mapping Proposal could not be read",
            );
          }
          return recordMutationInvocation(
            transaction,
            mutationKey,
            "rearchive_mapping_proposal.save",
            semanticInput,
            outcome,
            timestamp,
          );
        }, { behavior: "immediate" });
      },

      planRearchiveAcceptance(input) {
        return planRearchiveAcceptance(database, input);
      },

      listRearchiveEncodeReplacementPlans(options) {
        return readRearchiveEncodeReplacementPlans(options);
      },

      recordRearchiveAcceptancePreviewDecision(input) {
        database.insert(mutationInvocations).values({
          key: requireNonEmpty(input.previewToken, "previewToken"),
          operation: "rearchive.accept.preview",
          semanticInput: rearchiveAcceptanceSemanticInput(input),
          outcome: JSON.stringify({
            expectedPreviewEvidence: input.expectedPreviewEvidence,
          }),
          createdAt: now(),
        }).run();
      },

      acceptRearchive(input) {
        const semanticInput = rearchiveAcceptanceSemanticInput(input);
        const operation = "rearchive.accept";
        return database.transaction((transaction) => {
          const replay = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            decodeRearchiveAcceptance,
          );
          if (replay !== undefined) return replay;

          const currentEvidenceHeader = transaction.select({
            evidenceFormat: dvdArchiveEvidenceHeaders.evidenceFormat,
          }).from(dvdArchiveEvidenceHeaders).where(eq(
            dvdArchiveEvidenceHeaders.originalDiscArchiveId,
            input.targetArchiveId,
          )).get();
          if (
            currentEvidenceHeader?.evidenceFormat ===
              DVD_RECOVERY_EVIDENCE_FORMAT
          ) {
            throw new DvdRecoveryEvidenceEncodingUnavailableError();
          }

          const evidenceEncodingCapability = input.replacements.length === 0
            ? null
            : requireDvdEvidenceReplacementEncodingAvailable(
              transaction,
              input.targetArchiveId,
            );

          const plan = planRearchiveAcceptance(transaction, input);
          const previewDecision = transaction
            .select()
            .from(mutationInvocations)
            .where(eq(mutationInvocations.key, input.previewToken))
            .get();
          if (
            previewDecision?.operation !== "rearchive.accept.preview" ||
            previewDecision.semanticInput !== semanticInput
          ) {
            throw new DomainInvariantError(
              "Re-archive Acceptance preview does not match the accepted plan",
            );
          }
          const savedPreview = JSON.parse(previewDecision.outcome) as {
            expectedPreviewEvidence?: unknown;
          };
          if (
            savedPreview.expectedPreviewEvidence !==
              rearchiveAcceptancePreviewEvidence(plan)
          ) {
            throw new DomainInvariantError(
              "Re-archive Acceptance preview is stale",
            );
          }

          const timestamp = now();
          const targetArchive = requireRow(
            transaction
              .select()
              .from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, plan.targetArchiveId))
              .get(),
            "original disc archive",
            plan.targetArchiveId,
          );
          const createdDiscSelections = plan.mappings.map((mapping) => {
            const id = newId<DiscSelectionId>();
            const selection = insertDiscSelection(
              transaction,
              {
                originalDiscArchiveId: plan.targetArchiveId,
                mediaItemId: mapping.mediaItemId,
                sourceIdentity: mapping.sourceIdentity,
                ...(mapping.label === null ? {} : { label: mapping.label }),
              },
              id,
              timestamp,
              { allowRearchiveAcceptance: true },
            );
            transaction.insert(discSelectionSupersessions).values({
              supersededDiscSelectionId: mapping.sourceDiscSelectionId,
              replacementDiscSelectionId: id,
              reason: "Re-archive Acceptance",
              createdAt: timestamp,
            }).run();
            return {
              priorDiscSelectionId: mapping.sourceDiscSelectionId,
              discSelection: selection,
            };
          });
          const replacementDiscSelectionIds = new Map(
            createdDiscSelections.map((created) => [
              created.priorDiscSelectionId,
              created.discSelection.id,
            ]),
          );

          const sourceSelectionIds = plan.mappings.map(
            (mapping) => mapping.sourceDiscSelectionId,
          );
          const retiredSelections = transaction
            .update(discSelections)
            .set({ isCatalogActive: false, updatedAt: timestamp })
            .where(and(
              inArray(discSelections.id, sourceSelectionIds),
              eq(discSelections.originalDiscArchiveId, plan.sourceArchiveId),
              eq(discSelections.isCatalogActive, true),
            ))
            .returning({ id: discSelections.id })
            .all();
          if (retiredSelections.length !== sourceSelectionIds.length) {
            throw new DomainInvariantError(
              "Re-archive Mapping Proposal changed during acceptance",
            );
          }

          const affectedEncodeJobs = plan.affectedEncodeJobs.map((job) =>
            requestEncodeJobCancellation(transaction, job.id, timestamp)
          );
          const sourceArchive = requireRow(
            transaction
              .update(originalDiscArchives)
              .set({ updatedAt: nextCatalogMutationTimestamp(timestamp) })
              .where(and(
                eq(originalDiscArchives.id, plan.sourceArchiveId),
                eq(
                  originalDiscArchives.updatedAt,
                  input.sourceCatalogRevision,
                ),
              ))
              .returning()
              .get(),
            "re-archive source",
            plan.sourceArchiveId,
          );
          const completedTarget = completeCatalogReviewTransition(
            transaction,
            targetArchive,
            input.catalogRevision,
            "reviewed_with_selections",
            timestamp,
            {
              staleMessage:
                "Re-archive Mapping Proposal changed; preview acceptance again",
            },
          );

          const replacementEncodeJobs: EncodeJob[] = [];
          if (evidenceEncodingCapability !== null) {
            for (const replacement of plan.replacementEncodes) {
              const predecessor = requireEncodeJob(
                transaction,
                replacement.predecessorEncodeJobId,
              );
              const replacementDiscSelectionId = requireRow(
                replacementDiscSelectionIds.get(
                  replacement.sourceDiscSelectionId,
                ),
                "accepted Re-archive Disc Selection",
                replacement.sourceDiscSelectionId,
              );
              replacementEncodeJobs.push(insertCorrectedEncodeReplacementJob(
                transaction,
                {
                  input: replacement,
                  predecessor,
                  outputPath: replacement.outputPath,
                  replacesExistingOutput:
                    replacement.replacesExistingOutput,
                },
                plan.targetArchiveId,
                evidenceEncodingCapability,
                replacementDiscSelectionId,
                timestamp,
              ));
            }
          }

          releaseCorrectedFailedReservationsStatement.run(
            plan.targetArchiveId,
            timestamp.getTime(),
          );

          transaction.delete(mutationInvocations)
            .where(eq(mutationInvocations.key, input.previewToken))
            .run();
          return recordMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            {
              sourceArchive,
              targetArchive: completedTarget,
              createdDiscSelections,
              affectedEncodeJobs,
              replacementEncodeJobs,
            },
            timestamp,
          );
        }, { behavior: "immediate" });
      },

      getCatalogReviewCoverage(originalDiscArchiveId) {
        return getCatalogReviewCoverage(originalDiscArchiveId);
      },

      getCatalogReviewActionAvailability(originalDiscArchiveId) {
        return readCatalogReviewActionAvailability(originalDiscArchiveId);
      },

      listDiscSelectionSupersessions(options) {
        const selection = {
          supersededDiscSelectionId:
            discSelectionSupersessions.supersededDiscSelectionId,
          replacementDiscSelectionId:
            discSelectionSupersessions.replacementDiscSelectionId,
          reason: discSelectionSupersessions.reason,
          createdAt: discSelectionSupersessions.createdAt,
        };
        if (options.originalDiscArchiveId !== undefined) {
          if (
            !Number.isSafeInteger(options.limit) ||
            options.limit < 1 ||
            options.limit > DISC_SELECTION_SUPERSESSION_HISTORY_LIMIT
          ) {
            throw new DomainInvariantError(
              `Disc Selection supersession history limit must be a safe integer between 1 and ${DISC_SELECTION_SUPERSESSION_HISTORY_LIMIT}`,
            );
          }
          const query = database
            .select(selection)
            .from(discSelectionSupersessions)
            .innerJoin(
              discSelections,
              eq(
                discSelections.id,
                discSelectionSupersessions.replacementDiscSelectionId,
              ),
            )
            .where(eq(
              discSelections.originalDiscArchiveId,
              options.originalDiscArchiveId,
            ))
            .orderBy(
              asc(discSelectionSupersessions.createdAt),
              asc(discSelectionSupersessions.supersededDiscSelectionId),
            );
          return listWithBoundedOffset(
            query,
            options,
            "Disc Selection supersession history",
          );
        }
        if (options.discSelectionIds.length === 0) {
          return [];
        }
        if (
          options.discSelectionIds.length > DISC_SELECTION_SUPERSESSION_LIMIT
        ) {
          throw new DomainInvariantError(
            `Disc Selection supersession lookup is limited to ${DISC_SELECTION_SUPERSESSION_LIMIT} records`,
          );
        }
        return database
          .select(selection)
          .from(discSelectionSupersessions)
          .where(or(
            inArray(
              discSelectionSupersessions.supersededDiscSelectionId,
              [...options.discSelectionIds],
            ),
            inArray(
              discSelectionSupersessions.replacementDiscSelectionId,
              [...options.discSelectionIds],
            ),
          ))
          .orderBy(
            asc(discSelectionSupersessions.createdAt),
            asc(discSelectionSupersessions.supersededDiscSelectionId),
          )
          .all();
      },

      listCorrectedEncodeReplacementPlans(options) {
        return readCorrectedEncodeReplacementPlans(options);
      },

      listDiscSelectionActionAvailability(options) {
        if (options.ids.length === 0) {
          return [];
        }
        if (options.ids.length > DISC_SELECTION_ACTION_AVAILABILITY_LIMIT) {
          throw new DomainInvariantError(
            `Disc Selection action availability is limited to ${DISC_SELECTION_ACTION_AVAILABILITY_LIMIT} records`,
          );
        }
        const selectionStates = database
          .select({
            selection: discSelections,
            scanData: detectedDiscs.scanData,
            legacyCutoverPending:
              originalDiscArchives.legacyCutoverPending,
          })
          .from(discSelections)
          .innerJoin(
            originalDiscArchives,
            eq(
              originalDiscArchives.id,
              discSelections.originalDiscArchiveId,
            ),
          )
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, originalDiscArchives.detectedDiscId),
          )
          .where(and(
            inArray(discSelections.id, [...options.ids]),
            eq(discSelections.isCatalogActive, true),
          ))
          .orderBy(asc(discSelections.createdAt), asc(discSelections.id))
          .all();

        return selectionStates.map(({
          selection,
          scanData,
          legacyCutoverPending,
        }) => readDiscSelectionActionAvailability({
          selection,
          scanData,
          legacyCutoverPending,
        }));
      },
    },

    encodingProfiles: {
      previewStateChange(input) {
        return database.transaction((transaction) => previewProfileState(transaction, input));
      },

      submit(input) {
        return database.transaction((transaction) => {
          const { mutationKey, ...semanticFields } = input;
          const semanticInput = JSON.stringify(semanticFields);
          const previous = transaction.select().from(mutationInvocations)
            .where(eq(mutationInvocations.key, mutationKey)).get();
          if (previous) {
            if (previous.operation !== `encoding_profile.${input.operation}` ||
                previous.semanticInput !== semanticInput) {
              throw new MutationKeyConflictError();
            }
            const saved = JSON.parse(previous.outcome) as EncodingProfile;
            return {
              ...saved,
              createdAt: new Date(saved.createdAt),
              updatedAt: new Date(saved.updatedAt),
            };
          }
          let profile: EncodingProfile;
          if (input.operation === "create") {
            profile = createProfile(transaction, {
              key: input.key, displayName: input.displayName,
              mediaDomain: input.mediaDomain, settings: input.settings,
            });
          } else if (input.operation === "createVersion") {
            profile = createProfileVersion(transaction, {
              sourceProfileId: input.sourceProfileId,
              mediaDomain: input.mediaDomain, settings: input.settings,
            });
          } else {
            const current = previewProfileState(transaction, {
              id: input.id, mediaDomain: input.mediaDomain, isActive: input.isActive,
            });
            if (current.revision !== input.expectedRevision) {
              throw new DomainInvariantError("Encoding Profile preview is stale");
            }
            profile = setProfileActive(transaction, {
              id: input.id, mediaDomain: input.mediaDomain, isActive: input.isActive,
            });
          }
          transaction.insert(mutationInvocations).values({
            key: mutationKey,
            operation: `encoding_profile.${input.operation}`,
            semanticInput,
            outcome: JSON.stringify(profile),
            createdAt: now(),
          }).run();
          return profile;
        }, { behavior: "immediate" });
      },

      create(input) {
        return database.transaction((transaction) => createProfile(transaction, input), { behavior: "immediate" });
      },

      createVersion(input) {
        return database.transaction((transaction) => createProfileVersion(transaction, input), { behavior: "immediate" });
      },

      find(input) {
        const key = requireNonEmpty(input.key, "key");
        const version = requirePositiveSafeInteger(input.version, "version");
        return (
          database
            .select()
            .from(encodingProfiles)
            .where(
              and(
                eq(encodingProfiles.mediaDomain, input.mediaDomain),
                eq(encodingProfiles.key, key),
                eq(encodingProfiles.version, version),
              ),
            )
            .get() ?? null
        );
      },

      setActive(input) {
        return database.transaction((transaction) => setProfileActive(transaction, input), { behavior: "immediate" });
      },

      list(input = {}) {
        if (input.ids !== undefined && input.ids.length === 0) {
          return [];
        }
        const conditions = [
          input.ids
            ? inArray(encodingProfiles.id, [...input.ids])
            : undefined,
          input.mediaDomain
            ? eq(encodingProfiles.mediaDomain, input.mediaDomain)
            : undefined,
          input.activeOnly ? eq(encodingProfiles.isActive, true) : undefined,
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(encodingProfiles)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            asc(encodingProfiles.mediaDomain),
            asc(encodingProfiles.key),
            asc(encodingProfiles.version),
          );
        if (input.limit === undefined) {
          return query.all();
        }
        const limited = query.limit(
          requirePositiveSafeInteger(input.limit, "limit"),
        );
        if (input.offset === undefined) {
          return limited.all();
        }
        const offset = optionalSafeInteger(input.offset, "offset", 0);
        if (offset === null || offset === undefined) {
          throw new DomainInvariantError("offset must be a safe integer");
        }
        return limited.offset(offset).all();
      },
    },

    discInspections: {
      beginOrResume(input) {
        const timestamp = now();
        const { mediaGeneration, mediaCapacityBytes } =
          requireDiscSettlingObservation(input);
        return database.transaction((transaction) => {
          const drive = requireRow(
            transaction
              .select()
              .from(opticalDrives)
              .where(eq(opticalDrives.id, input.opticalDriveId))
              .get(),
            "optical drive",
            input.opticalDriveId,
          );
          if (!drive.isPresent || !drive.isEnabled) {
            throw new DomainInvariantError(
              "Disc Inspection requires an enabled, present Optical Drive",
            );
          }
          let current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.opticalDriveId, input.opticalDriveId),
                eq(discInspections.isCurrent, true),
              ),
            )
            .get();
          const retryAttempt = current?.phase === "retry_wait"
            ? transaction
                .select({ phase: discInspectionAttempts.phase })
                .from(discInspectionAttempts)
                .where(
                  and(
                    eq(
                      discInspectionAttempts.discInspectionId,
                      current.id,
                    ),
                    eq(
                      discInspectionAttempts.attemptNumber,
                      current.attemptCount,
                    ),
                  ),
                )
                .get()
            : undefined;
          const provisionalInsertionCanChange =
            current?.phase === "settling" ||
            (current?.phase === "retry_wait" &&
              retryAttempt?.phase === "settling");
          if (
            current &&
            current.mediaGeneration !== mediaGeneration &&
            !provisionalInsertionCanChange
          ) {
            if (current.status === "running") {
              transaction
                .insert(discInspectionAttempts)
                .values({
                  id: newId<DiscInspectionAttemptId>(),
                  discInspectionId: current.id,
                  attemptNumber: current.attemptCount,
                  outcome: "aborted",
                  phase: current.phase,
                  reasonCode: "media_changed",
                  startedAt: current.attemptStartedAt,
                  endedAt: timestamp,
                })
                .onConflictDoNothing()
                .run();
              transaction
                .update(discInspections)
                .set({
                  isCurrent: false,
                  status: "aborted",
                  reasonCode: "media_changed",
                  diagnostic: null,
                  retryAt: null,
                  claimToken: null,
                  claimUpdatedAt: null,
                  completedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.isCurrent, true),
                    eq(discInspections.status, "running"),
                  ),
                )
                .run();
            } else {
              transaction
                .update(discInspections)
                .set({
                  isCurrent: false,
                  manualRetryRequestedAt: null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.isCurrent, true),
                  ),
                )
                .run();
            }
            inspectionProgress.delete(current.id);
            current = undefined;
          }

          if (current) {
            if (
              current.status === "failed" &&
              current.manualRetryRequestedAt !== null
            ) {
              const claimToken = newId<DiscInspectionClaimToken>();
              const restarted = requireRow(
                transaction
                  .update(discInspections)
                  .set({
                    mediaGeneration,
                    status: "running",
                    ...initialDiscSettlingState(
                      timestamp,
                      mediaCapacityBytes,
                      0,
                      retainedSettlingCapacityBaseline({
                        currentBaselineCapacityBytes:
                          current.settlingBaselineCapacityBytes,
                        currentCapacityBytes: current.mediaCapacityBytes,
                        currentMediaGeneration: current.mediaGeneration,
                        mediaCapacityBytes,
                        mediaGeneration,
                      }),
                    ),
                    attemptCount: current.attemptCount + 1,
                    consecutiveFailureCount: 0,
                    retryAt: null,
                    manualRetryRequestedAt: null,
                    reasonCode: null,
                    diagnostic: null,
                    claimToken,
                    claimUpdatedAt: timestamp,
                    completedAt: null,
                    updatedAt: timestamp,
                  })
                  .where(
                    and(
                      eq(discInspections.id, current.id),
                      eq(discInspections.status, "failed"),
                      eq(discInspections.isCurrent, true),
                      isNotNull(discInspections.manualRetryRequestedAt),
                    ),
                  )
                  .returning()
                  .get(),
                "disc inspection",
                current.id,
              );
              return {
                inspection: restarted,
                claim: createDiscInspectionClaim(restarted, claimToken),
              };
            }
            if (current.status !== "running") {
              return { inspection: current, claim: null };
            }
            if (
              current.retryAt !== null &&
              current.retryAt.getTime() > timestamp.getTime()
            ) {
              return { inspection: current, claim: null };
            }
            if (current.phase === "settling") {
              const expiredBefore = new Date(
                timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
              );
              if (
                current.claimToken !== null &&
                current.claimUpdatedAt !== null &&
                current.claimUpdatedAt > expiredBefore
              ) {
                return { inspection: current, claim: null };
              }
              const recoveringExpiredClaim = current.claimToken !== null;
              if (recoveringExpiredClaim) {
                transaction
                  .insert(discInspectionAttempts)
                  .values({
                    id: newId<DiscInspectionAttemptId>(),
                    discInspectionId: current.id,
                    attemptNumber: current.attemptCount,
                    outcome: "interrupted",
                    phase: "settling",
                    reasonCode: "worker_interrupted",
                    startedAt: current.attemptStartedAt,
                    endedAt: timestamp,
                  })
                  .onConflictDoNothing()
                  .run();
              }
              const evidenceChanged =
                current.mediaGeneration !== mediaGeneration ||
                (mediaCapacityBytes !== null &&
                  ((current.mediaCapacityBytes !== null &&
                    current.mediaCapacityBytes !== mediaCapacityBytes) ||
                    (current.mediaCapacityBytes === null &&
                      current.settlingBaselineCapacityBytes !== null &&
                      current.settlingBaselineCapacityBytes !==
                        mediaCapacityBytes)));
              const settlingResetCount = evidenceChanged
                ? Math.min(
                    MAX_DISC_INSPECTION_SETTLING_RESET_COUNT,
                    (current.settlingResetCount ?? 0) + 1,
                  )
                : (current.settlingResetCount ?? 0);
              inspectionProgress.delete(current.id);
              const claimToken = newId<DiscInspectionClaimToken>();
              const resumed = requireRow(
                transaction
                  .update(discInspections)
                  .set({
                    mediaGeneration,
                    ...initialDiscSettlingState(
                      timestamp,
                      mediaCapacityBytes,
                      settlingResetCount,
                      retainedSettlingCapacityBaseline({
                        currentBaselineCapacityBytes:
                          current.settlingBaselineCapacityBytes,
                        currentCapacityBytes: current.mediaCapacityBytes,
                        currentMediaGeneration: current.mediaGeneration,
                        mediaCapacityBytes,
                        mediaGeneration,
                      }),
                    ),
                    attemptCount: current.attemptCount +
                      (recoveringExpiredClaim ? 1 : 0),
                    bytesHashed: null,
                    bytesPerSecond: null,
                    etaSeconds: null,
                    retryAt: null,
                    reasonCode: null,
                    diagnostic: null,
                    claimToken,
                    claimUpdatedAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .where(
                    and(
                      eq(discInspections.id, current.id),
                      eq(discInspections.status, "running"),
                      eq(discInspections.phase, "settling"),
                      eq(discInspections.isCurrent, true),
                      current.claimToken === null
                        ? isNull(discInspections.claimToken)
                        : eq(discInspections.claimToken, current.claimToken),
                    ),
                  )
                  .returning()
                  .get(),
                "disc inspection",
                current.id,
              );
              return {
                inspection: resumed,
                claim: createDiscInspectionClaim(resumed, claimToken),
              };
            }
            if (current.phase === "retry_wait") {
              const claimToken = newId<DiscInspectionClaimToken>();
              const restarted = requireRow(
                transaction
                  .update(discInspections)
                  .set({
                    mediaGeneration,
                    ...initialDiscSettlingState(
                      timestamp,
                      mediaCapacityBytes,
                      0,
                      retainedSettlingCapacityBaseline({
                        currentBaselineCapacityBytes:
                          current.settlingBaselineCapacityBytes,
                        currentCapacityBytes: current.mediaCapacityBytes,
                        currentMediaGeneration: current.mediaGeneration,
                        mediaCapacityBytes,
                        mediaGeneration,
                      }),
                    ),
                    attemptCount: current.attemptCount + 1,
                    bytesHashed: null,
                    bytesPerSecond: null,
                    etaSeconds: null,
                    retryAt: null,
                    reasonCode: null,
                    diagnostic: null,
                    claimToken,
                    claimUpdatedAt: timestamp,
                    updatedAt: timestamp,
                  })
                  .where(
                    and(
                      eq(discInspections.id, current.id),
                      eq(discInspections.status, "running"),
                      eq(discInspections.phase, "retry_wait"),
                      eq(discInspections.isCurrent, true),
                      isNull(discInspections.claimToken),
                    ),
                  )
                  .returning()
                  .get(),
                "disc inspection",
                current.id,
              );
              return {
                inspection: restarted,
                claim: createDiscInspectionClaim(restarted, claimToken),
              };
            }
            const expiredBefore = new Date(
              timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
            );
            if (
              current.claimToken !== null &&
              current.claimUpdatedAt !== null &&
              current.claimUpdatedAt > expiredBefore
            ) {
              return { inspection: current, claim: null };
            }
            if (current.claimToken !== null) {
              transaction
                .insert(discInspectionAttempts)
                .values({
                  id: newId<DiscInspectionAttemptId>(),
                  discInspectionId: current.id,
                  attemptNumber: current.attemptCount,
                  outcome: "interrupted",
                  phase: current.phase,
                  reasonCode: "worker_interrupted",
                  startedAt: current.attemptStartedAt,
                  endedAt: timestamp,
                })
                .onConflictDoNothing()
                .run();
            }
            inspectionProgress.delete(current.id);
            const claimToken = newId<DiscInspectionClaimToken>();
            const resumed = requireRow(
              transaction
                .update(discInspections)
                .set({
                  attemptCount: current.attemptCount + 1,
                  bytesHashed: null,
                  bytesPerSecond: null,
                  etaSeconds: null,
                  retryAt: null,
                  reasonCode: null,
                  diagnostic: null,
                  claimToken,
                  claimUpdatedAt: timestamp,
                  phaseStartedAt: timestamp,
                  attemptStartedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.status, "running"),
                    eq(discInspections.isCurrent, true),
                    current.claimToken === null
                      ? isNull(discInspections.claimToken)
                      : eq(discInspections.claimToken, current.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            return {
              inspection: resumed,
              claim: createDiscInspectionClaim(resumed, claimToken),
            };
          }

          const id = newId<DiscInspectionId>();
          const claimToken = newId<DiscInspectionClaimToken>();
          const inspection = requireRow(
            transaction
              .insert(discInspections)
              .values({
                id,
                opticalDriveId: input.opticalDriveId,
                mediaGeneration,
                ...initialDiscSettlingState(timestamp, mediaCapacityBytes),
                claimToken,
                claimUpdatedAt: timestamp,
                startedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "disc inspection",
            id,
          );
          return {
            inspection,
            claim: createDiscInspectionClaim(inspection, claimToken),
          };
        }, { behavior: "immediate" });
      },

      recordSettlingObservation(claim, input) {
        const timestamp = now();
        const { mediaGeneration, mediaCapacityBytes } =
          requireDiscSettlingObservation(input);
        return database.transaction((transaction) => {
          const current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.id, claim.id),
                eq(discInspections.opticalDriveId, claim.opticalDriveId),
                eq(discInspections.mediaGeneration, claim.mediaGeneration),
                eq(discInspections.status, "running"),
                eq(discInspections.phase, "settling"),
                eq(discInspections.isCurrent, true),
                eq(discInspections.claimToken, claim.claimToken),
                gt(
                  discInspections.claimUpdatedAt,
                  new Date(
                    timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .get();
          if (!current) {
            throw new StaleJobAttemptError("disc inspection", claim.id);
          }
          if (
            current.settlingStartedAt === null ||
            timestamp.getTime() >=
              current.settlingStartedAt.getTime() +
                DISC_INSPECTION_SETTLING_TIMEOUT_MS
          ) {
            throw new DomainInvariantError(
              "Disc Inspection settling deadline has expired",
            );
          }

          const matchingValidEvidence =
            mediaCapacityBytes !== null &&
            current.mediaGeneration === mediaGeneration &&
            current.mediaCapacityBytes === mediaCapacityBytes;
          const baselineCapacityChanged =
            mediaCapacityBytes !== null &&
            current.settlingBaselineCapacityBytes !== null &&
            current.settlingBaselineCapacityBytes !== mediaCapacityBytes;
          const evidenceReset =
            current.mediaGeneration !== mediaGeneration ||
            (current.mediaCapacityBytes !== null &&
              current.mediaCapacityBytes !== mediaCapacityBytes) ||
            baselineCapacityChanged;
          const settlingBaselineCapacityBytes =
            retainedSettlingCapacityBaseline({
              currentBaselineCapacityBytes:
                current.settlingBaselineCapacityBytes,
              currentCapacityBytes: current.mediaCapacityBytes,
              currentMediaGeneration: current.mediaGeneration,
              mediaCapacityBytes,
              mediaGeneration,
            });
          const stableObservationCount = mediaCapacityBytes === null
            ? 0
            : matchingValidEvidence
            ? Math.min(
                DISC_INSPECTION_SETTLING_OBSERVATION_TARGET,
                (current.stableObservationCount ?? 0) + 1,
              )
            : 1;
          const quietWindowStartedAt = mediaCapacityBytes === null
            ? null
            : matchingValidEvidence
            ? (current.settlingQuietWindowStartedAt ?? timestamp)
            : timestamp;
          const quietWindowElapsed =
            quietWindowStartedAt === null
              ? 0
              : timestamp.getTime() - quietWindowStartedAt.getTime();
          const settled =
            mediaCapacityBytes !== null &&
            stableObservationCount >=
              DISC_INSPECTION_SETTLING_OBSERVATION_TARGET &&
            quietWindowElapsed >= DISC_INSPECTION_SETTLING_QUIET_WINDOW_MS;
          const observed = requireRow(
            transaction
              .update(discInspections)
              .set({
                mediaGeneration,
                mediaCapacityBytes,
                ...(evidenceReset ? { readPathNotice: null } : {}),
                settlingBaselineCapacityBytes,
                stableObservationCount,
                settlingQuietWindowStartedAt: quietWindowStartedAt,
                settlingResetCount: evidenceReset
                  ? Math.min(
                      MAX_DISC_INSPECTION_SETTLING_RESET_COUNT,
                      (current.settlingResetCount ?? 0) + 1,
                    )
                  : current.settlingResetCount,
                ...(settled
                  ? {
                      phase: "reading_metadata" as const,
                      phaseStartedAt: timestamp,
                    }
                  : {}),
                claimUpdatedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.opticalDriveId, claim.opticalDriveId),
                  eq(discInspections.mediaGeneration, claim.mediaGeneration),
                  eq(discInspections.status, "running"),
                  eq(discInspections.phase, "settling"),
                  eq(discInspections.isCurrent, true),
                  eq(discInspections.claimToken, claim.claimToken),
                  evidenceReset
                    ? isNull(discInspections.detectedDiscId)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.volumeLabel)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.titleCount)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.chapterCount)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.audioStreamCount)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.subtitleStreamCount)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.totalBytes)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.bytesHashed)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.bytesPerSecond)
                    : undefined,
                  evidenceReset
                    ? isNull(discInspections.etaSeconds)
                    : undefined,
                ),
              )
              .returning()
              .get(),
            "disc inspection",
            current.id,
          );
          if (evidenceReset) {
            inspectionProgress.delete(current.id);
          }
          return {
            inspection: observed,
            claim: createDiscInspectionClaim(observed, claim.claimToken),
          };
        }, { behavior: "immediate" });
      },

      renew(claim) {
        const timestamp = now();
        const renewed = database
          .update(discInspections)
          .set({ claimUpdatedAt: timestamp, updatedAt: timestamp })
          .where(
            and(
              eq(discInspections.id, claim.id),
              eq(discInspections.opticalDriveId, claim.opticalDriveId),
              eq(discInspections.mediaGeneration, claim.mediaGeneration),
              eq(discInspections.status, "running"),
              eq(discInspections.isCurrent, true),
              eq(discInspections.claimToken, claim.claimToken),
              gt(
                discInspections.claimUpdatedAt,
                new Date(
                  timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("disc inspection", claim.id);
        }
        return renewed;
      },

      record(claim, event) {
        const timestamp = now();
        const diagnostic =
          "diagnostic" in event && event.diagnostic !== undefined
            ? event.diagnostic.trim().slice(0, 500) || null
            : null;
        return database.transaction((transaction) => {
          const current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.id, claim.id),
                eq(discInspections.opticalDriveId, claim.opticalDriveId),
                eq(discInspections.mediaGeneration, claim.mediaGeneration),
                eq(discInspections.status, "running"),
                eq(discInspections.isCurrent, true),
                eq(discInspections.claimToken, claim.claimToken),
                gt(
                  discInspections.claimUpdatedAt,
                  new Date(
                    timestamp.getTime() - DISC_INSPECTION_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .get();
          if (!current) {
            throw new StaleJobAttemptError("disc inspection", claim.id);
          }
          if (
            current.phase === "settling" &&
            event.type !== "read_path_notice" &&
            event.type !== "retry" &&
            event.type !== "fail" &&
            event.type !== "abort"
          ) {
            throw new DomainInvariantError(
              "Disc Inspection must finish settling before recording work progress",
            );
          }
          if (event.type === "read_path_notice") {
            if (event.notice !== "scsi_capacity_exceeds_cached_size" &&
                event.notice !== "cached_size_exceeds_scsi_capacity") {
              throw new DomainInvariantError("Invalid DVD read path notice");
            }
            return requireRow(
              transaction
                .update(discInspections)
                .set({ readPathNotice: event.notice, updatedAt: timestamp })
                .where(and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.claimToken, claim.claimToken),
                ))
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }
          const recordAttempt = (
            outcome: "completed" | "failed" | "aborted",
            reasonCode: DiscInspectionReasonCode | null,
          ) => {
            transaction
              .insert(discInspectionAttempts)
              .values({
                id: newId<DiscInspectionAttemptId>(),
                discInspectionId: current.id,
                attemptNumber: current.attemptCount,
                outcome,
                phase: current.phase,
                reasonCode,
                diagnostic,
                startedAt: current.attemptStartedAt,
                endedAt: timestamp,
              })
              .run();
          };

          if (event.type === "metadata") {
            const update = {
              phase: "confirming_media" as const,
              volumeLabel: event.volumeLabel?.trim().slice(0, 255) || null,
              titleCount: optionalSafeInteger(event.titleCount, "titleCount", 0),
              chapterCount: optionalSafeInteger(
                event.chapterCount,
                "chapterCount",
                0,
              ),
              audioStreamCount: optionalSafeInteger(
                event.audioStreamCount,
                "audioStreamCount",
                0,
              ),
              subtitleStreamCount: optionalSafeInteger(
                event.subtitleStreamCount,
                "subtitleStreamCount",
                0,
              ),
              totalBytes: requirePositiveSafeInteger(
                event.totalBytes,
                "totalBytes",
              ),
              bytesHashed: null,
              bytesPerSecond: null,
              etaSeconds: null,
              phaseStartedAt: timestamp,
              updatedAt: timestamp,
            };
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set(update)
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            return updated;
          }

          if (event.type === "hash_progress") {
            const bytesHashed = optionalSafeInteger(
              event.bytesHashed,
              "bytesHashed",
              0,
            );
            if (
              bytesHashed === null ||
              bytesHashed === undefined ||
              current.totalBytes === null ||
              bytesHashed < (current.bytesHashed ?? 0) ||
              bytesHashed > current.totalBytes
            ) {
              throw new DomainInvariantError(
                "Disc Inspection hash progress must be monotonic and bounded by totalBytes",
              );
            }
            const previous = inspectionProgress.get(current.id);
            if (
              previous?.token === claim.claimToken &&
              bytesHashed < previous.latestBytes
            ) {
              throw new DomainInvariantError(
                "Disc Inspection hash progress must be monotonic and bounded by totalBytes",
              );
            }
            if (
              (event.bytesPerSecond === null) !==
              (event.etaSeconds === null)
            ) {
              throw new DomainInvariantError(
                "Disc Inspection throughput and ETA must stabilize together",
              );
            }
            const bytesPerSecond =
              event.bytesPerSecond === null
                ? null
                : requirePositiveSafeInteger(
                    event.bytesPerSecond,
                    "bytesPerSecond",
                  );
            const etaSeconds =
              event.etaSeconds === null
                ? null
                : (optionalSafeInteger(event.etaSeconds, "etaSeconds", 0) ?? null);
            const shouldPersist =
              previous === undefined ||
              previous.token !== claim.claimToken ||
              timestamp.getTime() - previous.persistedAt >= 1_000 ||
              bytesHashed === current.totalBytes ||
              (bytesHashed - previous.persistedBytes) * 100 >=
                current.totalBytes * 5;
            if (!shouldPersist) {
              inspectionProgress.set(current.id, {
                ...previous,
                latestBytes: bytesHashed,
                latestBytesPerSecond: bytesPerSecond,
                latestEtaSeconds: etaSeconds,
              });
              return {
                ...current,
                bytesHashed,
                bytesPerSecond,
                etaSeconds,
              };
            }
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set({
                  bytesHashed,
                  bytesPerSecond,
                  etaSeconds,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                    or(
                      isNull(discInspections.bytesHashed),
                      lte(discInspections.bytesHashed, bytesHashed),
                    ),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.set(current.id, {
              latestBytes: bytesHashed,
              latestBytesPerSecond: bytesPerSecond,
              latestEtaSeconds: etaSeconds,
              persistedAt: timestamp.getTime(),
              persistedBytes: bytesHashed,
              token: claim.claimToken,
            });
            return updated;
          }

          if (event.type === "confirming_media") {
            return requireRow(
              transaction
                .update(discInspections)
                .set({
                  phase: "confirming_media",
                  phaseStartedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }

          if (event.type === "retry") {
            const failureCount = Math.min(
              current.consecutiveFailureCount + 1,
              5,
            );
            recordAttempt("failed", event.reasonCode);
            const terminal = failureCount >= 5;
            const cachedProgress = inspectionProgress.get(current.id);
            const latestProgress = cachedProgress?.token === claim.claimToken
              ? cachedProgress
              : undefined;
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set({
                  status: terminal ? "failed" : "running",
                  phase: terminal ? current.phase : "retry_wait",
                  consecutiveFailureCount: failureCount,
                  bytesHashed: latestProgress?.latestBytes ?? current.bytesHashed,
                  bytesPerSecond: latestProgress === undefined
                    ? current.bytesPerSecond
                    : latestProgress.latestBytesPerSecond,
                  etaSeconds: latestProgress === undefined
                    ? current.etaSeconds
                    : latestProgress.latestEtaSeconds,
                  retryAt: terminal ? null : event.retryAt,
                  reasonCode: event.reasonCode,
                  diagnostic,
                  claimToken: null,
                  claimUpdatedAt: null,
                  phaseStartedAt: terminal ? current.phaseStartedAt : timestamp,
                  completedAt: terminal ? timestamp : null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.delete(current.id);
            return updated;
          }

          if (event.type === "complete") {
            const disc = requireRow(
              transaction
                .select()
                .from(detectedDiscs)
                .where(eq(detectedDiscs.id, event.detectedDiscId))
                .get(),
              "detected disc",
              event.detectedDiscId,
            );
            if (disc.opticalDriveId !== current.opticalDriveId) {
              throw new DomainInvariantError(
                "Completed Disc Inspection must link to its Optical Drive observation",
              );
            }
            recordAttempt("completed", null);
            inspectionProgress.delete(current.id);
            return requireRow(
              transaction
                .update(discInspections)
                .set({
                  detectedDiscId: disc.id,
                  status: "completed",
                  consecutiveFailureCount: 0,
                  bytesHashed: current.bytesHashed,
                  bytesPerSecond: null,
                  etaSeconds: null,
                  retryAt: null,
                  reasonCode: null,
                  diagnostic: null,
                  claimToken: null,
                  claimUpdatedAt: null,
                  completedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }

          if (event.type === "fail") {
            recordAttempt("failed", event.reasonCode);
            const cachedProgress = inspectionProgress.get(current.id);
            const latestProgress = cachedProgress?.token === claim.claimToken
              ? cachedProgress
              : undefined;
            const updated = requireRow(
              transaction
                .update(discInspections)
                .set({
                  status: "failed",
                  consecutiveFailureCount: Math.min(
                    current.consecutiveFailureCount + 1,
                    5,
                  ),
                  bytesHashed: latestProgress?.latestBytes ?? current.bytesHashed,
                  bytesPerSecond: latestProgress === undefined
                    ? current.bytesPerSecond
                    : latestProgress.latestBytesPerSecond,
                  etaSeconds: latestProgress === undefined
                    ? current.etaSeconds
                    : latestProgress.latestEtaSeconds,
                  retryAt: null,
                  reasonCode: event.reasonCode,
                  diagnostic,
                  claimToken: null,
                  claimUpdatedAt: null,
                  completedAt: timestamp,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.claimToken, claim.claimToken),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
            inspectionProgress.delete(current.id);
            return updated;
          }

          recordAttempt("aborted", event.reasonCode);
          const cachedProgress = inspectionProgress.get(current.id);
          const latestProgress = cachedProgress?.token === claim.claimToken
            ? cachedProgress
            : undefined;
          const updated = requireRow(
            transaction
              .update(discInspections)
              .set({
                isCurrent: false,
                status: "aborted",
                bytesHashed: latestProgress?.latestBytes ?? current.bytesHashed,
                bytesPerSecond: latestProgress === undefined
                  ? current.bytesPerSecond
                  : latestProgress.latestBytesPerSecond,
                etaSeconds: latestProgress === undefined
                  ? current.etaSeconds
                  : latestProgress.latestEtaSeconds,
                retryAt: null,
                reasonCode: event.reasonCode,
                diagnostic,
                claimToken: null,
                claimUpdatedAt: null,
                completedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.claimToken, claim.claimToken),
                ),
              )
              .returning()
              .get(),
            "disc inspection",
            current.id,
          );
          inspectionProgress.delete(current.id);
          return updated;
        }, { behavior: "immediate" });
      },

      requestRetry(id) {
        const timestamp = now();
        const requested = database
          .update(discInspections)
          .set({
            manualRetryRequestedAt: timestamp,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(discInspections.id, id),
              eq(discInspections.status, "failed"),
              eq(discInspections.isCurrent, true),
              isNull(discInspections.manualRetryRequestedAt),
            ),
          )
          .returning()
          .get();
        if (!requested) {
          const current = database
            .select()
            .from(discInspections)
            .where(eq(discInspections.id, id))
            .get();
          if (!current) {
            throw new RecordNotFoundError("disc inspection", id);
          }
          if (
            current.status === "failed" &&
            current.isCurrent &&
            current.manualRetryRequestedAt !== null
          ) {
            return current;
          }
          throw new InvalidStatusTransitionError(
            "disc inspection",
            current.status,
            "retry requested",
          );
        }
        return requested;
      },

      requestRetryWithReplay({ mutationKey, id }) {
        return replayRecoveryMutation(mutationKey, "disc_inspection.retry", id, () => {
          const current = database.select().from(discInspections)
            .where(eq(discInspections.id, id)).get();
          if (current?.manualRetryRequestedAt !== null && current?.manualRetryRequestedAt !== undefined) {
            throw new InvalidStatusTransitionError(
              "disc inspection", "retry already requested", "retry requested",
            );
          }
          const retried = this.requestRetry(id);
          return { id: retried.id, status: retried.status, phase: retried.phase };
        });
      },

      clearCurrent(input) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const current = transaction
            .select()
            .from(discInspections)
            .where(
              and(
                eq(discInspections.opticalDriveId, input.opticalDriveId),
                eq(discInspections.isCurrent, true),
              ),
            )
            .get();
          if (!current) {
            return null;
          }
          if (
            input.mediaGeneration !== undefined &&
            input.mediaGeneration === current.mediaGeneration
          ) {
            return current;
          }
          inspectionProgress.delete(current.id);
          const reasonCode = input.reasonCode ?? "no_medium";
          if (
            reasonCode === "no_medium" &&
            input.discardUnprovenInspectionId === current.id &&
            current.status === "running" &&
            current.phase === "settling" &&
            current.attemptCount === 1 &&
            current.consecutiveFailureCount === 0 &&
            current.mediaCapacityBytes === null &&
            current.stableObservationCount === 0
          ) {
            const discarded = transaction
              .delete(discInspections)
              .where(
                and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.isCurrent, true),
                  eq(discInspections.status, "running"),
                  eq(discInspections.phase, "settling"),
                  eq(discInspections.attemptCount, 1),
                  eq(discInspections.consecutiveFailureCount, 0),
                  isNull(discInspections.mediaCapacityBytes),
                  eq(discInspections.stableObservationCount, 0),
                  notExists(
                    transaction
                      .select({ id: discInspectionAttempts.id })
                      .from(discInspectionAttempts)
                      .where(
                        eq(
                          discInspectionAttempts.discInspectionId,
                          current.id,
                        ),
                      ),
                  ),
                ),
              )
              .returning()
              .get();
            if (discarded !== undefined) {
              return discarded;
            }
          }
          if (current.status !== "running") {
            return requireRow(
              transaction
                .update(discInspections)
                .set({
                  isCurrent: false,
                  manualRetryRequestedAt: null,
                  updatedAt: timestamp,
                })
                .where(
                  and(
                    eq(discInspections.id, current.id),
                    eq(discInspections.isCurrent, true),
                  ),
                )
                .returning()
                .get(),
              "disc inspection",
              current.id,
            );
          }
          transaction
            .insert(discInspectionAttempts)
            .values({
              id: newId<DiscInspectionAttemptId>(),
              discInspectionId: current.id,
              attemptNumber: current.attemptCount,
              outcome: "aborted",
              phase: current.phase,
              reasonCode,
              startedAt: current.attemptStartedAt,
              endedAt: timestamp,
            })
            .onConflictDoNothing()
            .run();
          return requireRow(
            transaction
              .update(discInspections)
              .set({
                isCurrent: false,
                status: "aborted",
                retryAt: null,
                reasonCode,
                claimToken: null,
                claimUpdatedAt: null,
                completedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(discInspections.id, current.id),
                  eq(discInspections.status, "running"),
                  eq(discInspections.isCurrent, true),
                ),
              )
              .returning()
              .get(),
            "disc inspection",
            current.id,
          );
        }, { behavior: "immediate" });
      },

      list(options = {}) {
        if (options.ids !== undefined && options.ids.length === 0) {
          return [];
        }
        const conditions = [
          options.currentOnly ? eq(discInspections.isCurrent, true) : undefined,
          options.ids ? inArray(discInspections.id, [...options.ids]) : undefined,
          options.opticalDriveId
            ? eq(discInspections.opticalDriveId, options.opticalDriveId)
            : undefined,
          options.detectedDiscId
            ? eq(discInspections.detectedDiscId, options.detectedDiscId)
            : undefined,
        ].filter((condition) => condition !== undefined);
        const query = database
          .select()
          .from(discInspections)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(discInspections.updatedAt), desc(discInspections.id));
        if (options.limit === undefined) {
          return query.all();
        }
        return query
          .limit(requirePositiveSafeInteger(options.limit, "limit"))
          .all();
      },

      listAttempts(id) {
        requireRow(
          database
            .select({ id: discInspections.id })
            .from(discInspections)
            .where(eq(discInspections.id, id))
            .get(),
          "disc inspection",
          id,
        );
        return database
          .select()
          .from(discInspectionAttempts)
          .where(eq(discInspectionAttempts.discInspectionId, id))
          .orderBy(
            asc(discInspectionAttempts.attemptNumber),
            asc(discInspectionAttempts.id),
          )
          .all();
      },
    },

    archiveRequests: {
      find(id) {
        return database.select().from(archiveRequests)
          .where(eq(archiveRequests.id, id)).get() ?? null;
      },
      listForDetectedDisc(id) {
        return database.select().from(archiveRequests)
          .where(eq(archiveRequests.detectedDiscId, id))
          .orderBy(asc(archiveRequests.createdAt), asc(archiveRequests.id))
          .all();
      },
      listForRearchiveSources(ids) {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length > RELATED_ACTIVITY_ROOT_LIMIT) {
          throw new DomainInvariantError(
            `related Original Disc Archive reads are limited to ${RELATED_ACTIVITY_ROOT_LIMIT} roots`,
          );
        }
        if (uniqueIds.length === 0) {
          return [];
        }
        return uniqueIds.flatMap((id) => {
          const request = database
            .select()
            .from(archiveRequests)
            .where(eq(archiveRequests.rearchiveSourceArchiveId, id))
            .orderBy(
              sql`case when ${archiveRequests.status} in ('pending', 'running', 'needs_attention', 'cancellation_requested') then 0 else 1 end`,
              desc(archiveRequests.updatedAt),
              desc(archiveRequests.id),
            )
            .limit(1)
            .get();
          return request === undefined ? [] : [request];
        });
      },
      create: createArchiveRequest,
      submit: ({ mutationKey, detectedDiscId, evidenceFormat }) =>
        createArchiveRequest({
          detectedDiscId,
          ...(evidenceFormat === undefined ? {} : { evidenceFormat }),
        }, mutationKey),
      submitRearchive({ mutationKey, sourceArchiveId }) {
        const timestamp = now();
        return database.transaction((transaction) => {
          const semanticInput = JSON.stringify({ sourceArchiveId });
          const previous = readMutationInvocation(
            transaction,
            mutationKey,
            "archive_request.submit_rearchive",
            semanticInput,
            (stored) => {
              const outcome = JSON.parse(stored) as ArchiveRequest;
              return {
                ...outcome,
                evidenceFormat: outcome.evidenceFormat ?? null,
                cancellationRequestedAt:
                  outcome.cancellationRequestedAt === null
                    ? null
                    : new Date(outcome.cancellationRequestedAt),
                fulfilledAt:
                  outcome.fulfilledAt === null
                    ? null
                    : new Date(outcome.fulfilledAt),
                cancelledAt:
                  outcome.cancelledAt === null
                    ? null
                    : new Date(outcome.cancelledAt),
                createdAt: new Date(outcome.createdAt),
                updatedAt: new Date(outcome.updatedAt),
              };
            },
          );
          if (previous !== undefined) {
            return previous;
          }
          const source = requireRow(
            transaction
              .select({ archive: originalDiscArchives })
              .from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, sourceArchiveId))
              .get(),
            "original disc archive",
            sourceArchiveId,
          );
          if (source.archive.discKind !== "dvd") {
            throw new DomainInvariantError(
              "Fresh re-archive requests are supported only for DVD archives",
            );
          }
          const activeCandidates = transaction
            .select({
              discKind: detectedDiscs.discKind,
              fingerprint: detectedDiscs.fingerprint,
              request: archiveRequests,
            })
            .from(archiveRequests)
            .innerJoin(
              detectedDiscs,
              eq(detectedDiscs.id, archiveRequests.detectedDiscId),
            )
            .where(
              and(
                eq(detectedDiscs.discKind, source.archive.discKind),
                inArray(archiveRequests.status, [
                  "pending",
                  "running",
                  "needs_attention",
                  "cancellation_requested",
                ]),
              ),
            )
            .orderBy(asc(archiveRequests.createdAt), asc(archiveRequests.id))
            .limit(ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT + 1)
            .all();
          if (
            activeCandidates.length > ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT
          ) {
            throw new DomainInvariantError(
              "Active Archive Request identity lookup exceeds the safety limit",
            );
          }
          const matchingActiveRequests = activeCandidates.filter(
            (candidate) => {
              if (candidate.discKind !== source.archive.discKind) {
                return false;
              }
              if (originalArchiveMatchesFingerprintOrContentIdAlias(
                sourceArchiveId,
                candidate.fingerprint,
                transaction,
              )) {
                return true;
              }
              return candidate.request.rearchiveSourceArchiveId !== null &&
                originalArchivesShareDiscIdentity(
                  sourceArchiveId,
                  candidate.request.rearchiveSourceArchiveId,
                  transaction,
                );
            },
          );
          if (matchingActiveRequests.length > 1) {
            throw new DomainInvariantError(
              "Disc identity matches multiple active Archive Requests",
            );
          }
          const active = matchingActiveRequests[0]?.request;
          assertDvdRecoveryEvidenceAdmissionAvailable(active?.evidenceFormat);
          if (
            active !== undefined &&
            active.rearchiveSourceArchiveId !== sourceArchiveId
          ) {
            throw new DomainInvariantError(
              "Matching archive work is already active for this disc",
            );
          }
          const outcome = active ?? requireRow(
            transaction
              .insert(archiveRequests)
              .values({
                id: newId<ArchiveRequestId>(),
                detectedDiscId: source.archive.detectedDiscId,
                rearchiveSourceArchiveId: sourceArchiveId,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "archive request",
            sourceArchiveId,
          );
          return recordMutationInvocation(
            transaction,
            mutationKey,
            "archive_request.submit_rearchive",
            semanticInput,
            outcome,
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      cancel(id) {
        return database.transaction((transaction) =>
          cancelArchiveRequest(transaction, id), { behavior: "immediate" });
      },

      retry(id) {
        const current = requireRow(
          database
            .select()
            .from(archiveRequests)
            .where(eq(archiveRequests.id, id))
            .get(),
          "archive request",
          id,
        );
        assertDvdRecoveryEvidenceAdmissionAvailable(current.evidenceFormat);
        const retried = database
          .update(archiveRequests)
          .set({
            status: "pending",
            cancellationRequestedAt: null,
            fulfilledAt: null,
            cancelledAt: null,
            updatedAt: now(),
          })
          .where(
            and(
              eq(archiveRequests.id, id),
              eq(archiveRequests.status, "needs_attention"),
            ),
          )
          .returning()
          .get();
        if (!retried) {
          throw new InvalidStatusTransitionError(
            "archive request",
            current.status,
            "pending",
          );
        }
        return retried;
      },

      cancelWithReplay({ mutationKey, id }) {
        return replayRecoveryMutation(mutationKey, "archive_request.cancel", id, (transaction) => {
          const current = transaction.select().from(archiveRequests)
            .where(eq(archiveRequests.id, id)).get();
          if (current && !["pending", "running", "needs_attention"].includes(current.status)) {
            throw new InvalidStatusTransitionError(
              "archive request", current.status, "cancelled",
            );
          }
          const cancelled = cancelArchiveRequest(transaction, id);
          return { id: cancelled.id, status: cancelled.status };
        });
      },

      retryWithReplay({ mutationKey, id }) {
        return replayRecoveryMutation(mutationKey, "archive_request.retry", id, () => {
          const retried = this.retry(id);
          return { id: retried.id, status: retried.status };
        });
      },

        list: listArchiveRequests,

        listRelevantForDetectedDiscs(detectedDiscIds) {
          const uniqueIds = [...new Set(detectedDiscIds)];
          if (uniqueIds.length > RELATED_ACTIVITY_ROOT_LIMIT) {
            throw new DomainInvariantError(
              `related Detected Disc reads are limited to ${RELATED_ACTIVITY_ROOT_LIMIT} roots`,
            );
          }
          return uniqueIds.flatMap((detectedDiscId) => {
            const ownedRequest = database
              .select()
              .from(archiveRequests)
              .where(eq(archiveRequests.detectedDiscId, detectedDiscId))
              .orderBy(
                sql`case when ${archiveRequests.status} in ('pending', 'running', 'needs_attention', 'cancellation_requested') then 0 else 1 end`,
                desc(archiveRequests.updatedAt),
                desc(archiveRequests.id),
              )
              .limit(1)
              .get();
            const attemptedRequest = database
              .select({ request: archiveRequests })
              .from(archiveJobs)
              .innerJoin(
                archiveRequests,
                eq(archiveRequests.id, archiveJobs.archiveRequestId),
              )
              .where(eq(archiveJobs.detectedDiscId, detectedDiscId))
              .orderBy(
                sql`case when ${archiveJobs.status} = 'running' then 0 else 1 end`,
                desc(archiveJobs.updatedAt),
                desc(archiveJobs.id),
              )
              .limit(1)
              .get()?.request;
            const relevantRequest = [ownedRequest, attemptedRequest].filter(
              (request): request is NonNullable<typeof request> =>
                request !== undefined,
            ).sort((left, right) => {
              const leftIsActive = !["fulfilled", "cancelled"].includes(
                left.status,
              );
              const rightIsActive = !["fulfilled", "cancelled"].includes(
                right.status,
              );
              if (leftIsActive !== rightIsActive) {
                return leftIsActive ? -1 : 1;
              }
              return right.updatedAt.getTime() - left.updatedAt.getTime() ||
                (left.id < right.id ? 1 : left.id === right.id ? 0 : -1);
            })[0];
            return relevantRequest === undefined ? [] : [relevantRequest];
          });
        },

        hasPendingRequestForDetectedDiscFingerprint(detectedDiscId) {
          const disc = database
            .select({
              discKind: detectedDiscs.discKind,
              fingerprint: detectedDiscs.fingerprint,
            })
            .from(detectedDiscs)
            .where(eq(detectedDiscs.id, detectedDiscId))
            .get();
          if (disc === undefined) {
            return false;
          }
          return hasPendingArchiveRequestForDisc(disc);
        },

        waitingStatus(id) {
          const candidate = database
            .select({
              request: archiveRequests,
              requestedDiscId: requestedDetectedDiscRecords.id,
              requestedDiscScanData: requestedDetectedDiscRecords.scanData,
              requestedDiscStatus: requestedDetectedDiscRecords.status,
            })
            .from(archiveRequests)
            .innerJoin(
              requestedDetectedDiscRecords,
              eq(requestedDetectedDiscRecords.id, archiveRequests.detectedDiscId),
            )
            .where(eq(archiveRequests.id, id))
            .get();
          if (candidate === undefined || candidate.request.status !== "pending") {
            return null;
          }
          if (candidate.request.evidenceFormat !== null) {
            return { code: "dvd_recovery_evidence_admission_closed" };
          }
          const requestDeclaredByteCount =
            declaredByteCountForArchiveRequest(
              database,
              candidate.request.id,
              candidate.requestedDiscId,
            );
          const currentInspections = database
            .select({
              disc: detectedDiscs,
              inspection: discInspections,
            })
            .from(discInspections)
            .leftJoin(
              detectedDiscs,
              eq(detectedDiscs.id, discInspections.detectedDiscId),
            )
            .where(eq(discInspections.isCurrent, true))
            .all();
          const ready = currentInspections.some(({ disc, inspection }) => {
            if (
              disc === null ||
              inspection.status !== "completed" ||
              inspection.totalBytes === null
            ) {
              return false;
            }
            if (candidate.requestedDiscId === disc.id) {
              return candidate.requestedDiscStatus ===
                requiredArchiveRequestDiscStatus(candidate.request);
            }
            return archiveRequestMatchesDvdContinuationIdentity(
              disc,
              inspection.totalBytes,
              candidate,
              requestDeclaredByteCount,
              database,
            );
          });
          if (ready) {
            return {
              code: "ready_for_archive_worker",
            };
          }
          const sourceContinuityUnavailable =
            candidate.request.rearchiveSourceArchiveId !== null &&
            requestDeclaredByteCount === null &&
            currentInspections.some(({ disc, inspection }) =>
              disc !== null &&
              disc.id !== candidate.requestedDiscId &&
              inspection.status === "completed" &&
              inspection.totalBytes !== null &&
              archiveRequestMatchesDvdContinuationDiscIdentity(
                disc,
                candidate,
                database,
              )
            );
          if (sourceContinuityUnavailable) {
            return { code: "source_continuity_unavailable" };
          }
          if (currentInspections.some(({ inspection }) =>
            inspection.status === "running"
          )) {
            return {
              code: "matching_inspection_incomplete",
            };
          }
          return {
            code: "matching_disc_required",
          };
        },
      },

      archiveJobs: {
        find(id) {
          return database.select().from(archiveJobs)
            .where(eq(archiveJobs.id, id)).get() ?? null;
        },
        listForInspection(id) {
          return database.select().from(archiveJobs)
            .where(eq(archiveJobs.discInspectionId, id))
            .orderBy(asc(archiveJobs.createdAt), asc(archiveJobs.id))
            .all();
        },
        listForArchive(id) {
          return database.select().from(archiveJobs)
            .where(eq(archiveJobs.originalDiscArchiveId, id))
            .orderBy(asc(archiveJobs.createdAt), asc(archiveJobs.id))
            .all();
        },
      startForInspection(inspectionId, workerIdInput) {
        const timestamp = now();
        const workerId = requireNonEmpty(workerIdInput, "workerId");
        const preflight = database
          .select({
            discKind: detectedDiscs.discKind,
            fingerprint: detectedDiscs.fingerprint,
          })
          .from(discInspections)
          .innerJoin(
            detectedDiscs,
            eq(detectedDiscs.id, discInspections.detectedDiscId),
          )
          .where(
            and(
              eq(discInspections.id, inspectionId),
              eq(discInspections.isCurrent, true),
              eq(discInspections.status, "completed"),
            ),
          )
          .get();
        if (
          preflight === undefined ||
          !hasPendingArchiveRequestForDisc(preflight, { admittedOnly: true })
        ) {
          return null;
        }
        if (preflight.discKind === "dvd") {
          requireLegacyDvdArchiveIdentitiesResolved(
            preflight.discKind,
            preflight.fingerprint,
          );
        }
        const claimToken = newId<ArchiveJobClaimToken>();
        return database.transaction((transaction) => {
          const inspection = transaction
            .select()
            .from(discInspections)
            .innerJoin(
              opticalDrives,
              eq(opticalDrives.id, discInspections.opticalDriveId),
            )
            .where(
              and(
                eq(discInspections.id, inspectionId),
                eq(discInspections.isCurrent, true),
                eq(discInspections.status, "completed"),
                isNotNull(discInspections.detectedDiscId),
                eq(opticalDrives.isPresent, true),
                eq(opticalDrives.isEnabled, true),
              ),
            )
            .get();
          if (!inspection || inspection.disc_inspections.detectedDiscId === null) {
            return null;
          }
          const disc = requireRow(
            transaction
              .select()
              .from(detectedDiscs)
              .where(
                and(
                  eq(
                    detectedDiscs.id,
                    inspection.disc_inspections.detectedDiscId,
                  ),
                  eq(
                    detectedDiscs.opticalDriveId,
                    inspection.disc_inspections.opticalDriveId,
                  ),
                ),
              )
              .get(),
            "detected disc",
            inspection.disc_inspections.detectedDiscId,
          );
          const requestCandidates = transaction
            .select({
              request: archiveRequests,
              requestedDiscId: requestedDetectedDiscRecords.id,
              requestedDiscScanData: requestedDetectedDiscRecords.scanData,
              requestedDiscStatus: requestedDetectedDiscRecords.status,
            })
            .from(archiveRequests)
            .innerJoin(
              requestedDetectedDiscRecords,
              eq(
                requestedDetectedDiscRecords.id,
                archiveRequests.detectedDiscId,
              ),
            )
            .where(
              and(
                eq(archiveRequests.status, "pending"),
                eq(requestedDetectedDiscRecords.discKind, disc.discKind),
                or(
                  eq(
                    requestedDetectedDiscRecords.fingerprint,
                    disc.fingerprint,
                  ),
                  isNotNull(archiveRequests.rearchiveSourceArchiveId),
                ),
              ),
            )
            .orderBy(
              desc(archiveRequests.priority),
              asc(archiveRequests.createdAt),
              asc(archiveRequests.id),
            )
            .limit(ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT + 1)
            .all();
          if (
            requestCandidates.length > ACTIVE_ARCHIVE_REQUEST_IDENTITY_LIMIT
          ) {
            throw new DomainInvariantError(
              "Pending Archive Request identity lookup exceeds the safety limit",
            );
          }
          const exactRequest = requestCandidates.find(
            (candidate) => candidate.requestedDiscId === disc.id,
          );
          if (
            exactRequest !== undefined &&
            exactRequest.requestedDiscStatus !==
              requiredArchiveRequestDiscStatus(exactRequest.request)
          ) {
            throw new DomainInvariantError(
              `pending Archive Request references a ${exactRequest.requestedDiscStatus} Detected Disc`,
            );
          }
          const matchingRequests = requestCandidates.filter((candidate) => {
            if (candidate.requestedDiscId === disc.id) {
              return true;
            }
            return archiveRequestMatchesDvdContinuationIdentity(
              disc,
              inspection.disc_inspections.totalBytes,
              candidate,
              declaredByteCountForArchiveRequest(
                transaction,
                candidate.request.id,
                candidate.requestedDiscId,
              ),
              transaction,
            );
          });
          if (matchingRequests.length > 1) {
            throw new DomainInvariantError(
              "Disc identity matches multiple pending Archive Requests",
            );
          }
          const request = matchingRequests[0]?.request;
          if (request === undefined) {
            return null;
          }
          if (request.evidenceFormat !== null) {
            return null;
          }
          if (
            request.rearchiveSourceArchiveId === null &&
            findOriginalArchiveByFingerprintOrContentIdAlias(
              disc.fingerprint,
              transaction,
            )
          ) {
            transaction
              .update(archiveRequests)
              .set({
                status: "fulfilled",
                fulfilledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, request.id),
                  eq(archiveRequests.status, "pending"),
                ),
              )
              .run();
            return null;
          }
          const conflicting = transaction
            .select({ id: archiveJobs.id })
            .from(archiveJobs)
            .innerJoin(
              detectedDiscs,
              eq(detectedDiscs.id, archiveJobs.detectedDiscId),
            )
            .where(
              and(
                eq(archiveJobs.status, "running"),
                or(
                  eq(detectedDiscs.fingerprint, disc.fingerprint),
                  eq(detectedDiscs.opticalDriveId, disc.opticalDriveId),
                ),
              ),
            )
            .get();
          if (conflicting) {
            return null;
          }
          const attempt = transaction
            .select({
              value: sql<number>`coalesce(max(${archiveJobs.attemptOrdinal}), 0)`,
            })
            .from(archiveJobs)
            .where(eq(archiveJobs.archiveRequestId, request.id))
            .get()?.value ?? 0;
          const id = newId<ArchiveJobId>();
          const transitioned = transaction
            .update(archiveRequests)
            .set({ status: "running", updatedAt: timestamp })
            .where(
              and(
                eq(archiveRequests.id, request.id),
                eq(archiveRequests.status, "pending"),
              ),
            )
            .returning({ id: archiveRequests.id })
            .get();
          if (!transitioned) {
            return null;
          }
          const job = requireRow(
            transaction
              .insert(archiveJobs)
              .values({
                id,
                archiveRequestId: request.id,
                discInspectionId: inspectionId,
                detectedDiscId: disc.id,
                evidenceFormat: request.evidenceFormat,
                attemptOrdinal: attempt + 1,
                status: "running",
                priority: request.priority,
                progressPhase: "preparing",
                progressPercent: 0,
                progressBytes: 0,
                progressEtaSeconds: null,
                lastProgressAt: timestamp,
                claimedBy: workerId,
                claimToken,
                claimedAt: timestamp,
                startedAt: timestamp,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .returning()
              .get(),
            "archive job",
            id,
          );
          archiveProgress.delete(id);
          return asRunningArchiveJob(job);
        }, { behavior: "immediate" });
      },

      renewDvdInitialClaim(claim) {
        return updateDvdInitialClaim(claim);
      },

      reclaimDvdInitialSave(claim, workerId) {
        return updateDvdInitialClaim(claim, requireNonEmpty(workerId, "workerId"));
      },

      renewClaim(claim) {
        requireLegacyArchiveJobMutation(claim);
        const timestamp = now();
        const renewed = database
          .update(archiveJobs)
          .set({ updatedAt: timestamp })
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
              gt(
                archiveJobs.updatedAt,
                new Date(
                  timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("archive job", claim.id);
        }
        return asRunningArchiveJob(renewed);
      },

      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        const recovered = database.transaction((transaction) => {
          const expired = transaction
            .select({
              id: archiveJobs.id,
              archiveRequestId: archiveJobs.archiveRequestId,
              claimToken: archiveJobs.claimToken,
            })
            .from(archiveJobs)
            .innerJoin(
              archiveRequests,
              eq(archiveRequests.id, archiveJobs.archiveRequestId),
            )
            .where(
              and(
                eq(archiveJobs.status, "running"),
                isNull(archiveJobs.evidenceFormat),
                lte(archiveJobs.updatedAt, expiredBefore),
                ne(archiveRequests.status, "cancellation_requested"),
              ),
            )
            .orderBy(asc(archiveJobs.updatedAt), asc(archiveJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all();
          if (expired.length === 0) {
            return [];
          }
          const terminalJobs: ArchiveJob[] = [];
          for (const candidate of expired) {
            const failedJob = transaction
              .update(archiveJobs)
              .set({
                status: "failed",
                ...archiveTerminalProgressPatchForClaim(
                  candidate.id,
                  candidate.claimToken,
                ),
                completedAt: timestamp,
                errorMessage: "Archive worker lease expired",
                failureDetailVersion: ARCHIVE_FAILURE_DETAIL_VERSIONS[0],
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveJobs.id, candidate.id),
                  eq(archiveJobs.status, "running"),
                  lte(archiveJobs.updatedAt, expiredBefore),
                ),
              )
              .returning()
              .get();
            if (failedJob === undefined) {
              continue;
            }
            terminalJobs.push(failedJob);
            requireRow(
              transaction
              .update(archiveRequests)
              .set({ status: "needs_attention", updatedAt: timestamp })
              .where(
                and(
                  eq(archiveRequests.id, candidate.archiveRequestId),
                  eq(archiveRequests.status, "running"),
                ),
              )
                .returning({ id: archiveRequests.id })
                .get(),
              "archive request",
              candidate.archiveRequestId,
            );
            recordArchiveJobFailure(transaction, failedJob);
          }
          const jobsById = new Map(terminalJobs.map((job) => [job.id, job]));
          const jobs = expired.flatMap(({ id }) => {
            const job = jobsById.get(id);
            return job === undefined ? [] : [job];
          });
          return jobs;
        }, { behavior: "immediate" });
        for (const job of recovered) {
          archiveProgress.delete(job.id);
        }
        return recovered;
      },

      listExpiredCancellations() {
        const expiredBefore = new Date(
          now().getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        const listAfter = (
          cursor: typeof expiredCancellationCursor,
        ) => database
            .select({ job: archiveJobs })
            .from(archiveJobs)
            .innerJoin(
              archiveRequests,
              eq(archiveRequests.id, archiveJobs.archiveRequestId),
            )
            .where(
              and(
                eq(archiveJobs.status, "running"),
                eq(archiveRequests.status, "cancellation_requested"),
                lte(archiveJobs.updatedAt, expiredBefore),
                cursor === undefined
                  ? undefined
                  : or(
                      gt(archiveJobs.updatedAt, cursor.updatedAt),
                      and(
                        eq(archiveJobs.updatedAt, cursor.updatedAt),
                        gt(archiveJobs.id, cursor.id),
                      ),
                    ),
              ),
            )
            .orderBy(asc(archiveJobs.updatedAt), asc(archiveJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all()
            .map(({ job }) => asRunningArchiveJob(job));
        let jobs = listAfter(expiredCancellationCursor);
        if (jobs.length === 0 && expiredCancellationCursor !== undefined) {
          expiredCancellationCursor = undefined;
          jobs = listAfter(undefined);
        }
        const last = jobs.at(-1);
        expiredCancellationCursor =
          jobs.length === JOB_RECOVERY_LIMIT && last !== undefined
            ? { id: last.id, updatedAt: last.updatedAt }
            : undefined;
        return jobs;
      },

      finalizeExpiredCancellation(claim) {
        const isClosedEvidenceCancellation =
          claim.evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT;
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
        );
        const completed = database.transaction((transaction) => {
          const job = transaction
            .update(archiveJobs)
            .set({
              status: "aborted",
              ...(isClosedEvidenceCancellation
                ? {}
                : archiveTerminalProgressPatchForClaim(
                  claim.id,
                  claim.claimToken,
                )),
              completedAt: timestamp,
              errorMessage: "Archive cancelled after worker recovery",
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.archiveRequestId, claim.archiveRequestId),
                eq(archiveJobs.detectedDiscId, claim.detectedDiscId),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                isClosedEvidenceCancellation
                  ? eq(
                    archiveJobs.evidenceFormat,
                    DVD_RECOVERY_EVIDENCE_FORMAT,
                  )
                  : undefined,
                lte(archiveJobs.updatedAt, expiredBefore),
                exists(
                  transaction
                    .select({ id: archiveRequests.id })
                    .from(archiveRequests)
                    .where(
                      and(
                        eq(
                          archiveRequests.id,
                          archiveJobs.archiveRequestId,
                        ),
                        eq(
                          archiveRequests.status,
                          "cancellation_requested",
                        ),
                      ),
                    ),
                ),
              ),
            )
            .returning()
            .get();
          if (job === undefined) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          requireRow(
            transaction
              .update(archiveRequests)
              .set({
                status: "cancelled",
                cancelledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, job.archiveRequestId),
                  eq(archiveRequests.status, "cancellation_requested"),
                ),
              )
              .returning({ id: archiveRequests.id })
              .get(),
            "archive request",
            job.archiveRequestId,
          );
          return job;
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return completed;
      },

        list: listArchiveJobs,

        listLatestForRequests(archiveRequestIds) {
          const uniqueIds = [...new Set(archiveRequestIds)];
          if (uniqueIds.length > RELATED_ACTIVITY_ROOT_LIMIT) {
            throw new DomainInvariantError(
              `related Archive Request reads are limited to ${RELATED_ACTIVITY_ROOT_LIMIT} roots`,
            );
          }
          return uniqueIds.flatMap((archiveRequestId) => {
            const job = database
              .select()
              .from(archiveJobs)
              .where(eq(archiveJobs.archiveRequestId, archiveRequestId))
              .orderBy(
                desc(archiveJobs.attemptOrdinal),
                desc(archiveJobs.id),
              )
              .limit(1)
              .get();
            return job === undefined ? [] : [job];
          });
        },

        isCancellationRequested(claim) {
        const current = database
          .select({ status: archiveRequests.status })
          .from(archiveJobs)
          .innerJoin(
            archiveRequests,
            eq(archiveRequests.id, archiveJobs.archiveRequestId),
          )
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
            ),
          )
          .get();
        if (!current) {
          throw new StaleJobAttemptError("archive job", claim.id);
        }
        return current.status === "cancellation_requested";
      },

      updateProgress(claim, progressInput) {
        requireLegacyArchiveJobMutation(claim);
        const timestamp = now();
        const progress: ArchiveJobProgress =
          typeof progressInput === "number"
            ? {
                phase: claim.progressPhase,
                progressPercent: progressInput,
              }
            : progressInput;
        if (!ARCHIVE_RUNNING_PROGRESS_PHASES.includes(progress.phase)) {
          throw new DomainInvariantError("Archive Job progress phase is invalid");
        }
        if (
          !Number.isInteger(progress.progressPercent) ||
          progress.progressPercent < 0 ||
          progress.progressPercent > 100
        ) {
          throw new DomainInvariantError(
            "progressPercent must be an integer between 0 and 100",
          );
        }
        if (
          progress.progressBytes !== undefined &&
          (!Number.isSafeInteger(progress.progressBytes) ||
            progress.progressBytes < 0)
        ) {
          throw new DomainInvariantError(
            "progressBytes must be a non-negative safe integer",
          );
        }
        if (
          progress.etaSeconds !== undefined &&
          progress.etaSeconds !== null &&
          (!Number.isSafeInteger(progress.etaSeconds) ||
            progress.etaSeconds < 0)
        ) {
          throw new DomainInvariantError(
            "etaSeconds must be a non-negative safe integer or null",
          );
        }
        const progressEtaSeconds = progress.etaSeconds ?? null;
        const previous = archiveProgress.get(claim.id);
        const previousBytes = previous?.latestBytes ?? claim.progressBytes;
        const progressBytes = Math.max(
          previousBytes,
          progress.progressBytes ?? previousBytes,
        );
        const madeForwardProgress =
          progress.phase !== (previous?.latestPhase ?? claim.progressPhase) ||
          progressBytes > previousBytes ||
          (progress.progressBytes === undefined &&
            progress.progressPercent >
              (previous?.latestPercent ?? claim.progressPercent));
        const lastProgressAt = madeForwardProgress
          ? timestamp
          : (previous?.lastProgressAt ?? claim.lastProgressAt);
        const shouldPersist =
          previous === undefined ||
          previous.token !== claim.claimToken ||
          previous.persistedPhase !== progress.phase ||
          timestamp.getTime() - previous.persistedAt >= 1_000 ||
          Math.abs(
            progress.progressPercent - (previous?.persistedPercent ?? 0),
          ) >= 5;
        if (!shouldPersist) {
          archiveProgress.set(claim.id, {
            ...previous,
            lastProgressAt,
            latestBytes: progressBytes,
            latestEtaSeconds: progressEtaSeconds,
            latestPercent: progress.progressPercent,
            latestPhase: progress.phase,
          });
          return {
            ...claim,
            lastProgressAt,
            progressBytes,
            progressEtaSeconds,
            progressPhase: progress.phase,
            progressPercent: progress.progressPercent,
          };
        }
        const updated = database
          .update(archiveJobs)
          .set({
            lastProgressAt,
            progressBytes,
            progressEtaSeconds,
            progressPhase: progress.phase,
            progressPercent: progress.progressPercent,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(archiveJobs.id, claim.id),
              eq(archiveJobs.status, "running"),
              eq(archiveJobs.claimToken, claim.claimToken),
              gt(
                archiveJobs.updatedAt,
                new Date(
                  timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError("archive job", claim.id);
        }
        archiveProgress.set(claim.id, {
          token: claim.claimToken,
          lastProgressAt,
          latestBytes: progressBytes,
          latestEtaSeconds: progressEtaSeconds,
          latestPercent: progress.progressPercent,
          latestPhase: progress.phase,
          persistedPercent: progress.progressPercent,
          persistedPhase: progress.phase,
          persistedAt: timestamp.getTime(),
        });
        return updated;
      },

      publish(claim, input) {
        return publishArchive(claim, input);
      },
      publishDvdInitial(claim, input) {
        const ranges = input.manifest.unrecoveredSourceRanges.map(({ startLba, sectorCount }) => ({ startLba, sectorCount }));
        return publishArchive(claim, {
          archivePath: input.archivePath, boundaryEvidence: input.boundaryEvidence,
          sizeBytes: input.manifest.boundaryPublishedSizeBytes,
          integrityEvidence: ranges.length === 0
            ? { integrity: "clean_read", policyVersion: DVD_RECOVERY_EVIDENCE_FORMAT, badSectorCount: 0, badAreaCount: 0, badSectorRanges: [] }
            : { integrity: "incomplete_read", policyVersion: DVD_RECOVERY_EVIDENCE_FORMAT,
                badSectorCount: ranges.reduce((n, r) => n + r.sectorCount, 0), badAreaCount: ranges.length, badSectorRanges: ranges },
        }, input);
      },

      fail(claim, errorMessageInput) {
        return failArchiveJob(claim, errorMessageInput);
      },

      failWithReadFailure(claim, evidence) {
        return failArchiveJob(
          claim,
          ARCHIVE_READ_FAILURE_MESSAGES[evidence.category],
          evidence,
        );
      },

      abort(claim, errorMessageInput) {
        const isClosedEvidenceCancellation =
          claim.evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT;
        const timestamp = now();
        const errorMessage = requireNonEmpty(
          errorMessageInput,
          "errorMessage",
        ).slice(0, 500);
        const aborted = database.transaction((transaction) => {
          if (isClosedEvidenceCancellation) {
            const cancellation = transaction
              .select({ status: archiveRequests.status })
              .from(archiveJobs)
              .innerJoin(
                archiveRequests,
                eq(archiveRequests.id, archiveJobs.archiveRequestId),
              )
              .where(and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                eq(
                  archiveJobs.evidenceFormat,
                  DVD_RECOVERY_EVIDENCE_FORMAT,
                ),
              ))
              .get();
            if (cancellation === undefined) {
              throw new StaleJobAttemptError("archive job", claim.id);
            }
            if (cancellation.status !== "cancellation_requested") {
              throw new DvdRecoveryEvidenceAdmissionClosedError();
            }
          }
          const job = transaction
            .update(archiveJobs)
            .set({
              status: "aborted",
              ...(isClosedEvidenceCancellation
                ? {}
                : archiveTerminalProgressPatchForClaim(
                  claim.id,
                  claim.claimToken,
                )),
              completedAt: timestamp,
              errorMessage,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
                isClosedEvidenceCancellation
                  ? eq(
                    archiveJobs.evidenceFormat,
                    DVD_RECOVERY_EVIDENCE_FORMAT,
                  )
                  : undefined,
                gt(
                  archiveJobs.updatedAt,
                  new Date(
                    timestamp.getTime() - ARCHIVE_JOB_LEASE_DURATION_MS,
                  ),
                ),
              ),
            )
            .returning()
            .get();
          if (!job) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          requireRow(
            transaction
              .update(archiveRequests)
              .set({
                status: "cancelled",
                ...(isClosedEvidenceCancellation
                  ? {}
                  : { cancellationRequestedAt: timestamp }),
                cancelledAt: timestamp,
                updatedAt: timestamp,
              })
              .where(
                and(
                  eq(archiveRequests.id, job.archiveRequestId),
                  isClosedEvidenceCancellation
                    ? eq(
                      archiveRequests.status,
                      "cancellation_requested",
                    )
                    : inArray(archiveRequests.status, [
                      "running",
                      "cancellation_requested",
                    ]),
                ),
              )
              .returning({ id: archiveRequests.id })
              .get(),
            "archive request",
            job.archiveRequestId,
          );
          return job;
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return aborted;
      },

      complete(claim, originalDiscArchiveId) {
        const timestamp = now();
        const completed = database.transaction((transaction) => {
          const archive = requireRow(
            transaction
              .select()
              .from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, originalDiscArchiveId))
              .get(),
            "original disc archive",
            originalDiscArchiveId,
          );
          if (archive.detectedDiscId !== claim.detectedDiscId) {
            throw new DomainInvariantError(
              "Archive Job result must belong to the job's Detected Disc",
            );
          }
          const job = transaction
            .update(archiveJobs)
            .set({
              originalDiscArchiveId,
              status: "completed",
              ...archiveTerminalProgressPatchForClaim(
                claim.id,
                claim.claimToken,
              ),
              progressPhase: "finalizing",
              progressPercent: 100,
              lastProgressAt: timestamp,
              completedAt: timestamp,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(archiveJobs.id, claim.id),
                eq(archiveJobs.status, "running"),
                eq(archiveJobs.claimToken, claim.claimToken),
              ),
            )
            .returning()
            .get();
          if (!job) {
            throw new StaleJobAttemptError("archive job", claim.id);
          }
          transaction
            .update(archiveRequests)
            .set({
              status: "fulfilled",
              fulfilledAt: timestamp,
              updatedAt: timestamp,
            })
            .where(eq(archiveRequests.id, job.archiveRequestId))
            .run();
          return job;
        }, { behavior: "immediate" });
        archiveProgress.delete(claim.id);
        return completed;
      },
    },

    encodeJobs: {
      find(id) {
        return database.select().from(encodeJobs)
          .where(eq(encodeJobs.id, id)).get() ?? null;
      },
      listForDiscSelection(id) {
        return database.select().from(encodeJobs)
          .where(eq(encodeJobs.discSelectionId, id))
          .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
          .all();
      },
      listActiveForDiscSelections(options) {
        if (
          !Number.isSafeInteger(options.limit) || options.limit < 1 ||
          options.limit > ACTIVE_ENCODE_JOB_RESULT_LIMIT
        ) {
          throw new DomainInvariantError(
            `Active Encode Job lookup limit must be a safe integer between 1 and ${ACTIVE_ENCODE_JOB_RESULT_LIMIT}`,
          );
        }
        const jobs = listActiveEncodeJobsForDiscSelections(
          options.discSelectionIds,
          ["queued", "running", "cancellation_requested"],
          options.limit + 1,
        );
        if (jobs.length > options.limit) {
          throw new DomainInvariantError(
            `Active Encode Job lookup exceeds the ${options.limit}-job limit`,
          );
        }
        return jobs;
      },
      listDvdTitleDamageAcceptanceWithdrawalWork(options) {
        return listActiveEncodeJobsForDiscSelections(
          options.discSelectionIds,
          ["queued", "running"],
        );
      },
      listActiveForOriginalDiscArchives(options) {
        const originalDiscArchiveIds = [
          ...new Set(options.originalDiscArchiveIds),
        ];
        if (
          originalDiscArchiveIds.length > DISC_SELECTION_ARCHIVE_LOOKUP_LIMIT
        ) {
          throw new DomainInvariantError(
            `Active Encode Job lookup is limited to ${DISC_SELECTION_ARCHIVE_LOOKUP_LIMIT} archives`,
          );
        }
        if (
          !Number.isSafeInteger(options.limit) || options.limit < 1 ||
          options.limit > ACTIVE_ENCODE_JOB_RESULT_LIMIT
        ) {
          throw new DomainInvariantError(
            `Active Encode Job lookup limit must be a safe integer between 1 and ${ACTIVE_ENCODE_JOB_RESULT_LIMIT}`,
          );
        }
        if (originalDiscArchiveIds.length === 0) return [];
        const selectionIds = database.select({ id: discSelections.id })
          .from(discSelections)
          .where(and(
            inArray(
              discSelections.originalDiscArchiveId,
              originalDiscArchiveIds,
            ),
            eq(discSelections.isCatalogActive, true),
          ));
        const jobs = database.select().from(encodeJobs)
          .where(and(
            inArray(encodeJobs.discSelectionId, selectionIds),
            inArray(encodeJobs.status, [
              "queued",
              "running",
              "cancellation_requested",
            ]),
          ))
          .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
          .limit(options.limit + 1)
          .all();
        if (jobs.length > options.limit) {
          throw new DomainInvariantError(
            `Active Encode Job lookup exceeds the ${options.limit}-job limit`,
          );
        }
        return jobs;
      },
      hasReservedOutputPathConflict(job) {
        return database.select({ id: encodeJobs.id }).from(encodeJobs)
          .where(and(
            eq(encodeJobs.outputPath, job.outputPath),
            eq(encodeJobs.reservesOutputPath, true),
            ne(encodeJobs.id, job.id),
          )).limit(1).get() !== undefined;
      },
      hasReservedOutputPath(outputPath) {
        return database.select({ id: encodeJobs.id }).from(encodeJobs)
          .where(and(
            eq(encodeJobs.outputPath, outputPath),
            eq(encodeJobs.reservesOutputPath, true),
          )).limit(1).get() !== undefined;
      },
      resolveQueueLogicalJobs(options) {
        if (
          options.discSelectionIds.length >
            ENCODE_QUEUE_DISC_SELECTION_LIMIT
        ) {
          throw new DomainInvariantError(
            `Encode queue logical-job resolution is limited to ${ENCODE_QUEUE_DISC_SELECTION_LIMIT} Disc Selections`,
          );
        }
        const discSelectionIds = [...new Set(options.discSelectionIds)];
        requireDvdRecoveryEvidenceEncodingAvailableForDiscSelections(
          database,
          discSelectionIds,
        );
        const jobs = discSelectionIds.length === 0
          ? []
          : database
            .select()
            .from(encodeJobs)
            .where(and(
              inArray(encodeJobs.discSelectionId, discSelectionIds),
              eq(encodeJobs.encodingProfileId, options.encodingProfileId),
              isNull(encodeJobs.predecessorEncodeJobId),
            ))
            .all();
        const jobsBySelectionId = new Map(
          jobs.map((job) => [job.discSelectionId, job]),
        );
        return discSelectionIds.map((discSelectionId) => {
          const job = jobsBySelectionId.get(discSelectionId);
          return {
            discSelectionId,
            logicalJob: job === undefined
              ? null
              : {
                  id: job.id,
                  encodingProfileId: job.encodingProfileId,
                  outputPath: job.outputPath,
                  status: job.status,
                  queueAvailable: isEncodeJobSafelyTerminal(job),
                },
          };
        });
      },

      listQueueDiscSelections(options) {
        const limit = requireSafeIntegerInRange(
          options.limit,
          "Encode queue Disc Selection limit",
          1,
          ENCODE_QUEUE_DISC_SELECTION_LIMIT,
        );
        const offset = optionalSafeInteger(options.offset, "offset", 0) ?? 0;
        const searchValidation = options.query === undefined
          ? undefined
          : validateEncodeQueueSearchQuery(options.query);
        if (searchValidation !== undefined && !searchValidation.valid) {
          const message = searchValidation.reason === "too_long"
            ? `Encode queue search query must be at most ${ENCODE_QUEUE_SEARCH_QUERY_MAX_LENGTH} characters`
            : searchValidation.reason === "no_terms"
            ? "Encode queue search query must contain a letter or number"
            : "Encode queue search query must not be empty";
          throw new DomainInvariantError(message);
        }
        const normalizedQuery = searchValidation?.normalizedQuery;
        const searchPattern = normalizedQuery === undefined
          ? null
          : `%${normalizedQuery.replaceAll(" ", "%")}%`;
        const pageRows = encodeQueueDiscSelectionPageStatement.all(
          options.historyGroup === "re_encode" ? 1 : 0,
          searchPattern,
          limit,
          offset,
        ) as unknown as Array<{
          not_encoded: number;
          re_encode: number;
          total: number;
          id: DiscSelectionId | null;
        }>;
        const countRow = pageRows[0];
        const counts = {
          notEncoded: countRow?.not_encoded ?? 0,
          reEncode: countRow?.re_encode ?? 0,
        };
        const selectionIds = pageRows.flatMap((row) =>
          row.id === null ? [] : [row.id]
        );
        const selectionById = new Map(
          (selectionIds.length === 0
            ? []
            : database
              .select()
              .from(discSelections)
              .where(inArray(discSelections.id, selectionIds))
              .all()
              .map(toDiscSelection))
            .map((selection) => [selection.id, selection]),
        );
        const selections = selectionIds.map((id) => {
          const selection = selectionById.get(id);
          if (!selection) {
            throw new DomainInvariantError(
              `Encode queue Disc Selection ${id} disappeared during hydration`,
            );
          }
          return selection;
        });
        // The page is bounded to 100 selections. Rank their history in one
        // scan instead of running a correlated self-scan for every job.
        const historicalJobIds = selectionIds.length === 0
          ? []
          : (sqlite.prepare(`
              with ranked_history as (
                select
                  history_job.id,
                  row_number() over (
                    partition by history_job.disc_selection_id
                    order by
                      coalesce(
                        history_job.completed_at,
                        history_job.updated_at
                      ) desc,
                      history_job.rowid desc
                  ) as history_rank
                from encode_jobs as history_job
                left join retained_encode_outputs as history_retained
                  on history_retained.replacement_encode_job_id = history_job.id
                where history_job.disc_selection_id in (
                  ${selectionIds.map(() => "?").join(", ")}
                )
                  and ${COMPLETED_ENCODE_HISTORY_SQL}
              )
              select id
              from ranked_history
              where history_rank = 1
            `).all(...selectionIds) as unknown as Array<{ id: EncodeJobId }>)
            .map(({ id }) => id);
        const historicalJobs = historicalJobIds.length === 0
          ? []
          : database
            .select()
            .from(encodeJobs)
            .where(inArray(encodeJobs.id, historicalJobIds))
            .all();
        const logicalJobs =
          selectionIds.length === 0 || options.encodingProfileId === undefined
            ? []
            : database
              .select()
              .from(encodeJobs)
              .where(and(
                inArray(encodeJobs.discSelectionId, selectionIds),
                eq(encodeJobs.encodingProfileId, options.encodingProfileId),
                isNull(encodeJobs.predecessorEncodeJobId),
              ))
              .orderBy(desc(encodeJobs.updatedAt), desc(encodeJobs.id))
              .all();
        const priorCompletedJobsBySelectionId = new Map<
          DiscSelectionId,
          EncodeJob
        >();
        const logicalJobsBySelectionId = new Map<DiscSelectionId, EncodeJob>();
        for (const job of historicalJobs) {
          if (!priorCompletedJobsBySelectionId.has(job.discSelectionId)) {
            priorCompletedJobsBySelectionId.set(job.discSelectionId, job);
          }
        }
        for (const job of logicalJobs) {
          if (!logicalJobsBySelectionId.has(job.discSelectionId)) {
            logicalJobsBySelectionId.set(job.discSelectionId, job);
          }
        }
        const priorProfileIds = [
          ...new Set(
            [...priorCompletedJobsBySelectionId.values()]
              .map((job) => job.encodingProfileId),
          ),
        ];
        const priorProfilesById = new Map(
          (priorProfileIds.length === 0
            ? []
            : database
              .select()
              .from(encodingProfiles)
              .where(inArray(encodingProfiles.id, priorProfileIds))
              .all())
            .map((profile) => [profile.id, profile]),
        );

        return {
          selections: selections.map((selection) => {
            const priorCompletedJob =
              priorCompletedJobsBySelectionId.get(selection.id) ?? null;
            const logicalJob =
              logicalJobsBySelectionId.get(selection.id) ?? null;
            return {
              selection,
              hasCompletedEncode: priorCompletedJob !== null,
              priorCompletedJob: priorCompletedJob === null
                ? null
                : {
                    id: priorCompletedJob.id,
                    encodingProfileId: priorCompletedJob.encodingProfileId,
                    status: "completed" as const,
                  },
              priorCompletedProfile: priorCompletedJob === null
                ? null
                : priorProfilesById.get(priorCompletedJob.encodingProfileId) ??
                  null,
              logicalJob: logicalJob === null
                ? null
                : {
                    id: logicalJob.id,
                    encodingProfileId: logicalJob.encodingProfileId,
                    outputPath: logicalJob.outputPath,
                    status: logicalJob.status,
                    queueAvailable: isEncodeJobSafelyTerminal(logicalJob),
                  },
            };
          }),
          counts,
          total: countRow?.total ?? 0,
        };
      },

      replayEnqueue(input) {
        return database.transaction((transaction) => replayEncodeMutation(transaction, input.mutationKey, "encode_job.enqueue", encodeEnqueueSemanticInput(input)), { behavior: "immediate" });
      },
      replayRequeue(id, options) {
        return database.transaction((transaction) => replayEncodeMutation(transaction, options.mutationKey, "encode_job.requeue", encodeRequeueSemanticInput(id, options)), { behavior: "immediate" });
      },
      enqueue(input, assertSourceDecision) {
        const timestamp = now();
        const outputPath = requireNonEmpty(input.outputPath, "outputPath");
        const semanticInput = encodeEnqueueSemanticInput(input);
        const previous = database.transaction(
          (transaction) => replayEncodeMutation(
            transaction,
            input.mutationKey,
            "encode_job.enqueue",
            semanticInput,
          ),
          { behavior: "immediate" },
        );
        if (previous) return previous;
        const selectReviewState = (
          querySource: Pick<typeof database, "select">,
        ) =>
          requireRow(
            querySource
              .select({
                catalogReviewedAt: originalDiscArchives.catalogReviewedAt,
                catalogReviewOutcome:
                  originalDiscArchives.catalogReviewOutcome,
                legacyCutoverPending:
                  originalDiscArchives.legacyCutoverPending,
                originalDiscArchiveId: originalDiscArchives.id,
                evidenceFormat: hasDvdRecoveryEvidenceSchema
                  ? sql<DvdArchiveEvidenceFormat | null>`coalesce(
                      (
                        select ${dvdArchiveEvidenceHeaders.evidenceFormat}
                        from ${dvdArchiveEvidenceHeaders}
                        where ${dvdArchiveEvidenceHeaders.originalDiscArchiveId} =
                          ${originalDiscArchives.id}
                        limit 1
                      ),
                      (
                        select ${archiveJobs.evidenceFormat}
                        from ${archiveJobs}
                        where ${archiveJobs.originalDiscArchiveId} =
                            ${originalDiscArchives.id}
                          and ${archiveJobs.evidenceFormat} is not null
                        order by ${archiveJobs.completedAt} desc,
                          ${archiveJobs.id} desc
                        limit 1
                      )
                    )`
                  : sql<DvdArchiveEvidenceFormat | null>`null`,
              })
              .from(discSelections)
              .innerJoin(
                originalDiscArchives,
                eq(
                  originalDiscArchives.id,
                  discSelections.originalDiscArchiveId,
                ),
              )
              .where(and(
                eq(discSelections.id, input.discSelectionId),
                eq(discSelections.isCatalogActive, true),
              ))
              .get(),
            "disc selection",
            input.discSelectionId,
          );
        const requireCompletedReview = (
          selectionReview: ReturnType<typeof selectReviewState>,
        ) => {
          if (
            selectionReview.catalogReviewOutcome !==
              "reviewed_with_selections" ||
            selectionReview.legacyCutoverPending
          ) {
            throw new DomainInvariantError(
              "Encode Jobs require a completed catalog review",
            );
          }
          return selectionReview;
        };
        const validatedArchive = assertSourceDecision === undefined ? database.transaction(
          (transaction) => {
            const selectionReview = selectReviewState(transaction);
            requireNoArchiveRecoveryWork(
              transaction,
              selectionReview.originalDiscArchiveId,
            );
            if (
              dvdRecoveryEvidenceEncodingGateClosed &&
              selectionReview.evidenceFormat !== null
            ) {
              throw new DvdRecoveryEvidenceEncodingUnavailableError();
            }
            requireCompletedReview(selectionReview);
            return requireReviewableDiscSelections(
              selectionReview.originalDiscArchiveId,
              transaction,
            );
          },
          { behavior: "deferred" },
        ) : null;
        return database.transaction(
          (transaction) => {
            const replay = replayEncodeMutation(
              transaction,
              input.mutationKey, "encode_job.enqueue", semanticInput,
            );
            if (replay) return replay;
            assertSourceDecision?.();
            const selectionReview = selectReviewState(transaction);
            requireNoArchiveRecoveryWork(
              transaction,
              selectionReview.originalDiscArchiveId,
            );
            if (
              dvdRecoveryEvidenceEncodingGateClosed &&
              selectionReview.evidenceFormat !== null
            ) {
              throw new DvdRecoveryEvidenceEncodingUnavailableError();
            }
            requireCompletedReview(selectionReview);
            const validated = validatedArchive ?? requireReviewableDiscSelections(selectionReview.originalDiscArchiveId, transaction);
            if (
              selectionReview.originalDiscArchiveId !== validated.id
            ) {
              throw new DomainInvariantError(
                "Catalog changed during validation; retry the operation",
              );
            }
            requireCurrentCatalogValidation(
              validated,
              transaction,
            );
            const existing = transaction
              .select()
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.discSelectionId, input.discSelectionId),
                  eq(encodeJobs.encodingProfileId, input.encodingProfileId),
                  isNull(encodeJobs.predecessorEncodeJobId),
                ),
              )
              .get();
            if (existing) {
              return saveEncodeMutation(
                transaction,
                input.mutationKey,
                "encode_job.enqueue",
                semanticInput,
                existing,
              );
            }
            const outputOwner = transaction
              .select({ id: encodeJobs.id })
              .from(encodeJobs)
              .where(
                and(
                  eq(encodeJobs.outputPath, outputPath),
                  eq(encodeJobs.reservesOutputPath, true),
                  or(
                    ne(encodeJobs.discSelectionId, input.discSelectionId),
                    ne(encodeJobs.encodingProfileId, input.encodingProfileId),
                    isNotNull(encodeJobs.predecessorEncodeJobId),
                  ),
                ),
              )
              .limit(1)
              .get();
            if (outputOwner) {
              throw new DomainInvariantError(
                `Encode Job output is already assigned: ${outputPath}`,
              );
            }
            const profile = requireRow(
              transaction
                .select({
                  id: encodingProfiles.id,
                  isActive: encodingProfiles.isActive,
                  mediaDomain: encodingProfiles.mediaDomain,
                  settings: encodingProfiles.settings,
                })
                .from(encodingProfiles)
                .where(eq(encodingProfiles.id, input.encodingProfileId))
                .get(),
              "encoding profile",
              input.encodingProfileId,
            );
            const profileBlockingReasons = encodingProfileQueueBlockingReasons(profile);
            if (profileBlockingReasons.length > 0) {
              throw new DomainInvariantError(
                `Encode Jobs require an active DVD video Encoding Profile with supported settings: ${profileBlockingReasons.join(", ")}`,
              );
            }
            transaction
              .insert(encodeJobs)
              .values({
                id: newId<EncodeJobId>(),
                discSelectionId: input.discSelectionId,
                encodingProfileId: input.encodingProfileId,
                expectedSourceDecision: input.expectedSourceDecision ?? null,
                outputPath,
                priority: input.priority ?? 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              })
              .onConflictDoNothing()
              .run();

            return saveEncodeMutation(
              transaction,
              input.mutationKey,
              "encode_job.enqueue",
              semanticInput,
              requireRow(
                transaction
                  .select()
                  .from(encodeJobs)
                  .where(
                    and(
                      eq(encodeJobs.discSelectionId, input.discSelectionId),
                      eq(encodeJobs.encodingProfileId, input.encodingProfileId),
                      isNull(encodeJobs.predecessorEncodeJobId),
                    ),
                  )
                  .get(),
                "encode job",
                `${input.discSelectionId}/${input.encodingProfileId}`,
              ),
            );
          },
          { behavior: "immediate" },
        );
      },

      requestCancellation(id, mutationKey) {
        const timestamp = now();
        const semanticInput = JSON.stringify({ id });
        return database.transaction(
          (transaction) => {
            const replay = replayEncodeMutation(
              transaction,
              mutationKey, "encode_job.cancel", semanticInput,
            );
            if (replay) return replay;
            return saveEncodeMutation(
              transaction,
              mutationKey, "encode_job.cancel", semanticInput,
              requestEncodeJobCancellation(transaction, id, timestamp),
            );
          },
          { behavior: "immediate" },
        );
      },

      listSourceClaimCandidates(options) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
          !Number.isSafeInteger(options.offset) || options.offset < 0) throw new DomainInvariantError("Invalid source claim candidate page");
        // No source scans or queue materialization while the core admission gate is closed.
        if (dvdRecoveryEvidenceEncodingGateClosed) return [];
        return database.select({ job: encodeJobs }).from(encodeJobs)
          .innerJoin(discSelections, eq(discSelections.id, encodeJobs.discSelectionId))
          .innerJoin(originalDiscArchives, eq(originalDiscArchives.id, discSelections.originalDiscArchiveId))
          .where(and(eq(encodeJobs.status, "queued"), eq(discSelections.isCatalogActive, true),
            eq(originalDiscArchives.catalogReviewOutcome, "reviewed_with_selections"),
            dvdRecoveryEvidenceMarkerCondition(database, originalDiscArchives.id)))
          .orderBy(desc(encodeJobs.priority), asc(encodeJobs.createdAt), asc(encodeJobs.id))
          .limit(options.limit).offset(options.offset).all().map(({ job }) => job);
      },
      claimNext: encodeJobQueue.claimNext,
      findClaimSnapshot(id) {
        return database.select().from(encodeClaimSnapshots).where(eq(encodeClaimSnapshots.id, id)).get() ?? null;
      },
      retainValidationFailedOutput(claim, input, options) {
        const failure = validateEncodeJobFailureReport(input.failure);
        if (failure.reasonCode !== "output_validation_failed" || failure.phase !== "validation" ||
          (failure.evidence.kind !== "duration" && failure.evidence.kind !== "validation_check") ||
          (failure.evidence.kind === "validation_check" && ["output_file", "subtitle_cleanup"].includes(failure.evidence.check))) {
          throw new DomainInvariantError("Only a complete media-validation failure can be retained");
        }
        const metadata = lstatSync(input.outputPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
          !matchesEncodeOutputFilesystemIdentity(input.filesystemIdentity, metadata) || metadata.ctimeMs !== input.changeTimeMs) {
          throw new DomainInvariantError("Failed Encode Output file is incomplete or changed");
        }
        return encodeJobQueue.fail(claim, "Encode output validation failed", {
          ...options, failureReports: [failure], validationFailedOutput: { ...input, failure },
        });
      },
      hasValidationFailedOutputPath(path) {
        return database.select({ id: validationFailedEncodeOutputs.id }).from(validationFailedEncodeOutputs)
          .where(eq(validationFailedEncodeOutputs.outputPath, path)).limit(1).get() !== undefined;
      },
      findValidationFailedOutput(id) {
        return database.select().from(validationFailedEncodeOutputs).where(eq(validationFailedEncodeOutputs.id, id)).get() ?? null;
      },
      listValidationFailedOutputs(id, page) {
        if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 101 ||
          !Number.isSafeInteger(page.offset ?? 0) || (page.offset ?? 0) < 0) throw new DomainInvariantError("Invalid failed output page");
        return database.select().from(validationFailedEncodeOutputs).where(eq(validationFailedEncodeOutputs.encodeJobId, id))
          .orderBy(desc(validationFailedEncodeOutputs.validatedAt), desc(validationFailedEncodeOutputs.id))
          .limit(page.limit).offset(page.offset ?? 0).all();
      },
      recordOutputValidation(claim, identity, evidence) {
        return database.transaction((transaction) => {
          const owned = transaction.select().from(encodeJobs).where(and(eq(encodeJobs.id, claim.id),
            eq(encodeJobs.status, "running"), eq(encodeJobs.claimToken, claim.claimToken))).get();
          if (!owned) throw new StaleJobAttemptError("encode output validation", claim.id);
          const snapshot = transaction.select().from(encodeClaimSnapshots)
            .where(eq(encodeClaimSnapshots.id, claim.claimToken)).get();
          if (snapshot !== undefined && (snapshot.encodeJobId !== claim.id || snapshot.source.output.path !== owned.outputPath)) {
            throw new DomainInvariantError("Encode output claim provenance is inconsistent");
          }
          const existing = transaction.select().from(encodeOutputValidations)
            .where(and(eq(encodeOutputValidations.encodeJobId, claim.id), eq(encodeOutputValidations.claimToken, claim.claimToken))).get();
          if (existing) {
            if (existing.filesystemIdentity !== identity || canonicalPublicationJson(existing.evidence) !== canonicalPublicationJson(evidence)) {
              throw new DomainInvariantError("Encode output validation is immutable");
            }
            return existing;
          }
          return transaction.insert(encodeOutputValidations).values({ id: newId<string>(), encodeJobId: claim.id,
            claimToken: claim.claimToken, filesystemIdentity: identity, validatedAt: now(),
            sourceSnapshot: snapshot === undefined ? null : JSON.parse(JSON.stringify(snapshot)), evidence,
          }).returning().get()!;
        }, { behavior: "immediate" });
      },
      findOutputValidation(jobId, identity, validatedAt) {
        return database.select().from(encodeOutputValidations).where(and(eq(encodeOutputValidations.encodeJobId, jobId),
          eq(encodeOutputValidations.filesystemIdentity, identity), eq(encodeOutputValidations.validatedAt, validatedAt))).get() ?? null;
      },
      listClaimSnapshots(id, options = { limit: 20, offset: 0 }) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 101 ||
          !Number.isSafeInteger(options.offset) || options.offset < 0) throw new DomainInvariantError("Invalid claim snapshot page");
        return database.select().from(encodeClaimSnapshots).where(eq(encodeClaimSnapshots.encodeJobId, id))
          .orderBy(desc(encodeClaimSnapshots.createdAt), desc(encodeClaimSnapshots.id))
          .limit(options.limit).offset(options.offset).all();
      },
      listDiscSelectionCorrectionEncodeJobLinks(options) {
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > DISC_SELECTION_CORRECTION_ENCODE_JOB_LINK_LIMIT
        ) {
          throw new DomainInvariantError(
            `Disc Selection correction Encode Job history limit must be a safe integer between 1 and ${DISC_SELECTION_CORRECTION_ENCODE_JOB_LINK_LIMIT}`,
          );
        }
        const query = database
          .select({
            replacementDiscSelectionId: sql<DiscSelectionId>`coalesce(
              ${replacementEncodeJobRecords.discSelectionId},
              ${discSelectionSupersessions.replacementDiscSelectionId}
            )`,
            predecessorEncodeJobId: predecessorEncodeJobRecords.id,
            predecessorEncodeJobStatus: predecessorEncodeJobRecords.status,
            replacementEncodeJobId: replacementEncodeJobRecords.id,
            replacementEncodeJobStatus: replacementEncodeJobRecords.status,
          })
          .from(predecessorEncodeJobRecords)
          .innerJoin(
            supersededDiscSelectionRecords,
            eq(
              supersededDiscSelectionRecords.id,
              predecessorEncodeJobRecords.discSelectionId,
            ),
          )
          .innerJoin(
            discSelectionSupersessions,
            eq(
              discSelectionSupersessions.supersededDiscSelectionId,
              supersededDiscSelectionRecords.id,
            ),
          )
          .innerJoin(
            discSelections,
            eq(
              discSelectionSupersessions.replacementDiscSelectionId,
              discSelections.id,
            ),
          )
          .leftJoin(
            replacementEncodeJobRecords,
            eq(
              replacementEncodeJobRecords.predecessorEncodeJobId,
              predecessorEncodeJobRecords.id,
            ),
          )
          .where(eq(
            discSelections.originalDiscArchiveId,
            options.originalDiscArchiveId,
          ))
          .orderBy(
            asc(predecessorEncodeJobRecords.createdAt),
            asc(predecessorEncodeJobRecords.id),
          );
        const rows = listWithBoundedOffset(
          query,
          options,
          "Disc Selection correction Encode Job history",
        );
        return rows.map((row): DiscSelectionCorrectionEncodeJobLink => {
          let replacementEncodeJob:
            DiscSelectionCorrectionEncodeJobLink["replacementEncodeJob"] =
              null;
          if (row.replacementEncodeJobId !== null) {
            if (row.replacementEncodeJobStatus === null) {
              throw new DomainInvariantError(
                "Correction replacement Encode Job is missing its status",
              );
            }
            replacementEncodeJob = {
              id: row.replacementEncodeJobId,
              status: row.replacementEncodeJobStatus,
            };
          }
          return {
            replacementDiscSelectionId: row.replacementDiscSelectionId,
            predecessorEncodeJob: {
              id: row.predecessorEncodeJobId,
              status: row.predecessorEncodeJobStatus,
            },
            replacementEncodeJob,
          };
        });
      },
      listDiscSelectionCorrectionRetainedOutputSummaries(options) {
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit >
            DISC_SELECTION_CORRECTION_RETAINED_OUTPUT_SUMMARY_LIMIT
        ) {
          throw new DomainInvariantError(
            `Disc Selection correction Retained Encode output history limit must be a safe integer between 1 and ${DISC_SELECTION_CORRECTION_RETAINED_OUTPUT_SUMMARY_LIMIT}`,
          );
        }
        const query = database
          .select({
            replacementDiscSelectionId: discSelections.id,
            id: retainedEncodeOutputs.id,
            predecessorEncodeJobId:
              retainedEncodeOutputs.predecessorEncodeJobId,
            replacementEncodeJobId:
              retainedEncodeOutputs.replacementEncodeJobId,
            sourceEncodeJobId: retainedEncodeOutputs.sourceEncodeJobId,
            state: retainedEncodeOutputs.state,
            cleanupEligible: retainedEncodeOutputs.cleanupEligible,
            retainedAt: retainedEncodeOutputs.retainedAt,
            validationResult: retainedEncodeOutputs.validationResult,
            validatedAt: retainedEncodeOutputs.validatedAt,
            completeness: retainedEncodeOutputs.completeness,
          })
          .from(retainedEncodeOutputs)
          .innerJoin(
            encodeJobs,
            eq(encodeJobs.id, retainedEncodeOutputs.replacementEncodeJobId),
          )
          .innerJoin(
            discSelections,
            eq(discSelections.id, encodeJobs.discSelectionId),
          )
          .innerJoin(
            discSelectionSupersessions,
            eq(
              discSelectionSupersessions.replacementDiscSelectionId,
              discSelections.id,
            ),
          )
          .where(eq(
            discSelections.originalDiscArchiveId,
            options.originalDiscArchiveId,
          ))
          .orderBy(
            asc(retainedEncodeOutputs.retainedAt),
            asc(retainedEncodeOutputs.id),
          );
        return listWithBoundedOffset(
          query,
          options,
          "Disc Selection correction Retained Encode output history",
        ).map((row): DiscSelectionCorrectionRetainedOutputSummary => ({
          replacementDiscSelectionId: row.replacementDiscSelectionId,
          retainedOutput: {
            id: row.id,
            predecessorEncodeJobId: row.predecessorEncodeJobId,
            replacementEncodeJobId: row.replacementEncodeJobId,
            sourceEncodeJobId: row.sourceEncodeJobId,
            state: row.state,
            cleanupEligible: row.cleanupEligible,
            retainedAt: row.retainedAt,
            validationResult: row.validationResult,
            validatedAt: row.validatedAt,
            completeness: row.completeness,
          },
        }));
      },
      listCorrectionLinks(ids) {
        if (ids.length === 0) return [];
        if (ids.length > 400) {
          throw new DomainInvariantError(
            "Encode Job correction-link lookup is limited to 400 records",
          );
        }
        const uniqueIds = [...new Set(ids)];
        const displayedPredecessors = database
          .select({ id: encodeJobs.predecessorEncodeJobId })
          .from(encodeJobs)
          .where(inArray(encodeJobs.id, uniqueIds));
        return database
          .select()
          .from(encodeJobs)
          .where(or(
            inArray(encodeJobs.id, uniqueIds),
            inArray(encodeJobs.predecessorEncodeJobId, uniqueIds),
            inArray(encodeJobs.id, displayedPredecessors),
          ))
          .orderBy(asc(encodeJobs.createdAt), asc(encodeJobs.id))
          .all();
      },
      findRetainedOutput(id) {
        return database
          .select()
          .from(retainedEncodeOutputs)
          .where(eq(retainedEncodeOutputs.id, id))
          .get() ?? null;
      },
      listRetainedOutputs(ids) {
        if (ids.length === 0) return [];
        const uniqueIds = retainedEncodeOutputLookupIds(ids);
        return database
          .select()
          .from(retainedEncodeOutputs)
          .where(or(
            inArray(retainedEncodeOutputs.predecessorEncodeJobId, uniqueIds),
            inArray(retainedEncodeOutputs.replacementEncodeJobId, uniqueIds),
          ))
          .orderBy(
            asc(retainedEncodeOutputs.retainedAt),
            asc(retainedEncodeOutputs.id),
          )
          .all();
      },
      listRetainedOutputSummaries(ids, options) {
        if (ids.length === 0) return [];
        const uniqueIds = retainedEncodeOutputLookupIds(ids);
        const selection = {
          id: retainedEncodeOutputs.id,
          predecessorEncodeJobId:
            retainedEncodeOutputs.predecessorEncodeJobId,
          replacementEncodeJobId:
            retainedEncodeOutputs.replacementEncodeJobId,
          sourceEncodeJobId: retainedEncodeOutputs.sourceEncodeJobId,
          state: retainedEncodeOutputs.state,
          cleanupEligible: retainedEncodeOutputs.cleanupEligible,
          retainedAt: retainedEncodeOutputs.retainedAt,
          validationResult: retainedEncodeOutputs.validationResult,
          validatedAt: retainedEncodeOutputs.validatedAt,
          completeness: retainedEncodeOutputs.completeness,
        };
        const condition = or(
          inArray(retainedEncodeOutputs.predecessorEncodeJobId, uniqueIds),
          inArray(retainedEncodeOutputs.replacementEncodeJobId, uniqueIds),
        );
        if (options !== undefined) {
          return database
            .select(selection)
            .from(retainedEncodeOutputs)
            .where(condition)
            .orderBy(
              desc(retainedEncodeOutputs.retainedAt),
              desc(retainedEncodeOutputs.id),
            )
            .limit(requirePositiveSafeInteger(options.limit, "limit"))
            .all()
            .reverse();
        }
        return database
          .select(selection)
          .from(retainedEncodeOutputs)
          .where(condition)
          .orderBy(
            asc(retainedEncodeOutputs.retainedAt),
            asc(retainedEncodeOutputs.id),
          )
          .all();
      },
      listRetainedOutputSummaryPageBySource(ids, options) {
        if (ids.length === 0) {
          return { outputs: [], truncatedSourceEncodeJobIds: [] };
        }
        const uniqueIds = retainedEncodeOutputLookupIds(ids);
        const limit = requirePositiveSafeInteger(options.limit, "limit");
        if (limit > RETAINED_ENCODE_OUTPUT_PAGE_LIMIT) {
          throw new DomainInvariantError(
            `Retained Encode output source page limit must be between 1 and ${RETAINED_ENCODE_OUTPUT_PAGE_LIMIT}`,
          );
        }
        const rows = sqlite.prepare(`
          with ranked_outputs as (
            select
              id,
              predecessor_encode_job_id,
              replacement_encode_job_id,
              source_encode_job_id,
              state,
              cleanup_eligible,
              retained_at,
              validation_result,
              validated_at,
              completeness,
              row_number() over (
                partition by source_encode_job_id
                order by retained_at desc, rowid desc
              ) as source_rank
            from retained_encode_outputs
            where source_encode_job_id in (
              ${uniqueIds.map(() => "?").join(", ")}
            )
          )
          select *
          from ranked_outputs
          where source_rank <= ?
          order by retained_at asc, id asc
        `).all(...uniqueIds, limit + 1) as unknown as Array<{
          id: RetainedEncodeOutputId;
          predecessor_encode_job_id: EncodeJobId;
          replacement_encode_job_id: EncodeJobId;
          source_encode_job_id: EncodeJobId;
          state: "retained";
          cleanup_eligible: number;
          retained_at: number;
          validation_result: "passed" | null;
          validated_at: number | null;
          completeness: "complete" | null;
          source_rank: number;
        }>;
        const truncatedSourceEncodeJobIds = [...new Set(
          rows
            .filter(({ source_rank }) => source_rank > limit)
            .map(({ source_encode_job_id }) => source_encode_job_id),
        )];
        return {
          outputs: rows
            .filter(({ source_rank }) => source_rank <= limit)
            .map((row) => ({
              id: row.id,
              predecessorEncodeJobId: row.predecessor_encode_job_id,
              replacementEncodeJobId: row.replacement_encode_job_id,
              sourceEncodeJobId: row.source_encode_job_id,
              state: row.state,
              cleanupEligible: row.cleanup_eligible === 1,
              retainedAt: new Date(row.retained_at),
              validationResult: row.validation_result,
              validatedAt: row.validated_at === null
                ? null
                : new Date(row.validated_at),
              completeness: row.completeness,
            })),
          truncatedSourceEncodeJobIds,
        };
      },
      listRetainedOutputHistoryPage(sourceEncodeJobId, options) {
        const limit = requirePositiveSafeInteger(options.limit, "limit");
        if (limit > RETAINED_ENCODE_OUTPUT_PAGE_LIMIT) {
          throw new DomainInvariantError(
            `Retained Encode output history page limit must be between 1 and ${RETAINED_ENCODE_OUTPUT_PAGE_LIMIT}`,
          );
        }
        const offset = options.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new DomainInvariantError(
            "Retained Encode output history offset must be a non-negative safe integer",
          );
        }
        const rows = database
          .select({
            id: retainedEncodeOutputs.id,
            predecessorEncodeJobId:
              retainedEncodeOutputs.predecessorEncodeJobId,
            replacementEncodeJobId:
              retainedEncodeOutputs.replacementEncodeJobId,
            sourceEncodeJobId: retainedEncodeOutputs.sourceEncodeJobId,
            state: retainedEncodeOutputs.state,
            cleanupEligible: retainedEncodeOutputs.cleanupEligible,
            retainedAt: retainedEncodeOutputs.retainedAt,
            validationResult: retainedEncodeOutputs.validationResult,
            validatedAt: retainedEncodeOutputs.validatedAt,
            completeness: retainedEncodeOutputs.completeness,
          })
          .from(retainedEncodeOutputs)
          .where(eq(
            retainedEncodeOutputs.sourceEncodeJobId,
            sourceEncodeJobId,
          ))
          .orderBy(
            asc(retainedEncodeOutputs.retainedAt),
            asc(retainedEncodeOutputs.id),
          )
          .limit(limit + 1)
          .offset(offset)
          .all();
        return {
          outputs: rows.slice(0, limit),
          nextOffset: rows.length > limit ? offset + limit : null,
        };
      },
      renewClaim(claim) {
        const timestamp = now();
        const renewed = database
          .update(encodeJobs)
          .set({ updatedAt: timestamp })
          .where(and(
            eq(encodeJobs.id, claim.id),
            inArray(encodeJobs.status, [
              "running",
              "cancellation_requested",
            ]),
            eq(encodeJobs.claimToken, claim.claimToken),
            gt(
              encodeJobs.updatedAt,
              new Date(
                timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
              ),
            ),
          ))
          .returning()
          .get();
        if (!renewed) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return asClaimedEncodeJob(renewed);
      },
      completeCancellation(claim) {
        return completeEncodeCancellation(claim);
      },
      completeCancellationWithReports(claim, cleanup, reportInputs) {
        if (reportInputs.length === 0 || reportInputs.length > 10) {
          throw new DomainInvariantError(
            "Encode Job cancellation cleanup must include between one and ten reports",
          );
        }
        const reports = reportInputs.map(validateEncodeJobFailureReport);
        if (reports.some(({ reasonCode }) => reasonCode !== "cleanup_failed")) {
          throw new DomainInvariantError(
            "Encode Job cancellation cleanup report reason is invalid",
          );
        }
        return completeEncodeCancellation(
          claim,
          reports,
          cleanup ?? undefined,
        );
      },
      beginPublicationMutation(claim, cleanup, retainedOutputPath) {
        if (!cleanup.publicationPending || cleanup.leaseToken !== null) {
          throw new DomainInvariantError(
            "Encode Job publication mutation requires unfenced provenance",
          );
        }
        const normalizedRetainedOutputPath = retainedOutputPath === undefined
          ? undefined
          : requireNonEmpty(retainedOutputPath, "retainedOutputPath");
        if (
          normalizedRetainedOutputPath !== undefined &&
          resolve(normalizedRetainedOutputPath) !==
            normalizedRetainedOutputPath
        ) {
          throw new DomainInvariantError(
            "Retained Encode output path is not claim scoped",
          );
        }
        const persistedAttempt = normalizedRetainedOutputPath === undefined
          ? undefined
          : database
            .select({
              claimToken: encodeJobs.claimToken,
              outputPath: encodeJobs.outputPath,
            })
            .from(encodeJobs)
            .where(and(
              eq(encodeJobs.id, claim.id),
              eq(encodeJobs.claimToken, claim.claimToken),
            ))
            .get();
        if (persistedAttempt && normalizedRetainedOutputPath !== undefined) {
          const resolvedOutputPath = resolve(persistedAttempt.outputPath);
          const logicalOutputDirectory = dirname(resolvedOutputPath);
          let canonicalOutputDirectory: string;
          try {
            canonicalOutputDirectory = realpathSync(logicalOutputDirectory);
          } catch {
            throw new DomainInvariantError(
              "Encode Job output directory is unavailable",
            );
          }
          if (!statSync(canonicalOutputDirectory).isDirectory()) {
            throw new DomainInvariantError(
              "Encode Job output directory is unavailable",
            );
          }
          const expectedRetainedOutputPath = join(
            canonicalOutputDirectory,
            `${basename(resolvedOutputPath)}.failed.${persistedAttempt.claimToken}`,
          );
          if (normalizedRetainedOutputPath !== expectedRetainedOutputPath) {
            throw new DomainInvariantError(
              "Retained Encode output path does not match the Encode Job output",
            );
          }
        }
        const timestamp = now();
        const leaseToken = newId<EncodeJobCleanupClaimToken>();
        return database.transaction((transaction) => {
          const renewed = transaction
            .update(encodeJobs)
            .set({
              partialCleanupLeaseToken: leaseToken,
              updatedAt: timestamp,
            })
            .where(and(
              encodeAttemptCondition(claim, timestamp),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(encodeJobs.publicationPending, true),
              isNull(encodeJobs.partialCleanupLeaseToken),
            ))
            .returning()
            .get();
          if (!renewed) {
            throw new StaleJobAttemptError("encode job", claim.id);
          }
          if (renewed.predecessorEncodeJobId === null) {
            if (normalizedRetainedOutputPath !== undefined) {
              throw new DomainInvariantError(
                "Only corrected Encode Jobs can stage retained output paths",
              );
            }
          } else if (renewed.replacementOutputIdentity === null) {
            if (normalizedRetainedOutputPath !== undefined) {
              throw new DomainInvariantError(
                "Corrected publication without a prior final cannot stage retained output authority",
              );
            }
          } else {
            if (normalizedRetainedOutputPath === undefined) {
              throw new DomainInvariantError(
                "Corrected publication mutation requires retained output authority",
              );
            }
            transaction
              .insert(correctedEncodePublicationAuthorities)
              .values({
                replacementEncodeJobId: renewed.id,
                claimToken: claim.claimToken,
                retainedOutputPath: normalizedRetainedOutputPath,
                filesystemIdentity: renewed.replacementOutputIdentity,
              })
              .onConflictDoUpdate({
                target:
                  correctedEncodePublicationAuthorities.replacementEncodeJobId,
                set: {
                  claimToken: claim.claimToken,
                  retainedOutputPath: normalizedRetainedOutputPath,
                  filesystemIdentity: renewed.replacementOutputIdentity,
                },
              })
              .run();
          }
          return { ...cleanup, leaseToken };
        }, { behavior: "immediate" });
      },
      listPublicationMutations() {
        return database
          .select({
            jobId: encodeJobs.id,
            outputPath: encodeJobs.partialCleanupOutputPath,
            claimToken: encodeJobs.partialCleanupClaimToken,
            leaseToken: encodeJobs.partialCleanupLeaseToken,
            publicationPending: encodeJobs.publicationPending,
          })
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.status, "running"),
            isNotNull(encodeJobs.partialCleanupOutputPath),
            isNotNull(encodeJobs.partialCleanupClaimToken),
            isNotNull(encodeJobs.partialCleanupLeaseToken),
          ))
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map((cleanup): EncodeJobPartialCleanup => {
            if (
              cleanup.outputPath === null ||
              cleanup.claimToken === null ||
              cleanup.leaseToken === null
            ) {
              throw new DomainInvariantError(
                "Encode Job publication mutation provenance is incomplete",
              );
            }
            return {
              jobId: cleanup.jobId,
              outputPath: cleanup.outputPath,
              claimToken: cleanup.claimToken,
              leaseToken: cleanup.leaseToken,
              publicationPending: cleanup.publicationPending,
            };
          });
      },
      listExpiredPublicationMutations() {
        const expiredBefore = new Date(
          now().getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        return database
          .select({
            jobId: encodeJobs.id,
            outputPath: encodeJobs.partialCleanupOutputPath,
            claimToken: encodeJobs.partialCleanupClaimToken,
            leaseToken: encodeJobs.partialCleanupLeaseToken,
            publicationPending: encodeJobs.publicationPending,
          })
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.status, "running"),
            isNotNull(encodeJobs.partialCleanupOutputPath),
            isNotNull(encodeJobs.partialCleanupClaimToken),
            isNotNull(encodeJobs.partialCleanupLeaseToken),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map((cleanup): EncodeJobPartialCleanup => {
            if (
              cleanup.outputPath === null ||
              cleanup.claimToken === null ||
              cleanup.leaseToken === null
            ) {
              throw new DomainInvariantError(
                "Encode Job publication mutation provenance is incomplete",
              );
            }
            return {
              jobId: cleanup.jobId,
              outputPath: cleanup.outputPath,
              claimToken: cleanup.claimToken,
              leaseToken: cleanup.leaseToken,
              publicationPending: cleanup.publicationPending,
            };
          });
      },
      completePublishedMutation(cleanup, publicationMatches, provenance) {
        if (!cleanup.publicationPending || cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job publication mutation completion requires fenced provenance",
          );
        }
        const matches = publicationMatches();
        if (!matches) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        const timestamp = now();
        const updated = database
          .update(encodeJobs)
          .set({
            status: "completed",
            publicationCompletionPending: true,
            progressPercent: 100,
            progressEtaSeconds: null,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(and(
            eq(encodeJobs.id, cleanup.jobId),
            eq(encodeJobs.status, "running"),
            eq(encodeJobs.publicationPending, true),
            eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
            eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
            eq(encodeJobs.partialCleanupLeaseToken, cleanup.leaseToken),
          ))
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        const completionCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          eq(encodeJobs.status, "completed"),
          eq(encodeJobs.publicationCompletionPending, true),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          eq(encodeJobs.partialCleanupLeaseToken, cleanup.leaseToken),
        );
        if (!publicationMatches()) {
          const invalidated = database
            .update(encodeJobs)
            .set({
              status: "running",
              publicationCompletionPending: false,
              completedAt: completedAtAfterInterruptedPublication(),
              updatedAt: now(),
            })
            .where(completionCondition)
            .returning()
            .get();
          if (!invalidated) {
            throw new StaleJobAttemptError(
              "encode job publication mutation",
              cleanup.jobId,
            );
          }
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        const finalized = database.transaction((transaction) => {
          return finalizePublishedEncodeJob(
            transaction,
            completionCondition,
            provenance,
            "encode job publication mutation",
            cleanup.jobId,
          );
        }, { behavior: "immediate" });
        if (!finalized) {
          throw new StaleJobAttemptError(
            "encode job publication mutation",
            cleanup.jobId,
          );
        }
        return finalized;
      },
      recoverExpiredPublicationMutation(cleanup, recoveryFailureReportInput) {
        if (cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job publication mutation recovery requires fenced provenance",
          );
        }
        const leaseToken = cleanup.leaseToken;
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const report = validateEncodeJobFailureReport({
          schemaVersion: 1,
          reasonCode: "lease_expired",
          phase: cleanup.publicationPending ? "publication" : "cleanup",
          retryability: "after_action",
          diagnostic: "Encode publication cleanup lease expired",
          evidence: { kind: "lease", scope: "publication_cleanup" },
        });
        const recoveryFailureReport = recoveryFailureReportInput === undefined
          ? undefined
          : validateEncodeJobFailureReport(recoveryFailureReportInput);
        if (
          recoveryFailureReport !== undefined &&
          (recoveryFailureReport.reasonCode !==
              "publication_recovery_failed" ||
            recoveryFailureReport.evidence.kind !== "recovery" ||
            recoveryFailureReport.evidence.operation !==
              (cleanup.publicationPending
                ? "publication_recovery"
                : "cleanup_recovery"))
        ) {
          throw new DomainInvariantError(
            "Expired Encode publication recovery report reason is invalid",
          );
        }
        return database.transaction((transaction) => {
          const updated = transaction
            .update(encodeJobs)
            .set({
              status: "failed",
              partialCleanupLeaseToken: null,
              errorMessage: "Encode publication mutation was abandoned",
              updatedAt: timestamp,
            })
            .where(and(
              eq(encodeJobs.id, cleanup.jobId),
              eq(encodeJobs.status, "running"),
              eq(
                encodeJobs.publicationPending,
                cleanup.publicationPending,
              ),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
              lte(encodeJobs.updatedAt, expiredBefore),
            ))
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job publication mutation",
              cleanup.jobId,
            );
          }
          appendEncodeJobFailureReports(
            transaction,
            updated.id,
            [
              report,
              ...(recoveryFailureReport === undefined
                ? []
                : [recoveryFailureReport]),
            ],
            timestamp,
          );
          return updated;
        }, { behavior: "immediate" });
      },
      recordExpiredPublicationRecoveryFailure(cleanup, reportInput) {
        if (cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job expired publication recovery report requires fenced provenance",
          );
        }
        const leaseToken = cleanup.leaseToken;
        const report = validateEncodeJobFailureReport(reportInput);
        if (
          report.reasonCode !== "publication_recovery_failed" ||
          report.evidence.kind !== "recovery" ||
          report.evidence.operation !==
            (cleanup.publicationPending
              ? "publication_recovery"
              : "cleanup_recovery")
        ) {
          throw new DomainInvariantError(
            "Expired Encode publication recovery report reason is invalid",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        database.transaction((transaction) => {
          const owned = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(and(
              eq(encodeJobs.id, cleanup.jobId),
              eq(encodeJobs.status, "running"),
              eq(
                encodeJobs.publicationPending,
                cleanup.publicationPending,
              ),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(
                encodeJobs.partialCleanupLeaseToken,
                leaseToken,
              ),
              lte(encodeJobs.updatedAt, expiredBefore),
            ))
            .get();
          if (!owned) {
            throw new StaleJobAttemptError(
              "encode job publication mutation",
              cleanup.jobId,
            );
          }
          const latestReport = transaction
            .select()
            .from(encodeJobFailureReports)
            .where(eq(encodeJobFailureReports.encodeJobId, owned.id))
            .orderBy(desc(encodeJobFailureReports.sequence))
            .limit(1)
            .get();
          if (
            latestReport !== undefined &&
            matchesLatestPublicationRecoveryFailure(latestReport, report)
          ) {
            return;
          }
          appendEncodeJobFailureReports(
            transaction,
            owned.id,
            [report],
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      listExpiredCancellationClaims() {
        const expiredBefore = new Date(
          now().getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        return database
          .select()
          .from(encodeJobs)
          .where(and(
            eq(encodeJobs.status, "cancellation_requested"),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map(asClaimedEncodeJob);
      },
      completeExpiredCancellation(claim, processInactive) {
        processInactive();
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const recovered = database
          .update(encodeJobs)
          .set({
            status: "cancelled",
            reservesOutputPath: sql`case when exists (
              select 1 from encode_jobs as corrected_replacement
              where corrected_replacement.predecessor_encode_job_id = ${claim.id}
                and corrected_replacement.output_path = ${claim.outputPath}
                and corrected_replacement.reserves_output_path = 1
            ) then 0 else ${claim.replaceExistingOutput ? 1 : 0} end`,
            partialCleanupOutputPath: claim.outputPath,
            partialCleanupClaimToken: claim.claimToken,
            partialCleanupLeaseToken: null,
            publicationPending: false,
            publicationCompletionPending: false,
            progressEtaSeconds: null,
            claimedBy: null,
            claimToken: null,
            claimedAt: null,
            completedAt: claim.completedAt,
            errorMessage: null,
            updatedAt: timestamp,
          })
          .where(and(
            eq(encodeJobs.id, claim.id),
            eq(encodeJobs.status, "cancellation_requested"),
            eq(encodeJobs.claimToken, claim.claimToken),
            lte(encodeJobs.updatedAt, expiredBefore),
          ))
          .returning()
          .get();
        if (!recovered) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return recovered;
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        return database.transaction((transaction) => {
          const expiredIds = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(
              and(
                eq(encodeJobs.status, "running"),
                isNull(encodeJobs.partialCleanupLeaseToken),
                lte(encodeJobs.updatedAt, expiredBefore),
              ),
            )
            .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
            .limit(JOB_RECOVERY_LIMIT)
            .all()
            .map(({ id }) => id);
          if (expiredIds.length === 0) {
            return [];
          }
          const recovered = transaction
            .update(encodeJobs)
            .set({
              status: "failed",
              progressEtaSeconds: null,
              partialCleanupOutputPath: sql`${encodeJobs.outputPath}`,
              partialCleanupClaimToken: sql`${encodeJobs.claimToken}`,
              partialCleanupLeaseToken: null,
              errorMessage: "Encode worker lease expired",
              updatedAt: timestamp,
            })
            .where(
              and(
                inArray(encodeJobs.id, expiredIds),
                eq(encodeJobs.status, "running"),
                isNull(encodeJobs.partialCleanupLeaseToken),
                lte(encodeJobs.updatedAt, expiredBefore),
              ),
            )
            .returning()
            .all();
          for (const job of recovered) {
            const phase = job.publicationPending
              ? "publication" as const
              : job.progressPhase ?? "preparation";
            appendEncodeJobFailureReports(
              transaction,
              job.id,
              [validateEncodeJobFailureReport({
                schemaVersion: 1,
                reasonCode: "lease_expired",
                phase,
                retryability: "after_action",
                diagnostic: "Encode Job claim lease expired",
                evidence: { kind: "lease", scope: "job_claim" },
              })],
              timestamp,
            );
          }
          return recovered;
        }, { behavior: "immediate" });
      },
      recordReplacementOutputIdentity(claim, identity) {
        const timestamp = now();
        requireNonEmpty(identity, "replacementOutputIdentity");
        const updated = database
          .update(encodeJobs)
          .set({
            replacementOutputIdentity: identity,
            updatedAt: timestamp,
          })
          .where(
            and(
              encodeAttemptCondition(claim, timestamp),
              eq(encodeJobs.replaceExistingOutput, true),
              or(
                isNull(encodeJobs.replacementOutputIdentity),
                eq(
                  encodeJobs.replacementOutputIdentity,
                  identity,
                ),
              ),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return asRunningEncodeJob(updated);
      },
      registerPartialCleanup(claim, options) {
        const timestamp = now();
        const publicationPending = options?.publicationPending === true;
        const updated = database
          .update(encodeJobs)
          .set({
            partialCleanupOutputPath: claim.outputPath,
            partialCleanupClaimToken: claim.claimToken,
            partialCleanupLeaseToken: null,
            publicationPending,
            updatedAt: timestamp,
          })
          .where(encodeAttemptCondition(claim, timestamp))
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError("encode job", claim.id);
        }
        return {
          jobId: updated.id,
          outputPath: claim.outputPath,
          claimToken: claim.claimToken,
          leaseToken: null,
          publicationPending,
        };
      },
      revokePublication(claim, cleanup) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const updated = database
          .update(encodeJobs)
          .set({ publicationPending: false, updatedAt: timestamp })
          .where(
            and(
              eq(encodeJobs.id, claim.id),
              inArray(encodeJobs.status, [
                "running",
                "cancellation_requested",
              ]),
              eq(encodeJobs.claimToken, claim.claimToken),
              gt(encodeJobs.updatedAt, expiredBefore),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              cleanup.leaseToken === null
                ? isNull(encodeJobs.partialCleanupLeaseToken)
                : eq(
                    encodeJobs.partialCleanupLeaseToken,
                    cleanup.leaseToken,
                  ),
              eq(encodeJobs.publicationPending, true),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return { ...cleanup, publicationPending: false };
      },
      listPendingPartialCleanups() {
        return database
          .select({
            jobId: encodeJobs.id,
            outputPath: encodeJobs.partialCleanupOutputPath,
            claimToken: encodeJobs.partialCleanupClaimToken,
            leaseToken: encodeJobs.partialCleanupLeaseToken,
            publicationPending: encodeJobs.publicationPending,
          })
          .from(encodeJobs)
          .where(
            and(
              inArray(encodeJobs.status, [
                "failed",
                "completed",
                "cancelled",
              ]),
              isNotNull(encodeJobs.partialCleanupOutputPath),
              isNotNull(encodeJobs.partialCleanupClaimToken),
            ),
          )
          .orderBy(asc(encodeJobs.updatedAt), asc(encodeJobs.id))
          .limit(JOB_RECOVERY_LIMIT)
          .all()
          .map((cleanup): EncodeJobPartialCleanup => {
            if (cleanup.outputPath === null || cleanup.claimToken === null) {
              throw new DomainInvariantError(
                "Encode Job partial cleanup provenance is incomplete",
              );
            }
            return {
              jobId: cleanup.jobId,
              outputPath: cleanup.outputPath,
              claimToken: cleanup.claimToken,
              leaseToken: cleanup.leaseToken,
              publicationPending: cleanup.publicationPending,
            };
          });
      },
      claimPartialCleanup(cleanup) {
        if (cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job publication cleanup cannot be claimed for rollback",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const leaseToken = newId<EncodeJobCleanupClaimToken>();
        const updated = database
          .update(encodeJobs)
          .set({
            partialCleanupLeaseToken: leaseToken,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(encodeJobs.id, cleanup.jobId),
              inArray(encodeJobs.status, [
                "failed",
                "completed",
                "cancelled",
              ]),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(encodeJobs.publicationPending, false),
              or(
                isNull(encodeJobs.partialCleanupLeaseToken),
                lte(encodeJobs.updatedAt, expiredBefore),
              ),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job cleanup",
            cleanup.jobId,
          );
        }
        return { ...cleanup, leaseToken };
      },
      renewPartialCleanup(cleanup) {
        if (cleanup.leaseToken === null) {
          throw new DomainInvariantError(
            "Encode Job cleanup renewal requires a cleanup lease",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const updated = database
          .update(encodeJobs)
          .set({ updatedAt: timestamp })
          .where(
            and(
              eq(encodeJobs.id, cleanup.jobId),
              inArray(encodeJobs.status, [
                "failed",
                "completed",
                "cancelled",
              ]),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(
                encodeJobs.partialCleanupLeaseToken,
                cleanup.leaseToken,
              ),
              eq(encodeJobs.publicationPending, false),
              gt(encodeJobs.updatedAt, expiredBefore),
            ),
          )
          .returning()
          .get();
        if (!updated) {
          throw new StaleJobAttemptError(
            "encode job cleanup",
            cleanup.jobId,
          );
        }
        return cleanup;
      },
      withPartialCleanupMutationFence(cleanup, mutation) {
        if (cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job publication cleanup cannot be claimed for rollback",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        const leaseToken = newId<EncodeJobCleanupClaimToken>();
        const authorizedCleanup = database.transaction((transaction) => {
          const updated = transaction
            .update(encodeJobs)
            .set({
              partialCleanupLeaseToken: leaseToken,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(encodeJobs.id, cleanup.jobId),
                inArray(encodeJobs.status, [
                  "failed",
                  "completed",
                  "cancelled",
                ]),
                eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
                eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
                eq(encodeJobs.publicationPending, false),
                or(
                  isNull(encodeJobs.partialCleanupLeaseToken),
                  lte(encodeJobs.updatedAt, expiredBefore),
                ),
              ),
            )
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job cleanup",
              cleanup.jobId,
            );
          }
          return { ...cleanup, leaseToken };
        }, { behavior: "immediate" });
        mutation();
        return authorizedCleanup;
      },
      renewPublishedPartial(cleanup, publicationMatches) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const leaseToken =
          cleanup.leaseToken ?? newId<EncodeJobCleanupClaimToken>();
        const publicationCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          inArray(encodeJobs.status, ["failed", "completed"]),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
        );
        const owned = database
          .update(encodeJobs)
          .set({
            partialCleanupLeaseToken: leaseToken,
            updatedAt: timestamp,
          })
          .where(publicationCondition)
          .returning()
          .get();
        if (!owned) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const matches = publicationMatches();
        if (!matches) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return { ...cleanup, leaseToken };
      },
      completePublishedPartial(cleanup, publicationMatches, provenance) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const leaseToken =
          cleanup.leaseToken ?? newId<EncodeJobCleanupClaimToken>();
        const publicationCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          inArray(encodeJobs.status, ["failed", "completed"]),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
        );
        const owned = database
          .update(encodeJobs)
          .set({
            partialCleanupLeaseToken: leaseToken,
            updatedAt: timestamp,
          })
          .where(publicationCondition)
          .returning()
          .get();
        if (!owned) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const matches = publicationMatches();
        database.transaction((transaction) => {
          if (!matches) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          const fencedPublicationCondition = and(
            eq(encodeJobs.id, cleanup.jobId),
            inArray(encodeJobs.status, ["failed", "completed"]),
            eq(encodeJobs.publicationPending, true),
            eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
            eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
            eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
          );
          const updated = transaction
            .update(encodeJobs)
            .set({
              status: "completed",
              publicationCompletionPending: true,
              progressPercent: 100,
              progressEtaSeconds: null,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(fencedPublicationCondition)
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          return updated;
        }, { behavior: "immediate" });
        const completionCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          eq(encodeJobs.status, "completed"),
          eq(encodeJobs.publicationCompletionPending, true),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          eq(encodeJobs.partialCleanupLeaseToken, leaseToken),
        );
        const replayedCompletion =
          owned.status === "completed" &&
            !owned.publicationCompletionPending
            ? {
              completedAt: owned.completedAt,
              outputValidationResult: owned.outputValidationResult,
              outputValidationFilesystemIdentity:
                owned.outputValidationFilesystemIdentity,
              outputValidatedAt: owned.outputValidatedAt,
              outputCompleteness: owned.outputCompleteness,
            }
            : undefined;
        const restoreOwnedPublication = () => {
          const restored = database
            .update(encodeJobs)
            .set({
              status: owned.status,
              publicationCompletionPending:
                owned.publicationCompletionPending,
              completedAt: owned.completedAt,
              errorMessage: owned.errorMessage,
              updatedAt: now(),
            })
            .where(completionCondition)
            .returning()
            .get();
          if (!restored) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
        };
        if (!publicationMatches()) {
          restoreOwnedPublication();
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        let finalized: EncodeJob | undefined;
        try {
          finalized = database.transaction((transaction) => {
            return finalizePublishedEncodeJob(
              transaction,
              completionCondition,
              provenance,
              "encode job publication",
              cleanup.jobId,
              replayedCompletion,
            );
          }, { behavior: "immediate" });
        } catch (error) {
          if (replayedCompletion !== undefined) {
            restoreOwnedPublication();
          }
          throw error;
        }
        if (!finalized) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return {
          cleanup: { ...cleanup, leaseToken },
          job: finalized,
        };
      },
      completePublishedClaim(claim, cleanup, publicationMatches, provenance) {
        if (!cleanup.publicationPending) {
          throw new DomainInvariantError(
            "Encode Job cleanup is not publication provenance",
          );
        }
        const timestamp = now();
        const publicationCondition = and(
          cleanup.leaseToken === null
            ? encodeAttemptCondition(claim, timestamp)
            : and(
                eq(encodeJobs.id, claim.id),
                eq(encodeJobs.status, "running"),
                eq(encodeJobs.claimToken, claim.claimToken),
              ),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(
                encodeJobs.partialCleanupLeaseToken,
                cleanup.leaseToken,
              ),
        );
        const matches = publicationMatches();
        database.transaction((transaction) => {
          const owned = transaction
            .update(encodeJobs)
            .set({ updatedAt: timestamp })
            .where(publicationCondition)
            .returning()
            .get();
          if (!owned || !matches) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          const updated = transaction
            .update(encodeJobs)
            .set({
              status: "completed",
              publicationCompletionPending: true,
              progressPercent: 100,
              progressEtaSeconds: null,
              errorMessage: null,
              updatedAt: timestamp,
            })
            .where(publicationCondition)
            .returning()
            .get();
          if (!updated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          return updated;
        }, { behavior: "immediate" });
        const completionCondition = and(
          eq(encodeJobs.id, cleanup.jobId),
          eq(encodeJobs.status, "completed"),
          eq(encodeJobs.publicationCompletionPending, true),
          eq(encodeJobs.claimToken, claim.claimToken),
          eq(encodeJobs.publicationPending, true),
          eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
          eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
          cleanup.leaseToken === null
            ? isNull(encodeJobs.partialCleanupLeaseToken)
            : eq(
                encodeJobs.partialCleanupLeaseToken,
                cleanup.leaseToken,
              ),
        );
        if (!publicationMatches()) {
          const invalidated = database
            .update(encodeJobs)
            .set({
              status: "failed",
              publicationCompletionPending: false,
              completedAt: completedAtAfterInterruptedPublication(),
              errorMessage:
                "Encode publication changed across completion commit",
              updatedAt: now(),
            })
            .where(completionCondition)
            .returning()
            .get();
          if (!invalidated) {
            throw new StaleJobAttemptError(
              "encode job publication",
              cleanup.jobId,
            );
          }
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        const finalized = database.transaction((transaction) => {
          return finalizePublishedEncodeJob(
            transaction,
            completionCondition,
            provenance,
            "encode job publication",
            cleanup.jobId,
          );
        }, { behavior: "immediate" });
        if (!finalized) {
          throw new StaleJobAttemptError(
            "encode job publication",
            cleanup.jobId,
          );
        }
        return finalized;
      },
      completePartialCleanup(cleanup) {
        return database.transaction((transaction) => {
          const cleanupCondition = and(
            eq(encodeJobs.id, cleanup.jobId),
            eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
            eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
            cleanup.leaseToken === null
              ? isNull(encodeJobs.partialCleanupLeaseToken)
              : eq(
                  encodeJobs.partialCleanupLeaseToken,
                  cleanup.leaseToken,
                ),
          );
          const interruptedPublication = transaction
            .select({
              publicationCompletionPending:
                encodeJobs.publicationCompletionPending,
            })
            .from(encodeJobs)
            .where(cleanupCondition)
            .get()?.publicationCompletionPending === true;
          const updated = transaction
            .update(encodeJobs)
            .set({
              status: sql`case when ${encodeJobs.publicationCompletionPending} = 1 then 'failed' else ${encodeJobs.status} end`,
              completedAt: sql`case when
                ${encodeJobs.publicationCompletionPending} = 1
                then ${completedAtAfterInterruptedPublication()}
                else ${encodeJobs.completedAt}
              end`,
              errorMessage: sql`case when ${encodeJobs.publicationCompletionPending} = 1 then 'Encode publication completion was interrupted' else ${encodeJobs.errorMessage} end`,
              partialCleanupOutputPath: null,
              partialCleanupClaimToken: null,
              partialCleanupLeaseToken: null,
              publicationPending: false,
              publicationCompletionPending: false,
              reservesOutputPath: sql`case when
                ${encodeJobs.status} = 'failed'
                and ${encodeJobs.replaceExistingOutput} = 0
                and exists (
                  select 1
                  from ${discSelections} as inactive_selection
                  inner join ${originalDiscArchives} as reviewed_archive
                    on reviewed_archive.id =
                      inactive_selection.original_disc_archive_id
                  where inactive_selection.id = ${encodeJobs.discSelectionId}
                    and inactive_selection.is_catalog_active = 0
                    and reviewed_archive.catalog_review_outcome <>
                      'needs_review'
                )
                then 0 else ${encodeJobs.reservesOutputPath} end`,
            })
            .where(cleanupCondition)
            .returning()
            .get();
          if (updated) {
            clearCorrectedEncodePublicationAuthority(
              transaction,
              cleanup.jobId,
            );
            if (interruptedPublication) {
              appendEncodeJobFailureReports(
                transaction,
                updated.id,
                [validateEncodeJobFailureReport({
                  schemaVersion: 1,
                  reasonCode: "worker_interrupted",
                  phase: "publication",
                  retryability: "after_action",
                  diagnostic:
                    "Encode publication completion was interrupted",
                  evidence: {
                    kind: "interruption",
                    source: "publication_completion",
                  },
                })],
                now(),
              );
            }
            return updated;
          }
          const current = transaction
            .select()
            .from(encodeJobs)
            .where(eq(encodeJobs.id, cleanup.jobId))
            .get();
          if (
            current?.partialCleanupOutputPath === null &&
            current.partialCleanupClaimToken === null &&
            current.partialCleanupLeaseToken === null &&
            !current.publicationPending
          ) {
            clearCorrectedEncodePublicationAuthority(
              transaction,
              cleanup.jobId,
            );
            return current;
          }
          throw new StaleJobAttemptError("encode job cleanup", cleanup.jobId);
        }, { behavior: "immediate" });
      },
      list: encodeJobQueue.list,
      updateProgress(claim, progress) {
        if (typeof progress === "number") {
          return encodeJobQueue.updateProgress(claim, progress);
        }
        if (!ENCODE_PROGRESS_PHASES.includes(progress.phase)) {
          throw new DomainInvariantError("Encode Job progress phase is invalid");
        }
        const etaSeconds = optionalSafeInteger(
          progress.etaSeconds,
          "etaSeconds",
          0,
        );
        return encodeJobQueue.updateProgress(
          claim,
          progress.progressPercent,
          {
            phase: progress.phase,
            etaSeconds: etaSeconds ?? null,
          },
        );
      },
      complete(claim) {
        if (claim.predecessorEncodeJobId !== null) {
          throw new DomainInvariantError(
            "Corrected replacement Encode Job completion requires publication provenance",
          );
        }
        return encodeJobQueue.complete(claim, undefined);
      },
      fail: encodeJobQueue.fail,
      failWithReport(claim, reportInput, options) {
        const report = validateEncodeJobFailureReport(reportInput);
        const failureMessages = {
          input_unavailable: "Encode input is unavailable",
          invalid_configuration: "Encode configuration is invalid",
          output_conflict: "Encode output conflicts with existing state",
          unsafe_output_state: "Encode output state is unsafe",
          command_failed: "HandBrake command failed",
          command_timeout: "HandBrake command timed out",
          output_validation_failed: "Encode output validation failed",
          unknown_failure: "Encode failed for an unknown reason",
          cleanup_failed: "Encode output cleanup failed",
          publication_failed: "Encode publication failed",
          lease_expired: "Encode Job lease expired",
          worker_interrupted: "Encode Worker was interrupted",
          publication_recovery_failed:
            "Encode publication recovery failed",
        } satisfies Record<typeof report.reasonCode, string>;
        return encodeJobQueue.fail(
          claim,
          failureMessages[report.reasonCode],
          { ...options, failureReports: [report] },
        );
      },
      failWithReports(claim, errorMessage, reportInputs, options) {
        if (reportInputs.length === 0 || reportInputs.length > 10) {
          throw new DomainInvariantError(
            "Encode Job failure must include between one and ten reports",
          );
        }
        const reports = reportInputs.map(validateEncodeJobFailureReport);
        return encodeJobQueue.fail(claim, errorMessage, {
          ...options,
          failureReports: reports,
        });
      },
      recordFailureReport(claim, reportInput) {
        const report = validateEncodeJobFailureReport(reportInput);
        const timestamp = now();
        database.transaction((transaction) => {
          const owned = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(encodeAttemptCondition(claim, timestamp))
            .get();
          if (!owned) {
            throw new StaleJobAttemptError("encode job", claim.id);
          }
          appendEncodeJobFailureReports(
            transaction,
            owned.id,
            [report],
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      recordCleanupFailureReport(cleanup, reportInput) {
        const report = validateEncodeJobFailureReport(reportInput);
        if (
          report.reasonCode !== "cleanup_failed" &&
          report.reasonCode !== "publication_failed" &&
          report.reasonCode !== "publication_recovery_failed"
        ) {
          throw new DomainInvariantError(
            "Encode Job cleanup report reason is invalid",
          );
        }
        if (
          report.reasonCode === "publication_recovery_failed" &&
          (report.evidence.kind !== "recovery" ||
            report.evidence.operation !==
              (cleanup.publicationPending
                ? "publication_recovery"
                : "cleanup_recovery"))
        ) {
          throw new DomainInvariantError(
            "Encode Job cleanup recovery report provenance is invalid",
          );
        }
        const timestamp = now();
        const expiredBefore = new Date(
          timestamp.getTime() - ENCODE_JOB_LEASE_DURATION_MS,
        );
        database.transaction((transaction) => {
          const owned = transaction
            .select({ id: encodeJobs.id })
            .from(encodeJobs)
            .where(and(
              eq(encodeJobs.id, cleanup.jobId),
              inArray(encodeJobs.status, [
                "running",
                "failed",
                "completed",
                "cancelled",
              ]),
              eq(encodeJobs.partialCleanupOutputPath, cleanup.outputPath),
              eq(encodeJobs.partialCleanupClaimToken, cleanup.claimToken),
              eq(encodeJobs.publicationPending, cleanup.publicationPending),
              cleanup.leaseToken === null
                ? and(
                    isNull(encodeJobs.partialCleanupLeaseToken),
                    or(
                      ne(encodeJobs.status, "running"),
                      gt(encodeJobs.updatedAt, expiredBefore),
                    ),
                  )
                : and(
                    eq(
                      encodeJobs.partialCleanupLeaseToken,
                      cleanup.leaseToken,
                    ),
                    gt(encodeJobs.updatedAt, expiredBefore),
                  ),
            ))
            .get();
          if (!owned) {
            throw new StaleJobAttemptError(
              "encode job cleanup",
              cleanup.jobId,
            );
          }
          const latestReport = report.reasonCode ===
              "publication_recovery_failed"
            ? transaction
              .select()
              .from(encodeJobFailureReports)
              .where(eq(encodeJobFailureReports.encodeJobId, owned.id))
              .orderBy(desc(encodeJobFailureReports.sequence))
              .limit(1)
              .get()
            : undefined;
          if (
            latestReport !== undefined &&
            matchesLatestPublicationRecoveryFailure(latestReport, report)
          ) {
            return;
          }
          appendEncodeJobFailureReports(
            transaction,
            owned.id,
            [report],
            timestamp,
          );
        }, { behavior: "immediate" });
      },
      listFailureReports(ids) {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length > ENCODE_JOB_FAILURE_REPORT_JOB_LIMIT) {
          throw new DomainInvariantError(
            `Encode Job Failure Report lookup cannot exceed ${ENCODE_JOB_FAILURE_REPORT_JOB_LIMIT} jobs`,
          );
        }
        return uniqueIds.flatMap((id) =>
          database
            .select()
            .from(encodeJobFailureReports)
            .where(eq(encodeJobFailureReports.encodeJobId, id))
            .orderBy(
              desc(encodeJobFailureReports.sequence),
            )
            .limit(ENCODE_JOB_FAILURE_REPORT_HISTORY_LIMIT)
            .all()
            .map(toEncodeJobFailureReport),
        );
      },
      requeue(id, options) {
        const outputPath = options?.outputPath === undefined
          ? undefined
          : requireNonEmpty(options.outputPath, "outputPath");
        if (
          options?.priority !== undefined &&
          !Number.isSafeInteger(options.priority)
        ) {
          throw new DomainInvariantError("priority must be a safe integer");
        }
        const semanticInput = encodeRequeueSemanticInput(id, {
          outputPath,
          priority: options?.priority,
          expectedRevision: options?.expectedRevision,
          acknowledgeReplacement: options?.acknowledgeReplacement,
          expectedSourceDecision: options?.expectedSourceDecision,
        });
        const replay = database.transaction(
          (transaction) => replayEncodeMutation(
            transaction,
            options?.mutationKey,
            "encode_job.requeue",
            semanticInput,
          ),
          { behavior: "immediate" },
        );
        if (replay) return replay;
        if (options?.mutationKey !== undefined && outputPath !== undefined) {
          const current = database.select().from(encodeJobs)
            .where(eq(encodeJobs.id, id)).get();
          if (current && (current.status === "completed" || current.replaceExistingOutput) &&
            current.outputPath !== outputPath) {
            throw new DomainInvariantError(
              "This Encode Job must retain its output path when requeued",
            );
          }
        }
        try {
          return encodeJobQueue.requeue(id, {
            outputPath,
            priority: options?.priority,
            mutationKey: options?.mutationKey,
            expectedRevision: options?.expectedRevision,
            acknowledgeReplacement: options?.acknowledgeReplacement,
            expectedSourceDecision: options?.expectedSourceDecision,
            assertSourceDecision: options?.assertSourceDecision,
          });
        } catch (error) {
          const racedReplay = database.transaction(
            (transaction) => replayEncodeMutation(
              transaction,
              options?.mutationKey,
              "encode_job.requeue",
              semanticInput,
            ),
            { behavior: "immediate" },
          );
          if (racedReplay) return racedReplay;
          // A competing retry may have made this job nonterminal before the
          // queue adapter reached its source assertion. Report stale source
          // evidence before falling back to the workflow-state rejection.
          if (error instanceof InvalidStatusTransitionError && options?.assertSourceDecision) {
            database.transaction(() => options.assertSourceDecision!(), { behavior: "immediate" });
          }
          throw error;
        }
      },
    },

    workerIncidents: {
      find(id) {
        return database.select().from(workerIncidents)
          .where(eq(workerIncidents.id, id)).get() ?? null;
      },
      record(input) {
        const normalized = normalizeRecordWorkerIncidentInput(input);
        const timestamp = now();
        return database.transaction((transaction) => {
          const identityCondition = and(
            eq(workerIncidents.workerKind, normalized.workerKind),
            eq(workerIncidents.reasonCode, normalized.reasonCode),
            eq(workerIncidents.phase, normalized.phase),
            eq(workerIncidents.evidence, normalized.evidence),
            isNull(workerIncidents.resolvedAt),
          );
          const existing = transaction
            .select()
            .from(workerIncidents)
            .where(identityCondition)
            .get();
          if (existing) {
            return requireRow(
              transaction
                .update(workerIncidents)
                .set({
                  schemaVersion: normalized.schemaVersion,
                  retryability: normalized.retryability,
                  lastObservedAt: timestamp,
                  occurrenceCount: sql`${workerIncidents.occurrenceCount} + 1`,
                })
                .where(and(
                  eq(workerIncidents.id, existing.id),
                  isNull(workerIncidents.resolvedAt),
                ))
                .returning()
                .get(),
              "worker incident",
              existing.id,
            );
          }

          const retainedCount = transaction
            .select({ count: count() })
            .from(workerIncidents)
            .where(eq(workerIncidents.workerKind, normalized.workerKind))
            .get()?.count ?? 0;
          if (retainedCount >= WORKER_INCIDENT_RETENTION_LIMIT) {
            const removalCount =
              retainedCount - WORKER_INCIDENT_RETENTION_LIMIT + 1;
            const removableIds = transaction
              .select({ id: workerIncidents.id })
              .from(workerIncidents)
              .where(and(
                eq(workerIncidents.workerKind, normalized.workerKind),
                isNotNull(workerIncidents.resolvedAt),
              ))
              .orderBy(
                asc(workerIncidents.resolvedAt),
                asc(workerIncidents.lastObservedAt),
                asc(workerIncidents.id),
              )
              .limit(removalCount)
              .all()
              .map(({ id }) => id);
            if (removableIds.length !== removalCount) {
              throw new DomainInvariantError(
                "Worker Incident capacity contains only active incidents",
              );
            }
            transaction
              .delete(workerIncidents)
              .where(inArray(workerIncidents.id, removableIds))
              .run();
          }

          const id = newId<WorkerIncidentId>();
          return requireRow(
            transaction
              .insert(workerIncidents)
              .values({
                id,
                schemaVersion: normalized.schemaVersion,
                workerKind: normalized.workerKind,
                reasonCode: normalized.reasonCode,
                phase: normalized.phase,
                retryability: normalized.retryability,
                evidence: normalized.evidence,
                firstObservedAt: timestamp,
                lastObservedAt: timestamp,
                occurrenceCount: 1,
              })
              .returning()
              .get(),
            "worker incident",
            id,
          );
        }, { behavior: "immediate" });
      },

      resolve(input) {
        const normalized = normalizeWorkerIncidentIdentity(input);
        const timestamp = now();
        return database
          .update(workerIncidents)
          .set({
            resolvedAt: sql`max(${workerIncidents.lastObservedAt}, ${timestamp.getTime()})`,
          })
          .where(and(
            eq(workerIncidents.workerKind, normalized.workerKind),
            eq(workerIncidents.reasonCode, normalized.reasonCode),
            eq(workerIncidents.phase, normalized.phase),
            eq(workerIncidents.evidence, normalized.evidence),
            isNull(workerIncidents.resolvedAt),
          ))
          .returning()
          .all();
      },

      list(options) {
        const resolvedLimit = requireSafeIntegerInRange(
          options.resolvedLimit,
          "Worker Incident resolved limit",
          0,
          WORKER_INCIDENT_RETENTION_LIMIT,
        );
        const active = database
          .select()
          .from(workerIncidents)
          .where(and(
            eq(workerIncidents.workerKind, options.workerKind),
            isNull(workerIncidents.resolvedAt),
          ))
          .orderBy(
            desc(workerIncidents.lastObservedAt),
            desc(workerIncidents.id),
          )
          .all();
        const resolved = resolvedLimit === 0
          ? []
          : database
            .select()
            .from(workerIncidents)
            .where(and(
              eq(workerIncidents.workerKind, options.workerKind),
              isNotNull(workerIncidents.resolvedAt),
            ))
            .orderBy(
              desc(workerIncidents.resolvedAt),
              desc(workerIncidents.lastObservedAt),
              desc(workerIncidents.id),
            )
            .limit(resolvedLimit)
            .all();
        return [...active, ...resolved];
      },
    },

    archiveAudits: {
      submit(input) {
        const bounds = {
          recordLimit: requireSafeIntegerInRange(input.bounds.recordLimit,
            "Archive audit record limit", 1, 1_000),
          concurrency: requireSafeIntegerInRange(input.bounds.concurrency,
            "Archive audit concurrency", 1, 8),
          fileTimeoutMs: requireSafeIntegerInRange(input.bounds.fileTimeoutMs,
            "Archive audit file timeout", 1, 30_000),
          runtimeTimeoutMs: requireSafeIntegerInRange(input.bounds.runtimeTimeoutMs,
            "Archive audit runtime timeout", 1, 600_000),
        };
        const semanticInput = JSON.stringify(bounds);
        return database.transaction((transaction) => {
          const operation = "archive_audit.submit";
          const previous = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            (stored) => {
              const outcome = JSON.parse(stored) as ArchiveAuditRunRow & {
                claimedAt: string | null;
                startedAt: string | null;
                completedAt: string | null;
                createdAt: string;
                updatedAt: string;
              };
              return toArchiveAuditRunSummary({
                ...outcome,
                claimedAt: outcome.claimedAt === null ? null : new Date(outcome.claimedAt),
                startedAt: outcome.startedAt === null ? null : new Date(outcome.startedAt),
                completedAt: outcome.completedAt === null ? null : new Date(outcome.completedAt),
                createdAt: new Date(outcome.createdAt),
                updatedAt: new Date(outcome.updatedAt),
              });
            },
          );
          if (previous !== undefined) return previous;
          const timestamp = now();
          const id = newId<ArchiveAuditRunId>();
          const row = requireRow(transaction.insert(archiveAuditRuns).values({
            id,
            status: "queued",
            progressPhase: "queued",
            recordLimit: bounds.recordLimit,
            concurrency: bounds.concurrency,
            fileTimeoutMs: bounds.fileTimeoutMs,
            runtimeTimeoutMs: bounds.runtimeTimeoutMs,
            recordsProcessed: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          }).returning().get(), "archive audit run", id);
          recordMutationInvocation(transaction, input.mutationKey, operation,
            semanticInput, row, timestamp);
          return toArchiveAuditRunSummary(row);
        });
      },
      find(id) {
        const row = database.select().from(archiveAuditRuns)
          .where(eq(archiveAuditRuns.id, id)).get();
        return row === undefined ? null : toArchiveAuditRun(row);
      },
      list(options) {
        const limit = requireSafeIntegerInRange(options.limit, "limit", 1, 100);
        const active = database.select().from(archiveAuditRuns)
          .where(inArray(archiveAuditRuns.status, ["queued", "running"]))
          .orderBy(desc(archiveAuditRuns.createdAt), desc(archiveAuditRuns.id))
          .limit(limit).all();
        const remaining = limit - active.length;
        return (remaining === 0 ? active : [...active,
          ...database.select().from(archiveAuditRuns)
            .where(inArray(archiveAuditRuns.status, ["completed", "failed"]))
            .orderBy(desc(archiveAuditRuns.createdAt), desc(archiveAuditRuns.id))
            .limit(remaining).all(),
        ]).map(toArchiveAuditRunSummary);
      },
      listActive() {
        return database.select().from(archiveAuditRuns)
          .where(inArray(archiveAuditRuns.status, ["queued", "running"]))
          .orderBy(desc(archiveAuditRuns.createdAt), desc(archiveAuditRuns.id))
          .all().map(toArchiveAuditRunSummary);
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(timestamp.getTime() - 60_000);
        return database.transaction((transaction) => {
          const expiredIds = transaction.select({ id: archiveAuditRuns.id })
            .from(archiveAuditRuns)
            .where(and(eq(archiveAuditRuns.status, "running"),
              lt(archiveAuditRuns.claimedAt, expiredBefore)))
            .orderBy(asc(archiveAuditRuns.claimedAt), asc(archiveAuditRuns.id))
            .limit(JOB_RECOVERY_LIMIT).all().map(({ id }) => id);
          if (expiredIds.length === 0) return 0;
          transaction.delete(archiveAuditFindings)
            .where(inArray(archiveAuditFindings.archiveAuditRunId, expiredIds)).run();
          return transaction.update(archiveAuditRuns).set({
            status: "queued",
            progressPhase: "queued",
            recordCount: null,
            recordsProcessed: 0,
            truncated: null,
            claimToken: null,
            claimedAt: null,
            startedAt: null,
            updatedAt: timestamp,
          }).where(and(inArray(archiveAuditRuns.id, expiredIds),
            eq(archiveAuditRuns.status, "running"),
            lt(archiveAuditRuns.claimedAt, expiredBefore)))
            .returning({ id: archiveAuditRuns.id }).all().length;
        });
      },
      renewClaim(claim) {
        if (claim.claimToken === null) return false;
        const timestamp = now();
        return database.update(archiveAuditRuns).set({
          claimedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(eq(archiveAuditRuns.id, claim.id),
          eq(archiveAuditRuns.status, "running"),
          eq(archiveAuditRuns.claimToken, claim.claimToken)))
          .returning({ id: archiveAuditRuns.id }).get() !== undefined;
      },
      claimNext() {
        return database.transaction((transaction) => {
          const next = transaction.select().from(archiveAuditRuns)
            .where(eq(archiveAuditRuns.status, "queued"))
            .orderBy(asc(archiveAuditRuns.createdAt), asc(archiveAuditRuns.id))
            .limit(1).get();
          if (!next) return null;
          const timestamp = now();
          const claimed = transaction.update(archiveAuditRuns).set({
            status: "running",
            progressPhase: "reading_records",
            claimToken: newId<ArchiveAuditClaimToken>(),
            claimedAt: timestamp,
            startedAt: timestamp,
            updatedAt: timestamp,
          }).where(and(eq(archiveAuditRuns.id, next.id),
            eq(archiveAuditRuns.status, "queued"))).returning().get();
          return claimed === undefined ? null : toArchiveAuditRunSummary(claimed);
        });
      },
      beginAudit(claim, input) {
        if (claim.claimToken === null) {
          throw new StaleJobAttemptError("archive audit run", claim.id);
        }
        const claimToken = claim.claimToken;
        const recordCount = requireSafeIntegerInRange(input.recordCount,
          "Archive audit record count", 0, claim.bounds.recordLimit);
        return database.transaction((transaction) => {
          const current = transaction.select().from(archiveAuditRuns)
            .where(eq(archiveAuditRuns.id, claim.id)).get();
          if (current?.status !== "running" || current.claimToken !== claimToken) {
            throw new StaleJobAttemptError("archive audit run", claim.id);
          }
          transaction.delete(archiveAuditFindings)
            .where(eq(archiveAuditFindings.archiveAuditRunId, claim.id)).run();
          return toArchiveAuditRunSummary(requireRow(
            transaction.update(archiveAuditRuns).set({
              progressPhase: "auditing",
              recordCount,
              recordsProcessed: 0,
              truncated: input.truncated,
              updatedAt: now(),
            }).where(and(eq(archiveAuditRuns.id, claim.id),
              eq(archiveAuditRuns.status, "running"),
              eq(archiveAuditRuns.claimToken, claimToken)))
              .returning().get(),
            "archive audit run", claim.id,
          ));
        });
      },
      recordFinding(claim, input) {
        if (claim.claimToken === null || !Number.isSafeInteger(input.index) ||
          input.index < 0 || input.index >= claim.bounds.recordLimit) {
          throw new StaleJobAttemptError("archive audit run", claim.id);
        }
        database.transaction((transaction) => {
          const current = transaction.select().from(archiveAuditRuns)
            .where(eq(archiveAuditRuns.id, claim.id)).get();
          if (current?.status !== "running" || current.progressPhase !== "auditing" ||
            current.claimToken !== claim.claimToken) {
            throw new StaleJobAttemptError("archive audit run", claim.id);
          }
          transaction.insert(archiveAuditFindings).values({
            archiveAuditRunId: claim.id,
            sequence: input.index,
            finding: JSON.stringify(input.finding),
          }).run();
          transaction.update(archiveAuditRuns).set({
            recordsProcessed: sql`${archiveAuditRuns.recordsProcessed} + 1`,
            updatedAt: now(),
          }).where(eq(archiveAuditRuns.id, claim.id)).run();
        });
      },
      complete(claim, input) {
        return finalizeArchiveAuditRun(claim, {
          findings: input.findings,
          resultStatus: input.resultStatus,
          incompleteReason: null,
          validateCurrent: (current) =>
            current.progressPhase === "auditing" &&
            current.recordCount === input.findings.length,
        });
      },
      completeIncomplete(claim, input) {
        return finalizeArchiveAuditRun(claim, {
          findings: input.findings,
          resultStatus: "incomplete",
          incompleteReason: input.reason,
          validateCurrent: (current) =>
            current.progressPhase === "reading_records"
              ? current.recordCount === null && input.findings.length === 0
              : current.progressPhase === "auditing" &&
                current.recordCount !== null &&
                input.findings.length <= current.recordCount,
        });
      },
      fail(claim) {
        if (claim.claimToken === null) return null;
        const timestamp = now();
        const row = database.update(archiveAuditRuns).set({
          status: "failed",
          progressPhase: "completed",
          failureCode: "ARCHIVE_AUDIT_UNAVAILABLE",
          claimToken: null,
          claimedAt: null,
          completedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(eq(archiveAuditRuns.id, claim.id),
          eq(archiveAuditRuns.status, "running"),
          eq(archiveAuditRuns.claimToken, claim.claimToken)))
          .returning().get();
        return row === undefined ? null : toArchiveAuditRun(row);
      },
    },

    filesystemVerification: {
      submit(input) {
        const targetId = requireNonEmpty(input.targetId.trim(), "Verification target ID");
        const semanticInput = JSON.stringify({ target: input.target, targetId });
        return database.transaction((transaction) => {
          const operation = "filesystem_verification.submit";
          const previous = readMutationInvocation(
            transaction,
            input.mutationKey,
            operation,
            semanticInput,
            (stored) => {
              const outcome = JSON.parse(stored) as {
                id: string; createdAt: string; updatedAt: string;
              };
              return toFilesystemVerificationRun({
                ...outcome,
                createdAt: new Date(outcome.createdAt),
                updatedAt: new Date(outcome.updatedAt),
              } as FilesystemVerificationRow);
            },
          );
          if (previous !== undefined) return previous;
          if (input.target === "original_disc_archive") {
            requireRow(transaction.select({ id: originalDiscArchives.id })
              .from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, targetId as OriginalDiscArchiveId)).get(),
              "original disc archive", targetId);
          } else if (input.target === "encode_job_output") {
            requireRow(transaction.select({ id: encodeJobs.id }).from(encodeJobs)
              .where(eq(encodeJobs.id, targetId as EncodeJobId)).get(), "encode job", targetId);
          } else {
            throw new DomainInvariantError("Unknown verification target");
          }
          const id = newId<FilesystemVerificationRunId>();
          const timestamp = now();
          const run = requireRow(transaction.insert(filesystemVerificationRuns).values({
            id, target: input.target, targetId: targetId as OriginalDiscArchiveId | EncodeJobId,
            status: "queued", progressPhase: "queued",
            createdAt: timestamp, updatedAt: timestamp,
          }).returning().get(), "verification run", id);
          recordMutationInvocation(transaction, input.mutationKey, operation,
            semanticInput, run, timestamp);
          return toFilesystemVerificationRun(run);
        });
      },
      find(id) {
        const row = database.select().from(filesystemVerificationRuns)
          .where(eq(filesystemVerificationRuns.id, id)).get();
        return row === undefined ? null : toFilesystemVerificationRun(row);
      },
      list(options) {
        const limit = requireSafeIntegerInRange(options.limit, "limit", 1, 100);
        const active = database.select().from(filesystemVerificationRuns)
          .where(inArray(filesystemVerificationRuns.status, ["queued", "running"]))
          .orderBy(desc(filesystemVerificationRuns.createdAt), desc(filesystemVerificationRuns.id))
          .limit(limit).all();
        const remaining = limit - active.length;
        return (remaining === 0 ? active : [...active,
          ...database.select().from(filesystemVerificationRuns)
            .where(inArray(filesystemVerificationRuns.status, ["completed", "failed"]))
            .orderBy(desc(filesystemVerificationRuns.createdAt), desc(filesystemVerificationRuns.id))
            .limit(remaining).all(),
        ]).map(toFilesystemVerificationRun);
      },
      listActive() {
        return database.select().from(filesystemVerificationRuns)
          .where(inArray(filesystemVerificationRuns.status, ["queued", "running"]))
          .orderBy(desc(filesystemVerificationRuns.createdAt), desc(filesystemVerificationRuns.id))
          .all().map(toFilesystemVerificationRun);
      },
      recoverExpiredClaims() {
        const timestamp = now();
        const expiredBefore = new Date(timestamp.getTime() - 60_000);
        return database.transaction((transaction) => {
          const expiredIds = transaction.select({ id: filesystemVerificationRuns.id })
            .from(filesystemVerificationRuns)
            .where(and(eq(filesystemVerificationRuns.status, "running"),
              lt(filesystemVerificationRuns.claimedAt, expiredBefore)))
            .orderBy(asc(filesystemVerificationRuns.claimedAt),
              asc(filesystemVerificationRuns.id))
            .limit(JOB_RECOVERY_LIMIT).all().map(({ id }) => id);
          if (expiredIds.length === 0) return 0;
          return transaction.update(filesystemVerificationRuns).set({
            status: "queued", progressPhase: "queued", claimToken: null, claimedAt: null,
            updatedAt: timestamp,
          }).where(and(inArray(filesystemVerificationRuns.id, expiredIds),
            eq(filesystemVerificationRuns.status, "running"),
            lt(filesystemVerificationRuns.claimedAt, expiredBefore)))
            .returning({ id: filesystemVerificationRuns.id }).all().length;
        });
      },
      renewClaim(claim) {
        if (claim.claimToken === null) return false;
        return database.update(filesystemVerificationRuns).set({
          claimedAt: now(), updatedAt: now(),
        }).where(and(eq(filesystemVerificationRuns.id, claim.id),
          eq(filesystemVerificationRuns.status, "running"),
          eq(filesystemVerificationRuns.claimToken, claim.claimToken)))
          .returning({ id: filesystemVerificationRuns.id }).get() !== undefined;
      },
      claimNext() {
        return database.transaction((transaction) => {
          const next = transaction.select().from(filesystemVerificationRuns)
            .where(eq(filesystemVerificationRuns.status, "queued"))
            .orderBy(asc(filesystemVerificationRuns.createdAt), asc(filesystemVerificationRuns.id))
            .limit(1).get();
          if (!next) return null;
          const claimed = transaction.update(filesystemVerificationRuns).set({
            status: "running", progressPhase: "checking",
            claimToken: newId<FilesystemVerificationClaimToken>(), claimedAt: now(), updatedAt: now(),
          }).where(and(eq(filesystemVerificationRuns.id, next.id),
            eq(filesystemVerificationRuns.status, "queued"))).returning().get();
          return claimed === undefined ? null : toFilesystemVerificationRun(claimed);
        });
      },
      async execute(claim, options) {
        if (claim.status !== "running" || claim.claimToken === null) {
          throw new StaleJobAttemptError("verification run", claim.id);
        }
        const archive = claim.target === "original_disc_archive"
          ? requireRow(database.select().from(originalDiscArchives)
              .where(eq(originalDiscArchives.id, claim.targetId as OriginalDiscArchiveId)).get(),
              "original disc archive", claim.targetId) : null;
        const job = claim.target === "encode_job_output"
          ? requireRow(database.select().from(encodeJobs)
              .where(eq(encodeJobs.id, claim.targetId as EncodeJobId)).get(),
              "encode job", claim.targetId) : null;
        const path = archive?.archivePath ?? job!.outputPath;
        const verification = await inspectFilesystemPath(
          path,
          claim.target === "original_disc_archive" ? originalsVerificationRoot : mediaVerificationRoot,
          archive?.sizeBytes ?? undefined,
        );
        options?.assertStable?.();
        return database.transaction((transaction) => {
          const current = transaction.select().from(filesystemVerificationRuns)
            .where(eq(filesystemVerificationRuns.id, claim.id)).get();
          if (current?.status !== "running" || current.claimToken !== claim.claimToken) {
            throw new StaleJobAttemptError("verification run", claim.id);
          }
          const updatedTarget = claim.target === "original_disc_archive"
            ? transaction.update(originalDiscArchives).set(verification)
                .where(and(eq(originalDiscArchives.id, claim.targetId as OriginalDiscArchiveId),
                  eq(originalDiscArchives.archivePath, path)))
                .returning({ id: originalDiscArchives.id }).get()
            : transaction.update(encodeJobs).set(verification)
                .where(and(eq(encodeJobs.id, claim.targetId as EncodeJobId),
                  eq(encodeJobs.outputPath, path)))
                .returning({ id: encodeJobs.id }).get();
          if (!updatedTarget) {
            throw new DomainInvariantError("Verification target changed during checking");
          }
          return toFilesystemVerificationRun(requireRow(transaction.update(filesystemVerificationRuns).set({
            status: "completed", progressPhase: "completed",
            resultStatus: verification.verificationStatus,
            resultMessage: verification.verificationMessage,
            verifiedAt: verification.verifiedAt,
            claimToken: null, claimedAt: null, updatedAt: now(),
          }).where(eq(filesystemVerificationRuns.id, claim.id)).returning().get(),
          "verification run", claim.id));
        });
      },
      fail(claim) {
        if (claim.claimToken === null) return null;
        const failed = database.update(filesystemVerificationRuns).set({
          status: "failed", progressPhase: "completed", failureCode: "VERIFICATION_UNAVAILABLE",
          claimToken: null, claimedAt: null, updatedAt: now(),
        }).where(and(eq(filesystemVerificationRuns.id, claim.id),
          eq(filesystemVerificationRuns.status, "running"),
          eq(filesystemVerificationRuns.claimToken, claim.claimToken)))
          .returning().get();
        return failed === undefined ? null : toFilesystemVerificationRun(failed);
      },
      listOriginalDiscArchives(options) {
        return access.catalog.listOriginalDiscArchives(options);
      },
      listEncodeJobOutputs(options) {
        const limit = requirePositiveSafeInteger(options.limit, "limit");
        const offset = optionalSafeInteger(options.offset, "offset", 0) ?? 0;
        return database
          .select()
          .from(encodeJobs)
          .orderBy(desc(encodeJobs.createdAt), desc(encodeJobs.id))
          .limit(limit)
          .offset(offset)
          .all()
          .reverse();
      },
    },

    legacySidecars: legacySidecarMigration
      ? legacySidecarMigration.createAccess(
          database,
          now,
          requireReviewableDiscSelections,
        )
      : {
          importLibrary() {
            throw new DomainInvariantError(
              "Legacy sidecar import is available from the migration-only entrypoint",
            );
          },
        },

    close() {
      sqlite.close();
    },
  };

  if (!legacySidecarMigration) {
    const {
      createOriginalDiscArchive: _migrationOnlyArchiveMutation,
      ...standardCatalog
    } = access.catalog;
    const {
      complete: _migrationOnlyArchiveCompletion,
      ...standardArchiveJobs
    } = access.archiveJobs;
    const { legacySidecars: _migrationOnlyAccess, ...standardAccess } = access;
    return {
      ...standardAccess,
      catalog: standardCatalog,
      archiveJobs: standardArchiveJobs,
    };
  }
  return access;
}
