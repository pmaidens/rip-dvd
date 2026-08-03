import type {
  ArchiveFormat,
  CatalogAccess,
  DataAccess,
  DetectedDiscId,
  DiscKind,
  OriginalDiscArchive,
} from "./types.js";

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
    recoverHistoricalCutover?: boolean;
  }): LegacySidecarImportReport;
}

export interface LegacySidecarCatalogAccess extends CatalogAccess {
  createOriginalDiscArchive(input: {
    detectedDiscId: DetectedDiscId;
    discKind: DiscKind;
    archiveFormat: ArchiveFormat;
    archivePath: string;
    fingerprint: string;
    sizeBytes?: number;
  }): OriginalDiscArchive;
}

export interface LegacySidecarDataAccess extends Omit<DataAccess, "catalog"> {
  readonly catalog: LegacySidecarCatalogAccess;
  readonly legacySidecars: LegacySidecarAccess;
}
