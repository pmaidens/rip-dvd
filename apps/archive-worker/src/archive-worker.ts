import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type { DataAccess } from "@rip-dvd/data-access";

import type { OpticalDriveHardware } from "./archive-worker-contracts.js";
import { runArchiveJob } from "./archive-job-runner.js";
import { reconcileDiscoveredDrives } from "./authorized-optical-drive.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import { runDiscInspection } from "./disc-inspection-runner.js";
import {
  type DvdCopyRunner,
  withCancelledDvdArchiveInactive,
} from "./dvd-archiver.js";

export type {
  BoundOpticalDrive,
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
  signal: AbortSignal;
  workerId?: string;
}

export interface RunArchiveWorkerOptions extends PollArchiveWorkerOptions {
  pollIntervalMs: number;
  waitForNextPoll?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
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

export async function pollArchiveWorker({
  access,
  concurrency = 1,
  configuredDevicePath,
  copyRunner,
  hardware,
  log,
  originalsLibraryPath,
  signal,
  workerId = "archive-worker",
}: PollArchiveWorkerOptions): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Archive worker concurrency is invalid");
  }
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
          devicePath: drive.devicePath,
          fingerprint: disc.fingerprint,
          mutation: () =>
            access.archiveJobs.finalizeExpiredCancellation(claim),
          originalsLibraryPath,
          runner: copyRunner,
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
  for (const drive of drives) {
    if (!drive.isPresent) {
      access.discInspections.clearCurrent({
        opticalDriveId: drive.id,
        reasonCode: "drive_unavailable",
      });
    }
  }

  const pollDrive = async (drive: (typeof drives)[number]): Promise<void> => {
    if (!drive.isPresent || !drive.isEnabled) {
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
      });
      if (
        completed === null ||
        copyRunner === undefined ||
        originalsLibraryPath === undefined
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
        signal,
        workerId,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`DVD scan failed for ${drive.devicePath}: ${message}`);
    }
  };

  let nextDriveIndex = 0;
  const pollNextDrive = async (): Promise<void> => {
    while (nextDriveIndex < drives.length) {
      const drive = drives[nextDriveIndex]!;
      nextDriveIndex += 1;
      await pollDrive(drive);
    }
  };

  const results = await Promise.allSettled(
    Array.from(
      { length: Math.min(concurrency, drives.length) },
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
  while (!pollOptions.signal.aborted) {
    try {
      await pollArchiveWorker(pollOptions);
    } catch (error) {
      if (pollOptions.signal.aborted) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      pollOptions.log(`Archive worker poll failed: ${message}`);
    }
    if (pollOptions.signal.aborted) {
      break;
    }
    try {
      await wait(pollIntervalMs, pollOptions.signal);
    } catch (error) {
      if (!pollOptions.signal.aborted) {
        throw error;
      }
    }
  }
}
