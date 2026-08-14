import type {
  ARCHIVE_JOB_STATUSES,
  ARCHIVE_REQUEST_STATUSES,
  ARCHIVE_RUNNING_PROGRESS_PHASES,
  ARCHIVE_FORMATS,
  CATALOG_REVIEW_OUTCOMES,
  DETECTED_DISC_STATUSES,
  DISC_KINDS,
  DISC_INSPECTION_ATTEMPT_OUTCOMES,
  DISC_INSPECTION_PHASES,
  DISC_INSPECTION_REASON_CODES,
  DISC_INSPECTION_STATUSES,
  DISC_SELECTION_KINDS,
  ENCODE_JOB_STATUSES,
  ENCODE_PROGRESS_PHASES,
  FILESYSTEM_VERIFICATION_STATUSES,
  MEDIA_DOMAINS,
  MEDIA_ITEM_KINDS,
  RETAINED_ENCODE_OUTPUT_STATES,
} from "./domain-values.js";
import type {
  DiscSelectionSourceIdentity,
  DiscSelectionSourceIdentityInput,
} from "./disc-selection-source-identity.js";

export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];
export type CatalogReviewOutcome = (typeof CATALOG_REVIEW_OUTCOMES)[number];
export type CompletedCatalogReviewOutcome = Exclude<
  CatalogReviewOutcome,
  "needs_review"
>;
export type DiscKind = (typeof DISC_KINDS)[number];
export type DetectedDiscStatus = (typeof DETECTED_DISC_STATUSES)[number];
export type MediaItemKind = (typeof MEDIA_ITEM_KINDS)[number];
export type DiscSelectionKind = (typeof DISC_SELECTION_KINDS)[number];
export type MediaDomain = (typeof MEDIA_DOMAINS)[number];
export type ArchiveJobStatus = (typeof ARCHIVE_JOB_STATUSES)[number];
export type ArchiveRequestStatus = (typeof ARCHIVE_REQUEST_STATUSES)[number];
export type DiscInspectionStatus = (typeof DISC_INSPECTION_STATUSES)[number];
export type DiscInspectionPhase = (typeof DISC_INSPECTION_PHASES)[number];
export type DiscInspectionAttemptOutcome =
  (typeof DISC_INSPECTION_ATTEMPT_OUTCOMES)[number];
export type DiscInspectionReasonCode =
  (typeof DISC_INSPECTION_REASON_CODES)[number];
export type EncodeJobStatus = (typeof ENCODE_JOB_STATUSES)[number];
export type ArchiveRunningProgressPhase =
  (typeof ARCHIVE_RUNNING_PROGRESS_PHASES)[number];
export type ArchiveProgressPhase = ArchiveRunningProgressPhase;
export type EncodeProgressPhase = (typeof ENCODE_PROGRESS_PHASES)[number];
export type FilesystemVerificationStatus =
  (typeof FILESYSTEM_VERIFICATION_STATUSES)[number];
export type RetainedEncodeOutputState =
  (typeof RETAINED_ENCODE_OUTPUT_STATES)[number];

declare const domainIdBrand: unique symbol;
type DomainId<Name extends string> = string & {
  readonly [domainIdBrand]: Name;
};

export type OpticalDriveId = DomainId<"OpticalDrive">;
export type DiscInspectionId = DomainId<"DiscInspection">;
export type DiscInspectionAttemptId = DomainId<"DiscInspectionAttempt">;
export type DetectedDiscId = DomainId<"DetectedDisc">;
export type ArchiveRequestId = DomainId<"ArchiveRequest">;
export type OriginalDiscArchiveId = DomainId<"OriginalDiscArchive">;
export type MediaItemId = DomainId<"MediaItem">;
export type DiscSelectionId = DomainId<"DiscSelection">;
export type EncodingProfileId = DomainId<"EncodingProfile">;
export type ArchiveJobId = DomainId<"ArchiveJob">;
export type EncodeJobId = DomainId<"EncodeJob">;
export type RetainedEncodeOutputId = DomainId<"RetainedEncodeOutput">;
export type ArchiveJobClaimToken = DomainId<"ArchiveJobClaim">;
export type DiscInspectionClaimToken = DomainId<"DiscInspectionClaim">;
export type EncodeJobClaimToken = DomainId<"EncodeJobClaim">;
export type EncodeJobCleanupClaimToken = DomainId<"EncodeJobCleanupClaim">;

