import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import {
  createDvdTitleDamageAssessment,
  type CommittedDvdCheckpointEvidence,
  type DvdCheckpointReadOwnership,
} from "@rip-dvd/data-access";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";

import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
} from "./archive-evidence.test-support.js";
import {
  createOperatorWorkflowFixture,
} from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  vi.useRealTimers();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

it("pages revision-bound Title Damage evidence through the public JSON CLI", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedCommittedArchiveEvidence(fixture, [
    {
      startLba: 15,
      sectorCount: 5,
      classification: "skipped_untested",
    },
    {
      startLba: 205,
      sectorCount: 2,
      classification: "skipped_untested",
    },
    {
      startLba: 400,
      sectorCount: 1,
      classification: "skipped_untested",
    },
  ], false, true);
  const { archive } = seeded;
  let manifest: CommittedDvdCheckpointEvidence = seeded.manifest;
  const verificationId = "synthetic-title-damage-verification";
  const confirmationId = "synthetic-title-damage-confirmation";
  const sourceSqlite = new DatabaseSync(fixture.databasePath);
  const source = sourceSqlite.prepare(`
    SELECT
      recoveries.id AS recoveryId,
      recoveries.attempt_id AS attemptId,
      jobs.disc_inspection_id AS discInspectionId,
      jobs.detected_disc_id AS detectedDiscId,
      inspections.media_generation AS mediaGeneration
    FROM archive_recoveries recoveries
    INNER JOIN dvd_archive_evidence_headers headers
      ON headers.original_disc_archive_id = recoveries.original_disc_archive_id
    INNER JOIN archive_jobs jobs
      ON jobs.id = headers.source_archive_job_id
    INNER JOIN disc_inspections inspections
      ON inspections.id = jobs.disc_inspection_id
    WHERE recoveries.original_disc_archive_id = ?
  `).get(archive.id) as {
    recoveryId: string;
    attemptId: string;
    discInspectionId: string;
    detectedDiscId: string;
    mediaGeneration: string;
  };
  sourceSqlite.prepare(`
    INSERT INTO dvd_disc_verifications (
      id, archive_recovery_id, archive_recovery_attempt_id, attempt_ordinal,
      original_disc_archive_id, disc_inspection_id, detected_disc_id,
      media_generation, source_metadata_fingerprint,
      observed_metadata_fingerprint, checkpoint_revision, checkpoint_digest,
      status, outcome, reasons, findings, budget_exhausted,
      worker_execution_id, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 'completed', 'mismatch',
      ?, '[]', 0, ?, 1, 1, 1)
  `).run(
    verificationId,
    source.recoveryId,
    source.attemptId,
    archive.id,
    source.discInspectionId,
    source.detectedDiscId,
    source.mediaGeneration,
    "a".repeat(64),
    "b".repeat(64),
    manifest.manifestDigest,
    JSON.stringify(["DISC_SAMPLE_MISMATCH"]),
    "synthetic-title-damage-verification-worker",
  );
  sourceSqlite.prepare(`
    INSERT INTO dvd_disc_confirmations (
      id, archive_recovery_id, archive_recovery_attempt_id,
      original_disc_archive_id, verification_id, disc_inspection_id,
      detected_disc_id, media_generation, verification_worker_execution_id,
      verification_outcome, verification_result_digest, checkpoint_revision,
      checkpoint_digest, acknowledged_mixed_source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mismatch', ?, 1, ?, 1, 1)
  `).run(
    confirmationId,
    source.recoveryId,
    source.attemptId,
    archive.id,
    verificationId,
    source.discInspectionId,
    source.detectedDiscId,
    source.mediaGeneration,
    "synthetic-title-damage-verification-worker",
    "c".repeat(64),
    manifest.manifestDigest,
  );
  sourceSqlite.close();
  manifest = advanceCommittedArchiveEvidence(fixture, manifest, {
    publishFilesystemCheckpoint: true,
    outcome: "recovered",
    sourceRangeIndex: 0,
    verificationId,
    discConfirmationId: confirmationId,
  });
  manifest = advanceCommittedArchiveEvidence(fixture, manifest, {
    publishFilesystemCheckpoint: true,
    outcome: "recovered",
    sourceRangeIndex: 2,
    verificationId,
    discConfirmationId: confirmationId,
  });
  const access = fixture.openAccess();
  const structuralResult = await access.assessDvdStructure(
    archive.id,
    createArchiveImageOwnership({
      authorityRootPath: fixture.originalsLibraryPath,
    }),
    async () => ({
      outcome: "completed" as const,
      findings: [
        {
          checkKind: "filesystem_structure" as const,
          policyVersion: "synthetic-filesystem-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 1_000,
            observedSectorCount: 50,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: "synthetic:filesystem",
        },
        {
          checkKind: "dvd_navigation" as const,
          policyVersion: "synthetic-navigation-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 250,
            observedSectorCount: 25,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: "synthetic:navigation",
        },
        {
          checkKind: "title_enumeration" as const,
          policyVersion: "synthetic-titles-v1",
          testedExtent: {
            startLba: 0,
            endLbaExclusive: 250,
            observedSectorCount: 25,
          },
          outcome: "valid" as const,
          reason: null,
          evidenceReference: "synthetic:titles",
        },
      ],
    }),
  );
  if (structuralResult?.outcome !== "completed") {
    throw new Error("Expected a completed Structural Assessment");
  }
  const header = access.catalog.findDvdArchiveEvidenceHeader(archive.id)!;
  const reviewSet = access.catalog.recordDvdTitleIdentityObservations({
    originalDiscArchiveId: archive.id,
    checkpoint: {
      manifestId: header.currentManifestId,
      manifestRevision: header.currentManifestRevision,
      manifestDigest: header.currentManifestDigest,
    },
    observations: [
      {
        displayTitleNumber: 1,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 1,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 4,
        chapterCount: 4,
        sourceExtents: [{ startLba: 0, sectorCount: 110 }],
      },
      {
        displayTitleNumber: 2,
        navigation: {
          videoTitleSetNumber: 1,
          titleSetTitleNumber: 2,
          programChainNumber: 2,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 1,
          cellId: 2,
        }],
        angleNumber: 1,
        angleCount: 1,
        chapterStart: 1,
        chapterEnd: 2,
        chapterCount: 2,
        sourceExtents: [{ startLba: 0, sectorCount: 60 }],
      },
      {
        displayTitleNumber: 3,
        navigation: {
          videoTitleSetNumber: 2,
          titleSetTitleNumber: 1,
          programChainNumber: 1,
        },
        selectedPath: [{
          programNumber: 1,
          cellNumber: 1,
          vobId: 2,
          cellId: 1,
        }],
        angleNumber: 2,
        angleCount: 2,
        chapterStart: 2,
        chapterEnd: 3,
        chapterCount: 3,
        sourceExtents: [{ startLba: 200, sectorCount: 2 }],
      },
    ],
  });
  const currentItems = reviewSet.items.filter((item) =>
    item.presentAtCurrentCheckpoint
  );
  const mappings = [
    {
      titleIdentityObservationId: currentItems[0]!.observation.id,
      sourceReferences: [
        { kind: "navigation", startLba: 0, sectorCount: 10 },
        {
          kind: "multiplexed_content",
          startLba: 10,
          sectorCount: 100,
        },
        {
          kind: "multiplexed_content",
          startLba: 10,
          sectorCount: 100,
        },
      ],
      mappingCoverage: {
        state: "complete",
        policyVersion: "synthetic-title-map-v1",
        unknownReasons: [],
      },
      timingEvidence: {
        policyVersion: "dvd-title-damage-timing-v1",
        occurrences: [
          {
            playbackOccurrence: 1,
            spans: [{
              sourceRange: { startLba: 0, sectorCount: 110 },
              startMilliseconds: 1_000,
              endMilliseconds: 5_000,
              timingMethod: "synthetic-vobu-timing-v1",
              coverage: "source_span",
            }],
            unknownReasons: [],
          },
          {
            playbackOccurrence: 2,
            spans: [],
            unknownReasons: [{
              code: "TIMING_UNAVAILABLE",
              message: "No trustworthy timing evidence places this occurrence.",
            }],
          },
        ],
      },
    },
    {
      titleIdentityObservationId: currentItems[1]!.observation.id,
      sourceReferences: [
        { kind: "navigation", startLba: 0, sectorCount: 10 },
        {
          kind: "multiplexed_content",
          startLba: 10,
          sectorCount: 50,
        },
      ],
      mappingCoverage: {
        state: "complete",
        policyVersion: "synthetic-title-map-v1",
        unknownReasons: [],
      },
      timingEvidence: {
        policyVersion: "dvd-title-damage-timing-v1",
        occurrences: [{
          playbackOccurrence: 1,
          spans: [{
            sourceRange: { startLba: 0, sectorCount: 60 },
            startMilliseconds: 0,
            endMilliseconds: 12_000,
            timingMethod: "synthetic-cell-timing-v1",
            coverage: "whole_cell",
          }],
          unknownReasons: [],
        }],
      },
    },
    {
      titleIdentityObservationId: currentItems[2]!.observation.id,
      sourceReferences: [{
        kind: "multiplexed_content",
        startLba: 200,
        sectorCount: 2,
      }],
      mappingCoverage: {
        state: "partial",
        policyVersion: "synthetic-title-map-v1",
        unknownReasons: [{
          code: "TITLE_SOURCE_MAP_INCOMPLETE",
          message: "The selected path has unresolved navigation.",
        }],
      },
      timingEvidence: {
        policyVersion: "dvd-title-damage-timing-v1",
        occurrences: [{
          playbackOccurrence: 1,
          spans: [],
          unknownReasons: [{
            code: "TIMING_UNAVAILABLE",
            message: "Playback timing is unavailable for this path.",
          }],
        }],
      },
    },
  ] as const;
  const ownership = createArchiveImageOwnership({
    authorityRootPath: fixture.originalsLibraryPath,
  });
  const recorded = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async ({ titleIdentity, structuralAssessmentIdentity }, handle) => {
      handle.assertOwned();
      expect(titleIdentity.reviewSetIdentity).toBe(
        reviewSet.reviewSetIdentity,
      );
      expect(structuralAssessmentIdentity).toBe(
        structuralResult.assessment.id,
      );
      return mappings;
    },
  );
  if (recorded === null) {
    throw new Error("Expected a recorded Title Damage Assessment");
  }
  const migratedAssessment = createDvdTitleDamageAssessment({
    checkpoint: recorded.checkpoint,
    titleIdentityReviewSetIdentity:
      recorded.titleIdentityReviewSetIdentity,
    catalogMappingProjectionId: null,
    structuralAssessmentIdentity: recorded.structuralAssessmentIdentity,
    structuralFindings: recorded.structuralFindings,
    unrecoveredSourceRanges: header.unrecoveredSourceRanges,
    sourceContinuity: null,
    titles: recorded.items.map((item) => ({
      titleIdentityId: item.titleIdentityId,
      titleIdentityObservationId: item.titleIdentityObservationId,
      displayTitleNumber: item.displayTitleNumber,
      selection: item.selection,
      sourceReferences: item.uniqueSourceRanges.map((range) => ({
        kind: "multiplexed_content" as const,
        ...range,
      })),
      mappingCoverage: item.mappingCoverage,
      timingEvidence: null,
    })),
  });
  expect(migratedAssessment.id).not.toBe(recorded.id);
  const migratedSqlite = new DatabaseSync(fixture.databasePath);
  migratedSqlite.prepare(`
    INSERT INTO dvd_title_damage_assessments (
      id, original_disc_archive_id, manifest_id, manifest_revision,
      manifest_digest, accepted_end_lba_exclusive,
      title_identity_review_set_identity,
      catalog_mapping_projection_id, structural_assessment_identity,
      policy_version, title_mappings, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    migratedAssessment.id,
    archive.id,
    recorded.checkpoint.manifestId,
    recorded.checkpoint.manifestRevision,
    recorded.checkpoint.manifestDigest,
    recorded.checkpoint.acceptedEndLbaExclusive,
    recorded.titleIdentityReviewSetIdentity,
    recorded.structuralAssessmentIdentity,
    recorded.policyVersion,
    JSON.stringify(mappings.map((mapping) => {
      const { timingEvidence: _timingEvidence, ...legacy } = mapping;
      return legacy;
    })),
    recorded.createdAt.getTime(),
  );
  migratedSqlite.prepare(`
    INSERT INTO dvd_title_damage_assessment_attempts (
      original_disc_archive_id, assessment_id, created_at
    ) VALUES (?, ?, ?)
  `).run(archive.id, migratedAssessment.id, recorded.createdAt.getTime());
  migratedSqlite.close();
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "outdated",
    currentAssessmentIdentity: null,
    assessment: { id: migratedAssessment.id },
  });
  const repeated = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => recorded.items.map((item) => ({
      titleIdentityObservationId: item.titleIdentityObservationId,
      sourceReferences: item.uniqueSourceRanges.map((range) => ({
        kind: "multiplexed_content" as const,
        ...range,
      })),
      mappingCoverage: item.mappingCoverage,
      timingEvidence: item.timingEvidence!,
    })),
  );
  expect(repeated?.id).toBe(recorded.id);

  const review = await fixture.run(["catalog-review", "show", archive.id]);
  expect(review).toMatchObject({
    exitCode: 0,
    result: {
      titleDamage: {
        state: "current",
        checkpointRevision: 3,
        assessmentIdentity: recorded.id,
        currentAssessmentIdentity: recorded.id,
        items: [
          { displayTitleNumber: 1 },
          { displayTitleNumber: 2 },
          { displayTitleNumber: 3 },
        ],
        truncated: false,
      },
    },
  });

  const first = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--limit",
    "1",
  ]);
  expect(first.exitCode).toBe(0);
  expect(first.result).toMatchObject({
    state: "current",
    checkpointRevision: 3,
    assessmentIdentity: recorded.id,
    items: [{
      displayTitleNumber: 1,
      uniqueSourceSectorCount: 110,
      unrecoveredUniqueSourceSectorCount: 4,
      titleMissingSourcePercentage: 4 / 110 * 100,
      sourceContinuityRiskSectorCount: 1,
      estimatedAffectedPlayback: {
        intervals: [{
          playbackOccurrence: 1,
          startMilliseconds: 1_000,
          endMilliseconds: 5_000,
          timingMethods: ["synthetic-vobu-timing-v1"],
          coverage: "source_span",
        }],
        unknownCoverage: [{
          playbackOccurrence: 2,
          unrecoveredSourceSectorCount: 4,
          reasons: [{ code: "TIMING_UNAVAILABLE" }],
        }],
      },
    }],
    truncated: true,
    nextCursor: expect.any(String),
    unknownTitleImpact: {
      unrecoveredSourceSectorCount: 2,
    },
    sourceContinuity: {
      policyVersion: "dvd-title-source-continuity-v1",
      sourceContinuityRiskSectorCount: 2,
      provenance: [{
        discConfirmationId: confirmationId,
        verificationOutcome: "mismatch",
      }],
    },
    unattributedSourceContinuityRisk: {
      sourceSectorCount: 1,
    },
  });
  const cursor = (first.result as { nextCursor: string }).nextCursor;
  const second = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--limit",
    "2",
    "--cursor",
    cursor,
  ]);
  expect(second).toMatchObject({
    exitCode: 0,
    result: {
      checkpointRevision: 3,
      itemOffset: 1,
      items: [
        { displayTitleNumber: 2 },
        {
          displayTitleNumber: 3,
          uniqueSourceSectorCount: null,
          titleMissingSourcePercentage: null,
        },
      ],
      truncated: false,
      nextCursor: null,
    },
  });

  const mediaItem = access.catalog.createMediaItem({
    kind: "movie",
    title: "Synthetic remapped damage",
  });
  const catalogRevision = access.catalog.listOriginalDiscArchives({
    ids: [archive.id],
  })[0]!.updatedAt;
  const mappedSelection = access.catalog.mutateDiscSelection({
    originalDiscArchiveId: archive.id,
    expectedCatalogRevision: catalogRevision,
    mutationKey: "synthetic-title-damage-remapping",
    mutation: {
      action: "create",
      selection: {
        originalDiscArchiveId: archive.id,
        mediaItemId: mediaItem.id,
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    },
  }).discSelection;
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "outdated",
    currentAssessmentIdentity: null,
    assessment: { id: recorded.id },
  });
  const remapped = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => mappings,
  );
  if (remapped === null) {
    throw new Error("Expected Title Damage Assessment after remapping");
  }
  expect(remapped.id).not.toBe(recorded.id);
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "current",
    currentAssessmentIdentity: remapped.id,
    assessment: { id: remapped.id },
  });
  const remappedProjection = access.catalog
    .readDvdCatalogReviewWorkflowEvidence([{
      originalDiscArchiveId: archive.id,
      evidenceHeader: header,
    }]).get(archive.id)!.titleIdentity!.catalogMappingProjectionId;
  const remappedRevision = access.catalog.listOriginalDiscArchives({
    ids: [archive.id],
  })[0]!.updatedAt;
  const chapterMappedSelection = access.catalog.mutateDiscSelection({
    originalDiscArchiveId: archive.id,
    expectedCatalogRevision: remappedRevision,
    mutationKey: "synthetic-title-damage-chapter-remapping",
    mutation: {
      action: "update",
      discSelectionId: mappedSelection.id,
      changes: {
        originalDiscArchiveId: archive.id,
        sourceIdentity: {
          kind: "dvd_chapters",
          titleNumber: 1,
          chapterStart: 1,
          chapterEnd: 2,
        },
      },
    },
  }).discSelection;
  expect(chapterMappedSelection.sourceIdentity).toEqual({
    kind: "dvd_chapters",
    titleNumber: 1,
    chapterStart: 1,
    chapterEnd: 2,
  });
  const chapterRemappedWorkflow = access.catalog
    .readDvdCatalogReviewWorkflowEvidence([{
      originalDiscArchiveId: archive.id,
      evidenceHeader: header,
    }]).get(archive.id)!;
  expect(chapterRemappedWorkflow.titleIdentity?.catalogMappingProjectionId)
    .not.toBe(remappedProjection);
  expect(chapterRemappedWorkflow.titleDamage).toEqual({
    state: "outdated",
    currentAssessmentIdentity: null,
    acceptanceRequired: false,
  });
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "outdated",
    currentAssessmentIdentity: null,
    assessment: { id: remapped.id },
  });
  const chapterRemapped = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => mappings,
  );
  if (chapterRemapped === null) {
    throw new Error("Expected Title Damage Assessment after chapter remapping");
  }
  expect(chapterRemapped.id).not.toBe(remapped.id);
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "current",
    currentAssessmentIdentity: chapterRemapped.id,
    assessment: { id: chapterRemapped.id },
  });

  const stableRecoverySqlite = new DatabaseSync(fixture.databasePath);
  stableRecoverySqlite.prepare(`
    UPDATE archive_recoveries
    SET status = 'stopped', stop_operation_id = 'synthetic-stop',
        stop_requested_at = 3, stopped_at = 4, updated_at = 4
    WHERE original_disc_archive_id = ?
  `).run(archive.id);
  stableRecoverySqlite.close();
  const completePreflight = await fixture.run([
    "catalog-review",
    "preview-damage-acceptance",
    archive.id,
  ]);
  expect(completePreflight).toMatchObject({
    exitCode: 0,
    result: {
      available: false,
      previewToken: null,
      action: {
        available: false,
        reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
      },
      allContent: [
        { titleIdentityId: currentItems[0]!.titleIdentityId, included: true },
        { titleIdentityId: currentItems[1]!.titleIdentityId, included: true },
        { titleIdentityId: currentItems[2]!.titleIdentityId, included: true },
      ],
      exclusions: [],
    },
  });
  const exactPreflight = await fixture.run([
    "catalog-review",
    "preview-damage-acceptance",
    archive.id,
    "--exclude-title-identity",
    currentItems[1]!.titleIdentityId,
    "--exclude-title-identity",
    currentItems[2]!.titleIdentityId,
  ]);
  expect(exactPreflight).toMatchObject({
    exitCode: 0,
    result: {
      available: true,
      previewToken: expect.stringMatching(
        /^dvd-damage-acceptance-preview:/,
      ),
      assessmentIdentity: chapterRemapped.id,
      reviewSetIdentity: expect.any(String),
      catalogMappingProjectionId: expect.any(String),
      reviewedContentIdentity: expect.any(String),
      acknowledgementRequired: true,
      reviewedContent: [{
        titleIdentityId: currentItems[0]!.titleIdentityId,
        sourceIdentity: {
          displayTitleNumber: 1,
          angleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
        catalogMappings: [{
          discSelectionId: mappedSelection.id,
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 1,
            chapterStart: 1,
            chapterEnd: 2,
          },
          mediaItem: {
            kind: "movie",
            title: "Synthetic remapped damage",
          },
        }],
        assessmentSnapshot: {
          unrecoveredUniqueSourceSectorCount: 4,
          sourceContinuityRiskSectorCount: 1,
        },
      }],
      exclusions: [
        { titleIdentityId: currentItems[1]!.titleIdentityId },
        { titleIdentityId: currentItems[2]!.titleIdentityId },
      ],
      affectedWork: [],
      damagePreview: {
        required: false,
        available: false,
      },
    },
  });
  const previewLedger = new DatabaseSync(fixture.databasePath);
  expect(previewLedger.prepare(`
    SELECT operation, outcome
    FROM mutation_invocations
    WHERE operation = 'dvd_damage_acceptance.preview'
  `).all()).toEqual([{
    operation: "dvd_damage_acceptance.preview",
    outcome: expect.stringContaining("expectedPreviewEvidence"),
  }]);
  previewLedger.close();

  const laterRecorded = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => mappings.map((mapping, index) => index === 0
      ? {
        ...mapping,
        mappingCoverage: {
          ...mapping.mappingCoverage,
          policyVersion: "synthetic-title-map-v2",
        },
      }
      : mapping),
  );
  if (laterRecorded === null) {
    throw new Error("Expected a later Title Damage Assessment");
  }
  expect(laterRecorded.createdAt).toEqual(recorded.createdAt);
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "current",
    currentAssessmentIdentity: laterRecorded.id,
    assessment: { id: laterRecorded.id },
  });

  const restored = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => mappings,
  );
  if (restored === null) {
    throw new Error("Expected a restored Title Damage Assessment");
  }
  expect(restored.id).toBe(chapterRemapped.id);
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "current",
    currentAssessmentIdentity: chapterRemapped.id,
    assessment: { id: chapterRemapped.id },
  });
  const sqlite = new DatabaseSync(fixture.databasePath);
  expect(sqlite.prepare(`
    SELECT assessment_id AS assessmentId
    FROM dvd_title_damage_assessment_attempts
    ORDER BY sequence
  `).all()).toEqual([
    { assessmentId: recorded.id },
    { assessmentId: migratedAssessment.id },
    { assessmentId: recorded.id },
    { assessmentId: remapped.id },
    { assessmentId: chapterRemapped.id },
    { assessmentId: laterRecorded.id },
    { assessmentId: chapterRemapped.id },
  ]);
  expect(sqlite.prepare(`
    SELECT count(*) AS count
    FROM dvd_title_damage_assessments
  `).get()).toEqual({ count: 5 });
  sqlite.close();

  let newerStructuralAssessmentIdentity: string | null = null;
  const racingOwnership: DvdCheckpointReadOwnership = {
    async withConsistentRead(request) {
      return ownership.withConsistentRead({
        ...request,
        task: async (handle) => {
          const prepared = await request.task(handle);
          const newerStructural = await access.assessDvdStructure(
            archive.id,
            ownership,
            async () => ({
              outcome: "completed" as const,
              findings: structuralResult.assessment.findings.map(
                (finding, index) => ({
                  ...finding,
                  evidenceReference: `synthetic:replacement-${index}`,
                }),
              ),
            }),
          );
          if (newerStructural?.outcome !== "completed") {
            throw new Error("Expected a replacement Structural Assessment");
          }
          newerStructuralAssessmentIdentity = newerStructural.assessment.id;
          return prepared;
        },
      });
    },
  };
  await expect(access.assessDvdTitleDamage(
    archive.id,
    racingOwnership,
    async () => mappings,
  )).rejects.toThrow(
    "Title Damage Assessment evidence changed before persistence",
  );
  expect(newerStructuralAssessmentIdentity).not.toBe(
    structuralResult.assessment.id,
  );
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "outdated",
    currentAssessmentIdentity: null,
    assessment: { id: chapterRemapped.id },
  });
  const dependencyCycleLatest = await access.assessDvdTitleDamage(
    archive.id,
    ownership,
    async () => mappings,
  );
  if (dependencyCycleLatest === null) {
    throw new Error(
      "Expected Title Damage Assessment for replacement structure",
    );
  }
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "current",
    currentAssessmentIdentity: dependencyCycleLatest.id,
    assessment: { id: dependencyCycleLatest.id },
  });
  const restoredStructural = await access.assessDvdStructure(
    archive.id,
    ownership,
    async () => ({
      outcome: "completed" as const,
      findings: structuralResult.assessment.findings,
    }),
  );
  if (restoredStructural?.outcome !== "completed") {
    throw new Error("Expected the original Structural Assessment to recur");
  }
  expect(restoredStructural.assessment.id).toBe(
    structuralResult.assessment.id,
  );
  expect(access.dvdTitleDamageAssessments.inspect(archive.id)).toMatchObject({
    state: "outdated",
    currentAssessmentIdentity: null,
    assessment: { id: dependencyCycleLatest.id },
  });
  access.close();

  advanceCommittedArchiveEvidence(fixture, manifest);
  const outdatedReview = await fixture.run([
    "catalog-review",
    "show",
    archive.id,
  ]);
  expect(outdatedReview).toMatchObject({
    exitCode: 0,
    result: {
      titleDamage: {
        state: "outdated",
        assessmentIdentity: dependencyCycleLatest.id,
        currentAssessmentIdentity: null,
        items: [],
        truncated: false,
      },
    },
  });
  const outdated = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--limit",
    "1",
  ]);
  expect(outdated).toMatchObject({
    exitCode: 0,
    result: {
      state: "outdated",
      assessmentIdentity: dependencyCycleLatest.id,
      currentAssessmentIdentity: null,
      items: [],
      truncated: false,
      nextCursor: null,
    },
  });
  const staleResult = await fixture.run([
    "catalog-review",
    "damage",
    archive.id,
    "--cursor",
    cursor,
  ]);
  expect(staleResult).toMatchObject({
    exitCode: 2,
    result: {
      error: {
        code: "TITLE_DAMAGE_CURSOR_STALE",
        current: {
          checkpointRevision: 4,
          assessmentIdentity: null,
        },
      },
    },
  });
}, 20_000);
