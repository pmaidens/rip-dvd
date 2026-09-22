import { isHandBrakePreset } from "@rip-dvd/config";
import { encodingProfileQueueBlockingReasons } from "@rip-dvd/data-access";

import type {
  ConsistentReadAccess,
  DataAccess,
  ArchiveRequestId,
  DetectedDiscId,
  EncodingProfile,
  EncodingProfileId,
  DiscInspectionId,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { readCatalogReview, type CatalogReviewPageCoordinates } from "./catalog-review-read.js";
import { suggestCatalogReview } from "./catalog-suggestion.js";
import { generateMutationKey, InvalidMutationKeyError, parseMutationKey } from "./mutation-key.js";
import {
  mutateMediaItem,
  previewMediaItemChange,
  searchMediaItems,
  showMediaItem,
  type MediaItemCommand,
} from "./media-item-operations.js";
import type { CatalogMetadataLookup, CatalogMetadataSelection } from "./catalog-automation.js";

export class InvalidProfileInputError extends Error {
  constructor(message = "Invalid Encoding Profile input.") {
    super(message);
    this.name = "InvalidProfileInputError";
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidProfileInputError(`${name} is required.`);
  }
  return value.trim();
}

function profileSettings(value: unknown): { preset: string; container: "mkv" } {
  const settings = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const preset = typeof settings?.preset === "string" ? settings.preset.trim() : null;
  if (!preset || !isHandBrakePreset(preset) || settings?.container !== "mkv") {
    throw new InvalidProfileInputError("A supported HandBrake preset and MKV container are required.");
  }
  return { preset, container: "mkv" };
}

export function toEncodingProfileDto(profile: EncodingProfile) {
  const preset = typeof profile.settings.preset === "string"
    ? profile.settings.preset : null;
  const container = profile.settings.container === "mkv" ? "mkv" as const : null;
  const blockingReasons = encodingProfileQueueBlockingReasons(profile);
  return {
    id: String(profile.id),
    key: profile.key,
    displayName: profile.displayName,
    mediaDomain: profile.mediaDomain,
    version: profile.version,
    isActive: profile.isActive,
    settings: { preset, container },
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
    eligibility: {
      newEncodeJobs: blockingReasons.length === 0,
      blockingReasons,
      canCreateVersion: true,
      canActivate: !profile.isActive,
      canDeactivate: profile.isActive,
    },
  };
}

export { generateMutationKey, InvalidMutationKeyError, parseMutationKey };

export {
  encodeRequeueAvailability,
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
    listEncodingProfiles: () => ({
      schemaVersion: 1,
      profiles: access.encodingProfiles.list({ mediaDomain: "dvd_video" }).map(toEncodingProfileDto),
    }),
    previewEncodingProfileState: (input: { id: unknown; isActive: unknown }) => {
      const id = requiredString(input.id, "Encoding Profile ID") as EncodingProfileId;
      if (typeof input.isActive !== "boolean") {
        throw new InvalidProfileInputError("isActive must be a boolean.");
      }
      const preview = access.encodingProfiles.previewStateChange({
        id, mediaDomain: "dvd_video", isActive: input.isActive,
      });
      return {
        schemaVersion: 1,
        profile: toEncodingProfileDto(preview.target),
        currentActive: preview.activeVersion ? toEncodingProfileDto(preview.activeVersion) : null,
        revision: preview.revision,
        requestedActiveState: input.isActive,
        replacesActiveVersion: input.isActive && preview.activeVersion !== null &&
          preview.activeVersion.id !== id,
      };
    },
    createEncodingProfile: (input: {
      mutationKey: unknown; key: unknown; displayName: unknown; settings: unknown;
    }) => ({
      profile: toEncodingProfileDto(access.encodingProfiles.submit({
        operation: "create",
        mutationKey: parseMutationKey(input.mutationKey),
        key: requiredString(input.key, "key"),
        displayName: requiredString(input.displayName, "displayName"),
        mediaDomain: "dvd_video",
        settings: profileSettings(input.settings),
      })),
    }),
    createEncodingProfileVersion: (input: {
      mutationKey: unknown; sourceProfileId: unknown; settings: unknown;
    }) => ({
      profile: toEncodingProfileDto(access.encodingProfiles.submit({
        operation: "createVersion",
        mutationKey: parseMutationKey(input.mutationKey),
        sourceProfileId: requiredString(input.sourceProfileId, "sourceProfileId") as EncodingProfileId,
        mediaDomain: "dvd_video",
        settings: profileSettings(input.settings),
      })),
    }),
    setEncodingProfileActive: (input: {
      mutationKey: unknown; id: unknown; isActive: unknown;
      expectedRevision: unknown; acknowledge: unknown;
    }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const id = requiredString(input.id, "Encoding Profile ID") as EncodingProfileId;
      if (typeof input.isActive !== "boolean") {
        throw new InvalidProfileInputError("isActive must be a boolean.");
      }
      const expectedRevision = requiredString(input.expectedRevision, "expectedRevision");
      if (input.acknowledge !== true) {
        throw new InvalidProfileInputError("Encoding Profile consequences must be acknowledged.");
      }
      return { profile: toEncodingProfileDto(access.encodingProfiles.submit({
        operation: "setActive", mutationKey, id,
        mediaDomain: "dvd_video", isActive: input.isActive, expectedRevision,
      })) };
    },
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
    cancelArchiveRequest: (input: { mutationKey: unknown; archiveRequestId: string }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const archiveRequest = access.archiveRequests.cancelWithReplay({
        mutationKey, id: input.archiveRequestId as ArchiveRequestId,
      });
      return { archiveRequest };
    },
    retryArchiveRequest: (input: { mutationKey: unknown; archiveRequestId: string }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const archiveRequest = access.archiveRequests.retryWithReplay({
        mutationKey, id: input.archiveRequestId as ArchiveRequestId,
      });
      return { archiveRequest };
    },
    retryDiscInspection: (input: { mutationKey: unknown; discInspectionId: string }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const inspection = access.discInspections.requestRetryWithReplay({
        mutationKey, id: input.discInspectionId as DiscInspectionId,
      });
      return { inspection };
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
    searchMediaItems: (input: Parameters<typeof searchMediaItems>[1]) =>
      searchMediaItems(access, input),
    showMediaItem: (id: Parameters<typeof showMediaItem>[1]) => showMediaItem(access, id),
    previewMediaItemChange: (
      id: Parameters<typeof previewMediaItemChange>[1],
      action: "update" | "delete",
    ) => previewMediaItemChange(access, id, action),
    mutateMediaItem: (input: {
      mutationKey: unknown;
      command: MediaItemCommand;
      acknowledgedRevision?: string;
    }) => mutateMediaItem(access, input),
  };
}

export { formatVolumeLabel } from "./catalog-label.js";
export { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";
export { readCatalogReview, serializeDiscSelection, serializeMediaItem } from "./catalog-review-read.js";
export type { CatalogReviewPageCoordinates } from "./catalog-review-read.js";
export * from "./catalog-review-types.js";
export * from "./catalog-review-command.js";
export type { MediaItemCommand } from "./media-item-operations.js";
export * from "./catalog-automation.js";
export * from "./tmdb-catalog-adapter.js";
export { suggestCatalogReview } from "./catalog-suggestion.js";
export { executeDiscSelectionCommand, previewDiscSelection, previewDiscSelectionChange } from "./disc-selection-operations.js";