declare const encodeOutputFilesystemIdentityBrand: unique symbol;
export type EncodeOutputFilesystemIdentity = string & {
  readonly [encodeOutputFilesystemIdentityBrand]: true;
};

export const ARCHIVE_JOB_LEASE_DURATION_MS = 60_000;
export const DISC_INSPECTION_LEASE_DURATION_MS = 60_000;
export const ENCODE_JOB_LEASE_DURATION_MS = 60_000;

export interface ServiceHealth {
  status: "ok";
  sqliteVersion: string;
  journalMode: string;
  busyTimeoutMs: number;
}

export interface OpticalDrive {
  id: OpticalDriveId;
  devicePath: string;
  displayName: string | null;
  vendor: string | null;
  product: string | null;
  serialNumber: string | null;
  isEnabled: boolean;
  isPresent: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DetectedDisc {
  id: DetectedDiscId;
  opticalDriveId: OpticalDriveId;
  discKind: DiscKind;
  fingerprint: string;
  volumeLabel: string | null;
  status: DetectedDiscStatus;
  scanData: unknown;
  detectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscInspection {
  id: DiscInspectionId;
  opticalDriveId: OpticalDriveId;
  detectedDiscId: DetectedDiscId | null;
  mediaGeneration: string;
  isCurrent: boolean;
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
  retryAt: Date | null;
  manualRetryRequestedAt: Date | null;
  reasonCode: DiscInspectionReasonCode | null;
  diagnostic: string | null;
  claimToken: DiscInspectionClaimToken | null;
  claimUpdatedAt: Date | null;
  phaseStartedAt: Date;
  attemptStartedAt: Date;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscInspectionAttempt {
  id: DiscInspectionAttemptId;
  discInspectionId: DiscInspectionId;
  attemptNumber: number;
  outcome: DiscInspectionAttemptOutcome;
  phase: DiscInspectionPhase;
  reasonCode: DiscInspectionReasonCode | null;
  diagnostic: string | null;
  startedAt: Date;
  endedAt: Date;
}

export interface ArchiveRequest {
  id: ArchiveRequestId;
  detectedDiscId: DetectedDiscId;
  status: ArchiveRequestStatus;
  priority: number;
  cancellationRequestedAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OriginalDiscArchive {
  id: OriginalDiscArchiveId;
  detectedDiscId: DetectedDiscId;
  discKind: DiscKind;
  archiveFormat: ArchiveFormat;
  archivePath: string;
  fingerprint: string;
  sizeBytes: number | null;
  archivedAt: Date;
  catalogReviewedAt: Date | null;
  catalogReviewOutcome: CatalogReviewOutcome;
  verificationStatus: FilesystemVerificationStatus | null;
  verificationMessage: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CatalogReviewArchiveView = "needs_review" | "reviewed";

export interface CatalogReviewArchive extends OriginalDiscArchive {
  discLabel: string;
  mappedMediaItemCount: number;
  mappedMediaItemTitles: readonly string[];
}

export interface MediaItem {
  id: MediaItemId;
  parentId: MediaItemId | null;
  kind: MediaItemKind;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaItemMaintenance {
  mediaItemId: MediaItemId;
  childCount: number;
  discSelectionReferenceCount: number;
  referencedArchiveCount: number;
  otherArchiveCount: number;
  deletionAvailability:
    | { state: "available"; reason: null }
    | { state: "unavailable"; reason: string };
}

interface DiscSelectionBase {
  id: DiscSelectionId;
  originalDiscArchiveId: OriginalDiscArchiveId;
  mediaItemId: MediaItemId;
  sourceIdentity: DiscSelectionSourceIdentity;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DiscSelection = DiscSelectionBase;

export interface DiscSelectionSupersession {
  supersededDiscSelectionId: DiscSelectionId;
  replacementDiscSelectionId: DiscSelectionId;
  reason: string | null;
  createdAt: Date;
}

export type CorrectDiscSelectionInput = CreateDiscSelectionInput & {
  catalogRevision: Date;
  reason?: string;
};

export interface DiscSelectionCorrection {
  discSelection: DiscSelection;
  supersession: DiscSelectionSupersession;
}

export type CatalogReviewCoverageStatus =
  | "mapped"
  | "partially_mapped"
  | "unmapped";

export interface CatalogReviewTitleCoverage {
  titleNumber: number;
  status: CatalogReviewCoverageStatus;
  hasOverlap: boolean;
}

export interface CatalogReviewCoverage {
  discSelectionCount: number;
  mediaItemsWithSelections: number;
  mappedTitles: number;
  partiallyMappedTitles: number;
  unmappedTitles: number;
  mainFeatureSelections: number;
  titles: CatalogReviewTitleCoverage[];
}

export interface DiscSelectionCorrectionEncodeJobLink {
  replacementDiscSelectionId: DiscSelectionId;
  predecessorEncodeJob: {
    id: EncodeJobId;
    status: EncodeJobStatus;
  };
  replacementEncodeJob: {
    id: EncodeJobId;
    status: EncodeJobStatus;
  };
}

export type DiscSelectionAction =
  | "update"
  | "correct"
  | "remove"
  | "repair";

export type DiscSelectionActionAvailability =
  | {
    discSelectionId: DiscSelectionId;
    state: "editable";
    availableActions: readonly ["update", "remove"];
    reason: null;
    relatedEncodeJob: null;
  }
  | {
    discSelectionId: DiscSelectionId;
    state: "locked_provenance";
    availableActions: readonly ["correct"];
    reason: string;
    relatedEncodeJob: {
      id: EncodeJobId;
      status: EncodeJobStatus;
    };
  }
  | {
    discSelectionId: DiscSelectionId;
    state: "correction_lineage";
    availableActions: readonly ["correct", "remove"];
    reason: string;
    relatedEncodeJob: null;
  }
  | {
    discSelectionId: DiscSelectionId;
    state: "needs_repair";
    availableActions: readonly ["repair", "remove"] | readonly [];
    reason: string;
    relatedEncodeJob: {
      id: EncodeJobId;
      status: "queued" | "running" | "cancellation_requested";
    } | null;
  }
  | {
    discSelectionId: DiscSelectionId;
    state: "changes_unavailable";
    availableActions: readonly [];
    reason: string;
    relatedEncodeJob: null;
  };

export type DeleteDiscSelectionResult = DiscSelection & {
  deletedEncodeJobs: number;
  deletionComplete: boolean;
};

export type CreateDiscSelectionInput = {
  originalDiscArchiveId: OriginalDiscArchiveId;
  mediaItemId: MediaItemId;
  sourceIdentity: DiscSelectionSourceIdentityInput;
  label?: string;
};

type UpdateDiscSelectionChanges = {
  mediaItemId?: MediaItemId;
  sourceIdentity?: DiscSelectionSourceIdentityInput;
  label?: string | null;
};

export type UpdateDiscSelectionInput = {
  originalDiscArchiveId: OriginalDiscArchiveId;
} & UpdateDiscSelectionChanges & (
  | { mediaItemId: MediaItemId }
  | { sourceIdentity: DiscSelectionSourceIdentityInput }
  | { label: string | null }
);

export interface CreateMediaItemInput {
  parentId?: MediaItemId;
  kind: MediaItemKind;
  title: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

interface CreateMappingProposalBaseInput {
  originalDiscArchiveId: OriginalDiscArchiveId;
  catalogRevision: Date;
  discSelection: {
    sourceIdentity: DiscSelectionSourceIdentityInput;
    label?: string;
  };
}

export type CreateMappingProposalInput = CreateMappingProposalBaseInput & (
  | {
    mediaItem: CreateMediaItemInput;
    existingMediaItemId?: never;
  }
  | {
    mediaItem?: never;
    existingMediaItemId: MediaItemId;
  }
);

export interface CreatedMappingProposal {
  mediaItem: MediaItem;
  discSelection: DiscSelection;
}

export type EpisodicMappingTvShowTarget =
  | {
    choice: "create_new";
    title: string;
    year?: number;
  }
  | {
    choice: "use_existing";
    mediaItemId: MediaItemId;
  };

export type EpisodicMappingSeasonTarget =
  | {
    choice: "create_new";
    title: string;
    seasonNumber: number;
  }
  | {
    choice: "use_existing";
    mediaItemId: MediaItemId;
  };

export interface EpisodicMappingEpisodeInput {
  titleNumber: number;
  title: string;
  episodeNumber: number;
  label?: string;
}

export interface CreateEpisodicMappingProposalInput {
  originalDiscArchiveId: OriginalDiscArchiveId;
  catalogRevision: Date;
  tvShow: EpisodicMappingTvShowTarget;
  season: EpisodicMappingSeasonTarget;
  episodes: readonly EpisodicMappingEpisodeInput[];
}

export interface CreatedEpisodicMappingProposal {
  tvShow: MediaItem;
  season: MediaItem;
  episodes: Array<{
    mediaItem: MediaItem;
    discSelection: DiscSelection;
  }>;
}

export interface EncodingProfile {
  id: EncodingProfileId;
  key: string;
  displayName: string;
  mediaDomain: MediaDomain;
  version: number;
  isActive: boolean;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArchiveJob {
  id: ArchiveJobId;
  archiveRequestId: ArchiveRequestId;
  detectedDiscId: DetectedDiscId;
  originalDiscArchiveId: OriginalDiscArchiveId | null;
  attemptOrdinal: number;
  status: ArchiveJobStatus;
  priority: number;
  progressPhase: ArchiveProgressPhase;
  progressPercent: number;
  claimedBy: string | null;
  claimToken: ArchiveJobClaimToken | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EncodeJob {
  id: EncodeJobId;
  predecessorEncodeJobId: EncodeJobId | null;
  discSelectionId: DiscSelectionId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
  status: EncodeJobStatus;
  priority: number;
  replaceExistingOutput: boolean;
  replacementOutputIdentity: EncodeOutputFilesystemIdentity | null;
  partialCleanupOutputPath: string | null;
  partialCleanupClaimToken: EncodeJobClaimToken | null;
  partialCleanupLeaseToken: EncodeJobCleanupClaimToken | null;
  publicationPending: boolean;
  publicationCompletionPending: boolean;
  progressPhase: EncodeProgressPhase | null;
  progressPercent: number;
  progressEtaSeconds: number | null;
  claimedBy: string | null;
  claimToken: EncodeJobClaimToken | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  verificationStatus: FilesystemVerificationStatus | null;
  verificationMessage: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EncodeJobCorrectionLink = EncodeJob;

export interface RetainedEncodeOutput {
  id: RetainedEncodeOutputId;
  predecessorEncodeJobId: EncodeJobId;
  replacementEncodeJobId: EncodeJobId;
  retainedOutputPath: string;
  filesystemIdentity: EncodeOutputFilesystemIdentity;
  state: RetainedEncodeOutputState;
  cleanupEligible: boolean;
  retainedAt: Date;
}

export type RetainedEncodeOutputSummary = Omit<
  RetainedEncodeOutput,
  "retainedOutputPath" | "filesystemIdentity"
>;

export interface DiscSelectionCorrectionRetainedOutputSummary {
  replacementDiscSelectionId: DiscSelectionId;
  retainedOutput: RetainedEncodeOutputSummary;
}

export interface CorrectedEncodeReplacementPlan {
  predecessorEncodeJobId: EncodeJobId;
  replacementDiscSelectionId: DiscSelectionId;
  proposedEncodingProfileId: EncodingProfileId;
  proposedOutputPath: string;
  predecessorStatus: EncodeJobStatus;
  predecessorReady: boolean;
}

export interface CorrectedEncodeReplacementInput {
  predecessorEncodeJobId: EncodeJobId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
  priority?: number;
}

export interface CompletedCatalogReviewWithReplacements {
  archive: OriginalDiscArchive;
  replacementEncodeJobs: EncodeJob[];
}

export type RunningArchiveJob = ArchiveJob & {
  status: "running";
  claimToken: ArchiveJobClaimToken;
};

export interface DiscInspectionClaim {
  id: DiscInspectionId;
  opticalDriveId: OpticalDriveId;
  mediaGeneration: string;
  claimToken: DiscInspectionClaimToken;
}

export interface DiscInspectionStart {
  inspection: DiscInspection;
  claim: DiscInspectionClaim | null;
}

export type DiscInspectionEvent =
  | {
      type: "metadata";
      volumeLabel: string | null;
      titleCount: number;
      chapterCount: number;
      audioStreamCount: number;
      subtitleStreamCount: number;
      totalBytes: number;
    }
  | {
      type: "hash_progress";
      bytesHashed: number;
      bytesPerSecond: number | null;
      etaSeconds: number | null;
    }
  | { type: "confirming_media" }
  | {
      type: "retry";
      reasonCode: DiscInspectionReasonCode;
      diagnostic?: string;
      retryAt: Date;
    }
  | {
      type: "complete";
      detectedDiscId: DetectedDiscId;
    }
  | {
      type: "fail";
      reasonCode: DiscInspectionReasonCode;
      diagnostic?: string;
    }
  | {
      type: "abort";
      reasonCode: DiscInspectionReasonCode;
      diagnostic?: string;
    };

export interface ArchiveJobProgress {
  phase: ArchiveRunningProgressPhase;
  progressPercent: number;
}

export type RunningEncodeJob = EncodeJob & {
  status: "running";
  claimToken: EncodeJobClaimToken;
};

export type ClaimedEncodeJob = EncodeJob & {
  status: "running" | "cancellation_requested";
  claimToken: EncodeJobClaimToken;
};

export interface EncodeJobProgress {
  phase: EncodeProgressPhase;
  progressPercent: number;
  etaSeconds: number | null;
}

export interface EncodeJobPartialCleanup {
  jobId: EncodeJobId;
  outputPath: string;
  claimToken: EncodeJobClaimToken;
  leaseToken: EncodeJobCleanupClaimToken | null;
  publicationPending: boolean;
}

export interface EncodeJobPartialCleanupOptions {
  publicationPending?: boolean;
}

export interface EncodeJobPublicationProvenance {
  retainedOutputPath?: string;
  retainedOutputIdentity?: EncodeOutputFilesystemIdentity;
}

export interface EncodeJobFailureOptions {
  preserveReplacementAuthority?: boolean;
}

export interface EncodeJobRequeueOptions {
  outputPath?: string;
  priority?: number;
}

export interface DiscoveredOpticalDrive {
  devicePath: string;
  displayName?: string;
  vendor?: string;
  product?: string;
  serialNumber?: string;
}

export type BoundedListPolicy = {
  mode: "active-and-history";
  activeLimit: number;
  historyLimit: number;
};

export interface ChronologicalListOptions {
  policy?: BoundedListPolicy;
}

export interface DetectedDiscListOptions extends ChronologicalListOptions {
  ids?: readonly DetectedDiscId[];
}

export interface OriginalDiscArchiveListCursor {
  direction: "newer" | "older";
  archivedAt: Date;
  id: OriginalDiscArchiveId;
}

export interface CatalogReviewArchiveListCursor
  extends OriginalDiscArchiveListCursor {
  inclusive?: boolean;
}

export interface OpticalDriveReconciliationInput
  extends DiscoveredOpticalDrive {
  isConfiguredDevice: boolean;
}

export interface CatalogAccess {
  reconcileOpticalDrives(
    discovered: readonly OpticalDriveReconciliationInput[],
  ): OpticalDrive[];
  upsertOpticalDrive(input: {
    devicePath: string;
    displayName?: string;
    vendor?: string;
    product?: string;
    serialNumber?: string;
    isEnabled?: boolean;
    isPresent: boolean;
  }): OpticalDrive;
  listOpticalDrives(options?: {
    ids?: readonly OpticalDriveId[];
    limit?: number;
    historicalLimit?: number;
  }): OpticalDrive[];
  registerDetectedDisc(input: {
    opticalDriveId: OpticalDriveId;
    discKind: DiscKind;
    fingerprint: string;
    isNewMediumObservation?: boolean;
    volumeLabel?: string;
    scanData?: unknown;
    sizeBytes?: number;
  }): DetectedDisc;
  listDetectedDiscs(
    statuses?: DetectedDiscStatus[],
    options?: DetectedDiscListOptions,
  ): DetectedDisc[];
  updateDetectedDiscStatus(
    id: DetectedDiscId,
    status: DetectedDiscStatus,
  ): DetectedDisc;
  listOriginalDiscArchives(options?: {
    cursor?: OriginalDiscArchiveListCursor;
    ids?: readonly OriginalDiscArchiveId[];
    limit?: number;
    offset?: number;
    uncatalogedOnly?: boolean;
    needsCatalogReviewOnly?: boolean;
  }): OriginalDiscArchive[];
  listCatalogReviewArchives(options: {
    view: CatalogReviewArchiveView;
    cursor?: CatalogReviewArchiveListCursor;
    limit: number;
    query?: string;
    outcome?: CompletedCatalogReviewOutcome;
  }): CatalogReviewArchive[];
  completeCatalogReview(
    id: OriginalDiscArchiveId,
    catalogRevision: Date,
    outcome: CompletedCatalogReviewOutcome,
  ): OriginalDiscArchive;
  completeCatalogReviewWithReplacements(
    id: OriginalDiscArchiveId,
    catalogRevision: Date,
    outcome: CompletedCatalogReviewOutcome,
    replacements: readonly CorrectedEncodeReplacementInput[],
  ): CompletedCatalogReviewWithReplacements;
  createMediaItem(input: CreateMediaItemInput): MediaItem;
  createMappingProposal(
    input: CreateMappingProposalInput,
  ): CreatedMappingProposal;
  createEpisodicMappingProposal(
    input: CreateEpisodicMappingProposalInput,
  ): CreatedEpisodicMappingProposal;
  updateMediaItem(
    id: MediaItemId,
    input: {
      parentId?: MediaItemId | null;
      kind?: MediaItemKind;
      title?: string;
      year?: number | null;
      seasonNumber?: number | null;
      episodeNumber?: number | null;
    },
  ): MediaItem;
  deleteMediaItem(id: MediaItemId): MediaItem;
  listMediaItemMaintenance(options: {
    ids: readonly MediaItemId[];
    currentArchiveId?: OriginalDiscArchiveId;
  }): MediaItemMaintenance[];
  listMediaItems(options?: {
    ids?: readonly MediaItemId[];
    limit?: number;
    offset?: number;
  }): MediaItem[];
  searchMediaItems(options: {
    query: string;
    limit: number;
    offset?: number;
  }): MediaItem[];
  createDiscSelection(input: CreateDiscSelectionInput): DiscSelection;
  updateDiscSelection(
    id: DiscSelectionId,
    input: UpdateDiscSelectionInput,
  ): DiscSelection;
  correctDiscSelection(
    id: DiscSelectionId,
    input: CorrectDiscSelectionInput,
  ): DiscSelectionCorrection;
  repairDiscSelection(
    id: DiscSelectionId,
    input: CreateDiscSelectionInput,
  ): DiscSelection;
  deleteDiscSelection(id: DiscSelectionId): DeleteDiscSelectionResult;
  listDiscSelections(options?: {
    ids?: readonly DiscSelectionId[];
    originalDiscArchiveId?: OriginalDiscArchiveId;
    encodeEligibleOnly?: boolean;
    limit?: number;
    offset?: number;
  }): DiscSelection[];
  getCatalogReviewCoverage(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): CatalogReviewCoverage;
  listDiscSelectionSupersessions(options:
    | {
      discSelectionIds: readonly DiscSelectionId[];
      originalDiscArchiveId?: never;
      limit?: never;
      offset?: never;
    }
    | {
      originalDiscArchiveId: OriginalDiscArchiveId;
      limit: number;
      offset?: number;
      discSelectionIds?: never;
    }): DiscSelectionSupersession[];
  listCorrectedEncodeReplacementPlans(options: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    limit: number;
    offset?: number;
  }): CorrectedEncodeReplacementPlan[];
  listDiscSelectionActionAvailability(options: {
    ids: readonly DiscSelectionId[];
  }): DiscSelectionActionAvailability[];
}

export interface EncodingProfileAccess {
  create(input: {
    key: string;
    displayName: string;
    mediaDomain: MediaDomain;
    settings: Record<string, unknown>;
  }): EncodingProfile;
  createVersion(input: {
    sourceProfileId: EncodingProfileId;
    mediaDomain: MediaDomain;
    settings: Record<string, unknown>;
  }): EncodingProfile;
  find(input: {
    key: string;
    mediaDomain: MediaDomain;
    version: number;
  }): EncodingProfile | null;
  setActive(input: {
    id: EncodingProfileId;
    mediaDomain: MediaDomain;
    isActive: boolean;
  }): EncodingProfile;
  list(input?: {
    ids?: readonly EncodingProfileId[];
    mediaDomain?: MediaDomain;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  }): EncodingProfile[];
}

export interface ArchiveJobAccess {
  startForInspection(
    inspectionId: DiscInspectionId,
    workerId: string,
  ): RunningArchiveJob | null;
  renewClaim(claim: RunningArchiveJob): RunningArchiveJob;
  recoverExpiredClaims(): ArchiveJob[];
  listExpiredCancellations(): RunningArchiveJob[];
  finalizeExpiredCancellation(claim: RunningArchiveJob): ArchiveJob;
  list(
    statuses?: ArchiveJobStatus[],
    options?: ChronologicalListOptions,
  ): ArchiveJob[];
  listLatestForRequests(
    archiveRequestIds: readonly ArchiveRequestId[],
  ): ArchiveJob[];
  isCancellationRequested(claim: RunningArchiveJob): boolean;
  updateProgress(
    claim: RunningArchiveJob,
    progress: number | ArchiveJobProgress,
  ): ArchiveJob;
  publish(
    claim: RunningArchiveJob,
    input: { archivePath: string; sizeBytes: number },
  ): ArchiveJob;
  fail(claim: RunningArchiveJob, errorMessage: string): ArchiveJob;
  abort(claim: RunningArchiveJob, errorMessage: string): ArchiveJob;
}

export interface DiscInspectionAccess {
  beginOrResume(input: {
    opticalDriveId: OpticalDriveId;
    mediaGeneration: string;
  }): DiscInspectionStart;
  renew(claim: DiscInspectionClaim): DiscInspection;
  record(claim: DiscInspectionClaim, event: DiscInspectionEvent): DiscInspection;
  requestRetry(id: DiscInspectionId): DiscInspection;
  clearCurrent(input: {
    opticalDriveId: OpticalDriveId;
    mediaGeneration?: string;
    reasonCode?: DiscInspectionReasonCode;
  }): DiscInspection | null;
  list(options?: {
    currentOnly?: boolean;
    ids?: readonly DiscInspectionId[];
    limit?: number;
  }): DiscInspection[];
  listAttempts(id: DiscInspectionId): DiscInspectionAttempt[];
}

export interface ArchiveRequestAccess {
  create(input: {
    detectedDiscId: DetectedDiscId;
    priority?: number;
  }): ArchiveRequest;
  cancel(id: ArchiveRequestId): ArchiveRequest;
  retry(id: ArchiveRequestId): ArchiveRequest;
  list(
    statuses?: ArchiveRequestStatus[],
    options?: ChronologicalListOptions,
  ): ArchiveRequest[];
  listRelevantForDetectedDiscs(
    detectedDiscIds: readonly DetectedDiscId[],
  ): ArchiveRequest[];
}

export interface EncodeJobAccess {
  enqueue(input: {
    discSelectionId: DiscSelectionId;
    encodingProfileId: EncodingProfileId;
    outputPath: string;
    priority?: number;
  }): EncodeJob;
  requestCancellation(id: EncodeJobId): EncodeJob;
  claimNext(workerId: string): RunningEncodeJob | null;
  renewClaim(claim: RunningEncodeJob): ClaimedEncodeJob;
  completeCancellation(claim: RunningEncodeJob): EncodeJob;
  beginPublicationMutation(
    claim: RunningEncodeJob,
    cleanup: EncodeJobPartialCleanup,
    retainedOutputPath?: string,
  ): EncodeJobPartialCleanup;
  listPublicationMutations(): EncodeJobPartialCleanup[];
  listExpiredPublicationMutations(): EncodeJobPartialCleanup[];
  completePublishedMutation(
    cleanup: EncodeJobPartialCleanup,
    publicationMatches: () => boolean,
    provenance?: EncodeJobPublicationProvenance,
  ): EncodeJob;
  recoverExpiredPublicationMutation(
    cleanup: EncodeJobPartialCleanup,
  ): EncodeJob;
  listExpiredCancellationClaims(): ClaimedEncodeJob[];
  completeExpiredCancellation(
    claim: ClaimedEncodeJob,
    processInactive: () => void,
  ): EncodeJob;
  recoverExpiredClaims(): EncodeJob[];
  recordReplacementOutputIdentity(
    claim: RunningEncodeJob,
    identity: EncodeOutputFilesystemIdentity,
  ): RunningEncodeJob;
  registerPartialCleanup(
    claim: RunningEncodeJob,
    options?: EncodeJobPartialCleanupOptions,
  ): EncodeJobPartialCleanup;
  revokePublication(
    claim: RunningEncodeJob,
    cleanup: EncodeJobPartialCleanup,
  ): EncodeJobPartialCleanup;
  listPendingPartialCleanups(): EncodeJobPartialCleanup[];
  claimPartialCleanup(
    cleanup: EncodeJobPartialCleanup,
  ): EncodeJobPartialCleanup;
  renewPartialCleanup(
    cleanup: EncodeJobPartialCleanup,
  ): EncodeJobPartialCleanup;
  withPartialCleanupMutationFence(
    cleanup: EncodeJobPartialCleanup,
    mutation: () => void,
  ): EncodeJobPartialCleanup;
  renewPublishedPartial(
    cleanup: EncodeJobPartialCleanup,
    publicationMatches: () => boolean,
  ): EncodeJobPartialCleanup;
  completePublishedPartial(
    cleanup: EncodeJobPartialCleanup,
    publicationMatches: () => boolean,
    provenance?: EncodeJobPublicationProvenance,
  ): { cleanup: EncodeJobPartialCleanup; job: EncodeJob };
  completePublishedClaim(
    claim: RunningEncodeJob,
    cleanup: EncodeJobPartialCleanup,
    publicationMatches: () => boolean,
    provenance?: EncodeJobPublicationProvenance,
  ): EncodeJob;
  completePartialCleanup(cleanup: EncodeJobPartialCleanup): EncodeJob;
  list(
    statuses?: EncodeJobStatus[],
    options?: ChronologicalListOptions,
  ): EncodeJob[];
  listDiscSelectionCorrectionEncodeJobLinks(options: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    limit: number;
    offset?: number;
  }): DiscSelectionCorrectionEncodeJobLink[];
  listDiscSelectionCorrectionRetainedOutputSummaries(options: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    limit: number;
    offset?: number;
  }): DiscSelectionCorrectionRetainedOutputSummary[];
  listCorrectionLinks(ids: readonly EncodeJobId[]): EncodeJobCorrectionLink[];
  listRetainedOutputs(ids: readonly EncodeJobId[]): RetainedEncodeOutput[];
  listRetainedOutputSummaries(
    ids: readonly EncodeJobId[],
  ): RetainedEncodeOutputSummary[];
  updateProgress(
    claim: RunningEncodeJob,
    progress: number | EncodeJobProgress,
  ): EncodeJob;
  complete(claim: RunningEncodeJob): EncodeJob;
  fail(
    claim: RunningEncodeJob,
    errorMessage: string,
    options?: EncodeJobFailureOptions,
  ): EncodeJob;
  requeue(id: EncodeJobId, options?: EncodeJobRequeueOptions): EncodeJob;
}

export interface FilesystemVerificationAccess {
  listOriginalDiscArchives(options: {
    limit: number;
    offset?: number;
  }): OriginalDiscArchive[];
  listEncodeJobOutputs(options: { limit: number; offset?: number }): EncodeJob[];
  verifyOriginalDiscArchive(
    id: OriginalDiscArchiveId,
  ): Promise<OriginalDiscArchive>;
  verifyEncodeJobOutput(id: EncodeJobId): Promise<EncodeJob>;
}

export type SnapshotCatalogAccess = Pick<
  CatalogAccess,
  | "listOpticalDrives"
  | "listDetectedDiscs"
  | "listOriginalDiscArchives"
  | "listCatalogReviewArchives"
  | "listMediaItems"
  | "listMediaItemMaintenance"
  | "searchMediaItems"
  | "listDiscSelections"
  | "getCatalogReviewCoverage"
  | "listDiscSelectionSupersessions"
  | "listCorrectedEncodeReplacementPlans"
  | "listDiscSelectionActionAvailability"
>;

export interface ConsistentReadAccess {
  readonly catalog: SnapshotCatalogAccess;
  readonly encodingProfiles: Pick<EncodingProfileAccess, "list">;
  readonly discInspections: Pick<DiscInspectionAccess, "list">;
  readonly archiveRequests: Pick<
    ArchiveRequestAccess,
    "list" | "listRelevantForDetectedDiscs"
  >;
  readonly archiveJobs: Pick<
    ArchiveJobAccess,
    "list" | "listLatestForRequests"
  >;
  readonly encodeJobs: Pick<
    EncodeJobAccess,
    | "list"
    | "listDiscSelectionCorrectionEncodeJobLinks"
    | "listDiscSelectionCorrectionRetainedOutputSummaries"
    | "listCorrectionLinks"
    | "listRetainedOutputSummaries"
  >;
}

export interface DataAccess {
  readonly catalog: CatalogAccess;
  readonly encodingProfiles: EncodingProfileAccess;
  readonly discInspections: DiscInspectionAccess;
  readonly archiveRequests: ArchiveRequestAccess;
  readonly archiveJobs: ArchiveJobAccess;
  readonly encodeJobs: EncodeJobAccess;
  readonly filesystemVerification: FilesystemVerificationAccess;
  readConsistentSnapshot<T>(read: (access: ConsistentReadAccess) => T): T;
  checkHealth(): ServiceHealth;
  close(): void;
}
