import {
  decodeDvdTitleMap,
  DVD_TITLE_MAP_SCHEMA_VERSION,
} from "@rip-dvd/data-access/dvd-scan";
import { createDvdMetadataFingerprint } from "@rip-dvd/data-access/dvd-metadata-fingerprint";

import type { BoundOpticalDrive, ScannedDvd } from "./archive-worker.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import {
  decodeLsdvdMetadata,
  type DecodedDvdMetadata,
} from "./dvd-metadata.js";
import {
  commandFailure,
  MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
  OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
  reportsNoMedium,
  type CommandResult,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import type { BoundOpticalDriveIdentity } from "./optical-drive-identity.js";
import type { OpticalDriveScanCache } from "./optical-drive-scan-cache.js";
import type { MediaGenerationObserver } from "./optical-media-generation.js";

interface OpticalDriveDvdScannerOptions {
  cache: OpticalDriveScanCache;
  identity: BoundOpticalDriveIdentity;
  mediaGenerationObserver: MediaGenerationObserver;
  runner: CommandRunner;
}

export interface OpticalDriveDvdScanner {
  scan(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
    options?: DiscInspectionScanOptions,
  ): Promise<ScannedDvd | null>;
}

export interface DiscInspectionMetadata {
  audioStreamCount: number;
  chapterCount: number;
  subtitleStreamCount: number;
  titleCount: number;
  totalBytes: number;
  volumeLabel: string | null;
}

export interface DiscInspectionScanOptions {
  expectedMediaCapacityBytes?: number;
  expectedMediaGeneration?: string;
  onMetadata?(metadata: DiscInspectionMetadata): void;
  onPhase?(phase: "reading_metadata" | "confirming_media"): void;
}

function mediaChanged(message: string): DiscInspectionError {
  return new DiscInspectionError("abort", "media_changed", message);
}

const MAX_RECOVERY_TITLE_ATTEMPTS = 99;
const MAX_CONSECUTIVE_TITLE_FAILURES = 3;

function lsdvdCommandOptions(signal: AbortSignal) {
  return {
    maxBufferBytes: MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
    signal,
    timeoutMs: OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
  };
}

function decodeLsdvdResult(result: CommandResult): DecodedDvdMetadata {
  return decodeLsdvdMetadata(`${result.stdout}\n${result.stderr}`);
}

async function recoverReadableTitles(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
): Promise<DecodedDvdMetadata | null> {
  const titles: DecodedDvdMetadata["titles"] = [];
  let volumeLabel: string | undefined;
  let hasVolumeLabel = false;
  let consecutiveFailures = 0;

  for (
    let titleNumber = 1;
    titleNumber <= MAX_RECOVERY_TITLE_ATTEMPTS &&
    consecutiveFailures < MAX_CONSECUTIVE_TITLE_FAILURES;
    titleNumber += 1
  ) {
    signal.throwIfAborted();
    const result = await runner.run(
      "rip-dvd-lsdvd",
      [
        "-q",
        "-t",
        String(titleNumber),
        "-Oh",
        "-a",
        "-c",
        "-s",
        devicePath,
      ],
      lsdvdCommandOptions(signal),
    );
    if (result.exitCode !== 0) {
      consecutiveFailures += 1;
      continue;
    }

    let decoded: DecodedDvdMetadata;
    try {
      decoded = decodeLsdvdResult(result);
    } catch {
      consecutiveFailures += 1;
      continue;
    }
    if (
      decoded.titles.length !== 1 ||
      decoded.titles[0]?.number !== titleNumber
    ) {
      return null;
    }
    if (!hasVolumeLabel) {
      volumeLabel = decoded.volumeLabel;
      hasVolumeLabel = true;
    } else if (decoded.volumeLabel !== volumeLabel) {
      return null;
    }
    titles.push(decoded.titles[0]);
    consecutiveFailures = 0;
  }

  if (titles.length === 0) {
    return null;
  }
  return {
    ...(volumeLabel ? { volumeLabel } : {}),
    titles,
  };
}

async function inspectDvd(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
) {
  const result = await runner.run(
    "rip-dvd-lsdvd",
    ["-Oh", "-a", "-c", "-s", devicePath],
    lsdvdCommandOptions(signal),
  );
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (reportsNoMedium(result)) {
      throw new DiscInspectionError(
        "abort",
        "no_medium",
        "No medium is present in the Optical Drive",
      );
    }
    if (/device not ready/i.test(output)) {
      throw new DiscInspectionError(
        "retry",
        "drive_not_ready",
        "Optical Drive is temporarily not ready",
      );
    }
    if (/Invalid IFO for title \d+/i.test(output)) {
      const recovered = await recoverReadableTitles(devicePath, signal, runner);
      if (recovered !== null) {
        return recovered;
      }
    }
    const failure = commandFailure("lsdvd", result);
    throw new DiscInspectionError(
      "retry",
      "metadata_read_failed",
      failure.message,
      { cause: failure },
    );
  }
  try {
    return decodeLsdvdResult(result);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "lsdvd returned invalid metadata";
    throw new DiscInspectionError(
      "fail",
      "invalid_metadata",
      message,
      { cause: error },
    );
  }
}

