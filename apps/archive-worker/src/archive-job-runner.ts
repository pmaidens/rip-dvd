import type { DataAccess } from "@rip-dvd/data-access";
import { ARCHIVE_JOB_LEASE_DURATION_MS } from "@rip-dvd/data-access";
import { decodeDvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

import type { OpticalDriveHardware } from "./archive-worker-contracts.js";
import { confirmAuthorizedDrive } from "./authorized-optical-drive.js";
import type { CompletedDiscInspection } from "./disc-inspection-runner.js";
import {
  preserveDvdArchive,
  quarantinePublishedArchive,
  type DvdCopyRunner,
} from "./dvd-archiver.js";

export interface RunArchiveJobOptions {
  access: DataAccess;
  completed: CompletedDiscInspection;
  configuredCanonicalPath: string;
  copyRunner: DvdCopyRunner;
  hardware: OpticalDriveHardware;
  log(message: string): void;
  originalsLibraryPath: string;
  signal: AbortSignal;
  workerId: string;
}

export async function runArchiveJob({
  access,
  completed,
  configuredCanonicalPath,
  copyRunner,
  hardware,
  log,
  originalsLibraryPath,
  signal,
  workerId,
}: RunArchiveJobOptions): Promise<void> {
  const { binding, inspection, mediaGeneration } = completed;
  if (inspection.detectedDiscId === null || inspection.totalBytes === null) {
    return;
  }
  const archiveSizeBytes = inspection.totalBytes;
  const disc = access.catalog.listDetectedDiscs(undefined, {
    ids: [inspection.detectedDiscId],
  })[0];
  const scanData = disc === undefined ? null : decodeDvdTitleMap(disc.scanData);
  if (disc === undefined || scanData === null) {
    throw new Error("Completed Disc Inspection has invalid catalog findings");
  }
  const claim = access.archiveJobs.startForInspection(inspection.id, workerId);
  if (!claim) {
    return;
  }

  const claimController = new AbortController();
  const archiveSignal = AbortSignal.any([signal, claimController.signal]);
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
        claimController.abort(
          new Error("Archive Request cancellation requested"),
        );
      }
    } catch (error) {
      claimController.abort(error);
    }
  }, 1_000);
  cancellationPoll.unref();

  let publishedArchivePath: string | undefined;
  try {
    const preserved = await preserveDvdArchive({
      authorizeCopy: () => {
        archiveSignal.throwIfAborted();
        if (access.archiveJobs.isCancellationRequested(claim)) {
          const cancellation = new Error(
            "Archive Request cancellation requested",
          );
          claimController.abort(cancellation);
          archiveSignal.throwIfAborted();
        }
        access.archiveJobs.renewClaim(claim);
      },
      devicePath: binding.drive.devicePath,
      fingerprint: disc.fingerprint,
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
      const failureMessage = failureError instanceof Error
        ? failureError.message
        : String(failureError);
      log(`Archive Job failure state could not be persisted: ${failureMessage}`);
    }
    if (publishedArchivePath !== undefined) {
      await quarantinePublishedArchive(publishedArchivePath);
    }
    if (signal.aborted) {
      throw error;
    }
    log(
      cancellationRequested
        ? `DVD archive cancelled for ${binding.drive.devicePath}`
        : `DVD archive failed for ${binding.drive.devicePath}: ${message}`,
    );
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancellationPoll);
  }
}
