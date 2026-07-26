import type {
  ArchiveFormat,
  ConsistentReadAccess,
  DataAccess,
  DetectedDiscStatus,
  DiscKind,
  JobStatus,
} from "@rip-dvd/data-access";

export interface DashboardOpticalDrive {
  id: string;
  displayName: string;
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
}

export interface DashboardEncodeJob {
  id: string;
  mediaTitle: string;
  mediaYear: number | null;
  encodingProfileName: string;
  status: JobStatus;
  progressPercent: number;
}

export interface DashboardCatalogReviewItem {
  id: string;
  discLabel: string;
  discKind: DiscKind;
  archiveFormat: ArchiveFormat;
  archivedAt: string;
}

export type DashboardStatus =
  | DashboardOpticalDrive["state"]
  | DetectedDiscStatus
  | JobStatus;

export type DashboardSectionResult<T> =
  | { status: "loaded"; items: T[] }
  | { status: "error" };

export interface DashboardSnapshot {
  generatedAt: string;
  opticalDrives: DashboardSectionResult<DashboardOpticalDrive>;
  detectedDiscs: DashboardSectionResult<DashboardDetectedDisc>;
  archiveJobs: DashboardSectionResult<DashboardArchiveJob>;
  encodeJobs: DashboardSectionResult<DashboardEncodeJob>;
  catalogReview: DashboardSectionResult<DashboardCatalogReviewItem>;
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

function readDashboardSnapshotRecords(
  access: ConsistentReadAccess,
): DashboardSnapshot {
  const opticalDriveSource = readSource(() =>
    access.catalog.listOpticalDrives(),
  );
  const detectedDiscSource = readSource(() =>
    access.catalog.listDetectedDiscs(),
  );
  const archiveJobSource = readSource(() => access.archiveJobs.list());
  const encodeJobSource = readSource(() => access.encodeJobs.list());
  const archiveSource = readSource(() =>
    access.catalog.listOriginalDiscArchives(),
  );
  const selectionSource = readSource(() =>
    access.catalog.listDiscSelections(),
  );
  const mediaItemSource = readSource(() => access.catalog.listMediaItems());
  const profileSource = readSource(() => access.encodingProfiles.list());
  const drivesById =
    opticalDriveSource.status === "loaded"
      ? new Map(opticalDriveSource.value.map((drive) => [drive.id, drive]))
      : null;
  const discsById =
    detectedDiscSource.status === "loaded"
      ? new Map(detectedDiscSource.value.map((disc) => [disc.id, disc]))
      : null;

  const opticalDrives =
    opticalDriveSource.status === "error"
      ? unavailable<DashboardOpticalDrive>()
      : loaded(
          opticalDriveSource.value.map((drive): DashboardOpticalDrive => ({
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
          })),
        );

  const detectedDiscs =
    detectedDiscSource.status === "error" || drivesById === null
      ? unavailable<DashboardDetectedDisc>()
      : (() => {
          return loaded(
            detectedDiscSource.value.map((disc) => {
              const drive = drivesById.get(disc.opticalDriveId);
              return {
                id: disc.id,
                volumeLabel: disc.volumeLabel ?? "Unlabeled disc",
                discKind: disc.discKind,
                status: disc.status,
                opticalDriveName: drive
                  ? driveDisplayName(drive)
                  : "Unknown Optical Drive",
                detectedAt: disc.detectedAt.toISOString(),
              };
            }),
          );
        })();

  const archiveJobs =
    archiveJobSource.status === "error" ||
    drivesById === null ||
    discsById === null
      ? unavailable<DashboardArchiveJob>()
      : (() => {
          return loaded(
            archiveJobSource.value.map((job) => {
              const disc = discsById.get(job.detectedDiscId);
              const drive = disc
                ? drivesById.get(disc.opticalDriveId)
                : undefined;
              return {
                id: job.id,
                discLabel: disc?.volumeLabel ?? "Unlabeled disc",
                opticalDriveName: drive
                  ? driveDisplayName(drive)
                  : "Unknown Optical Drive",
                status: job.status,
                progressPercent: job.progressPercent,
              };
            }),
          );
        })();

  const encodeJobs =
    encodeJobSource.status === "error" ||
    selectionSource.status === "error" ||
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
          const mediaItemsById = new Map(
            mediaItemSource.value.map((item) => [item.id, item]),
          );
          const profilesById = new Map(
            profileSource.value.map((profile) => [profile.id, profile]),
          );
          return loaded(
            encodeJobSource.value.map((job) => {
              const selection = selectionsById.get(job.discSelectionId);
              const mediaItem = selection
                ? mediaItemsById.get(selection.mediaItemId)
                : undefined;
              const profile = profilesById.get(job.encodingProfileId);
              return {
                id: job.id,
                mediaTitle: mediaItem?.title ?? "Unknown Media Item",
                mediaYear: mediaItem?.year ?? null,
                encodingProfileName:
                  profile?.displayName ?? "Unknown Encoding Profile",
                status: job.status,
                progressPercent: job.progressPercent,
              };
            }),
          );
        })();

  const catalogReview =
    archiveSource.status === "error" ||
    selectionSource.status === "error" ||
    discsById === null
      ? unavailable<DashboardCatalogReviewItem>()
      : (() => {
          const selectedArchiveIds = new Set(
            selectionSource.value.map(
              (selection) => selection.originalDiscArchiveId,
            ),
          );
          return loaded(
            archiveSource.value
              .filter((archive) => !selectedArchiveIds.has(archive.id))
              .map((archive) => ({
                id: archive.id,
                discLabel:
                  discsById.get(archive.detectedDiscId)?.volumeLabel ??
                  "Unlabeled disc",
                discKind: archive.discKind,
                archiveFormat: archive.archiveFormat,
                archivedAt: archive.archivedAt.toISOString(),
              })),
          );
        })();

  return {
    generatedAt: new Date().toISOString(),
    opticalDrives,
    detectedDiscs,
    archiveJobs,
    encodeJobs,
    catalogReview,
  };
}

export function readDashboardSnapshot(access: DataAccess): DashboardSnapshot {
  return access.readConsistentSnapshot((snapshotAccess) =>
    readDashboardSnapshotRecords(snapshotAccess),
  );
}
