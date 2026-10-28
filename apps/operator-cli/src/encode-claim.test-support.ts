import { withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import { join } from "node:path";
import { createApplicationOperations, type EncodingReadiness } from "@rip-dvd/application";
import { openEncodeSourceTestAccess } from "./encode-source-decision.test-support.js";
import { acceptReadinessContent, seedEncodingReadiness } from "./encoding-readiness.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedEncodeClaim(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  options: Parameters<typeof seedEncodingReadiness>[1] = { clean: true },
) {
  const seeded = await seedEncodingReadiness(fixture, options);
  const access = openEncodeSourceTestAccess(fixture);
  access.catalog.completeCatalogReview(seeded.archive.id,
    access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  if (!options.clean || options.mainFeature || options.continuityRisk || options.otherTitlePartial) await acceptReadinessContent(fixture, seeded.archive.id,
    options.mainFeature ? [{ discSelectionId: seeded.selection.id, titleIdentityId: seeded.observation.titleIdentityId }] : []);
  const readiness = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  const expectedSourceDecision = readiness.selections[0]!.expectedSourceDecision;
  const job = await createApplicationOperations(access).enqueueEncodeJob({
    discSelectionId: seeded.selection.id, encodingProfileId: seeded.profile.id,
    outputPath: join(fixture.mediaLibraryPath, "synthetic-claim.mkv"),
    mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath,
    expectedSourceDecision, mutationKey: "synthetic-claim-enqueue",
  });
  return { ...seeded, access, job, expectedSourceDecision };
}

export async function withdrawClaimAcceptance(fixture: ReturnType<typeof createOperatorWorkflowFixture>, archiveId: string, acceptedDecisionId: string) {
  const preview = (await fixture.run(["catalog-review", "preview-withdrawal", archiveId,
    "--accepted-decision-id", acceptedDecisionId])).result as { previewToken: string };
  const withdrawn = await fixture.run(["catalog-review", "withdraw-damage", archiveId, "--key", "synthetic-claim-withdrawal",
    "--json", JSON.stringify({ operator: "Synthetic operator", acceptedDecisionId, previewToken: preview.previewToken })]);
  if (withdrawn.exitCode !== 0) throw new Error("Synthetic claim withdrawal failed");
}

/** Inject a concurrent Recovery projection without relaxing reader assertions. */
export function injectClaimRecoveryState(fixture: ReturnType<typeof createOperatorWorkflowFixture>, archiveId: string, state: string) {
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => {
    db.prepare(`UPDATE archive_recoveries SET status = ?, stopped_at = NULL,
      stop_operation_id = CASE WHEN ? = 'stopping' THEN COALESCE(stop_operation_id, 'synthetic-stop') ELSE NULL END,
      stop_requested_at = CASE WHEN ? = 'stopping' THEN COALESCE(stop_requested_at, 1) ELSE NULL END,
      pause_reason = CASE WHEN ? = 'paused' THEN 'no_progress' ELSE NULL END,
      fault_code = CASE WHEN ? = 'faulted' THEN 'CONSISTENCY_FAULT' ELSE NULL END
      WHERE original_disc_archive_id = ?`).run(state, state, state, state, state, archiveId);
  });
}
