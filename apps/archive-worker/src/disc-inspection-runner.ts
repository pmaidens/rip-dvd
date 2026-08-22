import { setTimeout as delay } from "node:timers/promises";

import type {
  DataAccess,
  DiscInspection,
  DiscoveredOpticalDrive,
  OpticalDrive,
} from "@rip-dvd/data-access";
import {
  DISC_INSPECTION_LEASE_DURATION_MS,
  DISC_INSPECTION_SETTLING_OBSERVATION_TARGET,
  DISC_INSPECTION_SETTLING_QUIET_WINDOW_MS,
  DISC_INSPECTION_SETTLING_TIMEOUT_MS,
} from "@rip-dvd/data-access";

import type {
  BoundOpticalDrive,
  OpticalDriveHardware,
} from "./archive-worker-contracts.js";
import { confirmAuthorizedDrive } from "./authorized-optical-drive.js";
import {
  classifyDiscInspectionError,
  DiscInspectionError,
  type ClassifiedDiscInspectionError,
} from "./disc-inspection-error.js";

export interface CompletedDiscInspection {
  binding: BoundOpticalDrive;
  inspection: DiscInspection;
  mediaGeneration: string;
}

export interface RunDiscInspectionOptions {
  access: DataAccess;
  configuredCanonicalPath: string;
  drive: OpticalDrive;
  expectedDrive: DiscoveredOpticalDrive;
  hardware: OpticalDriveHardware;
  log(message: string): void;
  signal: AbortSignal;
  waitForNextSettlingObservation?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

const DISC_INSPECTION_SETTLING_OBSERVATION_INTERVAL_MS =
  DISC_INSPECTION_SETTLING_QUIET_WINDOW_MS /
  (DISC_INSPECTION_SETTLING_OBSERVATION_TARGET - 1);
const DISC_INSPECTION_SETTLING_TIMEOUT_DIAGNOSTIC =
  `Optical Drive did not settle within ${
    DISC_INSPECTION_SETTLING_TIMEOUT_MS / 1_000
  } seconds`;

async function waitForNextSettlingObservation(
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(intervalMs, undefined, { signal });
}

async function classifyFailureAfterMediaObservation({
  binding,
  error,
  expectedMediaGeneration,
  hardware,
  signal,
}: {
  binding: BoundOpticalDrive;
  error: unknown;
  expectedMediaGeneration: string;
  hardware: OpticalDriveHardware;
  signal: AbortSignal;
}): Promise<ClassifiedDiscInspectionError> {
  try {
    const currentMediaGeneration = await hardware.observeMediaGeneration(
      binding,
      signal,
    );
    if (currentMediaGeneration !== expectedMediaGeneration) {
      return {
        kind: "abort",
        reasonCode: "media_changed",
        diagnostic: "DVD medium changed during Disc Inspection",
      };
    }
  } catch (observationError) {
    // A failed observation cannot prove that the insertion changed. Only a
    // structured hardware error may choose a terminal outcome; opaque errors
    // remain retryable as unknown failures.
    return classifyDiscInspectionError(observationError);
  }
  return classifyDiscInspectionError(error);
}

function persistInspectionFailure({
  access,
  claim,
  classified,
  consecutiveFailureCount,
}: {
  access: DataAccess;
  claim: Parameters<DataAccess["discInspections"]["record"]>[0];
  classified: ClassifiedDiscInspectionError;
  consecutiveFailureCount: number;
}) {
  if (classified.kind === "abort") {
    return access.discInspections.record(claim, {
      type: "abort",
      reasonCode: classified.reasonCode,
      diagnostic: classified.diagnostic,
    });
  }
  if (classified.kind === "fail") {
    return access.discInspections.record(claim, {
      type: "fail",
      reasonCode: classified.reasonCode,
      diagnostic: classified.diagnostic,
    });
  }
  const retryDelayMs = Math.min(
    60_000,
    5_000 * 2 ** consecutiveFailureCount,
  );
  return access.discInspections.record(claim, {
    type: "retry",
    reasonCode: classified.reasonCode,
    diagnostic: classified.diagnostic,
    retryAt: new Date(Date.now() + retryDelayMs),
  });
}

export async function runDiscInspection({
  access,
  configuredCanonicalPath,
  drive,
  expectedDrive,
  hardware,
  log,
  signal,
  waitForNextSettlingObservation: waitForSettling =
    waitForNextSettlingObservation,
}: RunDiscInspectionOptions): Promise<CompletedDiscInspection | null> {
  const settlingDeadlineController = new AbortController();
  const readinessSignal = AbortSignal.any([
    signal,
    settlingDeadlineController.signal,
  ]);
  let settlingDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSettlingDeadline = () => {
    if (settlingDeadlineTimer !== null) {
      clearTimeout(settlingDeadlineTimer);
      settlingDeadlineTimer = null;
    }
  };
  const armSettlingDeadline = (inspection: DiscInspection): boolean => {
    if (inspection.phase !== "settling" || inspection.settlingStartedAt === null) {
      return true;
    }
    const remainingMs =
      inspection.settlingStartedAt.getTime() +
      DISC_INSPECTION_SETTLING_TIMEOUT_MS -
      Date.now();
    if (remainingMs <= 0) {
      settlingDeadlineController.abort(
        new Error(DISC_INSPECTION_SETTLING_TIMEOUT_DIAGNOSTIC),
      );
      return false;
    }
    if (settlingDeadlineTimer !== null) {
      clearSettlingDeadline();
    }
    settlingDeadlineTimer = setTimeout(() => {
      settlingDeadlineController.abort(
        new Error(DISC_INSPECTION_SETTLING_TIMEOUT_DIAGNOSTIC),
      );
    }, remainingMs);
    settlingDeadlineTimer.unref();
    return true;
  };
  let confirmedBeforeScan: Awaited<ReturnType<typeof confirmAuthorizedDrive>>;
  let binding: BoundOpticalDrive;
  let preparedStart:
    | ReturnType<DataAccess["discInspections"]["beginOrResume"]>
    | undefined;
  let newlyStartedUnprovenInspectionId: DiscInspection["id"] | undefined;
  let mediaObservation: Awaited<
    ReturnType<OpticalDriveHardware["observeMedia"]>
  >;
  try {
    confirmedBeforeScan = await confirmAuthorizedDrive({
      access,
      configuredCanonicalPath,
      expected: expectedDrive,
      hardware,
      phase: "DVD scanning",
      signal: readinessSignal,
    });
    binding = await hardware.bindOpticalDrive(
      confirmedBeforeScan.discovered,
      readinessSignal,
    );
    await confirmAuthorizedDrive({
      access,
      configuredCanonicalPath,
      expected: binding.drive,
      hardware,
      phase: "DVD scanning",
      signal: readinessSignal,
    });
    mediaObservation = await hardware.observeMedia(binding, readinessSignal, {
      onMediaGeneration(mediaGeneration) {
        const current = access.discInspections
          .list({ currentOnly: true })
          .find((inspection) => inspection.opticalDriveId === drive.id);
        const retryIsEligible =
          current?.status === "running" &&
          current.phase === "retry_wait" &&
          (current.retryAt === null || current.retryAt.getTime() <= Date.now());
        const manualRetryIsEligible =
          current?.status === "failed" &&
          current.manualRetryRequestedAt !== null;
        const observedGenerationChanged =
          current !== undefined &&
          current.mediaGeneration !== mediaGeneration;
        const settlingClaimIsRecoverable =
          current?.status === "running" &&
          current.phase === "settling" &&
          (current.claimToken === null ||
            current.claimUpdatedAt === null ||
            current.claimUpdatedAt.getTime() <=
              Date.now() - DISC_INSPECTION_LEASE_DURATION_MS);
        if (
          current === undefined ||
          observedGenerationChanged ||
          retryIsEligible ||
          manualRetryIsEligible ||
          settlingClaimIsRecoverable
        ) {
          preparedStart = access.discInspections.beginOrResume({
            opticalDriveId: drive.id,
            mediaGeneration,
            mediaCapacityBytes: null,
          });
          if (
            current === undefined ||
            preparedStart.inspection.id !== current.id
          ) {
            newlyStartedUnprovenInspectionId = preparedStart.inspection.id;
          }
          if (preparedStart.claim !== null) {
            armSettlingDeadline(preparedStart.inspection);
          }
        }
      },
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (
      settlingDeadlineController.signal.aborted &&
      preparedStart?.claim !== null &&
      preparedStart?.claim !== undefined
    ) {
      persistInspectionFailure({
        access,
        claim: preparedStart.claim,
        classified: {
          kind: "retry",
          reasonCode: "drive_not_ready",
          diagnostic: DISC_INSPECTION_SETTLING_TIMEOUT_DIAGNOSTIC,
        },
        consecutiveFailureCount:
          preparedStart.inspection.consecutiveFailureCount,
      });
      clearSettlingDeadline();
      return null;
    }
    const classified = classifyDiscInspectionError(error);
    if (
      classified.reasonCode === "no_medium" ||
      classified.reasonCode === "drive_identity_changed" ||
      classified.reasonCode === "drive_unavailable"
    ) {
      if (preparedStart?.claim !== null && preparedStart?.claim !== undefined) {
        if (
          classified.reasonCode === "no_medium" &&
          newlyStartedUnprovenInspectionId !== undefined
        ) {
          access.discInspections.clearCurrent({
            opticalDriveId: drive.id,
            reasonCode: classified.reasonCode,
            discardUnprovenInspectionId: newlyStartedUnprovenInspectionId,
          });
        } else {
          access.discInspections.record(preparedStart.claim, {
            type: "abort",
            reasonCode: classified.reasonCode,
          });
        }
      } else {
        access.discInspections.clearCurrent({
          opticalDriveId: drive.id,
          reasonCode: classified.reasonCode,
        });
      }
      if (classified.reasonCode !== "no_medium") {
        const message = error instanceof Error ? error.message : String(error);
        log(`DVD scan failed for ${drive.devicePath}: ${message}`);
      }
      clearSettlingDeadline();
      return null;
    }
    clearSettlingDeadline();
    throw error;
  }
  if (mediaObservation === null) {
    if (preparedStart?.claim !== null && preparedStart?.claim !== undefined) {
      if (newlyStartedUnprovenInspectionId !== undefined) {
        access.discInspections.clearCurrent({
          opticalDriveId: drive.id,
          reasonCode: "no_medium",
          discardUnprovenInspectionId: newlyStartedUnprovenInspectionId,
        });
      } else {
        access.discInspections.record(preparedStart.claim, {
          type: "abort",
          reasonCode: "no_medium",
        });
      }
    } else {
      access.discInspections.clearCurrent({
        opticalDriveId: drive.id,
        reasonCode: "no_medium",
      });
    }
    clearSettlingDeadline();
    return null;
  }
  const { mediaGeneration, capacityBytes: mediaCapacityBytes } =
    mediaObservation;
  const startedInspection = preparedStart?.claim === null ||
      preparedStart === undefined
    ? access.discInspections.beginOrResume({
        opticalDriveId: drive.id,
        mediaGeneration,
        mediaCapacityBytes,
      })
    : access.discInspections.recordSettlingObservation(
        preparedStart.claim,
        { mediaGeneration, mediaCapacityBytes },
      );
  if (startedInspection.claim === null) {
    const inspection = startedInspection.inspection;
    if (inspection.status !== "completed" || inspection.detectedDiscId === null) {
      clearSettlingDeadline();
      return null;
    }
    return { binding, inspection, mediaGeneration };
  }
  if (!armSettlingDeadline(startedInspection.inspection)) {
    persistInspectionFailure({
      access,
      claim: startedInspection.claim,
      classified: {
        kind: "retry",
        reasonCode: "drive_not_ready",
        diagnostic: DISC_INSPECTION_SETTLING_TIMEOUT_DIAGNOSTIC,
      },
      consecutiveFailureCount:
        startedInspection.inspection.consecutiveFailureCount,
    });
    clearSettlingDeadline();
    return null;
  }

  let claim = startedInspection.claim;
  let inspection = startedInspection.inspection;
  let settledMediaGeneration = inspection.mediaGeneration;
  let settledMediaCapacityBytes = inspection.mediaCapacityBytes;
  const inspectionController = new AbortController();
  const inspectionSignal = AbortSignal.any([
    signal,
    inspectionController.signal,
    settlingDeadlineController.signal,
  ]);
  const heartbeat = setInterval(() => {
    try {
      access.discInspections.renew(claim);
    } catch (error) {
      inspectionController.abort(error);
    }
  }, Math.floor(DISC_INSPECTION_LEASE_DURATION_MS / 3));
  heartbeat.unref();

  let totalBytes: number | null = null;
  try {
    while (inspection.phase === "settling") {
      await waitForSettling(
        DISC_INSPECTION_SETTLING_OBSERVATION_INTERVAL_MS,
        inspectionSignal,
      );
      if (!armSettlingDeadline(inspection)) {
        inspectionSignal.throwIfAborted();
      }
      await confirmAuthorizedDrive({
        access,
        configuredCanonicalPath,
        expected: binding.drive,
        hardware,
        phase: "DVD scanning",
        signal: inspectionSignal,
      });
      const observation = await hardware.observeMedia(
        binding,
        inspectionSignal,
      );
      if (observation === null) {
        access.discInspections.record(claim, {
          type: "abort",
          reasonCode: "no_medium",
        });
        return null;
      }
      const observed = access.discInspections.recordSettlingObservation(
        claim,
        {
          mediaGeneration: observation.mediaGeneration,
          mediaCapacityBytes: observation.capacityBytes,
        },
      );
      claim = observed.claim;
      inspection = observed.inspection;
      settledMediaGeneration = inspection.mediaGeneration;
      settledMediaCapacityBytes = inspection.mediaCapacityBytes;
    }
    clearSettlingDeadline();
    if (settledMediaCapacityBytes === null) {
      throw new Error("Settled Disc Inspection has no declared capacity");
    }
    const scan = await hardware.scanDvd(binding, inspectionSignal, {
      expectedMediaCapacityBytes: settledMediaCapacityBytes,
      expectedMediaGeneration: settledMediaGeneration,
      onMetadata(metadata) {
        totalBytes = metadata.totalBytes;
        access.discInspections.record(claim, {
          type: "metadata",
          ...metadata,
        });
      },
      onPhase(phase) {
        if (phase === "confirming_media") {
          access.discInspections.record(claim, { type: "confirming_media" });
        }
      },
    });
    signal.throwIfAborted();
    if (scan === null) {
      access.discInspections.record(claim, {
        type: "abort",
        reasonCode: "no_medium",
      });
      return null;
    }
    if (totalBytes === null && scan.sizeBytes !== undefined) {
      totalBytes = scan.sizeBytes;
      access.discInspections.record(claim, {
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
      access.discInspections.record(claim, { type: "confirming_media" });
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
    if (observedGeneration !== settledMediaGeneration) {
      throw new DiscInspectionError(
        "abort",
        "media_changed",
        "DVD medium changed during scanning",
      );
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
    inspection = access.discInspections.record(claim, {
      type: "complete",
      detectedDiscId: disc.id,
    });
    return {
      binding,
      inspection,
      mediaGeneration: settledMediaGeneration,
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    const settlingFailure = classifyDiscInspectionError(error);
    const settlingEndedByDriveState =
      inspection.phase === "settling" &&
      (settlingFailure.reasonCode === "no_medium" ||
        settlingFailure.reasonCode === "drive_identity_changed" ||
        settlingFailure.reasonCode === "drive_unavailable");
    const classified: ClassifiedDiscInspectionError =
      settlingDeadlineController.signal.aborted &&
        inspection.phase === "settling"
        ? {
            kind: "retry",
            reasonCode: "drive_not_ready",
            diagnostic: DISC_INSPECTION_SETTLING_TIMEOUT_DIAGNOSTIC,
          }
        : settlingEndedByDriveState
        ? {
            kind: "abort",
            reasonCode: settlingFailure.reasonCode,
          }
        : await classifyFailureAfterMediaObservation({
            binding,
            error,
            expectedMediaGeneration: settledMediaGeneration,
            hardware,
            signal,
          });
    try {
      persistInspectionFailure({
        access,
        claim,
        classified,
        consecutiveFailureCount:
          inspection.consecutiveFailureCount,
      });
    } catch (persistenceError) {
      const persistenceMessage = persistenceError instanceof Error
        ? persistenceError.message
        : String(persistenceError);
      log(
        `Disc Inspection failure state could not be persisted: ${persistenceMessage}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`DVD scan failed for ${drive.devicePath}: ${message}`);
    return null;
  } finally {
    clearInterval(heartbeat);
    clearSettlingDeadline();
  }
}
