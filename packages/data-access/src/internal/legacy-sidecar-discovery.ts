import { opendirSync } from "node:fs";
import { join } from "node:path";

import type { LegacySidecarImportIssue } from "../legacy-sidecar-types.js";
import type {
  LegacySidecarDiscovery,
  LegacySidecarDiscoveryBatch,
} from "./legacy-sidecars.js";
import {
  createLegacySidecarImportBudgetAccumulator,
  MAX_LEGACY_IMPORT_BYTES,
  MAX_LEGACY_IMPORT_JOBS,
  MAX_LEGACY_SCAN_BYTES,
} from "./legacy-sidecar-import-budget.js";
import {
  LEGACY_MARKER_FIXED_BYTES,
  MAX_LEGACY_LIBRARY_DEPTH,
  MAX_LEGACY_LIBRARY_ENTRIES,
  MAX_LEGACY_MARKER_BYTES,
} from "./legacy-sidecar-limits.js";
import { parseLegacySidecar } from "./legacy-sidecar-parser.js";
import { snapshotLegacySidecar } from "./legacy-sidecar-cutover-marker.js";
import {
  legacyJobLogicalKey,
  legacyJobSignature,
} from "./legacy-sidecar-identity.js";

interface LegacySidecarSearchState {
  complete: boolean;
  entriesVisited: number;
  issues: LegacySidecarImportIssue[];
  limitReached: boolean;
  paths: string[];
  rootPath: string;
}

function findSidecars(
  directory: string,
  depth = 0,
  state: LegacySidecarSearchState = {
    complete: true,
    entriesVisited: 0,
    issues: [],
    limitReached: false,
    paths: [],
    rootPath: directory,
  },
): LegacySidecarSearchState {
  const directoryHandle = opendirSync(directory);
  try {
    let entry;
    while (!state.limitReached && (entry = directoryHandle.readSync())) {
      state.entriesVisited += 1;
      if (state.entriesVisited > MAX_LEGACY_LIBRARY_ENTRIES) {
        state.complete = false;
        state.limitReached = true;
        state.issues.push({
          code: "invalid_sidecar",
          message: `Library traversal entries exceed the ${MAX_LEGACY_LIBRARY_ENTRIES}-entry limit`,
          sidecarPath: state.rootPath,
        });
        break;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_LEGACY_LIBRARY_DEPTH) {
          state.complete = false;
          state.issues.push({
            code: "invalid_sidecar",
            message: `Library traversal depth exceeds the ${MAX_LEGACY_LIBRARY_DEPTH}-level limit`,
            sidecarPath: path,
          });
        } else {
          findSidecars(path, depth + 1, state);
        }
      } else if (entry.isFile() && entry.name.endsWith(".rip-dvd.json")) {
        state.paths.push(path);
      }
    }
  } finally {
    directoryHandle.closeSync();
  }
  return state;
}

export function discoverLegacySidecars(
  originalsLibraryPath: string,
): LegacySidecarDiscoveryBatch {
  const found = findSidecars(originalsLibraryPath);
  const discoveries: LegacySidecarDiscovery[] = [];
  const importBudget = createLegacySidecarImportBudgetAccumulator();
  let totalMarkerBytes = LEGACY_MARKER_FIXED_BYTES;
  let totalMarkerJobs = 0;
  let totalMarkerSidecars = 0;
  for (const path of found.paths.sort()) {
    let discovery = parseLegacySidecar(path, { originalsLibraryPath });
    let markerSnapshotBytes = 0;
    if (discovery.outcome === "parsed") {
      try {
        markerSnapshotBytes = Buffer.byteLength(
          JSON.stringify(snapshotLegacySidecar(discovery.sidecar)),
          "utf8",
        );
      } catch (error) {
        discovery = {
          outcome: "skipped",
          sourceBytes: discovery.sidecar.sourceBytes,
          issue: {
            code: "invalid_sidecar",
            message: `Sidecar cannot be serialized safely for the SQLite cutover marker: ${error instanceof Error ? error.message : String(error)}`,
            sidecarPath: discovery.sidecar.sidecarPath,
          },
        };
      }
    }
    discoveries.push(discovery);
    const exceededImportBound = importBudget.record(discovery);
    if (exceededImportBound === "scan-bytes") {
      found.complete = false;
      found.issues.push({
        code: "invalid_sidecar",
        message: `Aggregate sidecar scan work exceeds the ${MAX_LEGACY_SCAN_BYTES}-byte limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (exceededImportBound === "retained-bytes") {
      found.complete = false;
      found.issues.push({
        code: "invalid_sidecar",
        message: `Aggregate sidecar bytes exceed the ${MAX_LEGACY_IMPORT_BYTES}-byte import limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (exceededImportBound === "jobs") {
      found.complete = false;
      found.issues.push({
        code: "invalid_sidecar",
        message: `Aggregate legacy jobs exceed the ${MAX_LEGACY_IMPORT_JOBS}-job import limit`,
        sidecarPath: originalsLibraryPath,
      });
      break;
    }
    if (discovery.outcome === "parsed") {
      totalMarkerBytes +=
        markerSnapshotBytes + (totalMarkerSidecars === 0 ? 0 : 1);
      totalMarkerSidecars += 1;
      if (totalMarkerBytes > MAX_LEGACY_MARKER_BYTES) {
        found.complete = false;
        found.issues.push({
          code: "invalid_sidecar",
          message: `Aggregate cutover marker bytes exceed the ${MAX_LEGACY_MARKER_BYTES}-byte import limit`,
          sidecarPath: originalsLibraryPath,
        });
        break;
      }
      for (const job of discovery.sidecar.jobs) {
        totalMarkerBytes +=
          Buffer.byteLength(
            JSON.stringify({
              logicalKey: legacyJobLogicalKey(
                discovery.sidecar.fingerprint,
                job,
              ),
              jobIndex: job.jobIndex,
              sidecarPath: discovery.sidecar.sidecarPath,
              signature: legacyJobSignature(job),
            }),
            "utf8",
          ) + (totalMarkerJobs === 0 ? 0 : 1);
        totalMarkerJobs += 1;
        if (totalMarkerBytes > MAX_LEGACY_MARKER_BYTES) {
          found.complete = false;
          found.issues.push({
            code: "invalid_sidecar",
            message: `Aggregate cutover marker bytes exceed the ${MAX_LEGACY_MARKER_BYTES}-byte import limit`,
            sidecarPath: originalsLibraryPath,
          });
          break;
        }
      }
      if (!found.complete) {
        break;
      }
    }
  }
  return {
    complete: found.complete,
    discoveries,
    scanIssues: found.issues,
    sidecarsFound: found.paths.length,
    sidecarPaths: found.paths,
  };
}
