import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type {
  DataAccess,
  DiscoveredOpticalDrive,
  OpticalDriveId,
  RunningArchiveJob,
} from "@rip-dvd/data-access";
import {
  ARCHIVE_INSPECTION_LEASE_DURATION_MS,
  ARCHIVE_JOB_LEASE_DURATION_MS,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

import {
  preserveDvdArchive,
  quarantinePublishedArchive,
  type DvdCopyRunner,
} from "./dvd-archiver.js";

export interface ScannedDvd {
  fingerprint: string;
  isNewMediumObservation?: boolean;
  sizeBytes?: number;
  volumeLabel?: string;
  scanData: DvdTitleMap;
}

export interface BoundOpticalDrive {
  readonly deviceInstanceToken: string;
  readonly drive: DiscoveredOpticalDrive;
}

export interface OpticalDriveHardware {
  discover(signal: AbortSignal): Promise<readonly DiscoveredOpticalDrive[]>;
  bindOpticalDrive(
    drive: DiscoveredOpticalDrive,
    signal: AbortSignal,
  ): Promise<BoundOpticalDrive>;
  scanDvd(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<ScannedDvd | null>;
  confirmOpticalDrive(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<void>;
}

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

interface DrivePollAdmission {
  release(devicePath: string): void;
  tryAcquire(devicePath: string): boolean;
}

interface ManagedArchiveClaim {
  claim: RunningArchiveJob;
  opticalDriveId: OpticalDriveId;
  signal: AbortSignal;
}

interface ArchiveClaimLease {
  signal: AbortSignal;
  stop(): void;
}

interface ArchiveClaimCoordinator {
  claimAvailable(): void;
  failPending(errorMessage: string): void;
  finish(claim: RunningArchiveJob): void;
  forDrive(opticalDriveId: OpticalDriveId):
    | ManagedArchiveClaim
    | undefined;
}

const MAX_ARCHIVE_JOB_CLAIM_INTERVAL_MS = 1_000;
const MAX_ARCHIVE_DRIVE_POLL_INTERVAL_MS = 5_000;

function requireArchiveWorkerConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Archive worker concurrency is invalid");
  }
  return value;
}

function boundedArchivePollIntervals(pollIntervalMs: number) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Archive worker poll interval is invalid");
  }
  return {
    claimIntervalMs: Math.min(
      pollIntervalMs,
      MAX_ARCHIVE_JOB_CLAIM_INTERVAL_MS,
    ),
    driveIntervalMs: Math.min(
      pollIntervalMs,
      MAX_ARCHIVE_DRIVE_POLL_INTERVAL_MS,
    ),
  };
}

function startArchiveClaimLease(
  access: DataAccess,
  claim: RunningArchiveJob,
  workerSignal: AbortSignal,
): ArchiveClaimLease {
  const claimController = new AbortController();
  const signal = AbortSignal.any([workerSignal, claimController.signal]);
  const heartbeat = setInterval(() => {
    try {
      access.archiveJobs.renewClaim(claim);
    } catch (error) {
      claimController.abort(error);
    }
  }, Math.floor(ARCHIVE_JOB_LEASE_DURATION_MS / 3));
  heartbeat.unref();
  return {
    signal,
    stop() {
      clearInterval(heartbeat);
    },
  };
}

