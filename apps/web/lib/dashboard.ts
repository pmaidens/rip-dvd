import type {
  ArchiveBoundaryEvidence,
  ArchiveFormat,
  ArchiveIntegrity,
  ArchiveJob,
  ArchiveJobStatus,
  ArchiveProgressPhase,
  ArchiveRequestStatus,
  CatalogReviewArchiveListCursor,
  CatalogReviewArchiveView,
  CompletedCatalogReviewOutcome,
  ConsistentReadAccess,
  DataAccess,
  DetectedDiscId,
  DetectedDiscStatus,
  DiscKind,
  DiscInspection,
  DiscInspectionPhase,
  DiscInspectionReasonCode,
  DiscInspectionStatus,
  EncodeJob,
  EncodeJobFailureReport,
  EncodeJobId,
  EncodeJobStatus,
  EncodeProgressPhase,
  FilesystemVerificationStatus,
  OriginalDiscArchive,
  OriginalDiscArchiveId,
  UnreadableSectorRange,
  WorkerIncident,
  WorkerIncidentPhase,
  WorkerIncidentReasonCode,
  WorkerIncidentRecoveryArea,
} from "@rip-dvd/data-access";
import {
  archiveBoundaryEvidenceFromRecord,
  isEncodeJobSafelyTerminal,
  WORKER_KINDS,
} from "@rip-dvd/data-access";
import {
  decodeDvdTitleMap,
  type DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";

import {
  DASHBOARD_ACTIVE_DISC_LIMIT,
  DASHBOARD_ACTIVE_JOB_LIMIT,
  DASHBOARD_ACTIVITY_HISTORY_LIMIT,
} from "./dashboard-bounds";
import { isArchiveJobRetryable } from "./archive-job-retryability";
import { isTerminalEncodeJobStatus } from "./encode-job-status";
import { formatFailureDetail } from "./failure-detail";
import type {
  DashboardInvestigation,
  InvestigationRetryability,
} from "./investigation";

export interface DashboardOpticalDrive {
  id: string;
  displayName: string;
  hardwareName: string | null;
  state: "ready" | "disabled" | "missing";
  lastSeenAt: string;
  currentInspection?: DashboardDiscInspection | null;
}

export interface DashboardDiscInspection {
  id: string;
  activityRevision?: string;
  status: DiscInspectionStatus;
  phase: DiscInspectionPhase;
  attemptCount: number;
  consecutiveFailureCount: number;
  volumeLabel: string | null;
  titleCount: number | null;
  chapterCount: number | null;
  audioStreamCount: number | null;
  subtitleStreamCount: number | null;
  totalBytes: number | null;
  bytesHashed: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  retryAt: string | null;
  manualRetryRequested: boolean;
  reasonCode: DiscInspectionReasonCode | null;
  archiveWorkFulfilled: boolean;
  phaseStartedAt: string;
  startedAt: string;
  completedAt: string | null;
  investigation?: DashboardInvestigation;
}

export interface DashboardArchiveRequest {
  id: string;
  status: ArchiveRequestStatus;
  attemptCount: number;
  latestFailureDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardDetectedDisc {
  id: string;
  volumeLabel: string;
  discKind: DiscKind;
  status: DetectedDiscStatus;
  opticalDriveName: string;
  fingerprint: string;
  titles: readonly DvdTitle[];
  detectedAt: string;
  archiveRequest?: DashboardArchiveRequest | null;
}

export interface DashboardDetectedDiscDetails {
  id: string;
  detectedAt: string;
  titles: readonly DvdTitle[];
}

export interface DashboardArchiveJob {
  id: string;
  activityRevision?: string;
  detectedDiscId: string;
  archiveRequestId: string;
  attemptOrdinal: number;
  discLabel: string;
  opticalDriveName: string;
  status: ArchiveJobStatus;
  progressPhase: ArchiveProgressPhase;
  progressPercent: number;
  progressBytes: number;
  progressEtaSeconds?: number | null;
  lastProgressAt: string;
  investigation?: DashboardInvestigation;
}

export interface DashboardEncodeJob {
  id: EncodeJobId;
  activityRevision?: string;
  mediaTitle: string;
  mediaYear: number | null;
  encodingProfileName: string;
  status: EncodeJobStatus;
  progressPhase: EncodeProgressPhase | null;
  progressPercent: number;
  progressEtaSeconds: number | null;
  correctedReplacement?: {
    predecessorId?: EncodeJobId;
    predecessorStatus?: EncodeJobStatus;
    predecessorReady?: boolean;
    successorId?: EncodeJobId;
    successorStatus?: EncodeJobStatus;
    priorOutput?: {
      state: "protected" | "retained";
      cleanupEligible: boolean;
    };
  };
  discSelectionCorrection?: {
    replacementDiscSelectionId: string;
    correctedMediaTitle: string;
    reason: string | null;
  };
  requeueable?: boolean;
  failureDetail?: string | null;
  investigations?: readonly DashboardInvestigation[];
  verificationStatus?: FilesystemVerificationStatus | null;
  verificationMessage?: string | null;
  verifiedAt?: string | null;
}

export interface DashboardWorkerIncident {
  id: string;
  activityRevision: string;
  worker: string;
  status: "active" | "recovered";
  reasonCode: `worker.${WorkerIncidentReasonCode}`;
  phase: WorkerIncidentPhase;
  phaseLabel: string;
  occurrenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  investigation?: DashboardInvestigation;
}

export interface DashboardCatalogReviewItem {
  id: string;
  activityRevision?: string;
  discLabel: string;
  discKind: DiscKind;
  archiveFormat: ArchiveFormat;
  boundaryEvidence?: ArchiveBoundaryEvidence;
  integrity: ArchiveIntegrity;
  badSectorCount: number | null;
  badAreaCount: number | null;
  badSectorRanges: readonly UnreadableSectorRange[] | null;
  archivedAt: string;
  catalogReviewedAt: string | null;
  catalogReviewOutcome: "needs_review" | CompletedCatalogReviewOutcome;
  mappedMediaItemCount: number;
  mappedMediaItemTitles: readonly string[];
  verificationStatus?: FilesystemVerificationStatus | null;
  verificationMessage?: string | null;
  verifiedAt?: string | null;
}

export interface DashboardPage {
  limit: number;
  previousCursor: string | null;
  nextCursor: string | null;
}

export type DashboardStatus =
  | DashboardOpticalDrive["state"]
  | DetectedDiscStatus
  | DiscInspectionStatus
  | ArchiveRequestStatus
  | ArchiveJobStatus
  | EncodeJobStatus
  | DashboardWorkerIncident["status"];

export type DashboardSectionResult<T> =
  | { status: "loaded"; items: T[]; page?: DashboardPage }
  | { status: "error" };

export interface DashboardSnapshot {
  generatedAt: string;
  opticalDrives: DashboardSectionResult<DashboardOpticalDrive>;
  detectedDiscs: DashboardSectionResult<DashboardDetectedDisc>;
  archiveJobs: DashboardSectionResult<DashboardArchiveJob>;
  workerIncidents: DashboardSectionResult<DashboardWorkerIncident>;
  encodeJobs: DashboardSectionResult<DashboardEncodeJob>;
  catalogReview: DashboardSectionResult<DashboardCatalogReviewItem>;
}

export interface DashboardSnapshotOptions {
  activityLimit?: number;
  catalogReviewCursor?: CatalogReviewArchiveListCursor;
  catalogReviewView?: CatalogReviewArchiveView;
  catalogReviewQuery?: string;
  catalogReviewOutcome?: CompletedCatalogReviewOutcome;
  includeDetectedDiscDetails?: boolean;
  includeInvestigations?: boolean;
}

export interface DashboardCatalogReviewFilters {
  view: CatalogReviewArchiveView;
  query?: string;
  outcome?: CompletedCatalogReviewOutcome;
}

const CATALOG_REVIEW_CURSOR_PATTERN =
  /^v1\.(newer|older)(-inclusive)?\.(\d{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function encodeCatalogReviewCursor(
  direction: CatalogReviewArchiveListCursor["direction"],
  archive: Pick<OriginalDiscArchive, "archivedAt" | "id">,
  inclusive = false,
): string {
  return `v1.${direction}${inclusive ? "-inclusive" : ""}.${archive.archivedAt.getTime()}.${archive.id}`;
}

export function parseDashboardCatalogReviewCursor(
  request: Request,
): CatalogReviewArchiveListCursor | null | undefined {
  const value = new URL(request.url).searchParams.get("catalogReviewCursor");
  if (value === null) {
    return undefined;
  }
  const match = CATALOG_REVIEW_CURSOR_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const archivedAtMilliseconds = Number(match[3]);
  const archivedAt = new Date(archivedAtMilliseconds);
  if (
    !Number.isSafeInteger(archivedAtMilliseconds) ||
    Number.isNaN(archivedAt.getTime())
  ) {
    return null;
  }
  return {
    direction: match[1] as CatalogReviewArchiveListCursor["direction"],
    archivedAt,
    id: match[4] as OriginalDiscArchiveId,
    ...(match[2] === undefined ? {} : { inclusive: true }),
  };
}

export function parseDashboardCatalogReviewFilters(
  request: Request,
): DashboardCatalogReviewFilters | null {
  const parameters = new URL(request.url).searchParams;
  const viewValue = parameters.get("catalogReviewView") ?? "needs_review";
  if (viewValue !== "needs_review" && viewValue !== "reviewed") {
    return null;
  }
  const outcomeValue = parameters.get("catalogReviewOutcome");
  if (
    outcomeValue !== null &&
    outcomeValue !== "reviewed_with_selections" &&
    outcomeValue !== "archive_only"
  ) {
    return null;
  }
  const queryValue = parameters.get("catalogReviewQuery");
  if (
    (outcomeValue !== null || queryValue !== null) &&
    viewValue !== "reviewed"
  ) {
    return null;
  }
  const query = queryValue?.trim();
  if (
    queryValue !== null &&
    (query === "" || queryValue.length > 256)
  ) {
    return null;
  }
  return {
    view: viewValue,
    ...(query === undefined ? {} : { query }),
    ...(outcomeValue === null ? {} : { outcome: outcomeValue }),
  };
}

type SourceResult<T> =
  | { status: "loaded"; value: T }
  | { status: "error" };

function readSource<T>(read: () => T): SourceResult<T> {
  try {
    return { status: "loaded", value: read() };
  } catch {
    return { status: "error" };
  }
}

function loaded<T>(items: T[]): DashboardSectionResult<T> {
  return { status: "loaded", items };
}

function unavailable<T>(): DashboardSectionResult<T> {
  return { status: "error" };
}

type OpticalDriveRecord = ReturnType<
  DataAccess["catalog"]["listOpticalDrives"]
>[number];

function driveDisplayName(drive: OpticalDriveRecord): string {
  return drive.displayName ?? "Unnamed Optical Drive";
}

interface DiscInspectionFailurePresentation {
  explanation: string;
  suggestedAction: string;
  retryability: InvestigationRetryability;
}

const DISC_INSPECTION_FAILURE_PRESENTATIONS: Record<
  DiscInspectionReasonCode,
  DiscInspectionFailurePresentation
> = {
  no_medium: {
    explanation: "No disc was present when the Disc Inspection failed.",
    suggestedAction:
      "Insert the expected disc, wait for the Optical Drive to become ready, then retry the Disc Inspection.",
    retryability: "after_action",
  },
  media_changed: {
    explanation:
      "The inserted disc was removed or replaced during the Disc Inspection.",
    suggestedAction:
      "Keep one disc inserted for the full inspection, then retry the Disc Inspection.",
    retryability: "after_action",
  },
  drive_identity_changed: {
    explanation:
      "The Optical Drive identity changed during the Disc Inspection.",
    suggestedAction:
      "Restore the configured Optical Drive and its host connection, then retry the Disc Inspection.",
    retryability: "after_action",
  },
  drive_unavailable: {
    explanation:
      "The configured Optical Drive became unavailable during the Disc Inspection.",
    suggestedAction:
      "Check that the Optical Drive is connected, enabled, and available to the Archive Worker, then retry the Disc Inspection.",
    retryability: "after_action",
  },
  drive_not_ready: {
    explanation:
      "The Optical Drive did not become ready for the Disc Inspection.",
    suggestedAction:
      "Check that the disc is fully inserted and the Optical Drive has settled, then retry the Disc Inspection.",
    retryability: "after_action",
  },
  metadata_read_failed: {
    explanation:
      "The Archive Worker could not read the DVD metadata needed to identify the disc.",
    suggestedAction:
      "Retry the Disc Inspection once. If it fails again, inspect the disc and verify the DVD metadata tools on the Archive Worker host.",
    retryability: "appropriate",
  },
  invalid_metadata: {
    explanation:
      "The DVD metadata did not satisfy the Disc Inspection requirements.",
    suggestedAction:
      "Inspect the disc and verify the DVD metadata tools on the Archive Worker host before retrying the Disc Inspection.",
    retryability: "after_action",
  },
  content_size_failed: {
    explanation:
      "The Archive Worker could not determine the DVD content size during the Disc Inspection.",
    suggestedAction:
      "Check that the disc and Optical Drive are readable, then retry the Disc Inspection.",
    retryability: "after_action",
  },
  content_read_failed: {
    explanation:
      "The Archive Worker could not read the DVD content needed to identify the disc.",
    suggestedAction:
      "Retry the Disc Inspection once. If it fails again, inspect the disc and Optical Drive.",
    retryability: "appropriate",
  },
  invalid_content: {
    explanation:
      "The DVD content did not satisfy the Disc Inspection requirements.",
    suggestedAction:
      "Inspect the disc and verify the DVD tools on the Archive Worker host before retrying the Disc Inspection.",
    retryability: "after_action",
  },
  worker_interrupted: {
    explanation:
      "The Archive Worker stopped before the Disc Inspection attempt completed.",
    suggestedAction:
      "Confirm that the Archive Worker is running, then retry the Disc Inspection.",
    retryability: "appropriate",
  },
  operator_cancelled: {
    explanation: "An operator cancelled the Disc Inspection.",
    suggestedAction:
      "No retry is needed unless the inserted disc still needs to be identified.",
    retryability: "not_appropriate",
  },
  unknown: {
    explanation:
      "The Disc Inspection failed for an unclassified reason.",
    suggestedAction:
      "Retry the Disc Inspection once. If it fails again, include this report when asking for support.",
    retryability: "appropriate",
  },
};

const DISC_INSPECTION_PHASE_LABELS: Record<DiscInspectionPhase, string> = {
  settling: "Settling",
  reading_metadata: "Reading metadata",
  hashing_content: "Hashing content",
  confirming_media: "Confirming media",
  retry_wait: "Retry wait",
};

function discInspectionInvestigation(
  inspection: DiscInspection,
): DashboardInvestigation {
  const reasonCode = inspection.reasonCode ?? "unknown";
  const presentation = DISC_INSPECTION_FAILURE_PRESENTATIONS[reasonCode];
  const retryability = inspection.manualRetryRequestedAt === null
    ? presentation.retryability
    : "not_appropriate";
  const retryabilityDetail = inspection.manualRetryRequestedAt !== null
    ? "A manual retry is already queued for this Disc Inspection."
    : retryability === "appropriate"
      ? "A manual retry is available for the current inserted disc."
      : retryability === "after_action"
        ? "A manual retry is available after completing the suggested action."
        : "Retrying is not useful unless the inserted disc still needs inspection.";
  return {
    incidentId: `disc-inspection-failure:${inspection.id}`,
    worker: "Archive Worker",
    subjectType: "Disc Inspection",
    subjectId: inspection.id,
    attempt: inspection.attemptCount,
    reasonCode: `disc_inspection.${reasonCode}`,
    failedPhase: DISC_INSPECTION_PHASE_LABELS[inspection.phase],
    occurredAt: (inspection.completedAt ?? inspection.updatedAt).toISOString(),
    retryability,
    retryabilityDetail,
    explanation: presentation.explanation,
    suggestedAction: inspection.manualRetryRequestedAt === null
      ? presentation.suggestedAction
      : "Wait for the Archive Worker to start the queued retry.",
    technicalEvidence: [],
  };
}

interface ArchiveReadFailurePresentation {
  summary: string;
  explanation: string;
  suggestedAction: string;
  retryability: Exclude<InvestigationRetryability, "not_appropriate">;
}

const READ_FAILURE_PRESENTATIONS: Record<
  NonNullable<ArchiveJob["readFailureCategory"]>,
  ArchiveReadFailurePresentation
> = {
  unknown: {
    summary:
      "The Optical Drive returned an unclassified read failure. Retry the Archive Request; if it fails again, inspect the disc and drive.",
    explanation: "The Optical Drive returned an unclassified read failure.",
    suggestedAction:
      "Retry the Archive Request once. If it fails again, inspect the disc and Optical Drive and include this report when asking for support.",
    retryability: "appropriate",
  },
  not_ready: {
    summary:
      "The Optical Drive was not ready to read the disc. Check that the disc is inserted and the drive is available, then retry the Archive Request.",
    explanation: "The Optical Drive was not ready to read the disc.",
    suggestedAction:
      "Check that the expected disc is inserted and the Optical Drive is available, then retry the Archive Request.",
    retryability: "after_action",
  },
  unit_attention: {
    summary:
      "The Optical Drive reported a media-state change. Confirm that the expected disc is still inserted, then retry the Archive Request.",
    explanation: "The Optical Drive reported a media-state change.",
    suggestedAction:
      "Confirm that the expected disc is still inserted, then retry the Archive Request.",
    retryability: "after_action",
  },
  hardware_error: {
    summary:
      "The Optical Drive reported a hardware fault. Retry the Archive Request; if it fails again with another disc, inspect or replace the Optical Drive.",
    explanation: "The Optical Drive reported a hardware fault.",
    suggestedAction:
      "Retry the Archive Request once. If another disc fails the same way, inspect or replace the Optical Drive.",
    retryability: "appropriate",
  },
  transport_error: {
    summary:
      "Communication with the Optical Drive failed. Check the drive connection and host passthrough, then retry the Archive Request.",
    explanation: "Communication with the Optical Drive failed.",
    suggestedAction:
      "Check the Optical Drive connection and host passthrough, then retry the Archive Request.",
    retryability: "after_action",
  },
  protection_error: {
    summary:
      "DVD copy protection or region access failed. Check DVD CSS support and the Optical Drive region, then retry the Archive Request.",
    explanation: "DVD copy protection or region access failed.",
    suggestedAction:
      "Correct DVD CSS support or the Optical Drive region, then retry the Archive Request.",
    retryability: "after_action",
  },
  out_of_range: {
    summary:
      "The Optical Drive reported a capacity or readable-boundary mismatch. Retry the Archive Request or manually choose another Optical Drive.",
    explanation:
      "The Optical Drive reported a capacity or readable-boundary mismatch.",
    suggestedAction:
      "Retry the Archive Request with another Optical Drive, or confirm the current drive reports the disc boundary consistently before retrying.",
    retryability: "after_action",
  },
};
const MISSING_READ_FAILURE_DETAIL =
  "The Archive Job failed with an unknown diagnostic because structured read evidence is unavailable.";

function archiveJobFailure(job: ArchiveJob | undefined): string | null {
  if (job?.readFailureCategory) {
    return READ_FAILURE_PRESENTATIONS[job.readFailureCategory].summary;
  }
  if (job?.status === "failed" && job.failureDetailVersion === null) {
    return MISSING_READ_FAILURE_DETAIL;
  }
  return formatFailureDetail(job?.errorMessage ?? null);
}

const ARCHIVE_PHASE_LABELS: Record<ArchiveProgressPhase, string> = {
  preparing: "Preparation",
  copying: "Copying",
  verifying: "Verification",
  finalizing: "Finalization",
};

function archiveReadFailureEvidence(
  job: ArchiveJob,
): DashboardInvestigation["technicalEvidence"] {
  if (job.readFailureCategory === null) {
    return [];
  }
  const recorded = (value: number | string | null): string =>
    value === null ? "Not recorded" : String(value);
  return [
    {
      label: "Read stage",
      value: job.readFailureStage === "rescue_resume"
        ? "Rescue resume"
        : "Initial copy",
    },
    { label: "Failing LBA", value: recorded(job.readFailureLba) },
    {
      label: "Requested block count",
      value: recorded(job.readFailureRequestedBlockCount),
    },
    { label: "Retry ordinal", value: recorded(job.readFailureRetryCount) },
    { label: "SCSI status", value: recorded(job.readFailureScsiStatus) },
    { label: "Host status", value: recorded(job.readFailureHostStatus) },
    { label: "Driver status", value: recorded(job.readFailureDriverStatus) },
    { label: "Sense key", value: recorded(job.readFailureSenseKey) },
    { label: "ASC", value: recorded(job.readFailureAsc) },
    { label: "ASCQ", value: recorded(job.readFailureAscq) },
    {
      label: "Classifier version",
      value: job.readFailureClassifierVersion === "scsi-read-classifier-v1" ||
          job.readFailureClassifierVersion === "scsi-read-classifier-v2"
        ? job.readFailureClassifierVersion
        : "Unrecognized classifier version",
    },
  ];
}

function archiveJobInvestigation({
  job,
  requestStatus,
  discStatus,
  isLatestAttempt,
}: {
  job: ArchiveJob;
  requestStatus: ArchiveRequestStatus | null;
  discStatus: DetectedDiscStatus | null;
  isLatestAttempt: boolean;
}): DashboardInvestigation {
  const presentation = job.readFailureCategory === null
    ? {
        explanation: archiveJobFailure(job) ??
          "The Archive Job failed without a recorded explanation.",
        suggestedAction:
          "Review the Archive Worker configuration and host state, then retry the Archive Request. If the failure repeats, include this report when asking for support.",
        retryability: "after_action" as const,
      }
    : READ_FAILURE_PRESENTATIONS[job.readFailureCategory];
  const retryIsAvailable =
    isLatestAttempt &&
    requestStatus === "needs_attention" &&
    isArchiveJobRetryable(
      job,
      discStatus === null ? undefined : { status: discStatus },
    );
  const retryability: InvestigationRetryability = retryIsAvailable
    ? presentation.retryability
    : "not_appropriate";
  const retryGuidance = retryIsAvailable
    ? {
        detail: presentation.retryability === "appropriate"
          ? "The current Archive Request is waiting for a retry."
          : "The current Archive Request can be retried after completing the suggested action.",
        suggestedAction: presentation.suggestedAction,
      }
    : !isLatestAttempt
      ? {
          detail: "A newer Archive Job attempt exists for this Archive Request.",
          suggestedAction:
            "Investigate the latest Archive Job attempt. Retry belongs to the Archive Request, not this historical attempt.",
        }
      : requestStatus === "fulfilled"
        ? {
            detail: "The Archive Request was fulfilled by another attempt.",
            suggestedAction:
              "No retry is needed. Keep this report only if the historical failure still needs investigation.",
          }
        : requestStatus === "cancelled"
          ? {
              detail: "The Archive Request was cancelled.",
              suggestedAction:
                "No retry is available for the cancelled Archive Request.",
            }
          : {
              detail:
                "The Archive Request is not currently waiting for a retry.",
              suggestedAction:
                "Review the current Archive Request state before deciding whether to retry.",
            };
  return {
    incidentId: `archive-job-failure:${job.id}`,
    worker: "Archive Worker",
    subjectType: "Archive Job",
    subjectId: job.id,
    attempt: job.attemptOrdinal,
    reasonCode: job.readFailureCategory === null
      ? job.failureDetailVersion === null
        ? "archive_failure.legacy"
        : "archive_failure.unclassified"
      : `archive_read.${job.readFailureCategory}`,
    failedPhase: job.readFailureStage === null
      ? ARCHIVE_PHASE_LABELS[job.progressPhase]
      : "Copying",
    occurredAt: (job.completedAt ?? job.updatedAt).toISOString(),
    retryability,
    retryabilityDetail: retryGuidance.detail,
    explanation: presentation.explanation,
    suggestedAction: retryGuidance.suggestedAction,
    technicalEvidence: archiveReadFailureEvidence(job),
  };
}

const ENCODE_PHASE_LABELS: Record<
  EncodeJobFailureReport["phase"] | EncodeProgressPhase,
  string
> = {
  preparation: "Preparation",
  scanning: "Scanning",
  previewing: "Previewing",
  encoding: "Encoding",
  validation: "Validation",
  cleanup: "Cleanup",
  publication: "Publication",
  recovery: "Recovery",
};

const ENCODE_FAILURE_PHASE_LABELS: Record<
  EncodeJobFailureReport["phase"],
  string
> = ENCODE_PHASE_LABELS;

const ENCODE_VALIDATION_CHECK_PRESENTATIONS = {
  subtitle_streams: {
    evidence: "Subtitle streams",
    explanation:
      "The encoded file's subtitle streams did not match the selected DVD title.",
    suggestedAction:
      "Verify the selected DVD title and subtitle metadata, then retry the Encode Job.",
  },
  subtitle_packets: {
    evidence: "Subtitle packet scan",
    explanation:
      "The encoded file's subtitle packets were missing or unreadable.",
    suggestedAction:
      "Retry the Encode Job. If the subtitle packet scan fails again, copy this report when asking for support.",
  },
  subtitle_cleanup: {
    evidence: "Subtitle cleanup",
    explanation: "The worker could not remove an empty subtitle stream safely.",
    suggestedAction:
      "Retry the Encode Job. If subtitle cleanup fails again, copy this report when asking for support.",
  },
  video_metadata: {
    evidence: "Video metadata",
    explanation: "The encoded file has incomplete video stream metadata.",
    suggestedAction:
      "Retry the Encode Job. If video metadata is still incomplete, copy this report when asking for support.",
  },
  duration_metadata: {
    evidence: "Duration metadata",
    explanation: "The encoded file has no usable duration measurement.",
    suggestedAction:
      "Verify the selected DVD title metadata, then retry the Encode Job.",
  },
  video_packets: {
    evidence: "First video packet",
    explanation: "The encoded file has no readable first video packet.",
    suggestedAction:
      "Retry the Encode Job. If the first video packet is still unreadable, copy this report when asking for support.",
  },
  audio_timing: {
    evidence: "Audio and video timing",
    explanation:
      "The encoded file's first video frame starts too far after its audio.",
    suggestedAction:
      "Retry the Encode Job. If the timing check fails again, copy this report when asking for support.",
  },
  video_decode: {
    evidence: "Bounded video decode",
    explanation: "The encoded file failed the bounded video decode check.",
    suggestedAction:
      "Retry the Encode Job. If the bounded video decode fails again, copy this report when asking for support.",
  },
  output_file: {
    evidence: "Output file",
    explanation:
      "HandBrake did not leave a non-empty regular file for validation.",
    suggestedAction:
      "Check free space and output permissions, then retry the Encode Job.",
  },
} satisfies Record<
  Extract<
    EncodeJobFailureReport["evidence"],
    { kind: "validation_check" }
  >["check"],
  { evidence: string; explanation: string; suggestedAction: string }
>;

const ENCODE_FAILURE_PRESENTATIONS = {
  input_unavailable: {
    explanation:
      "The Encode Worker could not read the selected Original Disc Archive or its catalog input.",
    suggestedAction:
      "Verify the Original Disc Archive and Catalog Review, then retry the Encode Job.",
  },
  invalid_configuration: {
    explanation:
      "The Encoding Profile is missing or has settings the Encode Worker cannot use.",
    suggestedAction:
      "Correct or reactivate the Encoding Profile, then retry the Encode Job.",
  },
  output_conflict: {
    explanation:
      "The requested output is already owned or changed while the Encode Job was running.",
    suggestedAction:
      "Resolve the competing output or choose a different output path, then retry the Encode Job.",
  },
  unsafe_output_state: {
    explanation:
      "The output path or file state did not pass the worker's safety checks.",
    suggestedAction:
      "Check output permissions and free space, and remove symlinks or ambiguous files from the output location before retrying the Encode Job.",
  },
  command_failed: {
    explanation: "HandBrake exited without completing the Encode Job.",
    suggestedAction:
      "Retry the Encode Job. If the same command failure repeats, copy this report when asking for support.",
  },
  command_timeout: {
    explanation: "HandBrake did not finish within the command time limit.",
    suggestedAction:
      "Retry the Encode Job. If it reaches the time limit again, copy this report when asking for support.",
  },
  output_validation_failed: {
    explanation: "The encoded file failed validation.",
    suggestedAction:
      "Review the Encode Job inputs, then retry the Encode Job.",
  },
  unknown_failure: {
    explanation: "The Encode Worker could not classify this failure.",
    suggestedAction:
      "Review the output location for an obvious conflict, then retry once. Copy this report if the failure repeats.",
  },
  cleanup_failed: {
    explanation:
      "The Encode Worker could not finish a required output cleanup operation.",
    suggestedAction:
      "Keep the Encode Worker running so it can retry cleanup. If the Encode Job remains blocked, restart the worker and copy this report when asking for support.",
  },
  publication_failed: {
    explanation:
      "The Encode Worker could not safely finish publishing the validated output.",
    suggestedAction:
      "Leave the output files in place and let publication reconciliation run. If recovery keeps failing, copy this report when asking for support.",
  },
  lease_expired: {
    explanation:
      "Encode Job ownership expired before the active work reached a durable terminal state.",
    suggestedAction:
      "Confirm that the Encode Worker is running, wait for its cleanup pass to finish, then retry the Encode Job.",
  },
  worker_interrupted: {
    explanation:
      "The Encode Worker stopped before the active phase reached a durable terminal state.",
    suggestedAction:
      "Restart or resume the Encode Worker, wait for cleanup or publication recovery to finish, then retry the Encode Job if it failed.",
  },
  publication_recovery_failed: {
    explanation:
      "The Encode Worker could not reconcile output state left by an interrupted publication.",
    suggestedAction:
      "Leave the output files in place and restart the Encode Worker. If reconciliation fails again, copy this report when asking for support.",
  },
} satisfies Record<
  EncodeJobFailureReport["reasonCode"],
  { explanation: string; suggestedAction: string }
>;

interface EncodeFailureEvidencePresentation {
  technicalEvidence: DashboardInvestigation["technicalEvidence"];
  explanation: string;
  suggestedAction: string;
}

function encodeFailureEvidencePresentation(
  report: EncodeJobFailureReport,
): EncodeFailureEvidencePresentation {
  const presentation = report.evidence.kind === "signal"
    ? {
        ...ENCODE_FAILURE_PRESENTATIONS[report.reasonCode],
        explanation: "HandBrake stopped after receiving a process signal.",
      }
    : report.evidence.kind === "duration"
      ? {
          explanation:
            "The encoded file is materially shorter than the selected DVD title.",
          suggestedAction:
            "Verify the selected DVD title and source metadata, then retry the Encode Job.",
        }
      : report.evidence.kind === "validation_check"
        ? ENCODE_VALIDATION_CHECK_PRESENTATIONS[report.evidence.check]
        : ENCODE_FAILURE_PRESENTATIONS[report.reasonCode];
  return {
    explanation: presentation.explanation,
    suggestedAction: presentation.suggestedAction,
    technicalEvidence: encodeFailureEvidence(report.evidence),
  };
}

function encodeFailureRetryGuidance(
  job: EncodeJob,
  canRetry: boolean,
  reportRetryability: EncodeJobFailureReport["retryability"] = "appropriate",
) {
  switch (job.status) {
    case "failed":
      return canRetry
        ? {
            retryability: reportRetryability,
            detail: reportRetryability === "appropriate"
              ? "Retrying starts another attempt for this logical Encode Job and keeps this report."
              : reportRetryability === "after_action"
                ? "Retry after completing the suggested action. This logical Encode Job keeps the report."
                : "Retrying unchanged is not appropriate for this failure.",
          }
        : {
            retryability: "not_appropriate" as const,
            detail:
              "Retry requires an active Disc Selection with completed Catalog Review.",
          };
    case "queued":
    case "running":
    case "cancellation_requested":
      return {
        retryability: "not_appropriate" as const,
        detail: "Another attempt or terminal transition is already in progress.",
      };
    case "completed":
      return {
        retryability: "not_appropriate" as const,
        detail:
          "This Encode Job is completed, so this report does not offer a retry.",
      };
    case "cancelled":
      return {
        retryability: "not_appropriate" as const,
        detail: "This Encode Job was cancelled after the recorded failure.",
      };
  }
}

function encodeFailureEvidence(
  evidence: EncodeJobFailureReport["evidence"],
): DashboardInvestigation["technicalEvidence"] {
  switch (evidence.kind) {
    case "exit_status":
      return [{ label: "Exit status", value: String(evidence.exitStatus) }];
    case "signal":
      return [{ label: "Termination signal", value: evidence.signal }];
    case "timeout":
      return [{
        label: "Timeout limit",
        value: `${evidence.timeoutSeconds} seconds`,
      }];
    case "duration":
      return [
        {
          label: "Expected duration",
          value: `${evidence.expectedSeconds} seconds`,
        },
        {
          label: "Observed duration",
          value: `${evidence.observedSeconds} seconds`,
        },
      ];
    case "validation_check":
      return [{
        label: "Validation check",
        value: ENCODE_VALIDATION_CHECK_PRESENTATIONS[evidence.check].evidence,
      }];
    case "none":
      return [];
    case "cleanup":
      return [{
        label: "Cleanup operation",
        value: {
          partial_output: "Partial output",
          replacement_artifact: "Replacement staging artifact",
          published_output: "Published output rollback",
          publication_completion: "Publication completion state",
        }[evidence.operation],
      }];
    case "publication":
      return [{
        label: "Publication stage",
        value: evidence.operation === "publication_mutation"
          ? "Filesystem mutation"
          : "Completion commit",
      }];
    case "lease":
      return [{
        label: "Expired lease",
        value: evidence.scope === "job_claim"
          ? "Encode Job claim"
          : "Publication cleanup",
      }];
    case "interruption":
      return [{
        label: "Interruption point",
        value: evidence.source === "worker_shutdown"
          ? "Worker shutdown"
          : "Publication completion",
      }];
    case "recovery":
      return [{
        label: "Recovery operation",
        value: evidence.operation === "publication_recovery"
          ? "Publication reconciliation"
          : "Output cleanup",
      }];
  }
}

function encodeFailureSuggestedAction(
  job: EncodeJob,
  effectiveRetryability: DashboardInvestigation["retryability"],
  classifiedAction: string,
): string {
  if (effectiveRetryability !== "not_appropriate") {
    return classifiedAction;
  }
  if (job.partialCleanupOutputPath !== null) {
    return "Keep the Encode Worker running and leave output files in place while cleanup or publication recovery finishes. No operator retry is needed while recovery is pending.";
  }
  switch (job.status) {
    case "completed":
      return "No operator action is needed for this completed Encode Job. Keep this report as historical context.";
    case "cancelled":
      return "No operator retry is needed for this cancelled Encode Job. Keep this report as historical context.";
    case "queued":
    case "running":
    case "cancellation_requested":
      return "Let the current Encode Job transition finish before deciding whether any further action is needed.";
    case "failed":
      return "Review the current Encode Job and Disc Selection state. This report does not recommend retrying unchanged.";
  }
}

function encodeJobFailureReportInvestigation(
  job: EncodeJob,
  report: EncodeJobFailureReport,
  canRetry: boolean,
): DashboardInvestigation {
  const retry = encodeFailureRetryGuidance(
    job,
    canRetry,
    report.retryability,
  );
  const presentation = encodeFailureEvidencePresentation(report);
  return {
    incidentId: report.id,
    worker: "Encode Worker",
    subjectType: "Encode Job",
    subjectId: job.id,
    attempt: null,
    reasonCode: `encode.${report.reasonCode}`,
    failedPhase: ENCODE_FAILURE_PHASE_LABELS[report.phase],
    occurredAt: report.occurredAt.toISOString(),
    retryability: retry.retryability,
    retryabilityDetail: retry.detail,
    explanation: presentation.explanation,
    suggestedAction: encodeFailureSuggestedAction(
      job,
      retry.retryability,
      presentation.suggestedAction,
    ),
    technicalEvidence: presentation.technicalEvidence,
  };
}

const WORKER_INCIDENT_RECOVERY_AREA_LABELS: Record<
  WorkerIncidentRecoveryArea,
  string
> = {
  expired_archive_job_claim: "Expired Archive Job claim",
  active_publication: "Active publication",
  expired_publication_mutation: "Expired publication mutation",
  expired_encode_job_claim: "Expired Encode Job claim",
  expired_cancellation: "Expired cancellation",
  pending_partial_cleanup: "Pending partial cleanup",
};

const WORKER_INCIDENT_PHASE_LABELS: Record<
  WorkerIncidentReasonCode,
  string
> = {
  poll_failure: "Polling",
  claim_recovery_failure: "Claim recovery",
  publication_recovery_failure: "Publication recovery",
};

function workerIncidentPresentation(incident: WorkerIncident) {
  const worker = incident.workerKind === "archive"
    ? "Archive Worker"
    : "Encode Worker";
  if (incident.reasonCode === "poll_failure") {
    return {
      worker,
      phaseLabel: WORKER_INCIDENT_PHASE_LABELS[incident.reasonCode],
      explanation:
        `${worker} could not finish a polling pass for available work.`,
      activeAction:
        `Check the ${worker} stdout and database health. The worker will retry the polling pass automatically.`,
      recoveredAction:
        `No action is needed. The ${worker} completed a later polling pass.`,
    };
  }
  if (incident.reasonCode === "claim_recovery_failure") {
    return {
      worker,
      phaseLabel: WORKER_INCIDENT_PHASE_LABELS[incident.reasonCode],
      explanation:
        "The Archive Worker could not finish part of Archive Job claim recovery.",
      activeAction:
        "Check the Archive Worker stdout and database health. The worker will retry claim recovery automatically.",
      recoveredAction:
        "No action is needed. The Archive Worker completed a later claim-recovery pass.",
    };
  }
  return {
    worker,
    phaseLabel: WORKER_INCIDENT_PHASE_LABELS[incident.reasonCode],
    explanation:
      "The Encode Worker could not finish part of publication recovery.",
    activeAction:
      "Check the Encode Worker stdout and media-library availability. The worker will retry publication recovery automatically.",
    recoveredAction:
      "No action is needed. The Encode Worker completed a later recovery pass.",
  };
}

function workerIncidentInvestigation(
  incident: WorkerIncident,
): DashboardInvestigation {
  const recovered = incident.resolvedAt !== null;
  const presentation = workerIncidentPresentation(incident);
  const technicalEvidence: DashboardInvestigation["technicalEvidence"] = [
    { label: "Occurrence count", value: String(incident.occurrenceCount) },
    {
      label: "First observed",
      value: incident.firstObservedAt.toISOString(),
    },
    {
      label: "Last observed",
      value: incident.lastObservedAt.toISOString(),
    },
    ...(incident.resolvedAt === null
      ? []
      : [{
          label: "Recovered",
          value: incident.resolvedAt.toISOString(),
        }]),
    ...("recoveryArea" in incident.evidence
      ? [{
          label: "Recovery area",
          value:
            WORKER_INCIDENT_RECOVERY_AREA_LABELS[
              incident.evidence.recoveryArea
            ],
        }]
      : []),
  ];
  return {
    incidentId: incident.id,
    worker: presentation.worker,
    subjectType: "Worker Incident",
    subjectId: incident.id,
    attempt: null,
    reasonCode: `worker.${incident.reasonCode}`,
    failedPhase: presentation.phaseLabel,
    occurredAt: incident.lastObservedAt.toISOString(),
    retryability: "not_appropriate",
    retryabilityDetail: recovered
      ? `${presentation.worker} recovered without an operator retry.`
      : `${presentation.worker} retries this phase automatically; there is no operator retry action.`,
    explanation: presentation.explanation,
    suggestedAction: recovered
      ? presentation.recoveredAction
      : presentation.activeAction,
    technicalEvidence,
  };
}

function legacyEncodeJobInvestigation(
  job: EncodeJob,
  canRetry: boolean,
): DashboardInvestigation {
  const retry = encodeFailureRetryGuidance(job, canRetry);
  return {
    incidentId: `encode-job-failure:legacy:${job.id}`,
    worker: "Encode Worker",
    subjectType: "Encode Job",
    subjectId: job.id,
    attempt: null,
    reasonCode:
      job.errorMessage === null
        ? "encode_failure.unclassified"
        : "encode_failure.legacy",
    failedPhase: job.progressPhase === null
      ? "Unclassified"
      : ENCODE_PHASE_LABELS[job.progressPhase],
    occurredAt: (job.completedAt ?? job.updatedAt).toISOString(),
    retryability: retry.retryability,
    retryabilityDetail: retry.detail,
    explanation:
      formatFailureDetail(job.errorMessage) ??
      "The Encode Worker did not record a structured failure explanation.",
    suggestedAction: retry.retryability === "appropriate"
      ? "Retry the Encode Job. If it fails again, use the new report when asking for support."
      : "Review the current Encode Job state. No retry is needed for this historical failure.",
    technicalEvidence: [],
  };
}

function readDashboardSnapshotRecords(
  access: ConsistentReadAccess,
  {
    activityLimit,
    catalogReviewCursor,
    catalogReviewView = "needs_review",
    catalogReviewQuery,
    catalogReviewOutcome,
    includeDetectedDiscDetails = true,
    includeInvestigations = true,
  }: DashboardSnapshotOptions = {},
): DashboardSnapshot {
  const opticalDriveSource = readSource(() =>
    access.catalog.listOpticalDrives(
      activityLimit === undefined
        ? undefined
        : { historicalLimit: activityLimit },
    ),
  );
  const discInspectionSource = readSource(() =>
    access.discInspections.list({ currentOnly: true }),
  );
  const currentDetectedDiscIds =
    discInspectionSource.status === "loaded"
      ? discInspectionSource.value
          .flatMap((inspection) =>
            inspection.detectedDiscId === null
              ? []
              : [inspection.detectedDiscId],
          )
          .slice(
            0,
            activityLimit === undefined
              ? undefined
              : DASHBOARD_ACTIVE_DISC_LIMIT,
          )
      : null;
  const detectedDiscSource = currentDetectedDiscIds === null
    ? { status: "error" as const }
    : readSource(() =>
        access.catalog.listDetectedDiscs(undefined, {
          ids: currentDetectedDiscIds,
        }),
      );
  const currentDetectedDiscArchiveJobOptions = {
    detectedDiscIds: currentDetectedDiscIds ?? [],
    ...(activityLimit === undefined
      ? {}
      : {
          policy: {
            mode: "active-and-history" as const,
            activeLimit: DASHBOARD_ACTIVE_JOB_LIMIT,
            historyLimit: activityLimit,
          },
        }),
  };
  const currentDetectedDiscArchiveJobSource = readSource(() =>
    access.archiveJobs.list(undefined, currentDetectedDiscArchiveJobOptions)
  );
  const currentArchiveRequestIds =
    currentDetectedDiscArchiveJobSource.status === "loaded"
    ? [...new Set(
        currentDetectedDiscArchiveJobSource.value.map((job) =>
          job.archiveRequestId
        ),
      )]
    : [];
  const archiveJobSource =
    currentDetectedDiscArchiveJobSource.status === "error"
      ? currentDetectedDiscArchiveJobSource
      : readSource(() =>
          access.archiveJobs.list(undefined, {
            ...currentDetectedDiscArchiveJobOptions,
            archiveRequestIds: currentArchiveRequestIds,
          }),
        );
  const displayedDetectedDiscIds = detectedDiscSource.status === "loaded"
    ? detectedDiscSource.value.map((disc) => disc.id)
    : [];
  const archiveRequestSource = readSource(() =>
    activityLimit === undefined
      ? access.archiveRequests.list()
      : access.archiveRequests.listRelevantForDetectedDiscs(
          [...new Set(displayedDetectedDiscIds)],
        ),
  );
  const latestRequestJobSource = readSource(() =>
    activityLimit === undefined || archiveRequestSource.status === "error"
      ? []
      : access.archiveJobs.listLatestForRequests(
          archiveRequestSource.value.map((request) => request.id),
        ),
  );
  const encodeJobSource = readSource(() =>
    access.encodeJobs.list(
      undefined,
      activityLimit === undefined
        ? undefined
        : {
            policy: {
              mode: "active-and-history",
              activeLimit: DASHBOARD_ACTIVE_JOB_LIMIT,
              historyLimit: activityLimit,
            },
      },
    ),
  );
  const encodeJobFailureReportSource = readSource(() =>
    !includeInvestigations || encodeJobSource.status === "error"
      ? []
      : access.encodeJobs.listFailureReports(
          encodeJobSource.value.map((job) => job.id),
        )
  );
  const workerIncidentSource = readSource(() => {
    const resolvedLimit = activityLimit ?? DASHBOARD_ACTIVITY_HISTORY_LIMIT;
    const incidents = WORKER_KINDS.flatMap((workerKind) =>
      access.workerIncidents.list({ workerKind, resolvedLimit })
    );
    const descendingId = (left: WorkerIncident, right: WorkerIncident) =>
      left.id < right.id ? 1 : left.id === right.id ? 0 : -1;
    const active = incidents
      .filter((incident) => incident.resolvedAt === null)
      .sort((left, right) =>
        right.lastObservedAt.getTime() - left.lastObservedAt.getTime() ||
        descendingId(left, right)
      );
    const recovered = incidents
      .filter(
        (incident): incident is WorkerIncident & { resolvedAt: Date } =>
          incident.resolvedAt !== null,
      )
      .sort((left, right) =>
        right.resolvedAt.getTime() - left.resolvedAt.getTime() ||
        right.lastObservedAt.getTime() - left.lastObservedAt.getTime() ||
        descendingId(left, right)
      )
      .slice(0, resolvedLimit);
    return [...active, ...recovered];
  });
  const encodeJobLinkSource = readSource(() =>
    encodeJobSource.status === "error"
      ? []
      : access.encodeJobs.listCorrectionLinks(
          encodeJobSource.value.map((job) => job.id),
        )
  );
  const retainedEncodeOutputSource = readSource(() =>
    encodeJobLinkSource.status === "error"
      ? []
      : access.encodeJobs.listRetainedOutputSummaries(
          encodeJobLinkSource.value.map((job) => job.id),
        )
  );
  const archiveSource = readSource(() =>
    access.catalog.listCatalogReviewArchives({
      view: catalogReviewView,
      limit: activityLimit === undefined ? 100 : activityLimit + 1,
      ...(catalogReviewCursor === undefined
        ? {}
        : { cursor: catalogReviewCursor }),
      ...(catalogReviewQuery === undefined
        ? {}
        : { query: catalogReviewQuery }),
      ...(catalogReviewOutcome === undefined
        ? {}
        : { outcome: catalogReviewOutcome }),
    }),
  );
  const catalogReviewArchives =
    archiveSource.status === "loaded" && activityLimit !== undefined
      ? catalogReviewCursor?.direction === "newer"
        ? archiveSource.value.slice(0, activityLimit)
        : archiveSource.value.slice(-activityLimit)
      : archiveSource.status === "loaded"
        ? archiveSource.value
        : [];
  const previousCatalogReviewBoundary =
    catalogReviewArchives.at(-1) ??
    (catalogReviewCursor?.direction === "older"
      ? catalogReviewCursor
      : undefined);
  const nextCatalogReviewBoundary =
    catalogReviewArchives[0] ??
    (catalogReviewCursor?.direction === "newer"
      ? catalogReviewCursor
      : undefined);
  const relevantDetectedDiscIds =
    activityLimit === undefined
      ? undefined
      : [
          ...(detectedDiscSource.status === "loaded"
            ? detectedDiscSource.value.map((disc) => disc.id)
            : []),
          ...(archiveJobSource.status === "loaded"
            ? archiveJobSource.value.map((job) => job.detectedDiscId)
            : []),
          ...catalogReviewArchives.map((archive) => archive.detectedDiscId),
        ];
  const linkedDetectedDiscSource =
    activityLimit === undefined
      ? detectedDiscSource
      : readSource(() =>
          access.catalog.listDetectedDiscs(undefined, {
            ids: [...new Set(relevantDetectedDiscIds ?? [])],
          }),
        );
  const relevantOpticalDriveIds =
    activityLimit === undefined
      ? undefined
      : [
          ...(opticalDriveSource.status === "loaded"
            ? opticalDriveSource.value.map((drive) => drive.id)
            : []),
          ...(linkedDetectedDiscSource.status === "loaded"
            ? linkedDetectedDiscSource.value.map((disc) => disc.opticalDriveId)
            : []),
        ];
  const linkedOpticalDriveSource =
    activityLimit === undefined
      ? opticalDriveSource
      : readSource(() =>
          access.catalog.listOpticalDrives({
            ids: [...new Set(relevantOpticalDriveIds ?? [])],
          }),
        );
  const relevantSelectionIds = encodeJobSource.status === "error"
    ? []
    : encodeJobSource.value.map((job) => job.discSelectionId);
  const selectionSource = readSource(() =>
    access.catalog.listDiscSelections({
      ids: [...new Set(relevantSelectionIds)],
    }),
  );
  const selectionSupersessionSource = readSource(() => {
    const selectionIds = [...new Set(relevantSelectionIds)];
    return Array.from(
      { length: Math.ceil(selectionIds.length / 100) },
      (_, page) => access.catalog.listDiscSelectionSupersessions({
        discSelectionIds: selectionIds.slice(page * 100, (page + 1) * 100),
      }),
    ).flat();
  });
  const correctedSelectionSource = readSource(() =>
    selectionSupersessionSource.status === "error"
      ? []
      : access.catalog.listDiscSelections({
          ids: [...new Set(selectionSupersessionSource.value.map(
            (supersession) => supersession.replacementDiscSelectionId,
          ))],
        }),
  );
  const terminalSelectionIds =
    encodeJobSource.status === "loaded"
      ? encodeJobSource.value
          .filter((job) => isTerminalEncodeJobStatus(job.status))
          .map((job) => job.discSelectionId)
      : [];
  const terminalRequeueSelectionSource = readSource(() =>
    terminalSelectionIds.length === 0
      ? []
      : access.catalog.listDiscSelections({
          ids: [...new Set(terminalSelectionIds)],
          encodeEligibleOnly: true,
        }),
  );
  const relevantMediaItemIds =
    selectionSource.status === "error" ||
      correctedSelectionSource.status === "error"
      ? []
      : [...selectionSource.value, ...correctedSelectionSource.value].map(
          (selection) => selection.mediaItemId,
        );
  const mediaItemSource = readSource(() =>
    access.catalog.listMediaItems({
      ids: [...new Set(relevantMediaItemIds)],
    }),
  );
  const relevantProfileIds =
    activityLimit === undefined
      ? undefined
      : encodeJobSource.status === "error"
        ? []
        : encodeJobSource.value.map((job) => job.encodingProfileId);
  const profileSource = readSource(() =>
    access.encodingProfiles.list(
      relevantProfileIds === undefined
        ? undefined
        : { ids: [...new Set(relevantProfileIds)] },
    ),
  );
  const drivesById =
    linkedOpticalDriveSource.status === "loaded"
      ? new Map(
          linkedOpticalDriveSource.value.map((drive) => [drive.id, drive]),
        )
      : null;
  const currentInspectionByDrive =
    discInspectionSource.status === "loaded"
      ? new Map(
          discInspectionSource.value.map((inspection) => [
            inspection.opticalDriveId,
            inspection,
          ]),
        )
      : null;
  const discsById =
    linkedDetectedDiscSource.status === "loaded"
      ? new Map(
          linkedDetectedDiscSource.value.map((disc) => [disc.id, disc]),
        )
      : null;
  const jobsByRequestId =
    archiveJobSource.status === "loaded" &&
    latestRequestJobSource.status === "loaded"
    ? [...new Map(
        [...archiveJobSource.value, ...latestRequestJobSource.value]
          .map((job) => [job.id, job]),
      ).values()].reduce((grouped, job) => {
        const jobs = grouped.get(job.archiveRequestId) ?? [];
        jobs.push(job);
        grouped.set(job.archiveRequestId, jobs);
        return grouped;
      }, new Map<
        (typeof archiveJobSource.value)[number]["archiveRequestId"],
        (typeof archiveJobSource.value)[number][]
      >())
    : null;
  const requestByDiscId = archiveRequestSource.status === "loaded"
    ? archiveRequestSource.value.reduce((requests, request) => {
        const existing = requests.get(request.detectedDiscId);
        const requestIsActive = !["fulfilled", "cancelled"].includes(
          request.status,
        );
        const existingIsActive =
          existing !== undefined &&
          !["fulfilled", "cancelled"].includes(existing.status);
        if (
          existing === undefined ||
          (requestIsActive && !existingIsActive) ||
          (requestIsActive === existingIsActive &&
            request.updatedAt > existing.updatedAt)
        ) {
          requests.set(request.detectedDiscId, request);
        }
        return requests;
      }, new Map<
        (typeof archiveRequestSource.value)[number]["detectedDiscId"],
        (typeof archiveRequestSource.value)[number]
      >())
    : null;
  const requestsById = archiveRequestSource.status === "loaded"
    ? new Map(
        archiveRequestSource.value.map((request) => [request.id, request]),
      )
    : null;

  const opticalDrives =
    opticalDriveSource.status === "error" ||
    currentInspectionByDrive === null
      ? unavailable<DashboardOpticalDrive>()
      : loaded(
          opticalDriveSource.value.map((drive): DashboardOpticalDrive => {
            const inspection = currentInspectionByDrive.get(drive.id);
            return {
              id: drive.id,
              displayName: driveDisplayName(drive),
              hardwareName:
                [drive.vendor, drive.product].filter(Boolean).join(" ") || null,
              state: !drive.isPresent
                ? "missing"
                : drive.isEnabled
                  ? "ready"
                  : "disabled",
              lastSeenAt: drive.lastSeenAt.toISOString(),
              currentInspection: inspection === undefined ? null : {
                id: inspection.id,
                activityRevision: inspection.updatedAt.toISOString(),
                status: inspection.status,
                phase: inspection.phase,
                attemptCount: inspection.attemptCount,
                consecutiveFailureCount: inspection.consecutiveFailureCount,
                volumeLabel: inspection.volumeLabel,
                titleCount: inspection.titleCount,
                chapterCount: inspection.chapterCount,
                audioStreamCount: inspection.audioStreamCount,
                subtitleStreamCount: inspection.subtitleStreamCount,
                totalBytes: inspection.totalBytes,
                bytesHashed: inspection.bytesHashed,
                bytesPerSecond: inspection.bytesPerSecond,
                etaSeconds: inspection.etaSeconds,
                retryAt: inspection.retryAt?.toISOString() ?? null,
                manualRetryRequested:
                  inspection.manualRetryRequestedAt !== null,
                reasonCode: inspection.reasonCode,
                archiveWorkFulfilled:
                  inspection.detectedDiscId !== null &&
                  requestByDiscId?.get(inspection.detectedDiscId)?.status ===
                    "fulfilled",
                phaseStartedAt: inspection.phaseStartedAt.toISOString(),
                startedAt: inspection.startedAt.toISOString(),
                completedAt: inspection.completedAt?.toISOString() ?? null,
                ...(inspection.status === "failed" && includeInvestigations
                  ? {
                      investigation: discInspectionInvestigation(inspection),
                    }
                  : {}),
              },
            };
          }),
        );

  const detectedDiscs =
    detectedDiscSource.status === "error" ||
    drivesById === null ||
    requestByDiscId === null ||
    jobsByRequestId === null
      ? unavailable<DashboardDetectedDisc>()
      : (() => {
          return loaded(
            detectedDiscSource.value.map((disc) => {
              const drive = drivesById.get(disc.opticalDriveId);
              const request = requestByDiscId.get(disc.id);
              const requestJobs = request === undefined
                ? []
                : (jobsByRequestId.get(request.id) ?? []);
              const latestJob = requestJobs.toSorted(
                (left, right) => right.attemptOrdinal - left.attemptOrdinal,
              )[0];
              return {
                id: disc.id,
                volumeLabel: disc.volumeLabel ?? "Unlabeled disc",
                discKind: disc.discKind,
                status: disc.status,
                opticalDriveName: drive
                  ? driveDisplayName(drive)
                  : "Unknown Optical Drive",
                fingerprint: disc.fingerprint,
                titles: includeDetectedDiscDetails
                  ? (decodeDvdTitleMap(disc.scanData)?.titles ?? [])
                  : [],
                detectedAt: disc.detectedAt.toISOString(),
                archiveRequest: request === undefined ? null : {
                  id: request.id,
                  status: request.status,
                  attemptCount: latestJob?.attemptOrdinal ?? 0,
                  latestFailureDetail: archiveJobFailure(latestJob),
                  createdAt: request.createdAt.toISOString(),
                  updatedAt: request.updatedAt.toISOString(),
                },
              };
            }),
          );
        })();

  const latestDisplayedArchiveJobIdByRequest =
    archiveJobSource.status === "loaded"
      ? archiveJobSource.value.reduce((latestByRequest, job) => {
          const latest = latestByRequest.get(job.archiveRequestId);
          if (
            latest === undefined ||
            job.attemptOrdinal > latest.attemptOrdinal
          ) {
            latestByRequest.set(job.archiveRequestId, job);
          }
          return latestByRequest;
        }, new Map<ArchiveJob["archiveRequestId"], ArchiveJob>())
      : null;

  const archiveJobs =
    archiveJobSource.status === "error" ||
    currentDetectedDiscIds === null ||
    drivesById === null ||
    discsById === null
      ? unavailable<DashboardArchiveJob>()
      : loaded(
          archiveJobSource.value.map((job) => {
            const disc = discsById.get(job.detectedDiscId);
            const drive = disc
              ? drivesById.get(disc.opticalDriveId)
              : undefined;
            return {
              id: job.id,
              activityRevision: job.updatedAt.toISOString(),
              archiveRequestId: job.archiveRequestId,
              attemptOrdinal: job.attemptOrdinal,
              detectedDiscId: job.detectedDiscId,
              discLabel: disc?.volumeLabel ?? "Unlabeled disc",
              opticalDriveName: drive
                ? driveDisplayName(drive)
                : "Unknown Optical Drive",
              status: job.status,
              progressPhase: job.progressPhase,
              progressPercent: job.progressPercent,
              progressBytes: job.progressBytes,
              ...(job.status === "running"
                ? { progressEtaSeconds: job.progressEtaSeconds }
                : {}),
              lastProgressAt: job.lastProgressAt.toISOString(),
              ...(job.status === "failed" && includeInvestigations
                ? {
                    investigation: archiveJobInvestigation({
                      job,
                      requestStatus:
                        requestsById?.get(job.archiveRequestId)?.status ?? null,
                      discStatus: disc?.status ?? null,
                      isLatestAttempt:
                        latestDisplayedArchiveJobIdByRequest
                          ?.get(job.archiveRequestId)?.id === job.id,
                    }),
                  }
                : {}),
            };
          }),
        );

  const encodeJobs =
    encodeJobSource.status === "error" ||
    encodeJobFailureReportSource.status === "error" ||
    encodeJobLinkSource.status === "error" ||
    retainedEncodeOutputSource.status === "error" ||
    selectionSource.status === "error" ||
    selectionSupersessionSource.status === "error" ||
    correctedSelectionSource.status === "error" ||
    terminalRequeueSelectionSource.status === "error" ||
    mediaItemSource.status === "error" ||
    profileSource.status === "error"
      ? unavailable<DashboardEncodeJob>()
      : (() => {
          const selectionsById = new Map(
            selectionSource.value.map((selection) => [
              selection.id,
              selection,
            ]),
          );
          const correctedSelectionsById = new Map(
            correctedSelectionSource.value.map((selection) => [
              selection.id,
              selection,
            ]),
          );
          const supersessionsBySelectionId = new Map(
            selectionSupersessionSource.value.map((supersession) => [
              supersession.supersededDiscSelectionId,
              supersession,
            ]),
          );
          const mediaItemsById = new Map(
            mediaItemSource.value.map((item) => [item.id, item]),
          );
          const profilesById = new Map(
            profileSource.value.map((profile) => [profile.id, profile]),
          );
          const terminalRequeueSelectionIds = new Set(
            terminalRequeueSelectionSource.value.map(
              (selection) => selection.id,
            ),
          );
          const relationshipJobs = encodeJobLinkSource.value;
          const encodeJobsById = new Map(
            relationshipJobs.map((job) => [job.id, job]),
          );
          const successorByPredecessorId = new Map(
            relationshipJobs.flatMap((job) =>
              job.predecessorEncodeJobId === null
                ? []
                : [[job.predecessorEncodeJobId, job] as const]
            ),
          );
          const retainedOutputByReplacementId = new Map(
            retainedEncodeOutputSource.value.map((output) => [
              output.replacementEncodeJobId,
              output,
            ]),
          );
          const failureReportsByJobId = encodeJobFailureReportSource.value
            .reduce((reportsByJobId, report) => {
              const reports = reportsByJobId.get(report.encodeJobId) ?? [];
              reports.push(report);
              reportsByJobId.set(report.encodeJobId, reports);
              return reportsByJobId;
            }, new Map<EncodeJobId, EncodeJobFailureReport[]>());
          return loaded(
            encodeJobSource.value.map((job) => {
              const relationshipJob = encodeJobsById.get(job.id);
              const selection = selectionsById.get(job.discSelectionId);
              const mediaItem = selection
                ? mediaItemsById.get(selection.mediaItemId)
                : undefined;
              const profile = profilesById.get(job.encodingProfileId);
              const supersession = supersessionsBySelectionId.get(
                job.discSelectionId,
              );
              const correctedSelection = supersession
                ? correctedSelectionsById.get(
                    supersession.replacementDiscSelectionId,
                  )
                : undefined;
              const correctedMediaItem = correctedSelection
                ? mediaItemsById.get(correctedSelection.mediaItemId)
                : undefined;
              const predecessor = job.predecessorEncodeJobId === null
                ? undefined
                : encodeJobsById.get(job.predecessorEncodeJobId);
              const successor = successorByPredecessorId.get(job.id);
              const correctedJob = predecessor
                ? relationshipJob
                : successor;
              const retainedOutput = correctedJob
                ? retainedOutputByReplacementId.get(correctedJob.id)
                : undefined;
              const priorOutput = retainedOutput
                ? {
                    state: "retained" as const,
                    cleanupEligible: retainedOutput.cleanupEligible,
                  }
                : correctedJob?.replaceExistingOutput
                  ? {
                      state: "protected" as const,
                      cleanupEligible: false,
                    }
                  : undefined;
              const failureReports = failureReportsByJobId.get(job.id) ?? [];
              const canRequeue = terminalRequeueSelectionIds.has(
                job.discSelectionId,
              );
              const structuredInvestigations = failureReports.map((report) =>
                encodeJobFailureReportInvestigation(job, report, canRequeue)
              );
              const primaryFailureIsUnclassified = job.status === "failed" &&
                includeInvestigations &&
                !failureReports.some(
                  ({ reasonCode }) =>
                    reasonCode !== "cleanup_failed" &&
                    reasonCode !== "publication_recovery_failed",
                );
              const investigations = [
                ...structuredInvestigations,
                ...(primaryFailureIsUnclassified
                  ? [legacyEncodeJobInvestigation(job, canRequeue)]
                  : []),
              ];
              return {
                id: job.id,
                mediaTitle: mediaItem?.title ?? "Unknown Media Item",
                mediaYear: mediaItem?.year ?? null,
                encodingProfileName:
                  profile
                    ? `${profile.displayName} · Version ${profile.version}`
                    : "Unknown Encoding Profile",
                status: job.status,
                progressPhase: job.progressPhase,
                progressPercent: job.progressPercent,
                progressEtaSeconds: job.progressEtaSeconds,
                ...(predecessor || successor
                  ? {
                      correctedReplacement: {
                        ...(predecessor
                          ? {
                              predecessorId: predecessor.id,
                              predecessorStatus: predecessor.status,
                              predecessorReady:
                                isEncodeJobSafelyTerminal(predecessor),
                            }
                          : {}),
                        ...(successor
                          ? {
                              successorId: successor.id,
                              successorStatus: successor.status,
                            }
                          : {}),
                        ...(priorOutput === undefined
                          ? {}
                          : { priorOutput }),
                      },
                    }
                  : {}),
                ...(supersession === undefined
                  ? {}
                  : {
                      discSelectionCorrection: {
                        replacementDiscSelectionId:
                          supersession.replacementDiscSelectionId,
                        correctedMediaTitle:
                          correctedMediaItem?.title ?? "Unknown Media Item",
                        reason: supersession.reason,
                      },
                    }),
                ...(isTerminalEncodeJobStatus(job.status)
                  ? {
                      requeueable: canRequeue,
                    }
                  : {}),
                failureDetail: formatFailureDetail(job.errorMessage),
                ...(investigations.length === 0 ? {} : { investigations }),
                verificationStatus: job.verificationStatus,
                verificationMessage: job.verificationMessage,
                verifiedAt: job.verifiedAt?.toISOString() ?? null,
              };
            }),
          );
        })();

  const workerIncidents = workerIncidentSource.status === "error"
    ? unavailable<DashboardWorkerIncident>()
    : loaded(
        workerIncidentSource.value.map((incident): DashboardWorkerIncident => {
          const presentation = workerIncidentPresentation(incident);
          return {
            id: incident.id,
            activityRevision: [
              incident.lastObservedAt.toISOString(),
              incident.occurrenceCount,
              incident.resolvedAt?.toISOString() ?? "active",
            ].join(":"),
            worker: presentation.worker,
            status: incident.resolvedAt === null ? "active" : "recovered",
            reasonCode: `worker.${incident.reasonCode}`,
            phase: incident.phase,
            phaseLabel: presentation.phaseLabel,
            occurrenceCount: incident.occurrenceCount,
            firstObservedAt: incident.firstObservedAt.toISOString(),
            lastObservedAt: incident.lastObservedAt.toISOString(),
            resolvedAt: incident.resolvedAt?.toISOString() ?? null,
            ...(includeInvestigations
              ? { investigation: workerIncidentInvestigation(incident) }
              : {}),
          };
        }),
      );

  const catalogReview =
    archiveSource.status === "error"
      ? unavailable<DashboardCatalogReviewItem>()
      : {
          status: "loaded" as const,
          items: catalogReviewArchives.map((archive) => {
            const boundaryEvidence =
              archiveBoundaryEvidenceFromRecord(archive);
            return {
              id: archive.id,
              activityRevision: archive.updatedAt.toISOString(),
              discLabel: archive.discLabel,
              discKind: archive.discKind,
              archiveFormat: archive.archiveFormat,
              ...(boundaryEvidence === null ? {} : { boundaryEvidence }),
              integrity: archive.integrity,
              badSectorCount: archive.badSectorCount,
              badAreaCount: archive.badAreaCount,
              badSectorRanges: archive.badSectorRanges,
              archivedAt: archive.archivedAt.toISOString(),
              catalogReviewedAt:
                archive.catalogReviewedAt?.toISOString() ?? null,
              catalogReviewOutcome: archive.catalogReviewOutcome,
              mappedMediaItemCount: archive.mappedMediaItemCount,
              mappedMediaItemTitles: archive.mappedMediaItemTitles,
              verificationStatus: archive.verificationStatus,
              verificationMessage: archive.verificationMessage,
              verifiedAt: archive.verifiedAt?.toISOString() ?? null,
            };
          }),
          ...(activityLimit !== undefined &&
          (catalogReviewView === "reviewed" ||
            catalogReviewCursor !== undefined ||
            archiveSource.value.length > activityLimit)
            ? {
                page: {
                  limit: activityLimit,
                  previousCursor:
                    (catalogReviewCursor?.direction === "newer"
                      ? archiveSource.value.length > activityLimit
                      : catalogReviewCursor !== undefined) &&
                    previousCatalogReviewBoundary !== undefined
                      ? encodeCatalogReviewCursor(
                          "newer",
                          previousCatalogReviewBoundary,
                          catalogReviewArchives.length === 0,
                        )
                      : null,
                  nextCursor:
                    (catalogReviewCursor?.direction === "newer"
                      ? catalogReviewCursor !== undefined
                      : archiveSource.value.length > activityLimit) &&
                    nextCatalogReviewBoundary !== undefined
                      ? encodeCatalogReviewCursor(
                          "older",
                          nextCatalogReviewBoundary,
                          catalogReviewArchives.length === 0,
                        )
                      : null,
                },
              }
            : {}),
        };

  return {
    generatedAt: new Date().toISOString(),
    opticalDrives,
    detectedDiscs,
    archiveJobs,
    workerIncidents,
    encodeJobs,
    catalogReview,
  };
}

export function readDashboardSnapshot(
  access: DataAccess,
  options: DashboardSnapshotOptions = {},
): DashboardSnapshot {
  return access.readConsistentSnapshot((snapshotAccess) =>
    readDashboardSnapshotRecords(snapshotAccess, options),
  );
}

export function readDashboardDetectedDiscDetails(
  access: DataAccess,
  id: string,
  detectedAt: string,
): DashboardDetectedDiscDetails | null {
  return access.readConsistentSnapshot((snapshotAccess) => {
    const disc = snapshotAccess.catalog.listDetectedDiscs(undefined, {
      ids: [id as DetectedDiscId],
    })[0];
    if (!disc || disc.detectedAt.toISOString() !== detectedAt) {
      return null;
    }
    const scan = decodeDvdTitleMap(disc.scanData);
    return {
      id: disc.id,
      detectedAt,
      titles: scan?.titles ?? [],
    };
  });
}
