import type {
  ArchiveFormat,
  ConsistentReadAccess,
  DataAccess,
  DetectedDiscId,
  DetectedDiscStatus,
  DiscKind,
  EncodeProgressPhase,
  JobStatus,
} from "@rip-dvd/data-access";
import {
  decodeDvdTitleMap,
  type DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";

import {
  DASHBOARD_ACTIVE_DISC_LIMIT,
  DASHBOARD_ACTIVE_JOB_LIMIT,
} from "./dashboard-bounds";

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
  fingerprint: string;
  titles: readonly DvdTitle[];
  detectedAt: string;
}

export interface DashboardDetectedDiscDetails {
  id: string;
  detectedAt: string;
  titles: readonly DvdTitle[];
}

export interface DashboardArchiveJob {
  id: string;
  detectedDiscId: string;
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
  progressPhase: EncodeProgressPhase | null;
  progressPercent: number;
  progressEtaSeconds: number | null;
}

export interface DashboardCatalogReviewItem {
  id: string;
  discLabel: string;
  discKind: DiscKind;
  archiveFormat: ArchiveFormat;
  archivedAt: string;
}

export interface DashboardPage {
  offset: number;
  limit: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export type DashboardStatus =
  | DashboardOpticalDrive["state"]
  | DetectedDiscStatus
  | JobStatus;

export type DashboardSectionResult<T> =
  | { status: "loaded"; items: T[]; page?: DashboardPage }
  | { status: "error" };

export interface DashboardSnapshot {
  generatedAt: string;
  opticalDrives: DashboardSectionResult<DashboardOpticalDrive>;
  detectedDiscs: DashboardSectionResult<DashboardDetectedDisc>;
  archiveJobs: DashboardSectionResult<DashboardArchiveJob>;
  encodeJobs: DashboardSectionResult<DashboardEncodeJob>;
  catalogReview: DashboardSectionResult<DashboardCatalogReviewItem>;
}

export interface DashboardSnapshotOptions {
  activityLimit?: number;
  catalogReviewOffset?: number;
  includeDetectedDiscDetails?: boolean;
}

export function parseDashboardCatalogReviewOffset(
  request: Request,
): number | null {
  const value = new URL(request.url).searchParams.get("catalogReviewOffset");
  if (value === null) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
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
  {
    activityLimit,
    catalogReviewOffset = 0,
    includeDetectedDiscDetails = true,
  }: DashboardSnapshotOptions = {},
): DashboardSnapshot {
  const opticalDriveSource = readSource(() =>
    access.catalog.listOpticalDrives(
      activityLimit === undefined
        ? undefined
        : { historicalLimit: activityLimit },
    ),
  );
  const detectedDiscSource = readSource(() =>
    access.catalog.listDetectedDiscs(
      undefined,
      activityLimit === undefined
        ? undefined
        : {
            policy: {
              mode: "active-and-history",
              activeLimit: DASHBOARD_ACTIVE_DISC_LIMIT,
              historyLimit: activityLimit,
            },
          },
    ),
  );
  const archiveJobSource = readSource(() =>
    access.archiveJobs.list(
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
  const archiveSource = readSource(() =>
    access.catalog.listOriginalDiscArchives(
      activityLimit === undefined
        ? { needsCatalogReviewOnly: true }
        : {
            limit: activityLimit + 1,
            offset: catalogReviewOffset,
            needsCatalogReviewOnly: true,
          },
    ),
  );
  const catalogReviewArchives =
    archiveSource.status === "loaded" && activityLimit !== undefined
      ? archiveSource.value.slice(-activityLimit)
      : archiveSource.status === "loaded"
        ? archiveSource.value
        : [];
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
  const relevantSelectionIds =
    activityLimit === undefined
      ? undefined
      : encodeJobSource.status === "error"
        ? []
        : encodeJobSource.value.map((job) => job.discSelectionId);
  const selectionSource = readSource(() =>
    access.catalog.listDiscSelections(
      relevantSelectionIds === undefined
        ? undefined
        : { ids: [...new Set(relevantSelectionIds)] },
    ),
  );
  const relevantMediaItemIds =
    activityLimit === undefined
      ? undefined
      : selectionSource.status === "error"
        ? []
        : selectionSource.value.map((selection) => selection.mediaItemId);
  const mediaItemSource = readSource(() =>
    access.catalog.listMediaItems(
      relevantMediaItemIds === undefined
        ? undefined
        : { ids: [...new Set(relevantMediaItemIds)] },
    ),
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
  const discsById =
    linkedDetectedDiscSource.status === "loaded"
      ? new Map(
          linkedDetectedDiscSource.value.map((disc) => [disc.id, disc]),
        )
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
                fingerprint: disc.fingerprint,
                titles: includeDetectedDiscDetails
                  ? (decodeDvdTitleMap(disc.scanData)?.titles ?? [])
                  : [],
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
                detectedDiscId: job.detectedDiscId,
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
                  profile
                    ? `${profile.displayName} · Version ${profile.version}`
                    : "Unknown Encoding Profile",
                status: job.status,
                progressPhase: job.progressPhase,
                progressPercent: job.progressPercent,
                progressEtaSeconds: job.progressEtaSeconds,
              };
            }),
          );
        })();

  const catalogReview =
    archiveSource.status === "error" ||
    discsById === null
      ? unavailable<DashboardCatalogReviewItem>()
      : {
          status: "loaded" as const,
          items: catalogReviewArchives.map((archive) => ({
            id: archive.id,
            discLabel:
              discsById.get(archive.detectedDiscId)?.volumeLabel ??
              "Unlabeled disc",
            discKind: archive.discKind,
            archiveFormat: archive.archiveFormat,
            archivedAt: archive.archivedAt.toISOString(),
          })),
          ...(activityLimit !== undefined &&
          (catalogReviewOffset > 0 || archiveSource.value.length > activityLimit)
            ? {
                page: {
                  offset: catalogReviewOffset,
                  limit: activityLimit,
                  hasPrevious: catalogReviewOffset > 0,
                  hasNext: archiveSource.value.length > activityLimit,
                },
              }
            : {}),
        };

  return {
    generatedAt: new Date().toISOString(),
    opticalDrives,
    detectedDiscs,
    archiveJobs,
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
