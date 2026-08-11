import type { LegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

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
    access.archiveJobs.approve({ detectedDiscId: disc.id });
  }

  const failedJob = access.archiveJobs.claimNext("failed-worker", {
    opticalDriveId: failedDrive.id,
    fingerprint,
  })!;
  access.archiveJobs.fail(failedJob, "disc read failed");

  return {
    failedDisc,
    failedJob,
    publishDuplicate() {
      const publishingJob = access.archiveJobs.claimNext(
        "publishing-worker",
        {
          opticalDriveId: publishingDrive.id,
          fingerprint,
        },
      )!;
      return access.archiveJobs.publish(publishingJob, {
        archivePath: `/media/originals/${fingerprint}.iso`,
        sizeBytes: 9,
      });
    },
  };
}
