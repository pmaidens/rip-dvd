import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type { DataAccess } from "@rip-dvd/data-access";

import type { OpticalDriveHardware } from "./archive-worker-contracts.js";
import { runArchiveJob } from "./archive-job-runner.js";
import {
  hasSameOpticalDriveIdentity,
  reconcileDiscoveredDrives,
} from "./authorized-optical-drive.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import { runDiscInspection } from "./disc-inspection-runner.js";
import {
  type DvdCopyRunner,
  withCancelledDvdArchiveInactive,
} from "./dvd-archiver.js";
import type { DvdSalvageValidator } from "./dvd-salvage-validator.js";
import {
  defaultDvdRescueWorkspaceLock,
  type DvdRescueWorkspaceLock,
} from "./dvd-rescue-workspace-lock.js";

export type {
  BoundOpticalDrive,
  OpticalMediaObservation,
  OpticalDriveHardware,
  ScannedDvd,
} from "./archive-worker-contracts.js";

export interface PollArchiveWorkerOptions {
  access: DataAccess;
  concurrency?: number;
  configuredDevicePath: string;
  copyRunner?: DvdCopyRunner;
  hardware: OpticalDriveHardware;
  log(message: string): void;
  originalsLibraryPath?: string;
  rescueWorkspaceLock?: DvdRescueWorkspaceLock;
  salvageValidator?: DvdSalvageValidator;
  signal: AbortSignal;
  waitForNextSettlingObservation?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  workerId?: string;
}

export interface RunArchiveWorkerOptions extends PollArchiveWorkerOptions {
  pollIntervalMs: number;
  waitForNextPoll?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface DrivePollAdmission {
  release(devicePath: string): void;
  tryAcquire(devicePath: string): boolean;
}

const MAX_ARCHIVE_DRIVE_POLL_INTERVAL_MS = 5_000;

function requireArchiveWorkerConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Archive worker concurrency is invalid");
  }
  return value;
}

function boundedArchiveDrivePollInterval(pollIntervalMs: number): number {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Archive worker poll interval is invalid");
  }
  return Math.min(pollIntervalMs, MAX_ARCHIVE_DRIVE_POLL_INTERVAL_MS);
}

function resolveConfiguredDevicePath(devicePath: string): string {
  try {
    return realpathSync(devicePath);
  } catch {
    // Preserve the configured path while its device is absent. A later poll
    // resolves an alias as soon as its target becomes available.
    return devicePath;
  }
}

function prioritizeDrivesWithPendingRequests<
  Drive extends { id: string },
>(access: DataAccess, drives: readonly Drive[]): Drive[] {
  const priorityByDriveId = new Map<string, number>();
  for (const inspection of access.discInspections.list({ currentOnly: true })) {
    if (
      inspection.status !== "completed" ||
      inspection.detectedDiscId === null
    ) {
      continue;
    }
    const request = access.archiveRequests.listRelevantForDetectedDiscs([
      inspection.detectedDiscId,
    ])[0];
    if (request?.status === "pending") {
      priorityByDriveId.set(inspection.opticalDriveId, request.priority);
    }
  }
  return drives
    .map((drive, index) => ({ drive, index }))
    .sort((left, right) => {
      const leftPriority = priorityByDriveId.get(left.drive.id);
      const rightPriority = priorityByDriveId.get(right.drive.id);
      if (leftPriority === undefined) {
        return rightPriority === undefined ? left.index - right.index : 1;
      }
      if (rightPriority === undefined) {
        return -1;
      }
      return rightPriority - leftPriority || left.index - right.index;
    })
    .map(({ drive }) => drive);
}

