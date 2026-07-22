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

type CreateDiscSelectionBase = {
  originalDiscArchiveId: OriginalDiscArchiveId;
  mediaItemId: MediaItemId;
  sourceKey: string;
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

export interface CatalogAccess {
  upsertOpticalDrive(input: {
    devicePath: string;
    displayName?: string;
    vendor?: string;
    product?: string;
    serialNumber?: string;
    isEnabled?: boolean;
    isPresent: boolean;
  }): OpticalDrive;
  listOpticalDrives(): OpticalDrive[];
  registerDetectedDisc(input: {
    opticalDriveId: OpticalDriveId;
    discKind: DiscKind;
    fingerprint: string;
    volumeLabel?: string;
    scanData?: unknown;
  }): DetectedDisc;
  listDetectedDiscs(statuses?: DetectedDiscStatus[]): DetectedDisc[];
  updateDetectedDiscStatus(
    id: DetectedDiscId,
    status: DetectedDiscStatus,
  ): DetectedDisc;
  createOriginalDiscArchive(input: {
    detectedDiscId: DetectedDiscId;
    discKind: DiscKind;
    archiveFormat: ArchiveFormat;
    archivePath: string;
    fingerprint: string;
    sizeBytes?: number;
  }): OriginalDiscArchive;
  listOriginalDiscArchives(): OriginalDiscArchive[];
  createMediaItem(input: {
    parentId?: MediaItemId;
    kind: MediaItemKind;
    title: string;
    year?: number;
    seasonNumber?: number;
    episodeNumber?: number;
  }): MediaItem;
  listMediaItems(): MediaItem[];
  createDiscSelection(input: CreateDiscSelectionInput): DiscSelection;
  listDiscSelections(): DiscSelection[];
  createEncodingProfile(input: {
    key: string;
    displayName: string;
    mediaDomain: MediaDomain;
    version: number;
    settings: Record<string, unknown>;
  }): EncodingProfile;
  findEncodingProfile(input: {
    key: string;
    mediaDomain: MediaDomain;
    version: number;
  }): EncodingProfile | null;
  listEncodingProfiles(): EncodingProfile[];
}

export interface ArchiveJobAccess {
  enqueue(input: { detectedDiscId: DetectedDiscId; priority?: number }): ArchiveJob;
  claimNext(workerId: string): RunningArchiveJob | null;
  list(statuses?: JobStatus[]): ArchiveJob[];
  updateProgress(
    claim: RunningArchiveJob,
    progressPercent: number,
  ): ArchiveJob;
  complete(
    claim: RunningArchiveJob,
    originalDiscArchiveId: OriginalDiscArchiveId,
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
  list(statuses?: JobStatus[]): EncodeJob[];
  updateProgress(claim: RunningEncodeJob, progressPercent: number): EncodeJob;
  complete(claim: RunningEncodeJob): EncodeJob;
  fail(claim: RunningEncodeJob, errorMessage: string): EncodeJob;
  requeue(id: EncodeJobId): EncodeJob;
}

export interface DataAccess {
  readonly catalog: CatalogAccess;
  readonly archiveJobs: ArchiveJobAccess;
  readonly encodeJobs: EncodeJobAccess;
  checkHealth(): ServiceHealth;
  close(): void;
}
