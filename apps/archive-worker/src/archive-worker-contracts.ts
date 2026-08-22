import type { DiscoveredOpticalDrive } from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

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

export interface OpticalMediaObservation {
  mediaGeneration: string;
  capacityBytes: number;
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
  observeMedia(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<OpticalMediaObservation | null>;
  observeMediaGeneration(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<string>;
  confirmOpticalDrive(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<void>;
}
