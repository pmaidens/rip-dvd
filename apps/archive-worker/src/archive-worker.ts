import { setTimeout as delay } from "node:timers/promises";

import type {
  DataAccess,
  DiscoveredOpticalDrive,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

export interface ScannedDvd {
  fingerprint: string;
  volumeLabel?: string;
  scanData: DvdTitleMap;
}

export interface OpticalDriveHardware {
  discover(signal: AbortSignal): Promise<readonly DiscoveredOpticalDrive[]>;
  scanDvd(
    devicePath: string,
    signal: AbortSignal,
  ): Promise<ScannedDvd | null>;
}

export interface PollArchiveWorkerOptions {
  access: DataAccess;
  configuredDevicePath: string;
  hardware: OpticalDriveHardware;
  log(message: string): void;
  signal: AbortSignal;
}

export interface RunArchiveWorkerOptions extends PollArchiveWorkerOptions {
  pollIntervalMs: number;
  waitForNextPoll?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export async function pollArchiveWorker({
  access,
  configuredDevicePath,
  hardware,
  log,
  signal,
}: PollArchiveWorkerOptions): Promise<void> {
  signal.throwIfAborted();
  const discovered = await hardware.discover(signal);
  signal.throwIfAborted();
  const drives = access.catalog.reconcileOpticalDrives(
    discovered.map((drive) => ({
      ...drive,
      isEnabledWhenNew: drive.devicePath === configuredDevicePath,
    })),
  );

  for (const drive of drives) {
    if (!drive.isPresent || !drive.isEnabled) {
      continue;
    }

    try {
      const scan = await hardware.scanDvd(drive.devicePath, signal);
      signal.throwIfAborted();
      if (scan === null) {
        continue;
      }
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint: scan.fingerprint,
        volumeLabel: scan.volumeLabel,
        scanData: scan.scanData,
      });
      if (disc.status === "detected") {
        access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`DVD scan failed for ${drive.devicePath}: ${message}`);
    }
  }
}

async function waitForNextPoll(
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(intervalMs, undefined, { signal });
}

export async function runArchiveWorker({
  pollIntervalMs,
  waitForNextPoll: wait = waitForNextPoll,
  ...pollOptions
}: RunArchiveWorkerOptions): Promise<void> {
  while (!pollOptions.signal.aborted) {
    try {
      await pollArchiveWorker(pollOptions);
    } catch (error) {
      if (pollOptions.signal.aborted) {
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      pollOptions.log(`Archive worker poll failed: ${message}`);
    }
    if (pollOptions.signal.aborted) {
      break;
    }
    try {
      await wait(pollIntervalMs, pollOptions.signal);
    } catch (error) {
      if (!pollOptions.signal.aborted) {
        throw error;
      }
    }
  }
}