function createArchiveClaimCoordinator({
  access,
  concurrency,
  log,
  signal,
  workerId,
}: {
  access: DataAccess;
  concurrency: number;
  log(message: string): void;
  signal: AbortSignal;
  workerId: string;
}): ArchiveClaimCoordinator {
  const managed = new Map<
    RunningArchiveJob["id"],
    ManagedArchiveClaim & Pick<ArchiveClaimLease, "stop">
  >();
  const finish = (claim: RunningArchiveJob) => {
    const current = managed.get(claim.id);
    if (current !== undefined) {
      current.stop();
      managed.delete(claim.id);
    }
  };
  return {
    claimAvailable() {
      while (!signal.aborted && managed.size < concurrency) {
        const claim = access.archiveJobs.claimNext(workerId);
        if (claim === null) {
          return;
        }
        const disc = access.catalog.listDetectedDiscs(["approved"], {
          ids: [claim.detectedDiscId],
        })[0];
        if (disc === undefined) {
          access.archiveJobs.fail(
            claim,
            "Approved DVD evidence disappeared before archiving",
          );
          continue;
        }
        const lease = startArchiveClaimLease(access, claim, signal);
        managed.set(claim.id, {
          claim,
          opticalDriveId: disc.opticalDriveId,
          signal: lease.signal,
          stop: lease.stop,
        });
      }
    },
    failPending(errorMessage) {
      for (const current of [...managed.values()]) {
        try {
          access.archiveJobs.fail(current.claim, errorMessage);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`Archive Job failure state could not be persisted: ${message}`);
        } finally {
          finish(current.claim);
        }
      }
    },
    finish,
    forDrive(opticalDriveId) {
      return [...managed.values()].find(
        (current) => current.opticalDriveId === opticalDriveId,
      );
    },
  };
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

function normalizeHardwareEvidence(
  value: string | undefined,
): string | undefined {
  return value?.trim() || undefined;
}

function hasSameHardwareIdentity(
  expected: DiscoveredOpticalDrive,
  observed: DiscoveredOpticalDrive,
): boolean {
  const expectedSerial = normalizeHardwareEvidence(expected.serialNumber);
  return (
    expected.devicePath === observed.devicePath &&
    expectedSerial !== undefined &&
    expectedSerial ===
      normalizeHardwareEvidence(observed.serialNumber)
  );
}

function reconcileDiscoveredDrives(
  access: DataAccess,
  discovered: readonly DiscoveredOpticalDrive[],
  configuredCanonicalPath: string,
) {
  return access.catalog.reconcileOpticalDrives(
    discovered.map((drive) => ({
      ...drive,
      isConfiguredDevice: drive.devicePath === configuredCanonicalPath,
    })),
  );
}

async function confirmAuthorizedDrive({
  access,
  configuredCanonicalPath,
  expected,
  hardware,
  phase,
  signal,
}: {
  access: DataAccess;
  configuredCanonicalPath: string;
  expected: DiscoveredOpticalDrive;
  hardware: OpticalDriveHardware;
  phase: "DVD persistence" | "DVD scanning";
  signal: AbortSignal;
}) {
  const discovered = await hardware.discover(signal);
  signal.throwIfAborted();
  const drives = reconcileDiscoveredDrives(
    access,
    discovered,
    configuredCanonicalPath,
  );
  const observed = discovered.find(
    (drive) => drive.devicePath === expected.devicePath,
  );
  if (observed === undefined || !hasSameHardwareIdentity(expected, observed)) {
    if (observed !== undefined) {
      access.catalog.upsertOpticalDrive({
        ...observed,
        isEnabled: false,
        isPresent: true,
      });
    }
    throw new Error(`Optical Drive identity changed before ${phase}`);
  }
  const confirmed = drives.find(
    (drive) => drive.devicePath === expected.devicePath && drive.isPresent,
  );
  if (confirmed === undefined || !confirmed.isPresent || !confirmed.isEnabled) {
    throw new Error(`Optical Drive is not enabled before ${phase}`);
  }
  return { discovered: observed, persisted: confirmed };
}

