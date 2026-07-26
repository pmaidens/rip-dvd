import {
  createDataAccessInternal,
  type CreateDataAccessOptions,
} from "./internal/create-data-access.js";
import {
  discoverLegacySidecars,
  resolveLegacyOriginalsLibrary,
  retireLegacySidecarQueue,
} from "./internal/legacy-sidecars.js";
import type { LegacySidecarDataAccess } from "./types.js";

export function createLegacySidecarDataAccess(
  input: CreateDataAccessOptions,
): LegacySidecarDataAccess {
  return createDataAccessInternal(input, {
    discover: discoverLegacySidecars,
    resolveOriginalsLibrary: resolveLegacyOriginalsLibrary,
    retireQueue: retireLegacySidecarQueue,
  });
}
