import { platform as operatingSystem } from "node:os";

import type { OpticalDriveHardware } from "./archive-worker.js";
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

    scanDvd(binding, signal, options?: DiscInspectionScanOptions) {
      return scanner.scan(binding, signal, options);
    },

    async observeMediaGeneration(binding, signal) {
      const safeDevicePath = await identity.requireCurrent(
        binding,
        "before DVD scanning",
        signal,
      );
      return mediaGenerationObserver.observe(safeDevicePath, signal);
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
