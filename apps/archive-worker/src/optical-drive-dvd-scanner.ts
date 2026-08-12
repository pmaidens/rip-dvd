import {
  decodeDvdTitleMap,
  DVD_TITLE_MAP_SCHEMA_VERSION,
  isDvdContentId,
} from "@rip-dvd/data-access/dvd-scan";

import type { BoundOpticalDrive, ScannedDvd } from "./archive-worker.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import { decodeLsdvdMetadata } from "./dvd-metadata.js";
import {
  commandFailure,
  MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
  OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import type { BoundOpticalDriveIdentity } from "./optical-drive-identity.js";
import type { OpticalDriveScanCache } from "./optical-drive-scan-cache.js";
import type { DiscContentReader } from "./optical-disc-content.js";
import type { MediaGenerationObserver } from "./optical-media-generation.js";

interface OpticalDriveDvdScannerOptions {
  cache: OpticalDriveScanCache;
  contentReader: DiscContentReader;
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
  expectedMediaGeneration?: string;
  onBytesHashed?(bytes: number): void;
  onMetadata?(metadata: DiscInspectionMetadata): void;
  onPhase?(phase: "reading_metadata" | "hashing_content" | "confirming_media"): void;
}

function mediaChanged(message: string): DiscInspectionError {
  return new DiscInspectionError("abort", "media_changed", message);
}

async function inspectDvd(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
) {
  const result = await runner.run(
    "lsdvd",
    ["-Oh", "-a", "-c", "-s", devicePath],
    {
      maxBufferBytes: MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
      signal,
      timeoutMs: OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/no medium found|medium not present/i.test(output)) {
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
    const failure = commandFailure("lsdvd", result);
    throw new DiscInspectionError(
      "retry",
      "metadata_read_failed",
      failure.message,
      { cause: failure },
    );
  }
  try {
    return decodeLsdvdMetadata(`${result.stdout}\n${result.stderr}`);
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

async function readDvdContentIdentity(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
  contentReader: DiscContentReader,
  metadata: NonNullable<Awaited<ReturnType<typeof inspectDvd>>>,
  options: DiscInspectionScanOptions,
): Promise<{ contentId: string; sizeBytes: number }> {
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
  let sizeBytes: number;
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
  options.onPhase?.("hashing_content");
  let contentId: string;
  try {
    contentId = options.onBytesHashed === undefined
      ? await contentReader.hash(devicePath, sizeBytes, signal)
      : await contentReader.hash(
          devicePath,
          sizeBytes,
          signal,
          options.onBytesHashed,
        );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof DiscInspectionError) {
      throw error;
    }
    const message = error instanceof Error
      ? error.message
      : "DVD content reader failed";
    throw new DiscInspectionError(
      "retry",
      "content_read_failed",
      message,
      { cause: error },
    );
  }
  if (!isDvdContentId(contentId)) {
    throw new DiscInspectionError(
      "fail",
      "invalid_content",
      "DVD content reader returned an invalid content identity",
    );
  }
  return { contentId, sizeBytes };
}

export function createOpticalDriveDvdScanner({
  cache,
  contentReader,
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
        if (generationBefore !== generationAfter) {
          throw mediaChanged("DVD medium changed during scanning");
        }
        await identity.requireCurrent(binding, "during DVD scanning", signal);
        cache.remember(safeDevicePath, generationAfter, null);
        throw error;
      }

      const { contentId, sizeBytes } = await readDvdContentIdentity(
        safeDevicePath,
        signal,
        runner,
        contentReader,
        metadata,
        options,
      );
      options.onPhase?.("confirming_media");
      const generationAfter = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      if (generationBefore !== generationAfter) {
        throw mediaChanged("DVD medium changed during scanning");
      }
      await identity.requireCurrent(binding, "during DVD scanning", signal);
      const scanData = decodeDvdTitleMap({
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
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
        fingerprint: contentId,
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
