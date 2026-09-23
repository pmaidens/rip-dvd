import {
  DomainInvariantError,
  RecordNotFoundError,
  StaleCatalogRevisionError,
  type ConsistentReadAccess,
  type CorrectedEncodeReplacementPlan,
  type DataAccess,
  type EncodeJobId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import type { CatalogReviewCommand } from "./catalog-review-command.js";
import { normalizeCorrectedEncodeReplacements } from "./corrected-encode-replacement.js";
import { parseMutationKey } from "./mutation-key.js";
import {
  createCatalogReviewCompletionPreviewToken,
  isCatalogReviewCompletionPreviewToken,
} from "./catalog-review-completion-preview-token.js";

export type CatalogReviewCompletionCommand = Extract<
  CatalogReviewCommand,
  { action: "complete_review" }
>;

function listAllCorrectedEncodeReplacementPlans(
  access: ConsistentReadAccess,
  archiveId: OriginalDiscArchiveId,
) {
  const replacements: CorrectedEncodeReplacementPlan[] = [];
  const limit = 100;
  for (let offset = 0;; offset += limit) {
    const page = access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archiveId,
      limit,
      offset,
    });
    replacements.push(...page);
    if (page.length < limit) return replacements;
  }
}

function planCatalogReviewCompletion(
  access: ConsistentReadAccess,
  archiveId: OriginalDiscArchiveId,
  command: CatalogReviewCompletionCommand,
  mediaLibraryPath: string,
) {
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [archiveId],
  })[0];
  if (!archive) {
    throw new RecordNotFoundError("original disc archive", archiveId);
  }
  if (archive.updatedAt.toISOString() !== command.catalogRevision) {
    throw new StaleCatalogRevisionError(
      "Catalog review changed; preview completion again",
    );
  }
  const availability = access.catalog.getCatalogReviewActionAvailability(
    archiveId,
  );
  const requestedAvailability = command.outcome === "archive_only"
    ? availability.completeArchiveOnly
    : availability.completeWithSelections;
  if (requestedAvailability.state !== "available") {
    throw new DomainInvariantError(requestedAvailability.reason);
  }
  if (
    command.outcome === "archive_only" && command.replacementEncodes.length > 0
  ) {
    throw new DomainInvariantError(
      "Archive-only Review cannot queue corrected replacement encodes",
    );
  }

  const predecessorIds = new Set<EncodeJobId>();
  const outputPaths = new Set<string>();
  const normalizedReplacements = normalizeCorrectedEncodeReplacements(
    command.replacementEncodes,
    mediaLibraryPath,
  );
  const replacementConsequences = [];
  for (const requested of normalizedReplacements) {
    if (predecessorIds.has(requested.predecessorEncodeJobId)) {
      throw new DomainInvariantError(
        "Corrected Encode replacement plan contains a duplicate predecessor",
      );
    }
    predecessorIds.add(requested.predecessorEncodeJobId);
    const planned = access.catalog.listCorrectedEncodeReplacementPlans({
      originalDiscArchiveId: archiveId,
      predecessorEncodeJobId: requested.predecessorEncodeJobId,
      limit: 1,
    })[0];
    if (!planned) {
      throw new DomainInvariantError(
        `Encode Job ${requested.predecessorEncodeJobId} is not available for corrected replacement`,
      );
    }
    const profile = access.encodingProfiles.list({
      ids: [requested.encodingProfileId],
    })[0];
    if (!profile) {
      throw new RecordNotFoundError(
        "encoding profile",
        requested.encodingProfileId,
      );
    }
    if (
      requested.encodingProfileId !== planned.proposedEncodingProfileId &&
      (!profile.isActive || profile.mediaDomain !== "dvd_video")
    ) {
      throw new DomainInvariantError(
        "Corrected replacement encodes require the prior or an active DVD video Encoding Profile",
      );
    }
    const outputPath = requested.outputPath;
    if (outputPaths.has(outputPath)) {
      throw new DomainInvariantError(
        `Corrected replacement output is selected more than once: ${outputPath}`,
      );
    }
    outputPaths.add(outputPath);
    if (access.encodeJobs.hasReservedOutputPathConflict({
      id: requested.predecessorEncodeJobId,
      outputPath,
    })) {
      throw new DomainInvariantError(
        `Encode Job output is already assigned: ${outputPath}`,
      );
    }
    const predecessor = access.encodeJobs.find(
      planned.predecessorEncodeJobId,
    );
    if (predecessor === null) {
      throw new RecordNotFoundError(
        "encode job",
        planned.predecessorEncodeJobId,
      );
    }
    replacementConsequences.push({
      ...requested,
      replacementDiscSelectionId: planned.replacementDiscSelectionId,
      predecessorStatus: planned.predecessorStatus,
      predecessorReady: planned.predecessorReady,
      replacesExistingOutput:
        outputPath === planned.proposedOutputPath &&
        (planned.predecessorStatus === "completed" ||
          predecessor.replaceExistingOutput),
    });
  }

  const availableReplacements = listAllCorrectedEncodeReplacementPlans(
    access,
    archiveId,
  );
  const expectedPreviewEvidence = JSON.stringify({
    replacementConsequences,
    availableReplacementPredecessorIds: availableReplacements.map(
      (replacement) => replacement.predecessorEncodeJobId,
    ),
    failedOutputReservationReleaseEncodeJobIds: availableReplacements
      .filter((replacement) => replacement.releasesFailedOutputReservation)
      .map((replacement) => replacement.predecessorEncodeJobId),
  });
  return {
    normalizedReplacements,
    expectedPreviewEvidence,
    preview: {
      state: "available" as const,
      archiveId,
      catalogRevision: command.catalogRevision,
      outcome: command.outcome,
      consequences: {
        completesCatalogReview: true,
        replacementEncodes: replacementConsequences,
        availableReplacementEncodeCount: availableReplacements.length,
        omittedReplacementEncodeCount: availableReplacements.filter(
          (replacement) =>
            !predecessorIds.has(replacement.predecessorEncodeJobId),
        ).length,
        failedOutputReservationReleaseEncodeJobIds: availableReplacements
          .filter((replacement) =>
            replacement.releasesFailedOutputReservation
          )
          .map((replacement) => replacement.predecessorEncodeJobId),
      },
    },
  };
}

