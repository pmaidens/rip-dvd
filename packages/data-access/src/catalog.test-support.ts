import { vi } from "vitest";

import type {
  DataAccess,
  DetectedDisc,
  OriginalDiscArchiveId,
  RunningArchiveJob,
} from "./types.js";

export function beginSettledDiscInspectionForTest(
  access: DataAccess,
  input: Parameters<DataAccess["discInspections"]["beginOrResume"]>[0],
) {
  const alreadyUsingFakeTimers = vi.isFakeTimers();
  if (!alreadyUsingFakeTimers) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const firstObservationAt = Date.now();
  access.discInspections.beginOrResume(input);
  vi.setSystemTime(new Date(firstObservationAt + 2_500));
  access.discInspections.beginOrResume(input);
  vi.setSystemTime(new Date(firstObservationAt + 5_000));
  const settled = access.discInspections.beginOrResume(input);
  if (settled.claim === null) {
    throw new Error("Expected a settled Disc Inspection claim");
  }
  return {
    ...settled,
    restoreSystemTime() {
      if (alreadyUsingFakeTimers) {
        vi.setSystemTime(new Date(firstObservationAt));
      } else {
        vi.useRealTimers();
      }
    },
  };
}

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
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: disc.opticalDriveId,
    mediaGeneration: `test-generation:${disc.id}`,
    mediaCapacityBytes: 2_048,
  });
  let inspection = started.inspection;
  if (started.claim) {
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
