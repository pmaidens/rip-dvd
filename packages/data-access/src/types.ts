import type {
  ARCHIVE_PROGRESS_PHASES,
  ARCHIVE_RUNNING_PROGRESS_PHASES,
  ARCHIVE_JOB_STATUSES,
  ARCHIVE_FORMATS,
  DETECTED_DISC_STATUSES,
  DISC_KINDS,
  DISC_SELECTION_KINDS,
  ENCODE_PROGRESS_PHASES,
  ENCODE_JOB_STATUSES,
  FILESYSTEM_VERIFICATION_STATUSES,
  JOB_STATUSES,
  MEDIA_DOMAINS,
  MEDIA_ITEM_KINDS,
} from "./domain-values.js";
import type {
  DiscSelectionSourceIdentity,
  DiscSelectionSourceIdentityInput,
} from "./disc-selection-source-identity.js";

export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];
export type DiscKind = (typeof DISC_KINDS)[number];
export type DetectedDiscStatus = (typeof DETECTED_DISC_STATUSES)[number];
export type MediaItemKind = (typeof MEDIA_ITEM_KINDS)[number];
export type DiscSelectionKind = (typeof DISC_SELECTION_KINDS)[number];
export type MediaDomain = (typeof MEDIA_DOMAINS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type ArchiveJobStatus = (typeof ARCHIVE_JOB_STATUSES)[number];
export type EncodeJobStatus = (typeof ENCODE_JOB_STATUSES)[number];
export type ArchiveProgressPhase = (typeof ARCHIVE_PROGRESS_PHASES)[number];
export type ArchiveRunningProgressPhase =
  (typeof ARCHIVE_RUNNING_PROGRESS_PHASES)[number];
export type EncodeProgressPhase = (typeof ENCODE_PROGRESS_PHASES)[number];
export type FilesystemVerificationStatus =
  (typeof FILESYSTEM_VERIFICATION_STATUSES)[number];

declare const domainIdBrand: unique symbol;
type DomainId<Name extends string> = string & {
  readonly [domainIdBrand]: Name;
};

export type OpticalDriveId = DomainId<"OpticalDrive">;
export type DetectedDiscId = DomainId<"DetectedDisc">;
export type OriginalDiscArchiveId = DomainId<"OriginalDiscArchive">;
export type MediaItemId = DomainId<"MediaItem">;
export type DiscSelectionId = DomainId<"DiscSelection">;
export type EncodingProfileId = DomainId<"EncodingProfile">;
export type ArchiveJobId = DomainId<"ArchiveJob">;
export type EncodeJobId = DomainId<"EncodeJob">;
export type ArchiveJobClaimToken = DomainId<"ArchiveJobClaim">;
export type ArchiveJobInspectionToken = DomainId<"ArchiveJobInspection">;
export type EncodeJobClaimToken = DomainId<"EncodeJobClaim">;
export type EncodeJobCleanupClaimToken = DomainId<"EncodeJobCleanupClaim">;

declare const encodeOutputFilesystemIdentityBrand: unique symbol;
export type EncodeOutputFilesystemIdentity = string & {
  readonly [encodeOutputFilesystemIdentityBrand]: true;
};

export const ARCHIVE_JOB_LEASE_DURATION_MS = 60_000;
export const ARCHIVE_INSPECTION_LEASE_DURATION_MS = 60_000;
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
  verificationStatus: FilesystemVerificationStatus | null;
  verificationMessage: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
  detectedDiscId: DetectedDiscId;
  originalDiscArchiveId: OriginalDiscArchiveId | null;
  status: ArchiveJobStatus;
  priority: number;
  progressPhase: ArchiveProgressPhase;
  progressPercent: number;
  inspectionToken: ArchiveJobInspectionToken | null;
  inspectionUpdatedAt: Date | null;
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

export type RunningArchiveJob = ArchiveJob & {
  status: "running";
  claimToken: ArchiveJobClaimToken;
};

export interface ArchiveJobProgress {
  phase: ArchiveRunningProgressPhase;
  progressPercent: number;
}

export interface ArchiveJobInspection {
  jobIds: readonly ArchiveJobId[];
  opticalDriveId: OpticalDriveId;
  token: ArchiveJobInspectionToken;
}

export type RunningEncodeJob = EncodeJob & {
  status: "running";
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
  completeCatalogReview(
    id: OriginalDiscArchiveId,
    catalogRevision: Date,
  ): OriginalDiscArchive;
  createMediaItem(input: {
    parentId?: MediaItemId;
    kind: MediaItemKind;
    title: string;
    year?: number;
    seasonNumber?: number;
    episodeNumber?: number;
  }): MediaItem;
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
  listMediaItems(options?: {
    ids?: readonly MediaItemId[];
    limit?: number;
    offset?: number;
  }): MediaItem[];
  createDiscSelection(input: CreateDiscSelectionInput): DiscSelection;
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
  approve(input: {
    detectedDiscId: DetectedDiscId;
    priority?: number;
  }): ArchiveJob;
  enqueue(input: { detectedDiscId: DetectedDiscId; priority?: number }): ArchiveJob;
  beginDriveInspection(opticalDriveId: OpticalDriveId): ArchiveJobInspection;
  renewDriveInspection(inspection: ArchiveJobInspection): ArchiveJob[];
  finishDriveInspection(inspection: ArchiveJobInspection): ArchiveJob[];
  recoverInterruptedInspections(): ArchiveJob[];
  claimNext(
    workerId: string,
    eligibility?: {
      opticalDriveId: OpticalDriveId;
      fingerprint?: string;
    },
  ): RunningArchiveJob | null;
  renewClaim(claim: RunningArchiveJob): RunningArchiveJob;
  recoverExpiredClaims(): ArchiveJob[];
  list(
    statuses?: ArchiveJobStatus[],
    options?: ChronologicalListOptions,
  ): ArchiveJob[];
  updateProgress(
    claim: RunningArchiveJob,
    progress: number | ArchiveJobProgress,
  ): ArchiveJob;
  publish(
    claim: RunningArchiveJob,
    input: { archivePath: string; sizeBytes: number },
  ): ArchiveJob;
  fail(claim: RunningArchiveJob, errorMessage: string): ArchiveJob;
  requeue(id: ArchiveJobId): ArchiveJob;
}

export interface EncodeJobAccess {
  enqueue(input: {
    discSelectionId: DiscSelectionId;
    encodingProfileId: EncodingProfileId;
    outputPath: string;
    priority?: number;
  }): EncodeJob;
  cancelQueued(id: EncodeJobId): EncodeJob;
  claimNext(workerId: string): RunningEncodeJob | null;
  renewClaim(claim: RunningEncodeJob): RunningEncodeJob;
  beginPublicationMutation(
    claim: RunningEncodeJob,
    cleanup: EncodeJobPartialCleanup,
  ): EncodeJobPartialCleanup;
  listPublicationMutations(): EncodeJobPartialCleanup[];
  listExpiredPublicationMutations(): EncodeJobPartialCleanup[];
  completePublishedMutation(
    cleanup: EncodeJobPartialCleanup,
    publicationMatches: () => boolean,
  ): EncodeJob;
  recoverExpiredPublicationMutation(
    cleanup: EncodeJobPartialCleanup,
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
  ): { cleanup: EncodeJobPartialCleanup; job: EncodeJob };
  completePublishedClaim(
    claim: RunningEncodeJob,
    cleanup: EncodeJobPartialCleanup,
    publicationMatches: () => boolean,
  ): EncodeJob;
  completePartialCleanup(cleanup: EncodeJobPartialCleanup): EncodeJob;
  list(
    statuses?: EncodeJobStatus[],
    options?: ChronologicalListOptions,
  ): EncodeJob[];
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
  | "listMediaItems"
  | "listDiscSelections"
>;

export interface ConsistentReadAccess {
  readonly catalog: SnapshotCatalogAccess;
  readonly encodingProfiles: Pick<EncodingProfileAccess, "list">;
  readonly archiveJobs: Pick<ArchiveJobAccess, "list">;
  readonly encodeJobs: Pick<EncodeJobAccess, "list">;
}

export interface DataAccess {
  readonly catalog: CatalogAccess;
  readonly encodingProfiles: EncodingProfileAccess;
  readonly archiveJobs: ArchiveJobAccess;
  readonly encodeJobs: EncodeJobAccess;
  readonly filesystemVerification: FilesystemVerificationAccess;
  readConsistentSnapshot<T>(read: (access: ConsistentReadAccess) => T): T;
  checkHealth(): ServiceHealth;
  close(): void;
}
