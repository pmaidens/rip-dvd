import {
  createCleanReadArchiveIntegrityEvidence,
} from "@rip-dvd/data-access";
import type { LegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import { vi } from "vitest";

import {
  pollArchiveWorker,
  type PollArchiveWorkerOptions,
} from "../../archive-worker/src/archive-worker.js";
import {
  createInProcessDvdRescueWorkspaceLock,
} from "../../archive-worker/src/dvd-rescue-workspace-lock.js";
import type { DvdEndpointProver } from "../../archive-worker/src/dvd-endpoint-prover.js";

const testRescueWorkspaceLock = createInProcessDvdRescueWorkspaceLock();
const passingDvdGeometryValidator = { async validate() {} };
const testEndpointProver: DvdEndpointProver = {
  async prove({ authorizeProbe, firstExcludedLba }) {
    for (let index = 0; index < 4; index += 1) {
      await authorizeProbe();
    }
    return {
      proofVersion: "dvd-normal-endpoint-proof-v1",
      confirmationCount: 2,
      firstExcludedLba,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 0x70,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      },
    };
  },
};

export async function pollArchiveWorkerForTest(
  options: PollArchiveWorkerOptions,
): Promise<void> {
  const alreadyUsingFakeTimers = vi.isFakeTimers();
  if (!alreadyUsingFakeTimers) {
    vi.useFakeTimers({ toFake: ["Date"] });
  }
  const startedAt = Date.now();
  let elapsedMs = 0;
  try {
    await pollArchiveWorker({
      geometryValidator: passingDvdGeometryValidator,
      ...options,
      endpointProver: options.endpointProver ?? testEndpointProver,
      rescueWorkspaceLock:
        options.rescueWorkspaceLock ?? testRescueWorkspaceLock,
      waitForNextSettlingObservation:
        options.waitForNextSettlingObservation ??
        (async (intervalMs, signal) => {
          signal.throwIfAborted();
          elapsedMs += intervalMs;
          vi.setSystemTime(new Date(startedAt + elapsedMs));
        }),
    });
  } finally {
    if (alreadyUsingFakeTimers) {
      vi.setSystemTime(new Date(startedAt));
    } else {
      vi.useRealTimers();
    }
  }
}

export { beginSettledDiscInspectionForTest };

export function startArchiveJob(
  access: LegacySidecarDataAccess,
  disc: ReturnType<LegacySidecarDataAccess["catalog"]["registerDetectedDisc"]>,
  workerId: string,
  totalBytes = 2_048,
) {
  access.archiveRequests.create({ detectedDiscId: disc.id });
  const completed = completeDiscInspection(
    access,
    disc,
    `${workerId}-generation`,
    totalBytes,
  );
  return access.archiveJobs.startForInspection(completed.id, workerId)!;
}

export function completeDiscInspection(
  access: LegacySidecarDataAccess,
  disc: ReturnType<LegacySidecarDataAccess["catalog"]["registerDetectedDisc"]>,
  mediaGeneration: string,
  totalBytes = 2_048,
) {
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: disc.opticalDriveId,
    mediaGeneration,
    mediaCapacityBytes: totalBytes,
  });
  access.discInspections.record(started.claim!, {
    type: "metadata",
    volumeLabel: disc.volumeLabel,
    titleCount: 0,
    chapterCount: 0,
    audioStreamCount: 0,
    subtitleStreamCount: 0,
    totalBytes,
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
        boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(2_048),
        integrityEvidence: createCleanReadArchiveIntegrityEvidence(
          "test-clean-v1",
        ),
        sizeBytes: 2_048,
      });
    },
  };
}
