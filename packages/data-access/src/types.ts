import type {
  ARCHIVE_FORMATS,
  DETECTED_DISC_STATUSES,
  DISC_KINDS,
  DISC_SELECTION_KINDS,
  JOB_STATUSES,
  MEDIA_DOMAINS,
  MEDIA_ITEM_KINDS,
} from "./domain-values.js";

export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];
export type DiscKind = (typeof DISC_KINDS)[number];
export type DetectedDiscStatus = (typeof DETECTED_DISC_STATUSES)[number];
export type MediaItemKind = (typeof MEDIA_ITEM_KINDS)[number];
export type DiscSelectionKind = (typeof DISC_SELECTION_KINDS)[number];
export type MediaDomain = (typeof MEDIA_DOMAINS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

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
export type EncodeJobClaimToken = DomainId<"EncodeJobClaim">;

export const ARCHIVE_JOB_LEASE_DURATION_MS = 60_000;

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
  sourceKey: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DiscSelection = DiscSelectionBase &
  (
    | {
        kind: "main_feature";
        titleNumber: null;
        chapterStart: null;
        chapterEnd: null;
      }
    | {
        kind: "dvd_title";
        titleNumber: number;
        chapterStart: null;
        chapterEnd: null;
      }
    | {
        kind: "dvd_chapters";
        titleNumber: number;
        chapterStart: number;
        chapterEnd: number;
      }
  );

export type DeleteDiscSelectionResult = DiscSelection & {
  deletedEncodeJobs: number;
  deletionComplete: boolean;
};

type CreateDiscSelectionBase = {
  originalDiscArchiveId: OriginalDiscArchiveId;
  mediaItemId: MediaItemId;
  label?: string;
};

export type CreateDiscSelectionInput = CreateDiscSelectionBase &
  (
    | {
        kind: "main_feature";
        titleNumber?: never;
        chapterStart?: never;
        chapterEnd?: never;
      }
    | {
        kind: "dvd_title";
        titleNumber: number;
        chapterStart?: never;
        chapterEnd?: never;
      }
    | {
        kind: "dvd_chapters";
        titleNumber: number;
        chapterStart: number;
        chapterEnd: number;
      }
  );

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
  status: JobStatus;
  priority: number;
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
  discSelectionId: DiscSelectionId;
  encodingProfileId: EncodingProfileId;
  outputPath: string;
  status: JobStatus;
  priority: number;
  progressPercent: number;
  claimedBy: string | null;
  claimToken: EncodeJobClaimToken | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RunningArchiveJob = ArchiveJob & {
  status: "running";
  claimToken: ArchiveJobClaimToken;
};

export type RunningEncodeJob = EncodeJob & {
  status: "running";
  claimToken: EncodeJobClaimToken;
};

export interface DiscoveredOpticalDrive {
  devicePath: string;
  displayName?: string;
  vendor?: string;
  product?: string;
  serialNumber?: string;
}

export type BoundedListPolicy =
  | { mode: "newest"; limit: number }
  | {
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
    ids?: readonly OriginalDiscArchiveId[];
    limit?: number;
    offset?: number;
    uncatalogedOnly?: boolean;
    needsCatalogReviewOnly?: boolean;
  }): OriginalDiscArchive[];
  completeCatalogReview(id: OriginalDiscArchiveId): OriginalDiscArchive;
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
  deleteDiscSelection(id: DiscSelectionId): DeleteDiscSelectionResult;
  listDiscSelections(options?: {
    ids?: readonly DiscSelectionId[];
    originalDiscArchiveId?: OriginalDiscArchiveId;
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
  }): EncodingProfile[];
}

export interface ArchiveJobAccess {
  approve(input: {
    detectedDiscId: DetectedDiscId;
    priority?: number;
  }): ArchiveJob;
  enqueue(input: { detectedDiscId: DetectedDiscId; priority?: number }): ArchiveJob;
  claimNext(
    workerId: string,
    eligibility?: {
      opticalDriveId: OpticalDriveId;
      fingerprint: string;
    },
  ): RunningArchiveJob | null;
  renewClaim(claim: RunningArchiveJob): RunningArchiveJob;
  recoverExpiredClaims(): ArchiveJob[];
  list(
    statuses?: JobStatus[],
    options?: ChronologicalListOptions,
  ): ArchiveJob[];
  updateProgress(
    claim: RunningArchiveJob,
    progressPercent: number,
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
  claimNext(workerId: string): RunningEncodeJob | null;
  list(
    statuses?: JobStatus[],
    options?: ChronologicalListOptions,
  ): EncodeJob[];
  updateProgress(claim: RunningEncodeJob, progressPercent: number): EncodeJob;
  complete(claim: RunningEncodeJob): EncodeJob;
  fail(claim: RunningEncodeJob, errorMessage: string): EncodeJob;
  requeue(id: EncodeJobId): EncodeJob;
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
  readConsistentSnapshot<T>(read: (access: ConsistentReadAccess) => T): T;
  checkHealth(): ServiceHealth;
  close(): void;
}
