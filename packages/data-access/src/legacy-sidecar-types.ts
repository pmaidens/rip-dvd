import type { DataAccess } from "./types.js";

export type LegacySidecarImportIssueCode =
  | "corrupt_sidecar"
  | "invalid_sidecar"
  | "missing_archive"
  | "invalid_job"
  | "duplicate_record";

export interface LegacySidecarImportIssue {
  code: LegacySidecarImportIssueCode;
  sidecarPath: string;
  message: string;
  jobIndex?: number;
}

export interface LegacySidecarImportReport {
  originalsLibraryPath: string;
  sidecarsFound: number;
  sidecarsImported: number;
  sidecarsSkipped: number;
  recordsCreated: {
    originalDiscArchives: number;
    discSelections: number;
    mediaItems: number;
    encodingProfiles: number;
    encodeJobs: number;
  };
  recordsUpdated: number;
  recordsUnchanged: number;
  issues: LegacySidecarImportIssue[];
}

export interface LegacySidecarAccess {
  importLibrary(input: {
    originalsLibraryPath: string;
  }): LegacySidecarImportReport;
}

export interface LegacySidecarDataAccess extends DataAccess {
  readonly legacySidecars: LegacySidecarAccess;
}
