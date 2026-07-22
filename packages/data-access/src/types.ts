export type DiscKind = "dvd" | "blu_ray" | "audio_cd";
export type DetectedDiscStatus =
  | "detected"
  | "scanned"
  | "approved"
  | "archived"
  | "rejected";
export type MediaItemKind =
  | "movie"
  | "tv_show"
  | "season"
  | "episode"
  | "trailer"
  | "bonus_feature";
export type DiscSelectionKind =
  | "main_feature"
  | "dvd_title"
  | "dvd_chapters";
export type MediaDomain = "dvd_video" | "audio";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface ServiceHealth {
  status: "ok";
  sqliteVersion: string;
  journalMode: string;
  busyTimeoutMs: number;
}

export interface OpticalDrive {
  id: string;
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
  id: string;
  opticalDriveId: string;
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
  id: string;
  detectedDiscId: string;
  discKind: DiscKind;
  archiveFormat: "iso";
  archivePath: string;
  fingerprint: string;
  sizeBytes: number | null;
  archivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaItem {
  id: string;
  parentId: string | null;
  kind: MediaItemKind;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscSelection {
  id: string;
  originalDiscArchiveId: string;
  mediaItemId: string;
  sourceKey: string;
  kind: DiscSelectionKind;
  titleNumber: number | null;
  chapterStart: number | null;
  chapterEnd: number | null;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EncodingProfile {
  id: string;
  key: string;
  displayName: string;
  mediaDomain: MediaDomain;
  version: number;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArchiveJob {
  id: string;
  detectedDiscId: string;
  originalDiscArchiveId: string | null;
  status: JobStatus;
  priority: number;
  progressPercent: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EncodeJob {
  id: string;
  discSelectionId: string;
  encodingProfileId: string;
  outputPath: string;
  status: JobStatus;
  priority: number;
  progressPercent: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
    opticalDriveId: string;
    discKind: DiscKind;
    fingerprint: string;
    volumeLabel?: string;
    scanData?: unknown;
  }): DetectedDisc;
  listDetectedDiscs(statuses?: DetectedDiscStatus[]): DetectedDisc[];
  updateDetectedDiscStatus(
    id: string,
    status: DetectedDiscStatus,
  ): DetectedDisc;
  createOriginalDiscArchive(input: {
    detectedDiscId: string;
    discKind: DiscKind;
    archiveFormat: "iso";
    archivePath: string;
    fingerprint: string;
    sizeBytes?: number;
  }): OriginalDiscArchive;
  listOriginalDiscArchives(): OriginalDiscArchive[];
  createMediaItem(input: {
    parentId?: string;
    kind: MediaItemKind;
    title: string;
    year?: number;
    seasonNumber?: number;
    episodeNumber?: number;
  }): MediaItem;
  listMediaItems(): MediaItem[];
  createDiscSelection(input: {
    originalDiscArchiveId: string;
    mediaItemId: string;
    sourceKey: string;
    kind: DiscSelectionKind;
    titleNumber?: number;
    chapterStart?: number;
    chapterEnd?: number;
    label?: string;
  }): DiscSelection;
  listDiscSelections(): DiscSelection[];
  createEncodingProfile(input: {
    key: string;
    displayName: string;
    mediaDomain: MediaDomain;
    version: number;
    settings: Record<string, unknown>;
  }): EncodingProfile;
  listEncodingProfiles(): EncodingProfile[];
}

export interface ArchiveJobAccess {
  enqueue(input: { detectedDiscId: string; priority?: number }): ArchiveJob;
  claimNext(workerId: string): ArchiveJob | null;
  list(statuses?: JobStatus[]): ArchiveJob[];
  updateProgress(id: string, progressPercent: number): ArchiveJob;
  complete(id: string, originalDiscArchiveId?: string): ArchiveJob;
  fail(id: string, errorMessage: string): ArchiveJob;
  requeue(id: string): ArchiveJob;
}

export interface EncodeJobAccess {
  enqueue(input: {
    discSelectionId: string;
    encodingProfileId: string;
    outputPath: string;
    priority?: number;
  }): EncodeJob;
  claimNext(workerId: string): EncodeJob | null;
  list(statuses?: JobStatus[]): EncodeJob[];
  updateProgress(id: string, progressPercent: number): EncodeJob;
  complete(id: string): EncodeJob;
  fail(id: string, errorMessage: string): EncodeJob;
  requeue(id: string): EncodeJob;
}

export interface DataAccess {
  readonly catalog: CatalogAccess;
  readonly archiveJobs: ArchiveJobAccess;
  readonly encodeJobs: EncodeJobAccess;
  checkHealth(): ServiceHealth;
  close(): void;
}
