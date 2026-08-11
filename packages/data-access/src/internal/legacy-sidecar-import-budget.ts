import type { LegacySidecarDiscovery } from "./legacy-sidecars.js";

export const MAX_LEGACY_IMPORT_BYTES = 8_388_608;
export const MAX_LEGACY_SCAN_BYTES = 67_108_864;
export const MAX_LEGACY_IMPORT_JOBS = 1_000;

export type LegacySidecarImportBudgetBound =
  | "scan-bytes"
  | "retained-bytes"
  | "jobs";

export function createLegacySidecarImportBudgetAccumulator(): {
  record(
    discovery: LegacySidecarDiscovery,
  ): LegacySidecarImportBudgetBound | null;
} {
  let retainedBytes = 0;
  let scanBytes = 0;
  let totalJobs = 0;

  return {
    record(discovery) {
      scanBytes += discovery.outcome === "parsed"
        ? discovery.sidecar.sourceBytes
        : discovery.sourceBytes;
      if (discovery.outcome === "parsed") {
        retainedBytes += discovery.sidecar.sourceBytes;
        totalJobs += discovery.sidecar.jobs.length;
      }

      if (scanBytes > MAX_LEGACY_SCAN_BYTES) {
        return "scan-bytes";
      }
      if (retainedBytes > MAX_LEGACY_IMPORT_BYTES) {
        return "retained-bytes";
      }
      if (totalJobs > MAX_LEGACY_IMPORT_JOBS) {
        return "jobs";
      }
      return null;
    },
  };
}
