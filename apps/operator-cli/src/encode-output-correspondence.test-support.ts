import { join } from "node:path";
import { createApplicationOperations, claimNextEncodeJob, type EncodingReadiness, type DvdTitleDamageAcceptancePreview } from "@rip-dvd/application";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { seedCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { seedDamagePreview } from "./damage-preview.test-support.js";
import { openEncodeSourceTestAccess } from "./encode-source-decision.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

/** Two recorded playback paths. The selected path uses sectors 0..99; the
 * omitted path uses sectors 200..299, including the unresolved sector 210. */
export async function seedCorrespondenceClaim(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  options: { chapters?: boolean; partialOmittedMap?: boolean; sharedSource?: boolean; overlappingPath?: boolean } = {},
) {
  const omittedRange = { startLba: options.sharedSource ? 0 : options.overlappingPath ? 50 : 200,
    sectorCount: options.overlappingPath ? 250 : 100 };
  const evidence = await seedCommittedArchiveEvidence(fixture, [
    { startLba: options.sharedSource ? 10 : 210, sectorCount: 1, classification: "skipped_untested" },
  ], false, true);
  const seeded = await seedDamagePreview(fixture, "source_span", [[1000, 5000]], { evidence,
    additionalTitleObservations: [{ displayTitleNumber: 2,
      navigation: { videoTitleSetNumber: 2, titleSetTitleNumber: 1, programChainNumber: 1 },
      selectedPath: [{ programNumber: 1, cellNumber: 1, vobId: 2, cellId: 1 }],
      angleNumber: 1, angleCount: 1, chapterStart: 1, chapterEnd: 4, chapterCount: 4,
      sourceExtents: [omittedRange],
    }],
  });
  const access = openEncodeSourceTestAccess(fixture);
  try {
    const review = access.catalog.readDvdTitleIdentityReviewSet(seeded.archive.id)!;
    const active = access.catalog.listDiscSelections({ originalDiscArchiveId: seeded.archive.id })[0]!;
    access.catalog.correctDiscSelection(active.id, {
      originalDiscArchiveId: seeded.archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt,
      mediaItemId: active.mediaItemId,
      sourceIdentity: options.chapters ? { kind: "dvd_chapters", titleNumber: 1, chapterStart: 2, chapterEnd: 3 }
        : { kind: "dvd_title", titleNumber: 1 },
      reason: "Select a synthetic concrete playback path.",
    });
    const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
    const assessment = (await access.assessDvdTitleDamage(seeded.archive.id, ownership, async () => review.items.map((item) => {
      const omitted = item.observation.displayTitleNumber === 2;
      const sourceRange = item.observation.sourceExtents[0]!;
      return {
        titleIdentityObservationId: item.observation.id,
        sourceReferences: [{ kind: "multiplexed_content" as const,
          ...sourceRange }],
        mappingCoverage: { state: omitted && options.partialOmittedMap ? "partial" as const : "complete" as const,
          policyVersion: "synthetic-correspondence-map-v1",
          unknownReasons: omitted && options.partialOmittedMap ? [{ code: "SYNTHETIC_PARTIAL_MAP", message: "Synthetic incomplete omitted path map." }] : [] },
        timingEvidence: { policyVersion: "dvd-title-damage-timing-v1" as const,
          occurrences: [{ playbackOccurrence: 1, spans: [{ sourceRange: { ...sourceRange },
            startMilliseconds: 1000, endMilliseconds: 5000, timingMethod: "synthetic-source-time-v1", coverage: options.overlappingPath ? "whole_cell" as const : "source_span" as const }], unknownReasons: [] }],
        },
      };
    })))!;
    access.catalog.completeCatalogReview(seeded.archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
    const excludedTitleIdentityIds = [review.items.find((item) => item.observation.displayTitleNumber === 2)!.titleIdentityId];
    const preview = (await fixture.run(["catalog-review", "preview-damage-acceptance", seeded.archive.id,
      "--json", JSON.stringify({ excludedTitleIdentityIds, mainFeatureResolutions: [] })])).result as DvdTitleDamageAcceptancePreview;
    if (!preview.available) throw new Error("Synthetic correspondence source acceptance is unavailable");
    const accepted = await fixture.run(["catalog-review", "accept-damage", seeded.archive.id, "--key", "synthetic-correspondence-acceptance",
      "--json", JSON.stringify({ operator: "Synthetic operator", previewToken: preview.previewToken,
        checkpointRevision: preview.current!.checkpoint!.revision, checkpointDigest: preview.current!.checkpoint!.manifestDigest,
        assessmentIdentity: preview.assessmentIdentity, reviewSetIdentity: preview.reviewSetIdentity,
        catalogMappingProjectionId: preview.catalogMappingProjectionId, reviewedContentIdentity: preview.reviewedContentIdentity,
        excludedTitleIdentityIds, mainFeatureResolutions: [], damageAcknowledgement: true })]);
    if (accepted.exitCode !== 0) throw new Error("Synthetic correspondence source acceptance failed");
    const readiness = (await createApplicationOperations(access, { archiveImageOwnership: ownership })
      .inspectEncodingReadiness(seeded.archive.id, fixture.originalsLibraryPath)) as EncodingReadiness;
    const selection = access.catalog.listDiscSelections({ originalDiscArchiveId: seeded.archive.id })[0]!;
    const job = await createApplicationOperations(access).enqueueEncodeJob({
      discSelectionId: selection.id, encodingProfileId: seeded.profile.id,
      outputPath: join(fixture.mediaLibraryPath, "synthetic-correspondence.mkv"),
      mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath,
      expectedSourceDecision: readiness.selections[0]!.expectedSourceDecision, mutationKey: "synthetic-correspondence-enqueue",
    });
    const claim = (await claimNextEncodeJob(access, "synthetic-correspondence-worker", fixture.originalsLibraryPath, ownership))!;
    if (claim?.id !== job.id) throw new Error("Synthetic correspondence output was not claimed");
    return { access, claim, assessment, selection, archive: seeded.archive,
      omitted: review.items.find((item) => item.observation.displayTitleNumber === 2)!.observation };
  } catch (error) { access.close(); throw error; }
}