export type CatalogReviewCompletionPreview = ReturnType<
  typeof previewCatalogReviewCompletion
>;

export function previewCatalogReviewCompletion(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  command: CatalogReviewCompletionCommand,
  mediaLibraryPath: string,
) {
  const plan = access.readConsistentSnapshot((snapshot) =>
    planCatalogReviewCompletion(
      snapshot,
      archiveId,
      command,
      mediaLibraryPath,
    )
  );
  const previewToken = createCatalogReviewCompletionPreviewToken();
  access.catalog.recordCatalogReviewCompletionPreviewDecision({
    previewToken,
    originalDiscArchiveId: archiveId,
    catalogRevision: new Date(command.catalogRevision),
    outcome: command.outcome,
    replacements: plan.normalizedReplacements,
    expectedPreviewEvidence: plan.expectedPreviewEvidence,
  });
  return { ...plan.preview, previewToken };
}

export function completeCatalogReview(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  command: CatalogReviewCompletionCommand,
  input: {
    mediaLibraryPath: string;
    mutationKey: unknown;
    acknowledgedRevision: unknown;
    previewToken: unknown;
    acknowledge: unknown;
  },
) {
  const mutationKey = parseMutationKey(input.mutationKey);
  if (
    input.acknowledge !== true ||
    input.acknowledgedRevision !== command.catalogRevision ||
    !isCatalogReviewCompletionPreviewToken(input.previewToken)
  ) {
    throw new DomainInvariantError(
      "Catalog Review completion preview acknowledgement is required",
    );
  }
  const normalizedReplacements = normalizeCorrectedEncodeReplacements(
    command.replacementEncodes,
    input.mediaLibraryPath,
  );
  const completion = access.catalog.completeCatalogReviewWithReplacements(
    archiveId,
    new Date(command.catalogRevision),
    command.outcome,
    normalizedReplacements,
    { mutationKey, previewToken: input.previewToken },
  );
  return {
    archive: {
      id: completion.archive.id,
      catalogReviewedAt:
        completion.archive.catalogReviewedAt?.toISOString() ?? null,
      catalogReviewOutcome: completion.archive.catalogReviewOutcome,
    },
    ...(completion.replacementEncodeJobs.length === 0
      ? {}
      : {
        replacementEncodeJobs: completion.replacementEncodeJobs.map(
          (job) => ({
            id: job.id,
            predecessorEncodeJobId: job.predecessorEncodeJobId,
            discSelectionId: job.discSelectionId,
            encodingProfileId: job.encodingProfileId,
            outputPath: job.outputPath,
            status: job.status,
            priority: job.priority,
            replaceExistingOutput: job.replaceExistingOutput,
          }),
        ),
      }),
  };
}
