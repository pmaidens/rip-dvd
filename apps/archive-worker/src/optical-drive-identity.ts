import type { DiscoveredOpticalDrive } from "@rip-dvd/data-access";

import type { BoundOpticalDrive } from "./archive-worker.js";
import { DiscInspectionError } from "./disc-inspection-error.js";
import {
  requireSafeOpticalDevicePath,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";

export type OpticalDriveIdentityPhase =
  | "before DVD settling"
  | "before DVD persistence"
  | "before DVD scanning"
  | "during DVD scanning";

export interface BoundOpticalDriveIdentity {
  bind(
    drive: DiscoveredOpticalDrive,
    signal: AbortSignal,
  ): Promise<BoundOpticalDrive>;
  requireCurrent(
    binding: BoundOpticalDrive,
    phase: OpticalDriveIdentityPhase,
    signal: AbortSignal,
  ): Promise<string>;
}

export function createBoundOpticalDriveIdentity(
  observer: MediaGenerationObserver,
): BoundOpticalDriveIdentity {
  return {
    async bind(drive, signal) {
      const safeDevicePath = requireSafeOpticalDevicePath(drive.devicePath);
      const deviceInstanceToken = await observer.observe(safeDevicePath, signal);
      return {
        deviceInstanceToken,
        drive: { ...drive, devicePath: safeDevicePath },
      };
    },

    async requireCurrent(binding, phase, signal) {
      const safeDevicePath = requireSafeOpticalDevicePath(
        binding.drive.devicePath,
      );
      const observedToken = await observer.observe(safeDevicePath, signal);
      if (observedToken !== binding.deviceInstanceToken) {
        throw new DiscInspectionError(
          "abort",
          "drive_identity_changed",
          `Optical Drive instance changed ${phase}`,
        );
      }
      return safeDevicePath;
    },
  };
}
