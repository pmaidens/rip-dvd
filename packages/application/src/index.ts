import { randomUUID } from "node:crypto";

import type {
  ConsistentReadAccess,
  DataAccess,
  DetectedDiscId,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { readCatalogReview, type CatalogReviewPageCoordinates } from "./catalog-review-read.js";
import { suggestCatalogReview } from "./catalog-suggestion.js";
import type { CatalogMetadataLookup, CatalogMetadataSelection } from "./catalog-automation.js";

export class InvalidMutationKeyError extends Error {
  constructor() {
    super("A mutation key of 8 to 128 safe characters is required.");
    this.name = "InvalidMutationKeyError";
  }
}

export function parseMutationKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)
  ) {
    throw new InvalidMutationKeyError();
  }
  return value;
}

export function generateMutationKey(): string {
  return randomUUID();
}

export {
  inspectOperations,
  isOperationKind,
  isWaitableKind,
  OPERATION_KINDS,
  validOperationLimit,
  waitForOperation,
} from "./operations.js";
export type { OperationKind, WaitableKind } from "./operations.js";

function readDeploymentReadiness(access: ConsistentReadAccess) {
  const inspections = access.discInspections
    .list({ currentOnly: true })
    .filter(({ status }) => status === "running")
    .map(({ id, status }) => ({ kind: "disc_inspection", id, status }));
  const archiveRequests = access.archiveRequests
    .list(["pending", "running", "cancellation_requested"])
    .map(({ id, status }) => ({ kind: "archive_request", id, status }));
  const archiveJobs = access.archiveJobs
    .list(["running"])
    .map(({ id, status }) => ({ kind: "archive_job", id, status }));
  const encodeJobs = access.encodeJobs
    .list(["queued", "running", "cancellation_requested"])
    .map(({ id, status }) => ({ kind: "encode_job", id, status }));
  const opticalDrives = access.catalog.listOpticalDrives().map((drive) => ({
    id: drive.id,
    devicePath: drive.devicePath,
    serialNumber: drive.serialNumber,
    isEnabled: drive.isEnabled,
    isPresent: drive.isPresent,
  }));

  return {
    schemaVersion: 1,
    activeWork: [
      ...inspections,
      ...archiveRequests,
      ...archiveJobs,
      ...encodeJobs,
    ],
    opticalDrives,
  };
}

export function createApplicationOperations(
  access: DataAccess,
) {
  return {
    health: () => access.checkHealth(),
    readiness: () => access.readConsistentSnapshot(readDeploymentReadiness),
    submitArchiveRequest: (input: {
      mutationKey: unknown;
      detectedDiscId: string;
    }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const detectedDiscId = input.detectedDiscId.trim();
      if (detectedDiscId === "") {
        throw new Error("Detected Disc ID is required.");
      }
      const request = access.archiveRequests.submit({
        mutationKey,
        detectedDiscId: detectedDiscId as DetectedDiscId,
      });
      return {
        archiveRequest: {
          id: request.id,
          detectedDiscId: request.detectedDiscId,
          status: request.status,
          priority: request.priority,
          createdAt: request.createdAt.toISOString(),
          updatedAt: request.updatedAt.toISOString(),
        },
      };
    },
    catalogReview: (
      id: OriginalDiscArchiveId,
      coordinates: CatalogReviewPageCoordinates,
      automaticCatalogingConfigured: boolean,
    ) => readCatalogReview(access, id, coordinates, automaticCatalogingConfigured),
    catalogSuggestion: (
      id: OriginalDiscArchiveId,
      lookup: CatalogMetadataLookup | null,
      selection?: CatalogMetadataSelection,
    ) => suggestCatalogReview(access, id, lookup, selection),
  };
}

export { formatVolumeLabel } from "./catalog-label.js";
export { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";
export { readCatalogReview, serializeDiscSelection, serializeMediaItem } from "./catalog-review-read.js";
export type { CatalogReviewPageCoordinates } from "./catalog-review-read.js";
export * from "./catalog-review-types.js";
export * from "./catalog-automation.js";
export * from "./tmdb-catalog-adapter.js";
export { suggestCatalogReview } from "./catalog-suggestion.js";
