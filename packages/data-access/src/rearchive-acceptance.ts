import type { RearchiveAcceptancePlan } from "./types.js";

export function rearchiveAcceptancePreviewEvidence(
  plan: RearchiveAcceptancePlan,
): string {
  return JSON.stringify({
    targetArchiveId: plan.targetArchiveId,
    sourceArchiveId: plan.sourceArchiveId,
    catalogRevision: plan.catalogRevision,
    sourceCatalogRevision: plan.sourceCatalogRevision,
    mappings: plan.mappings,
    affectedEncodeJobs: plan.affectedEncodeJobs.map((job) => ({
      id: job.id,
      discSelectionId: job.discSelectionId,
      status: job.status,
      updatedAt: job.updatedAt.toISOString(),
    })),
    replacementEncodes: plan.replacementEncodes,
    availableReplacementEncodes: plan.availableReplacementEncodes,
  });
}
