import {
  DomainInvariantError,
  rearchiveAcceptancePreviewEvidence,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import type { CatalogReviewCommand } from "./catalog-review-command.js";
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

function validateAcceptanceCommand(command: RearchiveAcceptanceCommand) {
  const replacementEncodes = (command as unknown as {
    replacementEncodes?: unknown;
  }).replacementEncodes;
  if (
    replacementEncodes !== undefined &&
    (!Array.isArray(replacementEncodes) || replacementEncodes.length !== 0)
  ) {
    throw new DomainInvariantError(
      "Re-archive replacement encodes are not supported yet",
    );
  }
  return {
    catalogRevision: revision(command.catalogRevision, "Catalog revision"),
    sourceCatalogRevision: revision(
      command.sourceCatalogRevision,
      "Source Catalog revision",
    ),
  };
}

export function previewRearchiveAcceptance(
  access: DataAccess,
  targetArchiveId: OriginalDiscArchiveId,
  command: RearchiveAcceptanceCommand,
) {
  const input = { targetArchiveId, ...validateAcceptanceCommand(command) };
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
      replacementEncodeCount: 0,
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
    mutationKey: unknown;
    acknowledgedRevision: unknown;
    acknowledgedSourceRevision: unknown;
    previewToken: unknown;
    acknowledge: unknown;
  },
) {
  const parsedRevisions = validateAcceptanceCommand(command);
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
    ...parsedRevisions,
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
  };
}
