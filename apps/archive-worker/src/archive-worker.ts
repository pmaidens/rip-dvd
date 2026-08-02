import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import type {
  DataAccess,
  DiscoveredOpticalDrive,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

export interface ScannedDvd {
  fingerprint: string;
  isNewMediumObservation?: boolean;
  volumeLabel?: string;
  scanData: DvdTitleMap;
}

export interface BoundOpticalDrive {
  readonly deviceInstanceToken: string;
  readonly drive: DiscoveredOpticalDrive;
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
  ): Promise<ScannedDvd | null>;
  confirmOpticalDrive(
    binding: BoundOpticalDrive,
    signal: AbortSignal,
  ): Promise<void>;
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

function resolveConfiguredDevicePath(devicePath: string): string {
  try {
    return realpathSync(devicePath);
  } catch {
    // Preserve the configured path while its device is absent. A later poll
    // resolves an alias as soon as its target becomes available.
    return devicePath;
  }
}

function normalizeHardwareEvidence(
  value: string | undefined,
): string | undefined {
  return value?.trim() || undefined;
}

function hasSameHardwareIdentity(
  expected: DiscoveredOpticalDrive,
  observed: DiscoveredOpticalDrive,
): boolean {
  const expectedSerial = normalizeHardwareEvidence(expected.serialNumber);
  return (
    expected.devicePath === observed.devicePath &&
    expectedSerial !== undefined &&
    expectedSerial ===
      normalizeHardwareEvidence(observed.serialNumber) &&
    normalizeHardwareEvidence(expected.vendor) ===
      normalizeHardwareEvidence(observed.vendor) &&
    normalizeHardwareEvidence(expected.product) ===
      normalizeHardwareEvidence(observed.product)
  );
}

function reconcileDiscoveredDrives(
  access: DataAccess,
  discovered: readonly DiscoveredOpticalDrive[],
  configuredCanonicalPath: string,
) {
  return access.catalog.reconcileOpticalDrives(
    discovered.map((drive) => ({
      ...drive,
      isConfiguredDevice: drive.devicePath === configuredCanonicalPath,
    })),
  );
}

async function confirmAuthorizedDrive({
  access,
  configuredCanonicalPath,
  expected,
  hardware,
  phase,
  signal,
}: {
  access: DataAccess;
  configuredCanonicalPath: string;
  expected: DiscoveredOpticalDrive;
  hardware: OpticalDriveHardware;
  phase: "DVD persistence" | "DVD scanning";
  signal: AbortSignal;
}) {
  const discovered = await hardware.discover(signal);
  signal.throwIfAborted();
  const drives = reconcileDiscoveredDrives(
    access,
    discovered,
    configuredCanonicalPath,
  );
  const observed = discovered.find(
    (drive) => drive.devicePath === expected.devicePath,
  );
  if (observed === undefined || !hasSameHardwareIdentity(expected, observed)) {
    if (observed !== undefined) {
      access.catalog.upsertOpticalDrive({
        ...observed,
        isEnabled: false,
        isPresent: true,
      });
    }
    throw new Error(`Optical Drive identity changed before ${phase}`);
  }
  const confirmed = drives.find(
    (drive) => drive.devicePath === expected.devicePath,
  );
  if (confirmed === undefined || !confirmed.isPresent || !confirmed.isEnabled) {
    throw new Error(`Optical Drive is not enabled before ${phase}`);
  }
  return { discovered: observed, persisted: confirmed };
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
  const configuredCanonicalPath =
    resolveConfiguredDevicePath(configuredDevicePath);
  const drives = reconcileDiscoveredDrives(
    access,
    discovered,
    configuredCanonicalPath,
  );
  const discoveredByPath = new Map(
    discovered.map((drive) => [drive.devicePath, drive]),
  );

  for (const drive of drives) {
    if (!drive.isPresent || !drive.isEnabled) {
      continue;
    }

    try {
      const expected = discoveredByPath.get(drive.devicePath);
      if (expected === undefined) {
        throw new Error("Optical Drive identity is unavailable for scanning");
      }
      const confirmedBeforeScan = await confirmAuthorizedDrive({
        access,
        configuredCanonicalPath,
        expected,
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
      const scan = await hardware.scanDvd(binding, signal);
      signal.throwIfAborted();
      if (scan === null) {
        continue;
      }
      const confirmedBeforePersistence = await confirmAuthorizedDrive({
        access,
        configuredCanonicalPath,
        expected: confirmedBeforeScan.discovered,
        hardware,
        phase: "DVD persistence",
        signal,
      });
      await hardware.confirmOpticalDrive(binding, signal);
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: confirmedBeforePersistence.persisted.id,
        discKind: "dvd",
        fingerprint: scan.fingerprint,
        isNewMediumObservation: scan.isNewMediumObservation,
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
