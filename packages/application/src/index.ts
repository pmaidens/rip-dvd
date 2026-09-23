import { isHandBrakePreset } from "@rip-dvd/config";
import { encodingProfileQueueBlockingReasons } from "@rip-dvd/data-access";
import type {
  ConsistentReadAccess,
  DataAccess,
  ArchiveAuditBounds,
  ArchiveRequestId,
  DetectedDiscId,
  EncodingProfile,
  EncodingProfileId,
  DiscInspectionId,
  FilesystemVerificationTarget,
  EncodeJobId,
  OriginalDiscArchiveId,
  EncodeQueueHistoryGroup,
  DiscSelectionId,
  MediaItemId,
  RearchiveMappingProposalInput,
  RearchiveMappingProposalRevisions,
  RearchiveMappingProposalReview,
} from "@rip-dvd/data-access";

import {
  readCatalogReview,
  serializeRearchiveMappingProposal,
  type CatalogReviewPageCoordinates,
} from "./catalog-review-read.js";
import type { CatalogReviewRearchiveMappingInput } from "./catalog-review-command.js";
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
import {
  cancelEncodeJob,
  enqueueEncodeJob,
  previewEncodeRequeue,
  readQueueOptions,
  requeueEncodeJob,
  resolveQueueLogicalJobs,
} from "./encode-jobs.js";
import { describeArchiveRequestWaitingStatus } from "./archive-request-waiting-status.js";
import {
  completeCatalogReview,
  previewCatalogReviewCompletion,
} from "./catalog-review-completion.js";
import {
  acceptRearchive,
  previewRearchiveAcceptance,
} from "./rearchive-acceptance.js";

export class InvalidProfileInputError extends Error {
  constructor(message = "Invalid Encoding Profile input.") {
    super(message);
    this.name = "InvalidProfileInputError";
  }
}

export interface RearchiveMappingProposalOperationInput
  extends RearchiveMappingProposalRevisions<string> {
  originalDiscArchiveId: string;
  mappings: readonly CatalogReviewRearchiveMappingInput[];
}

function rearchiveMappingProposalInput(
  input: RearchiveMappingProposalOperationInput,
): RearchiveMappingProposalInput {
  const revision = (value: string, name: string) => {
    const parsed = new Date(value);
    if (!Number.isSafeInteger(parsed.getTime()) || parsed.toISOString() !== value) {
      throw new RangeError(`${name} must be an ISO timestamp.`);
    }
    return parsed;
  };
  return {
    originalDiscArchiveId:
      requiredString(input.originalDiscArchiveId, "Original Disc Archive ID") as
        OriginalDiscArchiveId,
    catalogRevision: revision(input.catalogRevision, "Catalog revision"),
    sourceCatalogRevision: revision(
      input.sourceCatalogRevision,
      "Source Catalog revision",
    ),
    mappings: input.mappings.map((mapping) => ({
      sourceDiscSelectionId:
        requiredString(
          mapping.sourceDiscSelectionId,
          "Prior Disc Selection ID",
        ) as DiscSelectionId,
      mediaItemId: requiredString(
        mapping.mediaItemId,
        "Media Item ID",
      ) as MediaItemId,
      sourceIdentity: mapping.sourceIdentity,
      label: mapping.label,
    })),
  };
}

