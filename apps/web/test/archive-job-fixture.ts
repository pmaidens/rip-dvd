import { createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import type { LegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

export function startArchiveJob(
  access: LegacySidecarDataAccess,
  disc: ReturnType<LegacySidecarDataAccess["catalog"]["registerDetectedDisc"]>,
  workerId: string,
) {
  access.archiveRequests.create({ detectedDiscId: disc.id });
  const completed = completeDiscInspection(access, disc, `${workerId}-generation`);
  return access.archiveJobs.startForInspection(completed.id, workerId)!;
}

export function completeDiscInspection(
  access: LegacySidecarDataAccess,
  disc: ReturnType<LegacySidecarDataAccess["catalog"]["registerDetectedDisc"]>,
  mediaGeneration: string,
) {
  const started = access.discInspections.beginOrResume({
    opticalDriveId: disc.opticalDriveId,
    mediaGeneration,
  });
  access.discInspections.record(started.claim!, {
    type: "metadata",
    volumeLabel: disc.volumeLabel,
    titleCount: 0,
    chapterCount: 0,
    audioStreamCount: 0,
    subtitleStreamCount: 0,
    totalBytes: 9,
  });
  return access.discInspections.record(started.claim!, {
    type: "complete",
    detectedDiscId: disc.id,
  });
}

export function seedFailedArchiveJobAndQueuedDuplicate(
  access: LegacySidecarDataAccess,
  fingerprint: string,
) {
  const failedDrive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/${fingerprint}-failed`,
    displayName: "Failed drive",
    isEnabled: true,
    isPresent: true,
  });
  const publishingDrive = access.catalog.upsertOpticalDrive({
    devicePath: `/dev/${fingerprint}-publishing`,
    displayName: "Publishing drive",
    isEnabled: true,
    isPresent: true,
  });
  const failedDisc = access.catalog.registerDetectedDisc({
    opticalDriveId: failedDrive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: "FAILED_DUPLICATE",
  });
  const publishingDisc = access.catalog.registerDetectedDisc({
    opticalDriveId: publishingDrive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: "PUBLISHED_DUPLICATE",
  });
  for (const disc of [failedDisc, publishingDisc]) {
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  }

  const failedJob = startArchiveJob(access, failedDisc, "failed-worker");
  access.archiveJobs.fail(failedJob, "disc read failed");

  return {
    failedDisc,
    failedJob,
    failedRequestId: failedJob.archiveRequestId,
    publishDuplicate() {
      const publishingJob = startArchiveJob(
        access,
        publishingDisc,
        "publishing-worker",
      );
      return access.archiveJobs.publish(publishingJob, {
        archivePath: `/media/originals/${fingerprint}.iso`,
        integrityEvidence: createCleanReadArchiveIntegrityEvidence(
          "test-clean-v1",
        ),
        sizeBytes: 9,
      });
    },
  };
}
