import { requestDamagePreview, inspectDamagePreview, cancelDamagePreview, waitDamagePreview, exportDamagePreview } from "./damage-preview-operations.js";
import { inspectArchiveEvidence } from "./archive-evidence.js";
import { inspectDamagePreviewAvailability } from "./damage-preview.js";
import { inspectArchiveRecoveryRanges } from "./archive-recovery-ranges.js";
import { inspectCatalogTitleDamage } from "./catalog-title-damage.js";
import { previewDvdTitleDamageAcceptance } from
  "./dvd-title-damage-acceptance-preview.js";
import {
  acceptDvdTitleDamage,
  inspectDvdTitleDamageDecision,
} from "./dvd-title-damage-acceptance.js";
import { createNotificationOperations } from "./notifications.js";
import { isHandBrakePreset } from "@rip-dvd/config";
import {
  DomainInvariantError,
  DVD_RECOVERY_EVIDENCE_FORMAT,
  encodingProfileQueueBlockingReasons,
  withAuthoritativeDvdArchiveIntegrity,
} from "@rip-dvd/data-access";
import type {
  ConsistentReadAccess,
  DataAccess,
  ArchiveAuditBounds,
  ArchiveRequestId,
  ArchiveRecoveryId,
  ArchiveRecoveryAttemptId,
  DetectedDiscId,
  EncodingProfile,
  EncodingProfileId,
  DiscInspectionId,
  DvdDiscVerificationId,
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
  inspectDvdDiscVerification,
  requestDvdDiscVerification,
} from "./dvd-disc-verification.js";
import {
  previewDvdDiscConfirmation,
  recordDvdDiscConfirmation,
} from "./dvd-disc-confirmation.js";
import {
  inspectDvdRecoveryReconciliation,
  requestDvdRecoveryReconciliation,
} from "./dvd-recovery-reconciliation.js";
import { requestDvdRecoveryStop } from "./dvd-recovery-stop.js";
import { requestDvdRecoveryResume } from "./dvd-recovery-resume.js";
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
import { recordCatalogReviewEvidenceChoice } from "./catalog-review-choice.js";
import {
  acceptRearchive,
  previewRearchiveAcceptance,
} from "./rearchive-acceptance.js";
import {
  readFilesystemVerificationInventory,
} from "./filesystem-verification-inventory.js";
import { UnsupportedArchiveEvidenceFormatError } from "./archive-request-input.js";
import {
  exportEncodeOutput,
  acknowledgeEncodeOutputInspection,
  inspectEncodeOutput,
  type EncodeOutputMediaProbe,
} from "./encode-output-inspection.js";
import { describeDvdRecoveryStorage } from "./dvd-recovery-storage.js";
import type { ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import {
  assertCatalogReviewMappingAvailable,
  rethrowCatalogMappingOperationError,
} from "./catalog-review-workflow.js";

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
  access: Pick<ConsistentReadAccess, "catalog">,
  proposal: RearchiveMappingProposalReview,
  providedEvidenceHeaders?: ReturnType<
    ConsistentReadAccess["catalog"]["findDvdArchiveEvidenceHeaders"]
  >,
) {
  const evidenceArchiveIds = [...new Set([
    proposal.sourceArchive.id,
    proposal.targetArchive.id,
  ])];
  const evidenceHeaders = providedEvidenceHeaders ??
    access.catalog.findDvdArchiveEvidenceHeaders(evidenceArchiveIds);
  const authoritativeProposal = {
    ...proposal,
    sourceArchive: withAuthoritativeDvdArchiveIntegrity(
      proposal.sourceArchive,
      evidenceHeaders.get(proposal.sourceArchive.id) ?? null,
    ),
    targetArchive: withAuthoritativeDvdArchiveIntegrity(
      proposal.targetArchive,
      evidenceHeaders.get(proposal.targetArchive.id) ?? null,
    ),
  };
  const discLabels = new Map(
    access.catalog.listDetectedDiscs(undefined, {
      ids: [
        authoritativeProposal.sourceArchive.detectedDiscId,
        authoritativeProposal.targetArchive.detectedDiscId,
      ],
    }).map((disc) => [disc.id, disc.volumeLabel]),
  );
  return serializeRearchiveMappingProposal(authoritativeProposal, {
    source: discLabels.get(
      authoritativeProposal.sourceArchive.detectedDiscId,
    ) ?? null,
    target: discLabels.get(
      authoritativeProposal.targetArchive.detectedDiscId,
    ) ?? null,
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
  inspectOperationsWithArtifacts,
  isOperationKind,
  isWaitableKind,
  OPERATION_KINDS,
  validOperationLimit,
  waitForOperation,
} from "./operations.js";
export {
  DvdDiscVerificationUnavailableError,
  inspectDvdDiscVerification,
  type DvdDiscVerificationAvailabilityCode,
} from "./dvd-disc-verification.js";
export {
  previewDvdDiscConfirmation,
} from "./dvd-disc-confirmation.js";
export type {
  OperationInspectionOptions,
  OperationKind,
  WaitableKind,
} from "./operations.js";

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
  const recoveryReconciliations = access.dvdRecoveryReconciliations
    .listActive()
    .map(({ id, status }) => ({
      kind: "dvd_recovery_reconciliation",
      id,
      status,
    }));
  const opticalDrives = access.catalog.listOpticalDrives().map((drive) => ({
    id: drive.id,
    devicePath: drive.devicePath,
    serialNumber: drive.serialNumber,
    isEnabled: drive.isEnabled,
    isPresent: drive.isPresent,
  }));

  return {
    schemaVersion: 1,
    dvdRecoveryStorage: describeDvdRecoveryStorage(
      access.dvdRecoveryStorage.readCurrent(),
    ),
    activeWork: [
      ...access.damagePreviews.list().filter((preview) => ["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(preview.status)).map(({ id, status }) => ({ kind: "damage_preview", id, status })),
      ...inspections,
      ...archiveRequests,
      ...archiveJobs,
      ...encodeJobs,
      ...archiveAudits,
      ...recoveryReconciliations,
      ...verificationRuns,
    ],
    opticalDrives,
  };
}

export function createApplicationOperations(
  access: DataAccess,
  dependencies: {
    archiveImageOwnership?: ArchiveImageOwnership;
    encodeOutputMediaProbe?: EncodeOutputMediaProbe;
  } = {},
) {
  return {
    ...createNotificationOperations(access),
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
    inspectArchiveEvidence: (archiveId: string, options?: { limit?: number; cursor?: string }) =>
      inspectArchiveEvidence(
        access,
        archiveId,
        options,
        dependencies.archiveImageOwnership,
      ),
    inspectArchiveRecoveryRanges: (
      archiveRecoveryId: string,
      options?: { limit?: number; cursor?: string },
    ) => inspectArchiveRecoveryRanges(
      access,
      archiveRecoveryId,
      options,
      dependencies.archiveImageOwnership,
    ),
    inspectCatalogTitleDamage: (
      archiveId: string,
      options?: { limit?: number; cursor?: string },
    ) => inspectCatalogTitleDamage(access, archiveId, options),
    requestDamagePreview: (archiveId: string, input: unknown) => requestDamagePreview(access, archiveId, input, dependencies.archiveImageOwnership),
    inspectDamagePreview: (id: string) => inspectDamagePreview(access, id, dependencies.archiveImageOwnership),
    waitDamagePreview: (id: string, options: { timeoutMs: number; pollMs?: number }) => waitDamagePreview(access, id, options, dependencies.archiveImageOwnership),
    cancelDamagePreview: (id: string, key: unknown) => cancelDamagePreview(access, id, key),
    exportDamagePreview: (identity: string, destination: string) => exportDamagePreview(access, identity, destination, dependencies.archiveImageOwnership),
    inspectDamagePreviewAvailability: (archiveId: string, input?: unknown) =>
      inspectDamagePreviewAvailability(access, archiveId, input, dependencies.archiveImageOwnership),
    previewDvdTitleDamageAcceptance: (
      archiveId: Parameters<typeof previewDvdTitleDamageAcceptance>[1],
      input?: Parameters<typeof previewDvdTitleDamageAcceptance>[2],
    ) => previewDvdTitleDamageAcceptance(access, archiveId, input),
    acceptDvdTitleDamage: (
      archiveId: Parameters<typeof acceptDvdTitleDamage>[1],
      input: Parameters<typeof acceptDvdTitleDamage>[2],
    ) => acceptDvdTitleDamage(access, archiveId, input),
    inspectDvdTitleDamageDecision: (
      archiveId: Parameters<typeof inspectDvdTitleDamageDecision>[1],
    ) => inspectDvdTitleDamageDecision(access, archiveId),
    inspectEncodeOutput: (artifactIdentity: unknown, page?: { receiptLimit?: number; receiptOffset?: number }) =>
      inspectEncodeOutput(
        access,
        artifactIdentity,
        dependencies.encodeOutputMediaProbe,
        page,
      ),
    acknowledgeEncodeOutputInspection: (artifactIdentity: unknown, input: unknown) =>
      acknowledgeEncodeOutputInspection(access, artifactIdentity, input, dependencies.encodeOutputMediaProbe),
    exportEncodeOutput: (input: {
      artifactIdentity: unknown;
      destination: unknown;
    }) => exportEncodeOutput(access, input),
    submitArchiveRequest: (input: {
      mutationKey: unknown;
      detectedDiscId: string;
      evidenceFormat?: unknown;
    }) => {
      const mutationKey = parseMutationKey(input.mutationKey);
      const detectedDiscId = input.detectedDiscId.trim();
      if (detectedDiscId === "") {
        throw new Error("Detected Disc ID is required.");
      }
      if (
        input.evidenceFormat !== undefined &&
        input.evidenceFormat !== DVD_RECOVERY_EVIDENCE_FORMAT
      ) {
        throw new UnsupportedArchiveEvidenceFormatError();
      }
      const request = access.archiveRequests.submit({
        mutationKey,
        detectedDiscId: detectedDiscId as DetectedDiscId,
        ...(input.evidenceFormat === undefined
          ? {}
          : { evidenceFormat: input.evidenceFormat }),
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
    inspectDvdDiscVerification: (archiveRecoveryId: string) => {
      const id = requiredString(
        archiveRecoveryId,
        "Archive Recovery ID",
      );
      if (id.length > 256) throw new RangeError("Invalid Archive Recovery ID.");
      return inspectDvdDiscVerification(access, id as ArchiveRecoveryId);
    },
    previewDvdDiscConfirmation: (archiveRecoveryId: string) => {
      const id = requiredString(
        archiveRecoveryId,
        "Archive Recovery ID",
      );
      if (id.length > 256) throw new RangeError("Invalid Archive Recovery ID.");
      return previewDvdDiscConfirmation(
        access,
        id as ArchiveRecoveryId,
        dependencies.archiveImageOwnership,
      );
    },
    inspectDvdRecoveryReconciliation: (archiveRecoveryId: string) => {
      const id = requiredString(
        archiveRecoveryId,
        "Archive Recovery ID",
      );
      if (id.length > 256) throw new RangeError("Invalid Archive Recovery ID.");
      return inspectDvdRecoveryReconciliation(
        access,
        id as ArchiveRecoveryId,
      );
    },
    reconcileDvdRecovery: (input: {
      mutationKey: unknown;
      archiveRecoveryId: unknown;
    }) => {
      const archiveRecoveryId = requiredString(
        input.archiveRecoveryId,
        "Archive Recovery ID",
      );
      if (archiveRecoveryId.length > 256) {
        throw new RangeError("Invalid Archive Recovery ID.");
      }
      return requestDvdRecoveryReconciliation(access, {
        mutationKey: parseMutationKey(input.mutationKey),
        archiveRecoveryId: archiveRecoveryId as ArchiveRecoveryId,
      });
    },
    stopDvdRecovery: (input: {
      mutationKey: unknown;
      archiveRecoveryId: unknown;
      attemptId: unknown;
    }) => {
      const archiveRecoveryId = requiredString(
        input.archiveRecoveryId,
        "Archive Recovery ID",
      );
      const attemptId = requiredString(
        input.attemptId,
        "Archive Recovery attempt ID",
      );
      if (archiveRecoveryId.length > 256 || attemptId.length > 256) {
        throw new RangeError("Invalid Archive Recovery Stop identity.");
      }
      return requestDvdRecoveryStop(access, {
        mutationKey: parseMutationKey(input.mutationKey),
        archiveRecoveryId: archiveRecoveryId as ArchiveRecoveryId,
        attemptId: attemptId as ArchiveRecoveryAttemptId,
      });
    },
    resumeDvdRecovery: (input: {
      mutationKey: unknown;
      archiveRecoveryId: unknown;
      attemptId: unknown;
      checkpointRevision: unknown;
      checkpointDigest: unknown;
      speedMode: unknown;
    }) => {
      const archiveRecoveryId = requiredString(
        input.archiveRecoveryId,
        "Archive Recovery ID",
      );
      const attemptId = requiredString(
        input.attemptId,
        "Archive Recovery attempt ID",
      );
      const checkpointDigest = requiredString(
        input.checkpointDigest,
        "Archive Recovery checkpoint digest",
      );
      if (
        archiveRecoveryId.length > 256 || attemptId.length > 256 ||
        !Number.isSafeInteger(input.checkpointRevision) ||
        Number(input.checkpointRevision) <= 0 ||
        !/^[0-9a-f]{64}$/.test(checkpointDigest) ||
        input.speedMode !== "normal" && input.speedMode !== "low"
      ) {
        throw new RangeError("Invalid Archive Recovery Resume input.");
      }
      return requestDvdRecoveryResume(access, {
        mutationKey: parseMutationKey(input.mutationKey),
        archiveRecoveryId: archiveRecoveryId as ArchiveRecoveryId,
        attemptId: attemptId as ArchiveRecoveryAttemptId,
        checkpointRevision: Number(input.checkpointRevision),
        checkpointDigest,
        speedMode: input.speedMode,
      }, dependencies.archiveImageOwnership);
    },
    verifyDisc: (input: {
      mutationKey: unknown;
      archiveRecoveryId: unknown;
      discInspectionId: unknown;
      checkpointRevision: unknown;
      checkpointDigest: unknown;
    }) => {
      const archiveRecoveryId = requiredString(
        input.archiveRecoveryId,
        "Archive Recovery ID",
      );
      const discInspectionId = requiredString(
        input.discInspectionId,
        "Disc Inspection ID",
      );
      const checkpointDigest = requiredString(
        input.checkpointDigest,
        "checkpoint digest",
      );
      if (
        archiveRecoveryId.length > 256 ||
        discInspectionId.length > 256 ||
        !Number.isSafeInteger(input.checkpointRevision) ||
        Number(input.checkpointRevision) <= 0 ||
        !/^[0-9a-f]{64}$/.test(checkpointDigest)
      ) throw new RangeError("Invalid DVD Disc Verification input.");
      return requestDvdDiscVerification(access, {
        mutationKey: parseMutationKey(input.mutationKey),
        archiveRecoveryId: archiveRecoveryId as ArchiveRecoveryId,
        discInspectionId: discInspectionId as DiscInspectionId,
        checkpointRevision: Number(input.checkpointRevision),
        checkpointDigest,
      });
    },
    confirmDisc: (input: {
      mutationKey: unknown;
      archiveRecoveryId: unknown;
      originalDiscArchiveId: unknown;
      archiveRecoveryAttemptId: unknown;
      discInspectionId: unknown;
      detectedDiscId: unknown;
      mediaGeneration: unknown;
      verificationId: unknown;
      verificationWorkerExecutionId: unknown;
      verificationOutcome: unknown;
      verificationResultDigest: unknown;
      checkpointRevision: unknown;
      checkpointDigest: unknown;
      acknowledgeMixedSource: unknown;
    }) => {
      const archiveRecoveryId = requiredString(
        input.archiveRecoveryId,
        "Archive Recovery ID",
      );
      const originalDiscArchiveId = requiredString(
        input.originalDiscArchiveId,
        "Original Disc Archive ID",
      );
      const archiveRecoveryAttemptId = requiredString(
        input.archiveRecoveryAttemptId,
        "Archive Recovery attempt ID",
      );
      const discInspectionId = requiredString(
        input.discInspectionId,
        "Disc Inspection ID",
      );
      const detectedDiscId = requiredString(
        input.detectedDiscId,
        "Detected Disc ID",
      );
      const mediaGeneration = requiredString(
        input.mediaGeneration,
        "media generation",
      );
      const verificationId = requiredString(
        input.verificationId,
        "DVD Disc Verification ID",
      );
      const verificationWorkerExecutionId = requiredString(
        input.verificationWorkerExecutionId,
        "verification worker execution ID",
      );
      const verificationResultDigest = requiredString(
        input.verificationResultDigest,
        "verification result digest",
      );
      const checkpointDigest = requiredString(
        input.checkpointDigest,
        "checkpoint digest",
      );
      if (
        [
          archiveRecoveryId,
          originalDiscArchiveId,
          archiveRecoveryAttemptId,
          discInspectionId,
          detectedDiscId,
          mediaGeneration,
          verificationId,
          verificationWorkerExecutionId,
        ].some((value) => value.length > 256) ||
        (input.verificationOutcome !== "mismatch" &&
          input.verificationOutcome !== "inconclusive") ||
        !/^[0-9a-f]{64}$/.test(verificationResultDigest) ||
        !Number.isSafeInteger(input.checkpointRevision) ||
        Number(input.checkpointRevision) <= 0 ||
        !/^[0-9a-f]{64}$/.test(checkpointDigest) ||
        input.acknowledgeMixedSource !== true
      ) throw new RangeError("Invalid DVD Disc Confirmation input.");
      return recordDvdDiscConfirmation(access, {
        mutationKey: parseMutationKey(input.mutationKey),
        archiveRecoveryId: archiveRecoveryId as ArchiveRecoveryId,
        originalDiscArchiveId:
          originalDiscArchiveId as OriginalDiscArchiveId,
        archiveRecoveryAttemptId:
          archiveRecoveryAttemptId as ArchiveRecoveryAttemptId,
        discInspectionId: discInspectionId as DiscInspectionId,
        detectedDiscId: detectedDiscId as DetectedDiscId,
        mediaGeneration,
        verificationId: verificationId as DvdDiscVerificationId,
        verificationWorkerExecutionId,
        verificationOutcome: input.verificationOutcome,
        verificationResultDigest,
        checkpointRevision: Number(input.checkpointRevision),
        checkpointDigest,
        acknowledgeMixedSource: true,
      }, dependencies.archiveImageOwnership);
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
    filesystemVerificationInventory: (
      input: Parameters<typeof readFilesystemVerificationInventory>[1],
    ) => readFilesystemVerificationInventory(access, input),
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
    ) => {
      const proposalInput = rearchiveMappingProposalInput(input);
      return access.readConsistentSnapshot((snapshot) => {
        const targetArchive = snapshot.catalog.listOriginalDiscArchives({
          ids: [proposalInput.originalDiscArchiveId],
          limit: 1,
        })[0];
        if (targetArchive === undefined) {
          return presentRearchiveMappingProposal(
            snapshot,
            snapshot.catalog.previewRearchiveMappingProposal(proposalInput),
          );
        }
        const evidenceArchiveIds = [...new Set([
          ...(targetArchive.rearchiveSourceArchiveId === null
            ? []
            : [targetArchive.rearchiveSourceArchiveId]),
          targetArchive.id,
        ])];
        const evidenceHeaders = snapshot.catalog.findDvdArchiveEvidenceHeaders(
          evidenceArchiveIds,
        );
        const workflowEvidence = snapshot.catalog
          .readDvdCatalogReviewWorkflowEvidence([{
            originalDiscArchiveId: proposalInput.originalDiscArchiveId,
            evidenceHeader: evidenceHeaders.get(
              proposalInput.originalDiscArchiveId,
            ) ?? null,
          }]).get(proposalInput.originalDiscArchiveId);
        if (workflowEvidence === undefined) {
          throw new DomainInvariantError(
            "Catalog Review workflow evidence is unavailable",
          );
        }
        assertCatalogReviewMappingAvailable(
          snapshot,
          proposalInput.originalDiscArchiveId,
          workflowEvidence,
        );
        const proposal = snapshot.catalog.previewRearchiveMappingProposal(
          proposalInput,
        );
        return presentRearchiveMappingProposal(
          snapshot,
          proposal,
          evidenceHeaders,
        );
      });
    },
    saveRearchiveMappingProposal: (
      input: RearchiveMappingProposalOperationInput & { mutationKey: unknown },
    ) => {
      const proposalInput = rearchiveMappingProposalInput(input);
      let proposal: RearchiveMappingProposalReview;
      try {
        proposal = access.catalog.saveRearchiveMappingProposal({
          ...proposalInput,
          mutationKey: parseMutationKey(input.mutationKey),
        });
      } catch (error) {
        rethrowCatalogMappingOperationError(
          access,
          proposalInput.originalDiscArchiveId,
          proposalInput.catalogRevision,
          error,
        );
      }
      return {
        message: "Re-archive Mapping Proposal saved",
        proposal: presentRearchiveMappingProposal(access, proposal),
      };
    },
    previewRearchiveAcceptance: (
      archiveId: Parameters<typeof previewRearchiveAcceptance>[1],
      command: Parameters<typeof previewRearchiveAcceptance>[2],
      mediaLibraryPath: Parameters<typeof previewRearchiveAcceptance>[3],
    ) => previewRearchiveAcceptance(
      access,
      archiveId,
      command,
      mediaLibraryPath,
    ),
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
    recordCatalogReviewEvidenceChoice: (
      archiveId: Parameters<typeof recordCatalogReviewEvidenceChoice>[1],
      command: Parameters<typeof recordCatalogReviewEvidenceChoice>[2],
      mutationKey: Parameters<typeof recordCatalogReviewEvidenceChoice>[3],
    ) => recordCatalogReviewEvidenceChoice(
      access,
      archiveId,
      command,
      mutationKey,
    ),
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
export { describeDvdRecoveryStorage } from "./dvd-recovery-storage.js";
export {
  inspectDvdRecoveryReconciliation,
  requestDvdRecoveryReconciliation,
} from "./dvd-recovery-reconciliation.js";
export {
  dvdRecoveryStopAction,
  requestDvdRecoveryStop,
} from "./dvd-recovery-stop.js";
export {
  dvdRecoveryResumeAction,
  DvdRecoveryResumeUnavailableError,
  requestDvdRecoveryResume,
} from "./dvd-recovery-resume.js";
export {
  FILESYSTEM_VERIFICATION_INVENTORY_PAGE_LIMIT,
  readFilesystemVerificationInventory,
} from "./filesystem-verification-inventory.js";
export type {
  FilesystemVerificationInventoryInput,
} from "./filesystem-verification-inventory.js";
export {
  encodeOutputArtifactReferences,
  encodeOutputArtifactIdentity,
  EncodeOutputExportRejectedError,
  acknowledgeEncodeOutputInspection,
  EncodeOutputAcknowledgementRejectedError,
  InvalidEncodeOutputAcknowledgementError,
  InvalidEncodeOutputInspectionInputError,
  exportEncodeOutput,
  inspectEncodeOutput,
  InvalidEncodeOutputArtifactIdentityError,
  InvalidEncodeOutputExportInputError,
  probeEncodeOutputMedia,
  retainedEncodeOutputArtifactIdentity,
} from "./encode-output-inspection.js";
export type {
  EncodeOutputArtifactReference,
  EncodeOutputExportReasonCode,
  EncodeOutputInspection,
  EncodeOutputInspectionReceipt,
  EncodeOutputInspectionReasonCode,
  EncodeOutputMediaInspection,
  EncodeOutputMediaProbe,
  EncodeOutputMediaStream,
  EncodeOutputStreamKind,
} from "./encode-output-inspection.js";
export { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";
export { readCatalogReview, serializeDiscSelection, serializeMediaItem } from "./catalog-review-read.js";
export type { CatalogReviewPageCoordinates } from "./catalog-review-read.js";
export {
  assertCatalogReviewMappingAvailable,
  assertLegacyCatalogReviewCompletionAvailable,
  CatalogReviewMappingUnavailableError,
  CatalogReviewCompletionUnavailableError,
  CatalogReviewRevisionStaleError,
  describeCatalogReviewWorkflow,
} from "./catalog-review-workflow.js";
export type {
  CatalogReviewWorkflow,
  CatalogReviewWorkflowAction,
  CatalogReviewWorkflowReason,
  CatalogReviewWorkflowReasonCode,
} from "./catalog-review-workflow.js";
export * from "./catalog-review-types.js";
export * from "./catalog-review-command.js";
export * from "./catalog-review-completion.js";
export * from "./catalog-review-choice.js";
export * from "./catalog-review-completion-preview-token.js";
export * from "./rearchive-acceptance.js";
export * from "./rearchive-acceptance-preview-token.js";
export * from "./dvd-title-damage-acceptance-preview.js";
export * from "./dvd-title-damage-acceptance-preview-token.js";
export * from "./dvd-title-damage-acceptance.js";
export * from "./archive-request-input.js";
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

export * from "./notifications.js";
export * from "./notification-policy.js";
export * from "./notification-validation.js";
export * from "./notification-config.js";
export * from "./notification-dispatch.js";
export * from "./notification-transport.js";

export { inspectArchiveEvidence, InvalidArchiveEvidenceInputError } from "./archive-evidence.js";
export { InvalidDamagePreviewInputError } from "./damage-preview-input.js";
export type { DamagePreviewInput, PlaybackRange } from "./damage-preview-input.js";
export type DamagePreviewAvailability = Awaited<ReturnType<typeof inspectDamagePreviewAvailability>>;
export {
  describeArchiveArtifact,
  enrichArchiveArtifactSourceIdentity,
} from "./archive-artifact.js";
export type {
  ArchiveArtifact,
  ArchiveArtifactAction,
  ArchiveArtifactReason,
  ArchiveArtifactRecoveryState,
} from "./archive-artifact.js";
export {
  inspectArchiveRecoveryRanges,
  InvalidArchiveRecoveryRangesInputError,
  presentArchiveRecoveryRangeEvidence,
} from "./archive-recovery-ranges.js";
export {
  inspectCatalogTitleDamage,
  InvalidCatalogTitleDamageInputError,
  StaleCatalogTitleDamageCursorError,
} from "./catalog-title-damage.js";

export * from "./damage-preview-operations.js";

export { reviewDamagePreviewEvidence } from "./damage-preview.js";

export type DamagePreviewInspection = Awaited<ReturnType<typeof inspectDamagePreview>>;
