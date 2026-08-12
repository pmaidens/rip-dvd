import type {
  ConsistentReadAccess,
  DataAccess,
  FilesystemVerificationStatus,
} from "@rip-dvd/data-access";

const PREVIEW_LIMIT = 3;

export interface ActionOverviewItem {
  id: string;
  label: string;
}

export interface ActionOverviewCategory {
  count: number;
  items: ActionOverviewItem[];
}

export interface ActionOverviewSnapshot {
  generatedAt: string;
  discApprovals: ActionOverviewCategory;
  failedArchives: ActionOverviewCategory;
  failedEncodes: ActionOverviewCategory;
  catalogReviews: ActionOverviewCategory;
  filesystemProblems: ActionOverviewCategory;
}

interface PreviewRecord {
  id: string;
  label: string;
  occurredAt: Date;
}

function category(records: PreviewRecord[]): ActionOverviewCategory {
  return {
    count: records.length,
    items: records
      .sort(
        (left, right) =>
          right.occurredAt.getTime() - left.occurredAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, PREVIEW_LIMIT)
      .map(({ id, label }) => ({ id, label })),
  };
}

function isFilesystemProblem(
  status: FilesystemVerificationStatus | null,
): boolean {
  return status !== null && status !== "accessible";
}

function mediaLabel(
  item: { title: string; year: number | null } | undefined,
): string {
  if (!item) {
    return "Unknown Media Item";
  }
  return item.year === null ? item.title : `${item.title} (${item.year})`;
}

function readSnapshot(access: ConsistentReadAccess): ActionOverviewSnapshot {
  const discsAwaitingApproval = access.catalog.listDetectedDiscs(["scanned"]);
  const archiveRequestsNeedingAttention = access.archiveRequests.list([
    "needs_attention",
  ]);
  const allArchives = access.catalog.listOriginalDiscArchives();
  const allEncodeJobs = access.encodeJobs.list();
  const failedEncodeJobs = allEncodeJobs.filter(
    (job) => job.status === "failed",
  );
  const catalogReviewArchives = allArchives.filter(
    (archive) => archive.catalogReviewOutcome === "needs_review",
  );
  const archiveProblems = allArchives.filter((archive) =>
    isFilesystemProblem(archive.verificationStatus),
  );
  const encodeProblems = allEncodeJobs.filter((job) =>
    isFilesystemProblem(job.verificationStatus),
  );

  const detectedDiscIds = [
    ...new Set([
      ...archiveRequestsNeedingAttention.map((request) => request.detectedDiscId),
      ...catalogReviewArchives.map((archive) => archive.detectedDiscId),
      ...archiveProblems.map((archive) => archive.detectedDiscId),
    ]),
  ];
  const relevantDiscs =
    detectedDiscIds.length === 0
      ? []
      : access.catalog.listDetectedDiscs(undefined, { ids: detectedDiscIds });
  const discsById = new Map(relevantDiscs.map((disc) => [disc.id, disc]));

  const relevantEncodeJobs = [...failedEncodeJobs, ...encodeProblems];
  const selectionIds = [
    ...new Set(relevantEncodeJobs.map((job) => job.discSelectionId)),
  ];
  const selections =
    selectionIds.length === 0
      ? []
      : access.catalog.listDiscSelections({ ids: selectionIds });
  const mediaItemIds = [
    ...new Set(selections.map((selection) => selection.mediaItemId)),
  ];
  const mediaItems =
    mediaItemIds.length === 0
      ? []
      : access.catalog.listMediaItems({ ids: mediaItemIds });
  const selectionsById = new Map(
    selections.map((selection) => [selection.id, selection]),
  );
  const mediaItemsById = new Map(mediaItems.map((item) => [item.id, item]));
  const encodeJobLabel = (job: (typeof relevantEncodeJobs)[number]) => {
    const selection = selectionsById.get(job.discSelectionId);
    return mediaLabel(
      selection ? mediaItemsById.get(selection.mediaItemId) : undefined,
    );
  };

  return {
    generatedAt: new Date().toISOString(),
    discApprovals: category(
      discsAwaitingApproval.map((disc) => ({
        id: disc.id,
        label: disc.volumeLabel ?? "Unlabeled disc",
        occurredAt: disc.detectedAt,
      })),
    ),
    failedArchives: category(
      archiveRequestsNeedingAttention.map((request) => ({
        id: request.id,
        label:
          discsById.get(request.detectedDiscId)?.volumeLabel ?? "Unlabeled disc",
        occurredAt: request.updatedAt,
      })),
    ),
    failedEncodes: category(
      failedEncodeJobs.map((job) => ({
        id: job.id,
        label: encodeJobLabel(job),
        occurredAt: job.updatedAt,
      })),
    ),
    catalogReviews: category(
      catalogReviewArchives.map((archive) => ({
        id: archive.id,
        label:
          discsById.get(archive.detectedDiscId)?.volumeLabel ??
          "Unlabeled disc",
        occurredAt: archive.archivedAt,
      })),
    ),
    filesystemProblems: category([
      ...archiveProblems.map((archive) => ({
        id: `original_disc_archive:${archive.id}`,
        label:
          discsById.get(archive.detectedDiscId)?.volumeLabel ??
          "Unlabeled disc",
        occurredAt: archive.verifiedAt ?? archive.archivedAt,
      })),
      ...encodeProblems.map((job) => ({
        id: `encode_job_output:${job.id}`,
        label: encodeJobLabel(job),
        occurredAt: job.verifiedAt ?? job.updatedAt,
      })),
    ]),
  };
}

export function readActionOverview(access: DataAccess): ActionOverviewSnapshot {
  return access.readConsistentSnapshot(readSnapshot);
}
