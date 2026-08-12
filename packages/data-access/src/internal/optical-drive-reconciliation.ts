import { DomainInvariantError } from "../errors.js";
import type {
  OpticalDriveId,
  OpticalDriveReconciliationInput,
} from "../types.js";
import { requireNonEmpty } from "./validation.js";

export interface StoredOpticalDriveReconciliationState {
  id: OpticalDriveId;
  devicePath: string;
  configurationDefaultResolved: boolean;
  isConfiguredTarget: boolean;
  isPresent: boolean;
  serialNumber: string | null;
  vendor: string | null;
  product: string | null;
}

interface OpticalDriveAuthorization {
  configurationDefaultResolved: boolean;
  isEnabled: boolean;
}

interface OpticalDriveReconciliationDecision {
  drive: OpticalDriveReconciliationInput;
  existingId: OpticalDriveId | undefined;
  insertAuthorization: OpticalDriveAuthorization;
  authorizationUpdate: Partial<OpticalDriveAuthorization>;
}

export interface OpticalDriveReconciliationPlan {
  configuredTargetPath: string | undefined;
  drives: OpticalDriveReconciliationDecision[];
}

export function planOpticalDriveReconciliation(
  discovered: readonly OpticalDriveReconciliationInput[],
  existingDrives: readonly StoredOpticalDriveReconciliationState[],
): OpticalDriveReconciliationPlan {
  const normalized = discovered.map((drive) => ({
    ...drive,
    devicePath: requireNonEmpty(drive.devicePath, "devicePath"),
  }));
  const uniquePaths = new Set(normalized.map((drive) => drive.devicePath));
  if (uniquePaths.size !== normalized.length) {
    throw new DomainInvariantError(
      "Discovered Optical Drive paths must be unique",
    );
  }
  const discoveredSerials = normalized
    .map((drive) => drive.serialNumber?.trim())
    .filter((serial): serial is string => Boolean(serial));
  if (new Set(discoveredSerials).size !== discoveredSerials.length) {
    throw new DomainInvariantError(
      "Discovered Optical Drive serial numbers must be unique",
    );
  }
  const configuredTargets = normalized.filter(
    (drive) => drive.isConfiguredDevice,
  );
  if (configuredTargets.length > 1) {
    throw new DomainInvariantError(
      "A discovery snapshot can prove only one configured Optical Drive",
    );
  }

  const configuredTargetPath = configuredTargets[0]?.devicePath;
  const existingByPath = new Map<
    string,
    StoredOpticalDriveReconciliationState[]
  >();
  const existingBySerial = new Map<
    string,
    StoredOpticalDriveReconciliationState[]
  >();
  for (const drive of existingDrives) {
    const atPath = existingByPath.get(drive.devicePath) ?? [];
    atPath.push(drive);
    existingByPath.set(drive.devicePath, atPath);
    const serial = drive.serialNumber?.trim();
    if (serial) {
      const withSerial = existingBySerial.get(serial) ?? [];
      withSerial.push(drive);
      existingBySerial.set(serial, withSerial);
    }
  }
  for (const [serial, matches] of existingBySerial) {
    if (matches.length > 1) {
      throw new DomainInvariantError(
        `Stored Optical Drive serial number is ambiguous: ${serial}`,
      );
    }
  }
  const previousConfiguredTarget = existingDrives.find(
    (drive) => drive.isConfiguredTarget,
  );
  const configuredTargetSerial = configuredTargets[0]?.serialNumber?.trim();
  const previousConfiguredTargetSerial =
    previousConfiguredTarget?.serialNumber?.trim();
  const configuredTargetChanged =
    configuredTargetPath !== undefined &&
    previousConfiguredTarget !== undefined &&
    configuredTargetPath !== previousConfiguredTarget.devicePath &&
    !(
      configuredTargetSerial !== undefined &&
      previousConfiguredTargetSerial !== undefined &&
      configuredTargetSerial === previousConfiguredTargetSerial
    );

  const claimedExistingIds = new Set<OpticalDriveId>();
  const existingByDiscoveredIndex = new Map<
    number,
    StoredOpticalDriveReconciliationState
  >();
  normalized.forEach((drive, index) => {
    const discoveredSerial = drive.serialNumber?.trim();
    if (!discoveredSerial) {
      return;
    }
    const serialMatch = existingBySerial.get(discoveredSerial)?.[0];
    if (serialMatch !== undefined) {
      claimedExistingIds.add(serialMatch.id);
      existingByDiscoveredIndex.set(index, serialMatch);
    }
  });
  normalized.forEach((drive, index) => {
    if (existingByDiscoveredIndex.has(index)) {
      return;
    }
    const pathMatches = (existingByPath.get(drive.devicePath) ?? []).filter(
      (candidate) => !claimedExistingIds.has(candidate.id),
    );
    const presentPathMatches = pathMatches.filter(
      (candidate) => candidate.isPresent,
    );
    if (presentPathMatches.length > 1) {
      throw new DomainInvariantError(
        `Stored present Optical Drive path is ambiguous: ${drive.devicePath}`,
      );
    }
    const pathMatch =
      presentPathMatches[0] ??
      (pathMatches.length === 1 ? pathMatches[0] : undefined);
    if (pathMatch !== undefined) {
      claimedExistingIds.add(pathMatch.id);
      existingByDiscoveredIndex.set(index, pathMatch);
    }
  });

  return {
    configuredTargetPath,
    drives: normalized.map((drive, index) => {
      const existing = existingByDiscoveredIndex.get(index);
      const discoveredSerial = drive.serialNumber?.trim() || undefined;
      const existingSerial = existing?.serialNumber?.trim() || undefined;
      const serialChanged =
        existing !== undefined && existingSerial !== discoveredSerial;
      const stableIdentityMatches =
        existingSerial !== undefined &&
        discoveredSerial !== undefined &&
        existingSerial === discoveredSerial;
      const modelEvidenceChanged =
        existing !== undefined &&
        ((existing.vendor ?? undefined) !== drive.vendor ||
          (existing.product ?? undefined) !== drive.product);
      const continuityUnprovenAfterDisappearance =
        existing !== undefined &&
        !existing.isPresent &&
        !stableIdentityMatches;
      const isReplacement =
        serialChanged ||
        (modelEvidenceChanged && !stableIdentityMatches) ||
        continuityUnprovenAfterDisappearance;
      const applyConfiguredDefault =
        drive.isConfiguredDevice &&
        !configuredTargetChanged &&
        existing?.configurationDefaultResolved !== true;
      const authorizationUpdate: Partial<OpticalDriveAuthorization> =
        isReplacement
          ? {
              configurationDefaultResolved:
                existing?.configurationDefaultResolved === true ||
                drive.isConfiguredDevice,
              isEnabled: false,
            }
          : drive.isConfiguredDevice && configuredTargetChanged
            ? { configurationDefaultResolved: true }
            : applyConfiguredDefault
              ? {
                  configurationDefaultResolved: true,
                  isEnabled: true,
                }
              : {};

      return {
        drive,
        existingId: existing?.id,
        insertAuthorization: {
          configurationDefaultResolved: drive.isConfiguredDevice,
          isEnabled: drive.isConfiguredDevice && !configuredTargetChanged,
        },
        authorizationUpdate,
      };
    }),
  };
}
