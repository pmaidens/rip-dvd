import type {
  DataAccess,
  DiscInspection,
  DiscoveredOpticalDrive,
  OpticalDrive,
} from "@rip-dvd/data-access";
import { DISC_INSPECTION_LEASE_DURATION_MS } from "@rip-dvd/data-access";

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
}: RunDiscInspectionOptions): Promise<CompletedDiscInspection | null> {
  const confirmedBeforeScan = await confirmAuthorizedDrive({
    access,
    configuredCanonicalPath,
    expected: expectedDrive,
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
  const { mediaGeneration, capacityBytes: mediaCapacityBytes } =
    await hardware.observeMedia(binding, signal);
  const startedInspection = access.discInspections.beginOrResume({
    opticalDriveId: drive.id,
    mediaGeneration,
    mediaCapacityBytes,
  });
  if (startedInspection.claim === null) {
    const inspection = startedInspection.inspection;
    if (inspection.status !== "completed" || inspection.detectedDiscId === null) {
      return null;
    }
    return { binding, inspection, mediaGeneration };
  }

  const claim = startedInspection.claim;
  const inspectionController = new AbortController();
  const inspectionSignal = AbortSignal.any([
    signal,
    inspectionController.signal,
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
    const scan = await hardware.scanDvd(binding, inspectionSignal, {
      expectedMediaCapacityBytes: mediaCapacityBytes,
      expectedMediaGeneration: mediaGeneration,
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
    if (observedGeneration !== mediaGeneration) {
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
    const inspection = access.discInspections.record(claim, {
      type: "complete",
      detectedDiscId: disc.id,
    });
    return { binding, inspection, mediaGeneration };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    const classified = await classifyFailureAfterMediaObservation({
      binding,
      error,
      expectedMediaGeneration: mediaGeneration,
      hardware,
      signal,
    });
    try {
      persistInspectionFailure({
        access,
        claim,
        classified,
        consecutiveFailureCount:
          startedInspection.inspection.consecutiveFailureCount,
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
  }
}
