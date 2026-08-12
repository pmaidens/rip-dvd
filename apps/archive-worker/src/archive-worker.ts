import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type {
  DataAccess,
  DiscInspection,
  DiscoveredOpticalDrive,
  RunningArchiveJob,
} from "@rip-dvd/data-access";
import {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
} from "@rip-dvd/data-access";
import {
  decodeDvdTitleMap,
  type DvdTitleMap,
} from "@rip-dvd/data-access/dvd-scan";

import {
  preserveDvdArchive,
  quarantinePublishedArchive,
  type DvdCopyRunner,
} from "./dvd-archiver.js";
import { classifyDiscInspectionError } from "./disc-inspection-error.js";
import { createDiscInspectionRateEstimator } from "./disc-inspection-rate.js";
import type { DiscInspectionScanOptions } from "./optical-drive-dvd-scanner.js";

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
    options?: DiscInspectionScanOptions,
  ): Promise<ScannedDvd | null>;
  observeMediaGeneration(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<string>;
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
    (drive) => drive.devicePath === expected.devicePath,
  );
  if (confirmed === undefined || !confirmed.isPresent || !confirmed.isEnabled) {
    throw new Error(`Optical Drive is not enabled before ${phase}`);
  }
  return { discovered: observed, persisted: confirmed };
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

  const pollDrive = async (
    drive: (typeof drives)[number],
  ): Promise<void> => {
    if (!drive.isPresent || !drive.isEnabled) {
      return;
    }

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
      const mediaGeneration = await hardware.observeMediaGeneration(
        binding,
        signal,
      );
      const startedInspection = access.discInspections.beginOrResume({
        opticalDriveId: drive.id,
        mediaGeneration,
      });
      let completedInspection: DiscInspection | null = null;
      if (startedInspection.claim === null) {
        if (
          startedInspection.inspection.status === "completed" &&
          startedInspection.inspection.detectedDiscId !== null
        ) {
          completedInspection = startedInspection.inspection;
        } else {
          return;
        }
      } else {
        const inspectionClaim = startedInspection.claim;
        const inspectionController = new AbortController();
        const inspectionSignal = AbortSignal.any([
          signal,
          inspectionController.signal,
        ]);
        const inspectionHeartbeat = setInterval(() => {
          try {
            access.discInspections.renew(inspectionClaim);
          } catch (error) {
            inspectionController.abort(error);
          }
        }, Math.floor(DISC_INSPECTION_LEASE_DURATION_MS / 3));
        inspectionHeartbeat.unref();
        const estimator = createDiscInspectionRateEstimator();
        let totalBytes: number | null = null;
        try {
          const scan = await hardware.scanDvd(binding, inspectionSignal, {
            expectedMediaGeneration: mediaGeneration,
            onBytesHashed(bytesHashed) {
              if (totalBytes === null) {
                throw new Error("DVD hash progress preceded metadata findings");
              }
              const estimate = estimator.update(
                bytesHashed,
                totalBytes,
                Date.now(),
              );
              access.discInspections.record(inspectionClaim, {
                type: "hash_progress",
                bytesHashed,
                ...estimate,
              });
            },
            onMetadata(metadata) {
              totalBytes = metadata.totalBytes;
              access.discInspections.record(inspectionClaim, {
                type: "metadata",
                ...metadata,
              });
            },
            onPhase(phase) {
              if (phase === "confirming_media") {
                access.discInspections.record(inspectionClaim, {
                  type: "confirming_media",
                });
              }
            },
          });
          signal.throwIfAborted();
          if (scan === null) {
            access.discInspections.record(inspectionClaim, {
              type: "abort",
              reasonCode: "no_medium",
            });
            return;
          }
          if (totalBytes === null && scan.sizeBytes !== undefined) {
            totalBytes = scan.sizeBytes;
            access.discInspections.record(inspectionClaim, {
              type: "metadata",
              volumeLabel: scan.volumeLabel ?? null,
              titleCount: scan.scanData.titles.length,
              chapterCount: scan.scanData.titles.reduce(
                (total, title) => total + title.chapters,
                0,
              ),
              audioStreamCount: scan.scanData.titles.reduce(
                (total, title) => total + title.audioStreams.length,
                0,
              ),
              subtitleStreamCount: scan.scanData.titles.reduce(
                (total, title) => total + title.subtitles.length,
                0,
              ),
              totalBytes,
            });
            access.discInspections.record(inspectionClaim, {
              type: "hash_progress",
              bytesHashed: totalBytes,
              bytesPerSecond: null,
              etaSeconds: null,
            });
            access.discInspections.record(inspectionClaim, {
              type: "confirming_media",
            });
          }
          const confirmedBeforePersistence = await confirmAuthorizedDrive({
            access,
            configuredCanonicalPath,
            expected: confirmedBeforeScan.discovered,
            hardware,
            phase: "DVD persistence",
            signal: inspectionSignal,
          });
          await hardware.confirmOpticalDrive(binding, inspectionSignal);
          const observedGeneration = await hardware.observeMediaGeneration(
            binding,
            inspectionSignal,
          );
          if (observedGeneration !== mediaGeneration) {
            throw new Error("DVD medium changed during scanning");
          }
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
          completedInspection = access.discInspections.record(
            inspectionClaim,
            { type: "complete", detectedDiscId: disc.id },
          );
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          const classified = classifyDiscInspectionError(error);
          try {
            if (classified.kind === "abort") {
              access.discInspections.record(inspectionClaim, {
                type: "abort",
                reasonCode: classified.reasonCode,
                diagnostic: classified.diagnostic,
              });
            } else if (classified.kind === "fail") {
              access.discInspections.record(inspectionClaim, {
                type: "fail",
                reasonCode: classified.reasonCode,
                diagnostic: classified.diagnostic,
              });
            } else {
              const retryDelayMs = Math.min(
                60_000,
                5_000 * 2 ** startedInspection.inspection.consecutiveFailureCount,
              );
              access.discInspections.record(inspectionClaim, {
                type: "retry",
                reasonCode: classified.reasonCode,
                diagnostic: classified.diagnostic,
                retryAt: new Date(Date.now() + retryDelayMs),
              });
            }
          } catch (persistenceError) {
            const persistenceMessage = persistenceError instanceof Error
              ? persistenceError.message
              : String(persistenceError);
            log(`Disc Inspection failure state could not be persisted: ${persistenceMessage}`);
          }
          const message = error instanceof Error ? error.message : String(error);
          log(`DVD scan failed for ${drive.devicePath}: ${message}`);
          return;
        } finally {
          clearInterval(inspectionHeartbeat);
        }
      }

      if (
        copyRunner === undefined ||
        originalsLibraryPath === undefined ||
        completedInspection === null ||
        completedInspection.detectedDiscId === null ||
        completedInspection.totalBytes === null
      ) {
        return;
      }
      const archiveSizeBytes = completedInspection.totalBytes;
      const disc = access.catalog.listDetectedDiscs(undefined, {
        ids: [completedInspection.detectedDiscId],
      })[0];
      const scanData = disc === undefined ? null : decodeDvdTitleMap(disc.scanData);
      if (disc === undefined || scanData === null) {
        throw new Error("Completed Disc Inspection has invalid catalog findings");
      }
      const scan: ScannedDvd = {
        fingerprint: disc.fingerprint,
        scanData,
        sizeBytes: archiveSizeBytes,
        ...(disc.volumeLabel === null ? {} : { volumeLabel: disc.volumeLabel }),
      };
      const claim = access.archiveJobs.startForInspection(
        completedInspection.id,
        workerId,
      );
      if (!claim) {
        return;
      }

      const claimController = new AbortController();
      const archiveSignal = AbortSignal.any([
        signal,
        claimController.signal,
      ]);
      const heartbeat = setInterval(() => {
        try {
          access.archiveJobs.renewClaim(claim);
        } catch (error) {
          claimController.abort(error);
        }
      }, Math.floor(ARCHIVE_JOB_LEASE_DURATION_MS / 3));
      heartbeat.unref();
      const cancellationPoll = setInterval(() => {
        try {
          if (access.archiveJobs.isCancellationRequested(claim)) {
            claimController.abort(new Error("Archive Request cancellation requested"));
          }
        } catch (error) {
          claimController.abort(error);
        }
      }, 1_000);
      cancellationPoll.unref();
      let publishedArchivePath: string | undefined;
      try {
        const preserved = await preserveDvdArchive({
          devicePath: binding.drive.devicePath,
          fingerprint: scan.fingerprint,
          originalsLibraryPath,
          runner: copyRunner,
          signal: archiveSignal,
          sizeBytes: archiveSizeBytes,
          onProgress: (progress) => {
            access.archiveJobs.updateProgress(claim, progress);
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
            const observedGeneration = await hardware.observeMediaGeneration(
              binding,
              archiveSignal,
            );
            if (observedGeneration !== mediaGeneration) {
              throw new Error("DVD medium changed during archiving");
            }
          },
        });
        publishedArchivePath = preserved.archivePath;
        try {
          access.archiveJobs.publish(claim, {
            archivePath: preserved.archivePath,
            sizeBytes: preserved.sizeBytes,
          });
        } catch (error) {
          await quarantinePublishedArchive(preserved.archivePath);
          publishedArchivePath = undefined;
          throw error;
        }
      } catch (error) {
        let cancellationRequested =
          archiveSignal.aborted &&
          archiveSignal.reason instanceof Error &&
          archiveSignal.reason.message === "Archive Request cancellation requested";
        const message = signal.aborted
          ? "Archive interrupted"
          : error instanceof Error
            ? error.message.slice(0, 500)
            : String(error).slice(0, 500);
        try {
          if (cancellationRequested) {
            access.archiveJobs.abort(claim, "Archive cancelled by operator");
          } else {
            const terminalJob = access.archiveJobs.fail(claim, message);
            cancellationRequested = terminalJob.status === "aborted";
          }
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
        if (signal.aborted) {
          throw error;
        }
        log(
          cancellationRequested
            ? `DVD archive cancelled for ${drive.devicePath}`
            : `DVD archive failed for ${drive.devicePath}: ${message}`,
        );
      } finally {
        clearInterval(heartbeat);
        clearInterval(cancellationPoll);
      }
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