async function pollArchiveWorkerWithDriveAdmission(
  {
    access,
    concurrency: requestedConcurrency = 1,
    configuredDevicePath,
    copyRunner,
    hardware,
    log,
    originalsLibraryPath,
    rescueWorkspaceLock = defaultDvdRescueWorkspaceLock,
    salvageValidator,
    signal,
    waitForNextSettlingObservation,
    workerId = "archive-worker",
  }: PollArchiveWorkerOptions,
  admission?: DrivePollAdmission,
): Promise<void> {
  signal.throwIfAborted();
  const concurrency = requireArchiveWorkerConcurrency(requestedConcurrency);
  access.archiveJobs.recoverExpiredClaims();
  if (copyRunner !== undefined && originalsLibraryPath !== undefined) {
    for (const claim of access.archiveJobs.listExpiredCancellations()) {
      try {
        const disc = access.catalog.listDetectedDiscs(undefined, {
          ids: [claim.detectedDiscId],
        })[0];
        if (disc === undefined) {
          throw new Error("Cancelled Archive Job has no Detected Disc");
        }
        const drive = access.catalog.listOpticalDrives({
          ids: [disc.opticalDriveId],
        })[0];
        if (drive === undefined) {
          throw new Error("Cancelled Archive Job has no Optical Drive");
        }
        await withCancelledDvdArchiveInactive({
          archiveRequestId: claim.archiveRequestId,
          devicePath: drive.devicePath,
          fingerprint: disc.fingerprint,
          mutation: () => {
            access.archiveJobs.finalizeExpiredCancellation(claim);
            return undefined;
          },
          originalsLibraryPath,
          runner: copyRunner,
          signal,
          workspaceLock: rescueWorkspaceLock,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          `Cancelled Archive Job recovery deferred for ${claim.id}: ${message}`,
        );
      }
    }
  }
  const discovered = await hardware.discover(signal);
  signal.throwIfAborted();
  const previouslyKnownDrives = access.catalog.listOpticalDrives();
  const configuredCanonicalPath =
    resolveConfiguredDevicePath(configuredDevicePath);
  const drives = reconcileDiscoveredDrives(
    access,
    discovered,
    configuredCanonicalPath,
  );
  const discoveredByPath = new Map(
    discovered.map((drive) => [drive.devicePath, drive]),
  );
  const previouslyKnownById = new Map(
    previouslyKnownDrives.map((drive) => [drive.id, drive]),
  );
  for (const drive of drives) {
    if (!drive.isPresent || !drive.isEnabled) {
      const previousDrive = previouslyKnownById.get(drive.id);
      const discoveredDrive = discoveredByPath.get(drive.devicePath);
      const identityChanged =
        previousDrive !== undefined &&
        discoveredDrive !== undefined &&
        !hasSameOpticalDriveIdentity(previousDrive, discoveredDrive);
      access.discInspections.clearCurrent({
        opticalDriveId: drive.id,
        reasonCode: identityChanged
          ? "drive_identity_changed"
          : "drive_unavailable",
      });
    }
  }
  const prioritizedDrives = prioritizeDrivesWithPendingRequests(access, drives);

  const pollDrive = async (drive: (typeof drives)[number]): Promise<void> => {
    if (!drive.isPresent || !drive.isEnabled) {
      return;
    }
    if (admission !== undefined && !admission.tryAcquire(drive.devicePath)) {
      return;
    }
    try {
      const expectedDrive = discoveredByPath.get(drive.devicePath);
      if (expectedDrive === undefined) {
        throw new DiscInspectionError(
          "retry",
          "drive_unavailable",
          "Optical Drive identity is unavailable for scanning",
        );
      }
      const completed = await runDiscInspection({
        access,
        configuredCanonicalPath,
        drive,
        expectedDrive,
        hardware,
        log,
        signal,
        waitForNextSettlingObservation,
      });
      if (
        completed === null ||
        copyRunner === undefined ||
        originalsLibraryPath === undefined
      ) {
        return;
      }
      const detectedDiscId = completed.inspection.detectedDiscId;
      if (
        detectedDiscId === null ||
        !access.archiveRequests.hasPendingRequestForDetectedDiscFingerprint(
          detectedDiscId,
        )
      ) {
        return;
      }
      await runArchiveJob({
        access,
        completed,
        configuredCanonicalPath,
        copyRunner,
        hardware,
        log,
        originalsLibraryPath,
        rescueWorkspaceLock,
        salvageValidator,
        signal,
        workerId,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`DVD scan failed for ${drive.devicePath}: ${message}`);
    } finally {
      admission?.release(drive.devicePath);
    }
  };

  let nextDriveIndex = 0;
  const pollNextDrive = async (): Promise<void> => {
    while (nextDriveIndex < prioritizedDrives.length) {
      const drive = prioritizedDrives[nextDriveIndex]!;
      nextDriveIndex += 1;
      await pollDrive(drive);
    }
  };

  const results = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, prioritizedDrives.length) },
      pollNextDrive,
    ),
  );
  signal.throwIfAborted();
  const failedLane = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedLane) {
    throw failedLane.reason;
  }
}

export async function pollArchiveWorker(
  options: PollArchiveWorkerOptions,
): Promise<void> {
  await pollArchiveWorkerWithDriveAdmission(options);
}

async function waitForNextPoll(
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(intervalMs, undefined, { signal });
}

export async function runArchiveWorker({
  pollIntervalMs,
  waitForNextPoll: wait = waitForNextPoll,
  ...pollOptions
}: RunArchiveWorkerOptions): Promise<void> {
  const concurrency = requireArchiveWorkerConcurrency(
    pollOptions.concurrency ?? 1,
  );
  const driveIntervalMs = boundedArchiveDrivePollInterval(pollIntervalMs);
  // Long-running work owns only its physical drive and one configured slot.
  // Later ticks can continue polling other drives without overlapping it.
  const activeDevicePaths = new Set<string>();
  const admission: DrivePollAdmission = {
    release(devicePath) {
      activeDevicePaths.delete(devicePath);
    },
    tryAcquire(devicePath) {
      if (
        activeDevicePaths.has(devicePath) ||
        activeDevicePaths.size >= concurrency
      ) {
        return false;
      }
      activeDevicePaths.add(devicePath);
      return true;
    },
  };
  const inFlightPolls = new Set<Promise<void>>();
  const startAvailableDrivePolls = () => {
    if (
      activeDevicePaths.size >= concurrency ||
      inFlightPolls.size >= concurrency
    ) {
      return;
    }
    let polling!: Promise<void>;
    polling = pollArchiveWorkerWithDriveAdmission(
      pollOptions,
      admission,
    )
      .catch((error: unknown) => {
        if (!pollOptions.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          pollOptions.log(`Archive worker poll failed: ${message}`);
        }
      })
      .finally(() => {
        inFlightPolls.delete(polling);
      });
    inFlightPolls.add(polling);
  };

  try {
    while (!pollOptions.signal.aborted) {
      startAvailableDrivePolls();
      if (pollOptions.signal.aborted) {
        break;
      }
      try {
        await wait(driveIntervalMs, pollOptions.signal);
      } catch (error) {
        if (!pollOptions.signal.aborted) {
          throw error;
        }
      }
    }
  } finally {
    await Promise.allSettled(inFlightPolls);
  }
}