async function readDvdIdentity(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
  metadata: NonNullable<Awaited<ReturnType<typeof inspectDvd>>>,
  options: DiscInspectionScanOptions,
): Promise<{ fingerprint: string; sizeBytes: number }> {
  let sizeBytes: number;
  if (options.expectedMediaCapacityBytes === undefined) {
    const sizeResult = await runner.run(
      "blockdev",
      ["--getsize64", devicePath],
      {
        maxBufferBytes: 128,
        signal,
        timeoutMs: OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
      },
    );
    if (sizeResult.exitCode !== 0) {
      const failure = commandFailure("blockdev", sizeResult);
      throw new DiscInspectionError(
        "retry",
        "content_size_failed",
        failure.message,
        { cause: failure },
      );
    }
    try {
      sizeBytes = requireDvdContentSize(Number(sizeResult.stdout.trim()));
    } catch (error) {
      throw new DiscInspectionError(
        "fail",
        "invalid_content",
        "blockdev returned an invalid DVD size",
        { cause: error },
      );
    }
  } else {
    sizeBytes = requireDvdContentSize(options.expectedMediaCapacityBytes);
  }
  options.onMetadata?.({
    audioStreamCount: metadata.titles.reduce(
      (total, title) => total + title.audioStreams.length,
      0,
    ),
    chapterCount: metadata.titles.reduce(
      (total, title) => total + title.chapters,
      0,
    ),
    subtitleStreamCount: metadata.titles.reduce(
      (total, title) => total + title.subtitles.length,
      0,
    ),
    titleCount: metadata.titles.length,
    totalBytes: sizeBytes,
    volumeLabel: metadata.volumeLabel ?? null,
  });
  return {
    fingerprint: createDvdMetadataFingerprint({
      sizeBytes,
      titles: metadata.titles,
      volumeLabel: metadata.volumeLabel,
    }),
    sizeBytes,
  };
}

export function createOpticalDriveDvdScanner({
  cache,
  identity,
  mediaGenerationObserver,
  runner,
}: OpticalDriveDvdScannerOptions): OpticalDriveDvdScanner {
  return {
    async scan(binding, signal, options = {}) {
      const safeDevicePath = await identity.requireCurrent(
        binding,
        "before DVD scanning",
        signal,
      );
      const generationBefore = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      cache.observe(safeDevicePath, generationBefore);
      if (
        options.expectedMediaGeneration !== undefined &&
        options.expectedMediaGeneration !== generationBefore
      ) {
        throw mediaChanged("DVD medium changed before scanning");
      }
      const cached = cache.find(safeDevicePath, generationBefore);
      if (cached !== undefined) {
        await identity.requireCurrent(binding, "during DVD scanning", signal);
        if (cached.result === null) {
          throw new DiscInspectionError(
            "abort",
            "no_medium",
            "No medium is present in the Optical Drive",
          );
        }
        return { ...cached.result, isNewMediumObservation: false };
      }

      options.onPhase?.("reading_metadata");
      let metadata: Awaited<ReturnType<typeof inspectDvd>>;
      try {
        metadata = await inspectDvd(safeDevicePath, signal, runner);
      } catch (error) {
        if (
          !(error instanceof DiscInspectionError) ||
          error.reasonCode !== "no_medium"
        ) {
          throw error;
        }
        const generationAfter = await mediaGenerationObserver.observe(
          safeDevicePath,
          signal,
        );
        cache.observe(safeDevicePath, generationAfter);
        if (generationBefore !== generationAfter) {
          throw mediaChanged("DVD medium changed during scanning");
        }
        await identity.requireCurrent(binding, "during DVD scanning", signal);
        cache.remember(safeDevicePath, generationAfter, null);
        throw error;
      }

      const { fingerprint, sizeBytes } = await readDvdIdentity(
        safeDevicePath,
        signal,
        runner,
        metadata,
        options,
      );
      options.onPhase?.("confirming_media");
      const generationAfter = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      cache.observe(safeDevicePath, generationAfter);
      if (generationBefore !== generationAfter) {
        throw mediaChanged("DVD medium changed during scanning");
      }
      await identity.requireCurrent(binding, "during DVD scanning", signal);
      const scanData = decodeDvdTitleMap({
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId: fingerprint,
        titles: metadata.titles,
      });
      if (scanData === null) {
        throw new DiscInspectionError(
          "fail",
          "invalid_metadata",
          "lsdvd returned an invalid DVD title map",
        );
      }
      const result = {
        fingerprint,
        isNewMediumObservation: true,
        sizeBytes,
        ...(metadata.volumeLabel ? { volumeLabel: metadata.volumeLabel } : {}),
        scanData,
      };
      cache.remember(safeDevicePath, generationAfter, result);
      return result;
    },
  };
}
