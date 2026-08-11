import type { LegacySidecarImportIssue } from "../legacy-sidecar-types.js";
import type { MediaItemKind } from "../types.js";
import type { LegacyJobLogicalKey } from "./legacy-sidecar-identity.js";

export interface ParsedLegacyJob {
  completedAt: Date | null;
  jobIndex: number;
  kind: "main_feature" | "dvd_title";
  label: string;
  mediaItemKind: Extract<MediaItemKind, "movie" | "bonus_feature">;
  mediaTitle: string;
  outputPath: string;
  preset: string;
  profileKey: string;
  sourceKey: string;
  titleNumber: number | null;
}

export interface ParsedLegacySidecar {
  archivePath: string;
  archiveSnapshot: LegacySourceArchiveSnapshot;
  archiveSizeBytes: number;
  archivedAt: Date;
  createdAt: Date;
  fingerprint: string;
  issues: LegacySidecarImportIssue[];
  jobs: ParsedLegacyJob[];
  movieTitle: string;
  movieYear: number | null;
  pathBase: string;
  scanData: unknown;
  sidecarPath: string;
  sourceBytes: number;
  updatedAt: Date;
}

export type LegacySidecarDiscovery =
  | { outcome: "parsed"; sidecar: ParsedLegacySidecar }
  | {
      outcome: "skipped";
      issue: LegacySidecarImportIssue;
      sourceBytes: number;
    };

export interface LegacySidecarDiscoveryBatch {
  complete: boolean;
  discoveries: LegacySidecarDiscovery[];
  scanIssues: LegacySidecarImportIssue[];
  sidecarsFound: number;
  sidecarPaths: string[];
}

interface LegacyQueueCutoverBase {
  jobSnapshots: ReadonlyMap<LegacyJobLogicalKey, LegacyQueueJobSnapshot>;
  recoveryDiscoveries: LegacySidecarDiscovery[] | null;
  recoveryIssues: LegacySidecarImportIssue[];
  sidecarSnapshots: readonly LegacyQueueSidecarSnapshot[];
  withdrawPublication(): void;
  wasAlreadyPublished: boolean;
}

export type LegacyQueueCutover = LegacyQueueCutoverBase &
  (
    | {
        mode: "schema-one";
        upgradeSchemaOne(
          jobSnapshots: ReadonlyMap<
            LegacyJobLogicalKey,
            LegacyQueueJobSnapshot
          >,
        ): void;
      }
    | { mode: "historical-snapshot" | "snapshot" }
  );

export interface LegacyQueueJobSnapshot {
  jobIndex: number;
  sidecarPath: string;
  signature: string;
}

export interface LegacyQueueSidecarSnapshot {
  archivePath: string;
  archiveSnapshot: LegacySourceArchiveSnapshot;
  fingerprint: string;
  pathBase: string;
  payload: LegacyQueueSidecarPayloadSnapshot;
  sidecarPath: string;
}

export interface LegacyQueueSidecarPayloadSnapshot {
  archivedAt: string;
  archiveSizeBytes: number;
  createdAt: string;
  issues: LegacySidecarImportIssue[];
  jobs: Array<Omit<ParsedLegacyJob, "completedAt"> & {
    completedAt: string | null;
  }>;
  movieTitle: string;
  movieYear: number | null;
  scanData: unknown;
  sourceBytes: number;
  updatedAt: string;
}

export interface LegacySourceArchiveSnapshot {
  changedAtNanoseconds: string;
  deviceId: string;
  inode: string;
  modifiedAtNanoseconds: string;
  sizeBytes: string;
}

export { retireLegacySidecarQueue } from "./legacy-sidecar-cutover-marker.js";
export { discoverLegacySidecars } from "./legacy-sidecar-discovery.js";
export { acquireLegacyQueueCutoverLock } from "./legacy-sidecar-lease.js";
export {
  legacySourceArchiveMatchesSnapshot,
  resolveLegacyOriginalsLibrary,
} from "./legacy-sidecar-parser.js";
