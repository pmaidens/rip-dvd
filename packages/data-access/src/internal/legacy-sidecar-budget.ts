import type { LegacySidecarDiscovery } from "./legacy-sidecars.js";
import {
  MAX_LEGACY_IMPORT_BYTES,
  MAX_LEGACY_IMPORT_JOBS,
  MAX_LEGACY_SCAN_BYTES,
} from "./legacy-sidecar-limits.js";

export interface LegacySidecarBudget {
  retainedBytes: number;
  scanBytes: number;
  totalJobs: number;
}

export type LegacySidecarBudgetLimit =
  | "import-bytes"
  | "import-jobs"
  | "scan-bytes";

export function emptyLegacySidecarBudget(): LegacySidecarBudget {
  return { retainedBytes: 0, scanBytes: 0, totalJobs: 0 };
}

export function advanceLegacySidecarBudget(
  budget: LegacySidecarBudget,
  discovery: LegacySidecarDiscovery,
): {
  budget: LegacySidecarBudget;
  exceeded: LegacySidecarBudgetLimit | null;
} {
  const next = {
    retainedBytes:
      budget.retainedBytes +
      (discovery.outcome === "parsed" ? discovery.sidecar.sourceBytes : 0),
    scanBytes:
      budget.scanBytes +
      (discovery.outcome === "parsed"
        ? discovery.sidecar.sourceBytes
        : discovery.sourceBytes),
    totalJobs:
      budget.totalJobs +
      (discovery.outcome === "parsed" ? discovery.sidecar.jobs.length : 0),
  };
  const exceeded =
    next.scanBytes > MAX_LEGACY_SCAN_BYTES
      ? "scan-bytes"
      : next.retainedBytes > MAX_LEGACY_IMPORT_BYTES
        ? "import-bytes"
        : next.totalJobs > MAX_LEGACY_IMPORT_JOBS
          ? "import-jobs"
          : null;
  return { budget: next, exceeded };
}