function presentRearchiveMappingProposal(
  access: DataAccess,
  proposal: RearchiveMappingProposalReview,
) {
  const discLabels = new Map(
    access.catalog.listDetectedDiscs(undefined, {
      ids: [
        proposal.sourceArchive.detectedDiscId,
        proposal.targetArchive.detectedDiscId,
      ],
    }).map((disc) => [disc.id, disc.volumeLabel]),
  );
  return serializeRearchiveMappingProposal(proposal, {
    source: discLabels.get(proposal.sourceArchive.detectedDiscId) ?? null,
    target: discLabels.get(proposal.targetArchive.detectedDiscId) ?? null,
  });
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
  describeArchiveRequestWaitingStatus,
  type PresentedArchiveRequestWaitingStatus,
} from "./archive-request-waiting-status.js";
export { applyMappingProposal } from "./mapping-proposal-operations.js";
export type { MappingProposalCommand } from "./mapping-proposal-operations.js";

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
  const verificationRuns = access.filesystemVerification.listActive()
    .map(({ id, status }) => ({ kind: "filesystem_verification", id, status }));
  const archiveAudits = access.archiveAudits.listActive()
    .map(({ id, status }) => ({ kind: "archive_audit", id, status }));
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
      ...archiveAudits,
      ...verificationRuns,
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
    encodeQueueOptions: (input: {
      mediaLibraryPath: string;
      selectionOffset?: number;
      profileOffset?: number;
      historyGroup?: EncodeQueueHistoryGroup;
      query?: string;
      encodingProfileId?: EncodingProfileId;
    }) => readQueueOptions(
      access, input.selectionOffset ?? 0, input.profileOffset ?? 0,
      input.mediaLibraryPath, input.historyGroup ?? "not_encoded",
      input.query, input.encodingProfileId,
    ),
    resolveEncodeQueue: (input: {
      discSelectionIds: readonly DiscSelectionId[];
      encodingProfileId: EncodingProfileId;
    }) => resolveQueueLogicalJobs(access, input.discSelectionIds, input.encodingProfileId),
    enqueueEncodeJob: (input: Parameters<typeof enqueueEncodeJob>[2] & { mediaLibraryPath: string }) =>
      enqueueEncodeJob(access, input.mediaLibraryPath, input),
    requeueEncodeJob: (input: Parameters<typeof requeueEncodeJob>[2] & { mediaLibraryPath: string }) =>
      requeueEncodeJob(access, input.mediaLibraryPath, input),
    previewEncodeRequeue: (input: Parameters<typeof previewEncodeRequeue>[1]) =>
      previewEncodeRequeue(access, input),
    cancelEncodeJob: (input: Parameters<typeof cancelEncodeJob>[1]) =>
      cancelEncodeJob(access, input),
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
    submitRearchiveRequest: (input: {
      mutationKey: unknown;
      sourceArchiveId: string;
    }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const sourceArchiveId = input.sourceArchiveId.trim();
      if (sourceArchiveId === "") {
        throw new Error("Original Disc Archive ID is required.");
      }
      const request = access.archiveRequests.submitRearchive({
        mutationKey,
        sourceArchiveId: sourceArchiveId as OriginalDiscArchiveId,
      });
      return {
        archiveRequest: {
          id: request.id,
          detectedDiscId: request.detectedDiscId,
          rearchiveSourceArchiveId: request.rearchiveSourceArchiveId,
          status: request.status,
          priority: request.priority,
          waiting: describeArchiveRequestWaitingStatus(
            access.archiveRequests.waitingStatus(request.id),
          ),
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
    submitFilesystemVerification: (input: {
      mutationKey: unknown;
      target: FilesystemVerificationTarget;
      targetId: string;
    }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      if (input.target !== "original_disc_archive" &&
        input.target !== "encode_job_output") {
        throw new RangeError("Unknown verification target.");
      }
      const targetId = input.targetId.trim();
      if (targetId.length === 0 || targetId.length > 256) {
        throw new RangeError("Invalid verification target ID.");
      }
      const targetReference = input.target === "original_disc_archive"
        ? { target: input.target, targetId: targetId as OriginalDiscArchiveId }
        : { target: input.target, targetId: targetId as EncodeJobId };
      const run = access.filesystemVerification.submit({ mutationKey, ...targetReference });
      return { verificationRun: {
        id: run.id,
        target: run.target,
        targetId: run.targetId,
        status: run.status,
        progressPhase: run.progressPhase,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      } };
    },
    submitArchiveAudit: (input: {
      mutationKey: unknown;
      bounds: ArchiveAuditBounds;
    }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const run = access.archiveAudits.submit({ mutationKey, bounds: input.bounds });
      return { archiveAuditRun: {
        id: run.id,
        status: run.status,
        bounds: run.bounds,
        progress: {
          phase: run.progressPhase,
          recordCount: run.recordCount,
          recordsProcessed: run.recordsProcessed,
        },
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      } };
    },
    catalogReview: (
      id: OriginalDiscArchiveId,
      coordinates: CatalogReviewPageCoordinates,
      automaticCatalogingConfigured: boolean,
    ) => readCatalogReview(access, id, coordinates, automaticCatalogingConfigured),
    previewRearchiveMappingProposal: (
      input: RearchiveMappingProposalOperationInput,
    ) => presentRearchiveMappingProposal(
      access,
      access.catalog.previewRearchiveMappingProposal(
        rearchiveMappingProposalInput(input),
      ),
    ),
    saveRearchiveMappingProposal: (
      input: RearchiveMappingProposalOperationInput & { mutationKey: unknown },
    ) => {
      const proposal = access.catalog.saveRearchiveMappingProposal({
        ...rearchiveMappingProposalInput(input),
        mutationKey: parseMutationKey(input.mutationKey),
      });
      return {
        message: "Re-archive Mapping Proposal saved",
        proposal: presentRearchiveMappingProposal(access, proposal),
      };
    },
    previewRearchiveAcceptance: (
      archiveId: Parameters<typeof previewRearchiveAcceptance>[1],
      command: Parameters<typeof previewRearchiveAcceptance>[2],
    ) => previewRearchiveAcceptance(access, archiveId, command),
    acceptRearchive: (
      archiveId: Parameters<typeof acceptRearchive>[1],
      command: Parameters<typeof acceptRearchive>[2],
      input: Parameters<typeof acceptRearchive>[3],
    ) => acceptRearchive(access, archiveId, command, input),
    catalogSuggestion: (
      id: OriginalDiscArchiveId,
      lookup: CatalogMetadataLookup | null,
      selection?: CatalogMetadataSelection,
    ) => suggestCatalogReview(access, id, lookup, selection),
    previewCatalogReviewCompletion: (
      archiveId: Parameters<typeof previewCatalogReviewCompletion>[1],
      command: Parameters<typeof previewCatalogReviewCompletion>[2],
      mediaLibraryPath: string,
    ) => previewCatalogReviewCompletion(
      access,
      archiveId,
      command,
      mediaLibraryPath,
    ),
    completeCatalogReview: (
      archiveId: Parameters<typeof completeCatalogReview>[1],
      command: Parameters<typeof completeCatalogReview>[2],
      input: Parameters<typeof completeCatalogReview>[3],
    ) => completeCatalogReview(access, archiveId, command, input),
    searchMediaItems: (input: Parameters<typeof searchMediaItems>[1]) =>
      searchMediaItems(access, input),
    showMediaItem: (id: Parameters<typeof showMediaItem>[1]) => showMediaItem(access, id),
    previewMediaItemChange: (
      id: Parameters<typeof previewMediaItemChange>[1],
      action: "update" | "delete",
      changes?: Parameters<typeof previewMediaItemChange>[3],
    ) => previewMediaItemChange(access, id, action, changes),
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
export * from "./catalog-review-completion.js";
export * from "./catalog-review-completion-preview-token.js";
export * from "./rearchive-acceptance.js";
export * from "./rearchive-acceptance-preview-token.js";
export type { MediaItemCommand } from "./media-item-operations.js";
export * from "./catalog-automation.js";
export * from "./tmdb-catalog-adapter.js";
export { suggestCatalogReview } from "./catalog-suggestion.js";
export { executeDiscSelectionCommand, previewDiscSelection, previewDiscSelectionChange } from "./disc-selection-operations.js";
export { InvalidEncodeJobInputError } from "./encode-jobs.js";
export { mediaOutputPath, suggestedMediaOutputPath } from "./media-output-path.js";
export {
  cancelEncodeJob,
  enqueueEncodeJob,
  parseEncodeEnqueueInput,
  previewEncodeRequeue,
  readQueueOptions,
  requeueEncodeJob,
  resolveQueueLogicalJobs,
  serializeJob,
} from "./encode-jobs.js";