async function pollArchiveWorkerWithDriveAdmission({
  access,
  concurrency: requestedConcurrency = 1,
  configuredDevicePath,
  copyRunner,
  hardware,
  log,
  originalsLibraryPath,
  signal,
  workerId = "archive-worker",
}: PollArchiveWorkerOptions,
  admission?: DrivePollAdmission,
  claimCoordinator?: ArchiveClaimCoordinator,
): Promise<void> {
  signal.throwIfAborted();
  const concurrency = requireArchiveWorkerConcurrency(requestedConcurrency);
  access.archiveJobs.recoverInterruptedInspections();
  access.archiveJobs.recoverExpiredClaims();
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

  const pollDrive = async (
    drive: (typeof drives)[number],
  ): Promise<void> => {
    if (!drive.isPresent || !drive.isEnabled) {
      return;
    }
    if (admission !== undefined && !admission.tryAcquire(drive.devicePath)) {
      return;
    }

    const managedClaim = claimCoordinator?.forDrive(drive.id);
    let archiveSignal = managedClaim?.signal ?? signal;
    let claim: RunningArchiveJob | null = managedClaim?.claim ?? null;
    let localClaimLease: ArchiveClaimLease | undefined;
    let publishedArchivePath: string | undefined;
    const startClaim = (nextClaim: RunningArchiveJob) => {
      localClaimLease = startArchiveClaimLease(access, nextClaim, signal);
      archiveSignal = localClaimLease.signal;
      return nextClaim;
    };

    try {
      const expected = discoveredByPath.get(drive.devicePath);
      if (expected === undefined) {
        throw new Error("Optical Drive identity is unavailable for scanning");
      }
      const confirmedBeforeScan = await confirmAuthorizedDrive({
        access,
        configuredCanonicalPath,
        expected,
        hardware,
        phase: "DVD scanning",
        signal,
      });
      const binding = await hardware.bindOpticalDrive(
        confirmedBeforeScan.discovered,
        signal,
      );
      await confirmAuthorizedDrive({
        access,
        configuredCanonicalPath,
        expected: binding.drive,
        hardware,
        phase: "DVD scanning",
        signal,
      });
      if (
        claimCoordinator === undefined &&
        copyRunner !== undefined &&
        originalsLibraryPath !== undefined
      ) {
        const pendingClaim = access.archiveJobs.claimNext(workerId, {
          opticalDriveId: drive.id,
        });
        if (pendingClaim !== null) {
          claim = startClaim(pendingClaim);
        }
      }
      const inspection = access.archiveJobs.beginDriveInspection(drive.id);
      const inspectionController = new AbortController();
      const inspectionSignal = AbortSignal.any([
        archiveSignal,
        inspectionController.signal,
      ]);
      const inspectionHeartbeat = inspection.jobIds.length > 0
        ? setInterval(() => {
            try {
              access.archiveJobs.renewDriveInspection(inspection);
            } catch (error) {
              inspectionController.abort(error);
            }
          }, Math.floor(ARCHIVE_INSPECTION_LEASE_DURATION_MS / 3))
        : undefined;
      inspectionHeartbeat?.unref();
      let scan: ScannedDvd | null;
      try {
        scan = await hardware.scanDvd(binding, inspectionSignal);
      } finally {
        if (inspectionHeartbeat !== undefined) {
          clearInterval(inspectionHeartbeat);
        }
        access.archiveJobs.finishDriveInspection(inspection);
      }
      archiveSignal.throwIfAborted();
      if (scan === null) {
        if (claim !== null) {
          throw new Error("DVD medium is unavailable before archiving");
        }
        return;
      }
      const confirmedBeforePersistence = await confirmAuthorizedDrive({
        access,
        configuredCanonicalPath,
        expected: confirmedBeforeScan.discovered,
        hardware,
        phase: "DVD persistence",
        signal: archiveSignal,
      });
      await hardware.confirmOpticalDrive(binding, archiveSignal);
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: confirmedBeforePersistence.persisted.id,
        discKind: "dvd",
        fingerprint: scan.fingerprint,
        isNewMediumObservation: scan.isNewMediumObservation,
        volumeLabel: scan.volumeLabel,
        scanData: scan.scanData,
        sizeBytes: scan.sizeBytes,
      });
      if (disc.status === "detected") {
        access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      }
      if (copyRunner === undefined || originalsLibraryPath === undefined) {
        return;
      }
      if (scan.sizeBytes === undefined) {
        if (claim !== null) {
          throw new Error("DVD size is unavailable before archiving");
        }
        return;
      }
      if (claim === null) {
        if (claimCoordinator !== undefined) {
          return;
        }
        const lateClaim = access.archiveJobs.claimNext(workerId, {
          opticalDriveId: confirmedBeforePersistence.persisted.id,
          fingerprint: scan.fingerprint,
        });
        if (lateClaim === null) {
          return;
        }
        claim = startClaim(lateClaim);
      }
      if (claim.detectedDiscId !== disc.id) {
        throw new Error("DVD medium changed before archiving");
      }
      const activeClaim = claim;

      const preserved = await preserveDvdArchive({
        devicePath: binding.drive.devicePath,
        fingerprint: scan.fingerprint,
        originalsLibraryPath,
        runner: copyRunner,
        signal: archiveSignal,
        sizeBytes: scan.sizeBytes,
        onProgress: (progress) => {
          access.archiveJobs.updateProgress(activeClaim, progress);
        },
        verifySource: async () => {
          await confirmAuthorizedDrive({
            access,
            configuredCanonicalPath,
            expected: binding.drive,
            hardware,
            phase: "DVD persistence",
            signal: archiveSignal,
          });
          await hardware.confirmOpticalDrive(binding, archiveSignal);
          const verified = await hardware.scanDvd(binding, archiveSignal);
          if (
            verified === null ||
            verified.fingerprint !== scan.fingerprint ||
            verified.sizeBytes !== scan.sizeBytes
          ) {
            throw new Error("DVD medium changed during archiving");
          }
        },
      });
      publishedArchivePath = preserved.archivePath;
      try {
        access.archiveJobs.publish(activeClaim, {
          archivePath: preserved.archivePath,
          sizeBytes: preserved.sizeBytes,
        });
      } catch (error) {
        await quarantinePublishedArchive(preserved.archivePath);
        publishedArchivePath = undefined;
        throw error;
      }
      claimCoordinator?.finish(activeClaim);
    } catch (error) {
      if (claim !== null) {
        const message = signal.aborted
          ? "Archive interrupted"
          : error instanceof Error
            ? error.message.slice(0, 500)
            : String(error).slice(0, 500);
        try {
          access.archiveJobs.fail(claim, message);
        } catch (failureError) {
          const failureMessage =
            failureError instanceof Error
              ? failureError.message
              : String(failureError);
          log(
            `Archive Job failure state could not be persisted: ${failureMessage}`,
          );
        }
        if (publishedArchivePath !== undefined) {
          await quarantinePublishedArchive(publishedArchivePath);
        }
        claimCoordinator?.finish(claim);
        if (signal.aborted) {
          throw error;
        }
        log(`DVD archive failed for ${drive.devicePath}: ${message}`);
        return;
      }
      if (signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`DVD scan failed for ${drive.devicePath}: ${message}`);
    } finally {
      localClaimLease?.stop();
      admission?.release(drive.devicePath);
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
  const { claimIntervalMs, driveIntervalMs } =
    boundedArchivePollIntervals(pollIntervalMs);
  // A long operation owns only its physical drive and one concurrency slot.
  // Later scheduler ticks can still poll other drives without overlapping it.
  const activeDevicePaths = new Set<string>();
  const claimCoordinator =
    pollOptions.copyRunner !== undefined &&
    pollOptions.originalsLibraryPath !== undefined
      ? createArchiveClaimCoordinator({
          access: pollOptions.access,
          concurrency,
          log: pollOptions.log,
          signal: pollOptions.signal,
          workerId: pollOptions.workerId ?? "archive-worker",
        })
      : undefined;
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
      claimCoordinator,
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

  let nextDrivePollAt = 0;
  try {
    while (!pollOptions.signal.aborted) {
      claimCoordinator?.claimAvailable();
      const currentTime = Date.now();
      if (currentTime >= nextDrivePollAt) {
        startAvailableDrivePolls();
        nextDrivePollAt = currentTime + driveIntervalMs;
      }
      if (pollOptions.signal.aborted) {
        break;
      }
      try {
        await wait(claimIntervalMs, pollOptions.signal);
      } catch (error) {
        if (!pollOptions.signal.aborted) {
          throw error;
        }
      }
    }
  } finally {
    await Promise.allSettled(inFlightPolls);
    claimCoordinator?.failPending("Archive interrupted");
  }
}
