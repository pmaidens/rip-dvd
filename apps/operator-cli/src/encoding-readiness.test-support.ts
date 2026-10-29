import { DatabaseSync } from "node:sqlite";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import type { DvdTitleDamageAssessmentItem, CommittedDvdCheckpointEvidence } from "@rip-dvd/data-access";
import { advanceCommittedArchiveEvidence, seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { seedDamagePreview } from "./damage-preview.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedEncodingReadiness(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  options: { clean?: boolean; partial?: boolean; mainFeature?: boolean; continuityRisk?: boolean; otherTitlePartial?: boolean } = {},
) {
  let evidence: { archive: Awaited<ReturnType<typeof seedCommittedArchiveEvidence>>["archive"]; manifest: CommittedDvdCheckpointEvidence } = await seedCommittedArchiveEvidence(fixture, options.clean ? [] : [
    { startLba: 10, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);
  if (options.continuityRisk) {
    const db = new DatabaseSync(fixture.databasePath);
    const source = db.prepare(`SELECT r.id AS recoveryId, r.attempt_id AS attemptId,
      j.disc_inspection_id AS inspectionId, j.detected_disc_id AS discId, i.media_generation AS generation
      FROM archive_recoveries r JOIN dvd_archive_evidence_headers h ON h.original_disc_archive_id = r.original_disc_archive_id
      JOIN archive_jobs j ON j.id = h.source_archive_job_id JOIN disc_inspections i ON i.id = j.disc_inspection_id
      WHERE r.original_disc_archive_id = ?`).get(evidence.archive.id)!;
    const verificationId = "synthetic-readiness-verification";
    const confirmationId = "synthetic-readiness-confirmation";
    db.prepare(`INSERT INTO dvd_disc_verifications (
      id, archive_recovery_id, archive_recovery_attempt_id, attempt_ordinal, original_disc_archive_id,
      disc_inspection_id, detected_disc_id, media_generation, source_metadata_fingerprint,
      observed_metadata_fingerprint, checkpoint_revision, checkpoint_digest, status, outcome, reasons,
      findings, budget_exhausted, worker_execution_id, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 'completed', 'mismatch', '[]', '[]', 0, 'synthetic-worker', 1, 1, 1)`)
      .run(verificationId, source.recoveryId, source.attemptId, evidence.archive.id,
        source.inspectionId, source.discId, source.generation, "a".repeat(64), "b".repeat(64), evidence.manifest.manifestDigest);
    db.prepare(`INSERT INTO dvd_disc_confirmations (
      id, archive_recovery_id, archive_recovery_attempt_id, original_disc_archive_id, verification_id,
      disc_inspection_id, detected_disc_id, media_generation, verification_worker_execution_id,
      verification_outcome, verification_result_digest, checkpoint_revision, checkpoint_digest,
      acknowledged_mixed_source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synthetic-worker', 'mismatch', ?, 1, ?, 1, 1)`)
      .run(confirmationId, source.recoveryId, source.attemptId, evidence.archive.id, verificationId,
        source.inspectionId, source.discId, source.generation, "c".repeat(64), evidence.manifest.manifestDigest);
    db.close();
    evidence = { ...evidence, manifest: advanceCommittedArchiveEvidence(fixture, evidence.manifest, {
      publishFilesystemCheckpoint: true, outcome: "recovered", verificationId, discConfirmationId: confirmationId,
    }) };
  }
  const seeded = await seedDamagePreview(fixture, "source_span", [[1000, 5000]], { evidence, otherTitlePartial: options.otherTitlePartial });
  const access = fixture.openAccess();
  if (!options.mainFeature) {
    const prior = access.catalog.listDiscSelections({ originalDiscArchiveId: seeded.archive.id })[0]!;
    const archive = access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!;
    access.catalog.correctDiscSelection(prior.id, {
      originalDiscArchiveId: archive.id, catalogRevision: archive.updatedAt,
      mediaItemId: prior.mediaItemId, sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      reason: "Bind synthetic concrete content.",
    });
  }
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
  const reassess = async (partial = options.partial ?? false) => access.assessDvdTitleDamage(seeded.archive.id, ownership, async () =>
    access.catalog.readDvdTitleIdentityReviewSet(seeded.archive.id)!.items.map(({ observation }) => ({
    titleIdentityObservationId: observation.id,
    sourceReferences: [{ kind: "multiplexed_content", startLba: 0, sectorCount: 100 }],
    mappingCoverage: { state: partial || observation.displayTitleNumber === 2 ? "partial" as const : "complete" as const, policyVersion: "synthetic-readiness-map-v1",
      unknownReasons: partial || observation.displayTitleNumber === 2 ? [{ code: "SYNTHETIC_UNKNOWN_IMPACT", message: "Synthetic partial source map." }] : [] },
    timingEvidence: seeded.assessment!.items[0]!.timingEvidence!,
  })));
  const assessment = await reassess();
  const selection = access.catalog.listDiscSelections({ originalDiscArchiveId: seeded.archive.id })[0]!;
  access.close();
  return { ...seeded, assessment, selection };
}

export function assessmentMappings(items: readonly DvdTitleDamageAssessmentItem[]) {
  return items.map((item) => ({
    titleIdentityObservationId: item.titleIdentityObservationId,
    sourceReferences: item.uniqueSourceRanges.map((range) => ({ kind: "multiplexed_content" as const, ...range })),
    mappingCoverage: item.mappingCoverage,
    timingEvidence: item.timingEvidence!,
  }));
}

export async function acceptReadinessContent(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  archiveId: string,
  mainFeatureResolutions: { discSelectionId: string; titleIdentityId: string }[] = [],
  mutationKey = "synthetic-readiness-acceptance",
) {
  const previewResult = await fixture.run(["catalog-review", "preview-damage-acceptance", archiveId,
    "--json", JSON.stringify({ excludedTitleIdentityIds: [], mainFeatureResolutions })]);
  const preview = previewResult.result as import("@rip-dvd/application").DvdTitleDamageAcceptancePreview;
  if (!preview.available) throw new Error(`Synthetic readiness acceptance preflight unavailable: ${JSON.stringify(preview)}`);
  return fixture.run(["catalog-review", "accept-damage", archiveId, "--key", mutationKey, "--json", JSON.stringify({
    operator: "Synthetic readiness operator", previewToken: preview.previewToken,
    checkpointRevision: preview.current!.checkpoint!.revision,
    checkpointDigest: preview.current!.checkpoint!.manifestDigest,
    assessmentIdentity: preview.assessmentIdentity, reviewSetIdentity: preview.reviewSetIdentity,
    catalogMappingProjectionId: preview.catalogMappingProjectionId, reviewedContentIdentity: preview.reviewedContentIdentity,
    excludedTitleIdentityIds: [], mainFeatureResolutions, damageAcknowledgement: true,
  })]);
}
