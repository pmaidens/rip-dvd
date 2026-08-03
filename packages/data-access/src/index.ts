import {
  createDataAccessInternal,
  type CreateDataAccessOptions,
} from "./internal/create-data-access.js";
import type { DataAccess } from "./types.js";

export * from "./errors.js";
export * from "./dvd-scan.js";
export {
  DISC_SELECTION_KINDS,
  MEDIA_ITEM_KINDS,
} from "./domain-values.js";
export type * from "./types.js";
export { ARCHIVE_JOB_LEASE_DURATION_MS } from "./types.js";
export type { CreateDataAccessOptions } from "./internal/create-data-access.js";

export function createDataAccess(input: CreateDataAccessOptions): DataAccess {
  return createDataAccessInternal(input);
}
