import type {
  DataAccess,
  DetectedDisc,
  OriginalDiscArchiveId,
  RunningArchiveJob,
} from "./types.js";

export function completeCatalogReview(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
) {
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [archiveId],
  })[0]!;
  return access.catalog.completeCatalogReview(
    archiveId,
    archive.updatedAt,
    "reviewed_with_selections",
  );
}

export function startArchiveJobForTest(
  access: DataAccess,
  disc: DetectedDisc,
  workerId: string,
): RunningArchiveJob {
  access.archiveRequests.create({ detectedDiscId: disc.id });
  const started = access.discInspections.beginOrResume({
    opticalDriveId: disc.opticalDriveId,
    mediaGeneration: `test-generation:${disc.id}`,
  });
  let inspection = started.inspection;
  if (started.claim) {
    inspection = access.discInspections.record(started.claim, {
      type: "complete",
      detectedDiscId: disc.id,
    });
  }
  const claim = access.archiveJobs.startForInspection(inspection.id, workerId);
  if (!claim) {
    throw new Error("Expected an Archive Job attempt to start");
  }
  return claim;
}
