import {
  createDataAccessInternal,
  type CreateDataAccessOptions,
} from "./internal/create-data-access.js";
import type { DataAccess } from "./types.js";

export { createDiscSelectionSourceIdentity } from "./disc-selection-source-identity.js";
export {
  createCleanReadArchiveIntegrityEvidence,
  createUnknownArchiveIntegrityEvidence,
  createWatchableSalvageArchiveIntegrityEvidence,
} from "./archive-integrity.js";
export { normalizeMediaItemSearchTitle } from "./media-item-title-search.js";
export { isCorrectedEncodePredecessorReady } from "./corrected-encode-readiness.js";

export * from "./errors.js";
export * from "./dvd-scan.js";
export {
  ARCHIVE_INTEGRITIES,
  CATALOG_REVIEW_OUTCOMES,
  DISC_SELECTION_KINDS,
  MAX_MEDIA_ITEM_HIERARCHY_DEPTH,
  MEDIA_ITEM_KINDS,
} from "./domain-values.js";
export type * from "./types.js";
export type {
  DiscSelectionSourceIdentity,
  DiscSelectionSourceIdentityInput,
} from "./disc-selection-source-identity.js";
export {
  ARCHIVE_JOB_LEASE_DURATION_MS,
  DISC_INSPECTION_LEASE_DURATION_MS,
  ENCODE_JOB_LEASE_DURATION_MS,
} from "./types.js";
export type {
  CreateDataAccessOptions,
  PublicationMutationRecoveryLock,
} from "./internal/create-data-access.js";
export type { FilesystemPathProbe } from "./internal/bounded-filesystem-path-probe.js";

export function createDataAccess(input: CreateDataAccessOptions): DataAccess {
  return createDataAccessInternal(input);
}
