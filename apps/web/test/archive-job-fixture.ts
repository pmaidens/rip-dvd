import { createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import type { LegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { vi } from "vitest";

import {
  pollArchiveWorker,
  type PollArchiveWorkerOptions,
} from "../../archive-worker/src/archive-worker.js";
import {
  createInProcessDvdRescueWorkspaceLock,
} from "../../archive-worker/src/dvd-rescue-workspace-lock.js";

const testRescueWorkspaceLock = createInProcessDvdRescueWorkspaceLock();

export async function pollArchiveWorkerForTest(
  options: PollArchiveWorkerOptions,
): Promise<void> {
  const alreadyUsingFakeTimers = vi.isFakeTimers();
  if (!alreadyUsingFakeTimers) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const firstObservationAt = Date.now();
  try {
    for (const elapsedMs of [0, 2_500, 5_000]) {
      vi.setSystemTime(new Date(firstObservationAt + elapsedMs));
      await pollArchiveWorker({
        ...options,
        rescueWorkspaceLock:
          options.rescueWorkspaceLock ?? testRescueWorkspaceLock,
      });
      if (!options.access.discInspections.list({ currentOnly: true }).some(
        (inspection) => inspection.phase === "settling",
      )) {
        return;
      }
    }
  } finally {
    if (!alreadyUsingFakeTimers) {
      vi.useRealTimers();
    }
  }
}

export function beginSettledDiscInspectionForTest(
  access: LegacySidecarDataAccess,
  input: Parameters<
    LegacySidecarDataAccess["discInspections"]["beginOrResume"]
  >[0],
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
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: disc.opticalDriveId,
    mediaGeneration,
    mediaCapacityBytes: 2_048,
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
  const completed = access.discInspections.record(started.claim!, {
    type: "complete",
    detectedDiscId: disc.id,
  });
  started.restoreSystemTime();
  return completed;
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
