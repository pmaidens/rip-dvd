import { performance } from "node:perf_hooks";

import type { ScannedDvd } from "./archive-worker.js";

// Keep this comfortably below the worker's five-second maximum drive-poll
// interval so probe duration cannot defer revalidation by another poll.
const NO_MEDIUM_CACHE_TTL_MS = 1_000;

export interface OpticalDriveScanCache {
  observe(devicePath: string, mediaGeneration: string): void;
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
    {
      mediaGeneration: string;
      noMediumExpiresAt: number | null;
      result: ScannedDvd | null;
    }
  >();

  return {
    observe(devicePath, mediaGeneration) {
      const cached = scans.get(devicePath);
      if (cached !== undefined && cached.mediaGeneration !== mediaGeneration) {
        scans.delete(devicePath);
      }
    },

    find(devicePath, mediaGeneration) {
      const cached = scans.get(devicePath);
      if (cached?.mediaGeneration !== mediaGeneration) {
        if (cached !== undefined) {
          scans.delete(devicePath);
        }
        return undefined;
      }
      if (
        cached.noMediumExpiresAt !== null &&
        performance.now() >= cached.noMediumExpiresAt
      ) {
        scans.delete(devicePath);
        return undefined;
      }
      return { result: cached.result };
    },

    remember(devicePath, mediaGeneration, result) {
      scans.set(devicePath, {
        mediaGeneration,
        noMediumExpiresAt:
          result === null ? performance.now() + NO_MEDIUM_CACHE_TTL_MS : null,
        result,
      });
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
