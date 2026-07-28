import {
  createDataAccessInternal,
  type CreateDataAccessOptions,
} from "./internal/create-data-access.js";
import {
  acquireLegacyQueueCutoverLock,
  discoverLegacySidecars,
  resolveLegacyOriginalsLibrary,
  retireLegacySidecarQueue,
} from "./internal/legacy-sidecars.js";
import type { LegacySidecarDataAccess } from "./types.js";

export function createLegacySidecarDataAccess(
  input: CreateDataAccessOptions,
): LegacySidecarDataAccess {
  const access = createDataAccessInternal(input, {
    discover: discoverLegacySidecars,
    resolveOriginalsLibrary: resolveLegacyOriginalsLibrary,
    retireQueue: retireLegacySidecarQueue,
  });
  return {
    ...access,
    legacySidecars: {
      importLibrary(importInput) {
        if (!importInput.originalsLibraryPath.trim()) {
          return access.legacySidecars.importLibrary(importInput);
        }
        const originalsLibraryPath = resolveLegacyOriginalsLibrary(
          importInput.originalsLibraryPath,
        );
        const releaseQueueLock =
          acquireLegacyQueueCutoverLock(originalsLibraryPath);
        try {
          return access.legacySidecars.importLibrary({
            originalsLibraryPath,
          });
        } finally {
          releaseQueueLock();
        }
      },
    },
  };
}
