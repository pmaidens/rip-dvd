import type { ScannedDvd } from "./archive-worker.js";

export interface OpticalDriveScanCache {
  find(
    devicePath: string,
    mediaGeneration: string,
  ): { result: ScannedDvd | null } | undefined;
  remember(
    devicePath: string,
    mediaGeneration: string,
    result: ScannedDvd | null,
  ): void;
  retainDiscovered(devicePaths: readonly string[]): void;
}

export function createOpticalDriveScanCache(): OpticalDriveScanCache {
  const scans = new Map<
    string,
    { mediaGeneration: string; result: ScannedDvd | null }
  >();

  return {
    find(devicePath, mediaGeneration) {
      const cached = scans.get(devicePath);
      return cached?.mediaGeneration === mediaGeneration
        ? { result: cached.result }
        : undefined;
    },

    remember(devicePath, mediaGeneration, result) {
      scans.set(devicePath, { mediaGeneration, result });
    },

    retainDiscovered(devicePaths) {
      const discovered = new Set(devicePaths);
      for (const cachedPath of scans.keys()) {
        if (!discovered.has(cachedPath)) {
          scans.delete(cachedPath);
        }
      }
    },
  };
}
