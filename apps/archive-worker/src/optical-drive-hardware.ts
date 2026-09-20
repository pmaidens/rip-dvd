import { platform as operatingSystem } from "node:os";

import type { OpticalDriveHardware } from "./archive-worker.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import { decodeDirectDvdCapacity } from "./direct-dvd-capacity.js";
import {
  commandFailure,
  MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
  nodeCommandRunner,
  OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import { decodeLsblkOpticalDrives } from "./optical-drive-discovery.js";
import {
  createOpticalDriveDvdScanner,
  type DiscInspectionScanOptions,
} from "./optical-drive-dvd-scanner.js";
import { createBoundOpticalDriveIdentity } from "./optical-drive-identity.js";
import { createOpticalDriveScanCache } from "./optical-drive-scan-cache.js";
import {
  nodeMediaGenerationObserver,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";

export {
  createNodeCommandRunner,
  nodeCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CommandRunnerOptions,
} from "./optical-drive-command-runner.js";

export {
  createHashProgressParser,
  createNodeDiscContentProbeLauncher,
  createNodeFileDiscContentProbeLauncher,
  createNodeDiscContentReader,
  nodeDiscContentProbeLauncher,
  nodeDiscContentReader,
  type DiscContentProbeLauncher,
  type DiscContentReader,
} from "./optical-disc-content.js";

export {
  createNodeMediaGenerationObserver,
  createNodeMediaGenerationProbeLauncher,
  nodeMediaGenerationProbeLauncher,
  type MediaGenerationObserver,
  type MediaGenerationProbeLauncher,
} from "./optical-media-generation.js";

interface LinuxOpticalDriveHardwareOptions {
  deviceInstanceObserver?: MediaGenerationObserver;
  mediaGenerationObserver?: MediaGenerationObserver;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
}

export function createLinuxOpticalDriveHardware({
  platform = operatingSystem(),
  runner = nodeCommandRunner,
  mediaGenerationObserver = nodeMediaGenerationObserver,
  deviceInstanceObserver = mediaGenerationObserver,
}: LinuxOpticalDriveHardwareOptions = {}): OpticalDriveHardware {
  const scanCache = createOpticalDriveScanCache();
  const identity = createBoundOpticalDriveIdentity(deviceInstanceObserver);
  const scanner = createOpticalDriveDvdScanner({
    cache: scanCache,
    identity,
    mediaGenerationObserver,
    runner,
  });

  return {
    async discover(signal) {
      if (platform !== "linux") {
        throw new Error("Optical Drive discovery is supported only on Linux");
      }
      const result = await runner.run(
        "lsblk",
        ["--json", "--output", "PATH,TYPE,TRAN,VENDOR,MODEL,SERIAL"],
        {
          maxBufferBytes: MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
          signal,
          timeoutMs: OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
        },
      );
      if (result.exitCode !== 0) {
        throw commandFailure("lsblk", result);
      }
      const discovered = decodeLsblkOpticalDrives(result.stdout);
      scanCache.retainDiscovered(
        discovered.map((drive) => drive.devicePath),
      );
      return discovered;
    },

    bindOpticalDrive(drive, signal) {
      return identity.bind(drive, signal);
    },

    scanDvd(binding, signal, options: DiscInspectionScanOptions) {
      return scanner.scan(binding, signal, options);
    },

    async observeMedia(binding, signal, options) {
      const safeDevicePath = await identity.requireCurrent(
        binding,
        "before DVD settling",
        signal,
      );
      const mediaGeneration = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      scanCache.observe(safeDevicePath, mediaGeneration);
      options?.onMediaGeneration(mediaGeneration);
      const capacityOutcome = await runner.run(
        "sg_readcap",
        ["--brief", "--readonly", safeDevicePath],
        {
          maxBufferBytes: 128,
          signal,
          timeoutMs: OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
        },
      ).then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ error, kind: "error" as const }),
      );
      signal.throwIfAborted();
      const mediaGenerationAfter = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      scanCache.observe(safeDevicePath, mediaGenerationAfter);
      await identity.requireCurrent(binding, "after DVD settling", signal);
      if (mediaGenerationAfter !== mediaGeneration) {
        return { mediaGeneration: mediaGenerationAfter, capacityBytes: null };
      }
      if (capacityOutcome.kind === "error") {
        const message = capacityOutcome.error instanceof Error
          ? capacityOutcome.error.message
          : String(capacityOutcome.error);
        throw new DiscInspectionError(
          "fail",
          "content_size_failed",
          `Direct DVD capacity observation failed: ${message}`,
          { cause: capacityOutcome.error },
        );
      }
      const decoded = decodeDirectDvdCapacity(capacityOutcome.result);
      if (decoded.kind === "no_medium") {
        return null;
      }
      if (decoded.kind === "retryable") {
        return { mediaGeneration, capacityBytes: null };
      }
      return { mediaGeneration, capacityBytes: decoded.capacityBytes };
    },

    async observeMediaGeneration(binding, signal) {
      const safeDevicePath = await identity.requireCurrent(
        binding,
        "before DVD scanning",
        signal,
      );
      const mediaGeneration = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      scanCache.observe(safeDevicePath, mediaGeneration);
      return mediaGeneration;
    },

    async confirmOpticalDrive(binding, signal) {
      await identity.requireCurrent(
        binding,
        "before DVD persistence",
        signal,
      );
    },
  };
}
