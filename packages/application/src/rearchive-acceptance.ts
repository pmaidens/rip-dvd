import {
  DomainInvariantError,
  rearchiveAcceptancePreviewEvidence,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import type { CatalogReviewCommand } from "./catalog-review-command.js";
import { normalizeCorrectedEncodeReplacements } from "./corrected-encode-replacement.js";
import { parseMutationKey } from "./mutation-key.js";
import {
  createRearchiveAcceptancePreviewToken,
  isRearchiveAcceptancePreviewToken,
} from "./rearchive-acceptance-preview-token.js";

export type RearchiveAcceptanceCommand = Extract<
  CatalogReviewCommand,
  { action: "accept_rearchive" }
>;

function revision(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isSafeInteger(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DomainInvariantError(`${name} must be an ISO timestamp`);
  }
  return parsed;
}

function validateAcceptanceCommand(
  command: RearchiveAcceptanceCommand,
  mediaLibraryPath: string,
) {
  return {
    catalogRevision: revision(command.catalogRevision, "Catalog revision"),
    sourceCatalogRevision: revision(
      command.sourceCatalogRevision,
      "Source Catalog revision",
    ),
    replacements: normalizeCorrectedEncodeReplacements(
      command.replacementEncodes,
      mediaLibraryPath,
    ),
  };
}

export function previewRearchiveAcceptance(
  access: DataAccess,
  targetArchiveId: OriginalDiscArchiveId,
  command: RearchiveAcceptanceCommand,
  mediaLibraryPath: string,
) {
  const input = {
    targetArchiveId,
    ...validateAcceptanceCommand(command, mediaLibraryPath),
  };
  const plan = access.readConsistentSnapshot((snapshot) =>
    snapshot.catalog.planRearchiveAcceptance(input)
  );
  const previewToken = createRearchiveAcceptancePreviewToken();
  access.catalog.recordRearchiveAcceptancePreviewDecision({
    previewToken,
    ...input,
    expectedPreviewEvidence: rearchiveAcceptancePreviewEvidence(plan),
  });
  return {
    state: "available" as const,
    targetArchiveId: plan.targetArchiveId,
    sourceArchiveId: plan.sourceArchiveId,
    catalogRevision: plan.catalogRevision,
    sourceCatalogRevision: plan.sourceCatalogRevision,
    previewToken,
    affectedEncodeJobs: plan.affectedEncodeJobs.map((job) => ({
      id: job.id,
      discSelectionId: job.discSelectionId,
      status: job.status,
    })),
    consequences: {
      adoptsMappingCount: plan.mappings.length,
      requestsEncodeJobCancellation: plan.affectedEncodeJobs.map(
        (job) => job.id,
      ),
      preventsOldSourceEnqueue: true,
      preservesPriorArchive: true,
      preservesCompletedOutputs: true,
      replacementEncodeCount: plan.replacementEncodes.length,
      replacementEncodes: plan.replacementEncodes,
      availableReplacementEncodeCount:
        plan.availableReplacementEncodes.length,
      omittedReplacementEncodeCount:
        plan.availableReplacementEncodes.length -
        plan.replacementEncodes.length,
      failedOutputReservationReleaseEncodeJobIds:
        plan.availableReplacementEncodes
          .filter((replacement) =>
            replacement.releasesFailedOutputReservation
          )
          .map((replacement) => replacement.predecessorEncodeJobId),
    },
  };
}

export type RearchiveAcceptancePreview = ReturnType<
  typeof previewRearchiveAcceptance
>;

export function acceptRearchive(
  access: DataAccess,
  targetArchiveId: OriginalDiscArchiveId,
  command: RearchiveAcceptanceCommand,
  input: {
    mediaLibraryPath: string;
    mutationKey: unknown;
    acknowledgedRevision: unknown;
    acknowledgedSourceRevision: unknown;
    previewToken: unknown;
    acknowledge: unknown;
  },
) {
  const parsedCommand = validateAcceptanceCommand(
    command,
    input.mediaLibraryPath,
  );
  if (
    input.acknowledge !== true ||
    input.acknowledgedRevision !== command.catalogRevision ||
    input.acknowledgedSourceRevision !== command.sourceCatalogRevision ||
    !isRearchiveAcceptancePreviewToken(input.previewToken)
  ) {
    throw new DomainInvariantError(
      "Re-archive Acceptance preview acknowledgement is required",
    );
  }
  const result = access.catalog.acceptRearchive({
    targetArchiveId,
    ...parsedCommand,
    mutationKey: parseMutationKey(input.mutationKey),
    previewToken: input.previewToken,
  });
  return {
    message: "Re-archive accepted",
    sourceArchive: {
      id: result.sourceArchive.id,
      catalogReviewOutcome: result.sourceArchive.catalogReviewOutcome,
    },
    targetArchive: {
      id: result.targetArchive.id,
      catalogReviewedAt:
        result.targetArchive.catalogReviewedAt?.toISOString() ?? null,
      catalogReviewOutcome: result.targetArchive.catalogReviewOutcome,
    },
    createdDiscSelections: result.createdDiscSelections.map((created) => ({
      priorDiscSelectionId: created.priorDiscSelectionId,
      discSelection: {
        id: created.discSelection.id,
        originalDiscArchiveId: created.discSelection.originalDiscArchiveId,
        mediaItemId: created.discSelection.mediaItemId,
        sourceIdentity: created.discSelection.sourceIdentity,
        label: created.discSelection.label,
      },
    })),
    affectedEncodeJobs: result.affectedEncodeJobs.map((job) => ({
      id: job.id,
      discSelectionId: job.discSelectionId,
      status: job.status,
    })),
    ...(result.replacementEncodeJobs.length === 0
      ? {}
      : {
        replacementEncodeJobs: result.replacementEncodeJobs.map((job) => ({
          id: job.id,
          predecessorEncodeJobId: job.predecessorEncodeJobId,
          discSelectionId: job.discSelectionId,
          encodingProfileId: job.encodingProfileId,
          outputPath: job.outputPath,
          status: job.status,
          priority: job.priority,
          replaceExistingOutput: job.replaceExistingOutput,
        })),
      }),
  };
}
