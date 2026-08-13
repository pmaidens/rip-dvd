import type {
  ArchiveFormat,
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
  DiscInspectionPhase,
  DiscInspectionReasonCode,
  DiscInspectionStatus,
  EncodeJobId,
  EncodeJobStatus,
  EncodeProgressPhase,
  FilesystemVerificationStatus,
  OriginalDiscArchive,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { isCorrectedEncodePredecessorReady } from "@rip-dvd/data-access";
import {
  decodeDvdTitleMap,
  type DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";

import {
  DASHBOARD_ACTIVE_DISC_LIMIT,
  DASHBOARD_ACTIVE_JOB_LIMIT,
} from "./dashboard-bounds";
import { isTerminalEncodeJobStatus } from "./encode-job-status";
import { formatFailureDetail } from "./failure-detail";

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
  detectedDiscId: string;
  archiveRequestId: string;
  attemptOrdinal: number;
  discLabel: string;
  opticalDriveName: string;
  status: ArchiveJobStatus;
  progressPhase: ArchiveProgressPhase;
  progressPercent: number;
  failureDetail?: string | null;
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
  verificationStatus?: FilesystemVerificationStatus | null;
  verificationMessage?: string | null;
  verifiedAt?: string | null;
}

export interface DashboardCatalogReviewItem {
  id: string;
  activityRevision?: string;
  discLabel: string;
  discKind: DiscKind;
  archiveFormat: ArchiveFormat;
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
  | EncodeJobStatus;

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
  catalogReviewCursor?: CatalogReviewArchiveListCursor;
  catalogReviewView?: CatalogReviewArchiveView;
  catalogReviewQuery?: string;
  catalogReviewOutcome?: CompletedCatalogReviewOutcome;
  includeDetectedDiscDetails?: boolean;
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

function readDashboardSnapshotRecords(
  access: ConsistentReadAccess,
  {
    activityLimit,
    catalogReviewCursor,
    catalogReviewView = "needs_review",
    catalogReviewQuery,
    catalogReviewOutcome,
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
  const discInspectionSource = readSource(() =>
    access.discInspections.list({ currentOnly: true }),
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
  const displayedDetectedDiscIds = [
    ...(detectedDiscSource.status === "loaded"
      ? detectedDiscSource.value.map((disc) => disc.id)
      : []),
    ...(discInspectionSource.status === "loaded"
      ? discInspectionSource.value.flatMap((inspection) =>
          inspection.detectedDiscId === null
            ? []
            : [inspection.detectedDiscId],
        )
      : []),
  ];
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
                  latestFailureDetail: formatFailureDetail(
                    latestJob?.errorMessage ?? null,
                  ),
                  createdAt: request.createdAt.toISOString(),
                  updatedAt: request.updatedAt.toISOString(),
                },
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
                failureDetail: formatFailureDetail(job.errorMessage),
              };
            }),
          );
        })();

  const encodeJobs =
    encodeJobSource.status === "error" ||
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
                                isCorrectedEncodePredecessorReady(predecessor),
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
                      requeueable: terminalRequeueSelectionIds.has(
                        job.discSelectionId,
                      ),
                    }
                  : {}),
                failureDetail: formatFailureDetail(job.errorMessage),
                verificationStatus: job.verificationStatus,
                verificationMessage: job.verificationMessage,
                verifiedAt: job.verifiedAt?.toISOString() ?? null,
              };
            }),
          );
        })();

  const catalogReview =
    archiveSource.status === "error"
      ? unavailable<DashboardCatalogReviewItem>()
      : {
          status: "loaded" as const,
          items: catalogReviewArchives.map((archive) => ({
            id: archive.id,
            activityRevision: archive.updatedAt.toISOString(),
            discLabel: archive.discLabel,
            discKind: archive.discKind,
            archiveFormat: archive.archiveFormat,
            archivedAt: archive.archivedAt.toISOString(),
            catalogReviewedAt:
              archive.catalogReviewedAt?.toISOString() ?? null,
            catalogReviewOutcome: archive.catalogReviewOutcome,
            mappedMediaItemCount: archive.mappedMediaItemCount,
            mappedMediaItemTitles: archive.mappedMediaItemTitles,
            verificationStatus: archive.verificationStatus,
            verificationMessage: archive.verificationMessage,
            verifiedAt: archive.verifiedAt?.toISOString() ?? null,
          })),
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
