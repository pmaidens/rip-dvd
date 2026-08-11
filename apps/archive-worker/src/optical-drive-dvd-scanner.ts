import {
  decodeDvdTitleMap,
  DVD_TITLE_MAP_SCHEMA_VERSION,
  isDvdContentId,
} from "@rip-dvd/data-access/dvd-scan";

import type { BoundOpticalDrive, ScannedDvd } from "./archive-worker.js";
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
  ): Promise<ScannedDvd | null>;
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
      return null;
    }
    if (/device not ready/i.test(output)) {
      throw new Error("Optical Drive is temporarily not ready");
    }
    throw commandFailure("lsdvd", result);
  }
  return decodeLsdvdMetadata(`${result.stdout}\n${result.stderr}`);
}

async function readDvdContentIdentity(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
  contentReader: DiscContentReader,
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
    throw commandFailure("blockdev", sizeResult);
  }
  let sizeBytes: number;
  try {
    sizeBytes = requireDvdContentSize(Number(sizeResult.stdout.trim()));
  } catch {
    throw new Error("blockdev returned an invalid DVD size");
  }
  const contentId = await contentReader.hash(devicePath, sizeBytes, signal);
  if (!isDvdContentId(contentId)) {
    throw new Error("DVD content reader returned an invalid content identity");
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
    async scan(binding, signal) {
      const safeDevicePath = await identity.requireCurrent(
        binding,
        "before DVD scanning",
        signal,
      );
      const generationBefore = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      const cached = cache.find(safeDevicePath, generationBefore);
      if (cached !== undefined) {
        await identity.requireCurrent(binding, "during DVD scanning", signal);
        return cached.result === null
          ? null
          : { ...cached.result, isNewMediumObservation: false };
      }

      const metadata = await inspectDvd(safeDevicePath, signal, runner);
      if (metadata === null) {
        const generationAfter = await mediaGenerationObserver.observe(
          safeDevicePath,
          signal,
        );
        if (generationBefore !== generationAfter) {
          throw new Error("DVD medium changed during scanning");
        }
        await identity.requireCurrent(binding, "during DVD scanning", signal);
        cache.remember(safeDevicePath, generationAfter, null);
        return null;
      }

      const { contentId, sizeBytes } = await readDvdContentIdentity(
        safeDevicePath,
        signal,
        runner,
        contentReader,
      );
      const generationAfter = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      if (generationBefore !== generationAfter) {
        throw new Error("DVD medium changed during scanning");
      }
      await identity.requireCurrent(binding, "during DVD scanning", signal);
      const scanData = decodeDvdTitleMap({
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: metadata.titles,
      });
      if (scanData === null) {
        throw new Error("lsdvd returned an invalid DVD title map");
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
