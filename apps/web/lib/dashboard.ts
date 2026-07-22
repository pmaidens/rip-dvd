import type {
  ArchiveFormat,
  DataAccess,
  DetectedDiscStatus,
  DiscKind,
  JobStatus,
} from "@rip-dvd/data-access";

export interface DashboardOpticalDrive {
  id: string;
  displayName: string;
  devicePath: string;
  hardwareName: string | null;
  state: "ready" | "disabled" | "missing";
  lastSeenAt: string;
}

export interface DashboardDetectedDisc {
  id: string;
  volumeLabel: string;
  discKind: DiscKind;
  status: DetectedDiscStatus;
  opticalDriveName: string;
  detectedAt: string;
}

export interface DashboardArchiveJob {
  id: string;
  discLabel: string;
  opticalDriveName: string;
  status: JobStatus;
  progressPercent: number;
  errorMessage: string | null;
}

export interface DashboardEncodeJob {
  id: string;
  mediaTitle: string;
  mediaYear: number | null;
  encodingProfileName: string;
  status: JobStatus;
  progressPercent: number;
  outputPath: string;
  errorMessage: string | null;
}

export interface DashboardCatalogReviewItem {
  id: string;
  discLabel: string;
  discKind: DiscKind;
  archiveFormat: ArchiveFormat;
  archivePath: string;
  archivedAt: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  opticalDrives: DashboardOpticalDrive[];
  detectedDiscs: DashboardDetectedDisc[];
  archiveJobs: DashboardArchiveJob[];
  encodeJobs: DashboardEncodeJob[];
  catalogReview: DashboardCatalogReviewItem[];
}

function driveDisplayName(
  drive: ReturnType<DataAccess["catalog"]["listOpticalDrives"]>[number],
): string {
  return drive.displayName ?? drive.devicePath;
}

export function readDashboardSnapshot(access: DataAccess): DashboardSnapshot {
  const opticalDrives = access.catalog.listOpticalDrives();
  const detectedDiscs = access.catalog.listDetectedDiscs();
  const archiveJobs = access.archiveJobs.list();
  const encodeJobs = access.encodeJobs.list();
  const originalDiscArchives = access.catalog.listOriginalDiscArchives();
  const discSelections = access.catalog.listDiscSelections();
  const mediaItems = access.catalog.listMediaItems();
  const encodingProfiles = access.catalog.listEncodingProfiles();

  const drivesById = new Map(opticalDrives.map((drive) => [drive.id, drive]));
  const discsById = new Map(detectedDiscs.map((disc) => [disc.id, disc]));
  const selectionsById = new Map(
    discSelections.map((selection) => [selection.id, selection]),
  );
  const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
  const profilesById = new Map(
    encodingProfiles.map((profile) => [profile.id, profile]),
  );
  const selectedArchiveIds = new Set(
    discSelections.map((selection) => selection.originalDiscArchiveId),
  );

  return {
    generatedAt: new Date().toISOString(),
    opticalDrives: opticalDrives.map((drive) => ({
      id: drive.id,
      displayName: driveDisplayName(drive),
      devicePath: drive.devicePath,
      hardwareName:
        [drive.vendor, drive.product].filter(Boolean).join(" ") || null,
      state: !drive.isPresent
        ? "missing"
        : drive.isEnabled
          ? "ready"
          : "disabled",
      lastSeenAt: drive.lastSeenAt.toISOString(),
    })),
    detectedDiscs: detectedDiscs.map((disc) => {
      const drive = drivesById.get(disc.opticalDriveId);
      return {
        id: disc.id,
        volumeLabel: disc.volumeLabel ?? "Unlabeled disc",
        discKind: disc.discKind,
        status: disc.status,
        opticalDriveName: drive ? driveDisplayName(drive) : "Unknown drive",
        detectedAt: disc.detectedAt.toISOString(),
      };
    }),
    archiveJobs: archiveJobs.map((job) => {
      const disc = discsById.get(job.detectedDiscId);
      const drive = disc ? drivesById.get(disc.opticalDriveId) : undefined;
      return {
        id: job.id,
        discLabel: disc?.volumeLabel ?? "Unlabeled disc",
        opticalDriveName: drive ? driveDisplayName(drive) : "Unknown drive",
        status: job.status,
        progressPercent: job.progressPercent,
        errorMessage: job.errorMessage,
      };
    }),
    encodeJobs: encodeJobs.map((job) => {
      const selection = selectionsById.get(job.discSelectionId);
      const mediaItem = selection
        ? mediaItemsById.get(selection.mediaItemId)
        : undefined;
      const profile = profilesById.get(job.encodingProfileId);
      return {
        id: job.id,
        mediaTitle: mediaItem?.title ?? "Unknown Media Item",
        mediaYear: mediaItem?.year ?? null,
        encodingProfileName: profile?.displayName ?? "Unknown profile",
        status: job.status,
        progressPercent: job.progressPercent,
        outputPath: job.outputPath,
        errorMessage: job.errorMessage,
      };
    }),
    catalogReview: originalDiscArchives
      .filter((archive) => !selectedArchiveIds.has(archive.id))
      .map((archive) => ({
        id: archive.id,
        discLabel:
          discsById.get(archive.detectedDiscId)?.volumeLabel ??
          "Unlabeled disc",
        discKind: archive.discKind,
        archiveFormat: archive.archiveFormat,
        archivePath: archive.archivePath,
        archivedAt: archive.archivedAt.toISOString(),
      })),
  };
}
