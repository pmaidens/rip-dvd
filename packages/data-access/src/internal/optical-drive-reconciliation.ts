import { DomainInvariantError } from "../errors.js";
import type { OpticalDriveReconciliationInput } from "../types.js";
import { requireNonEmpty } from "./validation.js";

export interface StoredOpticalDriveReconciliationState {
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
  const configuredTargets = normalized.filter(
    (drive) => drive.isConfiguredDevice,
  );
  if (configuredTargets.length > 1) {
    throw new DomainInvariantError(
      "A discovery snapshot can prove only one configured Optical Drive",
    );
  }

  const configuredTargetPath = configuredTargets[0]?.devicePath;
  const existingByPath = new Map(
    existingDrives.map((drive) => [drive.devicePath, drive]),
  );
  const previousConfiguredTargetPath = existingDrives.find(
    (drive) => drive.isConfiguredTarget,
  )?.devicePath;
  const configuredTargetChanged =
    configuredTargetPath !== undefined &&
    previousConfiguredTargetPath !== undefined &&
    configuredTargetPath !== previousConfiguredTargetPath;

  return {
    configuredTargetPath,
    drives: normalized.map((drive) => {
      const existing = existingByPath.get(drive.devicePath);
      const existingSerial = existing?.serialNumber?.trim() || undefined;
      const discoveredSerial = drive.serialNumber?.trim() || undefined;
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
        insertAuthorization: {
          configurationDefaultResolved: drive.isConfiguredDevice,
          isEnabled: drive.isConfiguredDevice && !configuredTargetChanged,
        },
        authorizationUpdate,
      };
    }),
  };
}
