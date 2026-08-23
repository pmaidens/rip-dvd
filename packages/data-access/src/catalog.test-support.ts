import type {
  DataAccess,
  DetectedDisc,
  OriginalDiscArchiveId,
  RunningArchiveJob,
} from "./types.js";
import { beginSettledDiscInspectionForTest } from "./disc-settling-fixture.js";

export { beginSettledDiscInspectionForTest };

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
  reportedSizeBytes?: number,
): RunningArchiveJob {
  access.archiveRequests.create({ detectedDiscId: disc.id });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: disc.opticalDriveId,
    mediaGeneration: `test-generation:${disc.id}`,
    mediaCapacityBytes: 2_048,
  });
  let inspection = started.inspection;
  if (started.claim) {
    if (reportedSizeBytes !== undefined) {
      access.discInspections.record(started.claim, {
        type: "metadata",
        volumeLabel: disc.volumeLabel,
        titleCount: 0,
        chapterCount: 0,
        audioStreamCount: 0,
        subtitleStreamCount: 0,
        totalBytes: reportedSizeBytes,
      });
    }
    inspection = access.discInspections.record(started.claim, {
      type: "complete",
      detectedDiscId: disc.id,
    });
  }
  started.restoreSystemTime();
  const claim = access.archiveJobs.startForInspection(inspection.id, workerId);
  if (!claim) {
    throw new Error("Expected an Archive Job attempt to start");
  }
  return claim;
}
