import { expect, it, vi } from "vitest";

import type { DataAccess } from "@rip-dvd/data-access";

import { previewDvdDamageAcceptance } from
  "./dvd-damage-acceptance-preview.js";

it("previews clean fully mapped content without a damage acknowledgement", () => {
  const archiveId = "synthetic-clean-archive";
  const checkpoint = {
    manifestId: "synthetic-manifest",
    manifestRevision: 2,
    manifestDigest: "a".repeat(64),
  };
  const reviewSet = {
    originalDiscArchiveId: archiveId,
    evidenceFormat: "dvd-recovery-evidence-v1",
    checkpoint,
    policyVersion: "synthetic-title-identity-v1",
    reviewSetIdentity: "b".repeat(64),
    items: [{
      titleIdentityId: "synthetic-title-1",
      presentAtCurrentCheckpoint: true,
      observation: {
        id: "synthetic-observation-1",
        titleIdentityId: "synthetic-title-1",
        checkpoint,
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
        sourceExtents: [{ startLba: 0, sectorCount: 100 }],
        contentDigest: "c".repeat(64),
        continuity: {
          result: "initial",
          policyVersion: "synthetic-title-identity-v1",
          previousObservationId: null,
        },
        createdAt: new Date("2026-10-27T12:00:00.000Z"),
      },
      reviewContinuity: {
        result: "initial",
        policyVersion: "synthetic-title-identity-v1",
        previousObservationId: null,
      },
      mappingState: "mapped",
      discSelectionMappings: [{
        discSelectionId: "synthetic-selection-1",
        discSelectionIdentity: "d".repeat(64),
        mappingState: "mapped",
      }],
    }],
    createdAt: new Date("2026-10-27T12:00:00.000Z"),
  };
  const assessmentItem = {
    titleIdentityId: "synthetic-title-1",
    titleIdentityObservationId: "synthetic-observation-1",
    displayTitleNumber: 1,
    selection: {
      selectedPath: reviewSet.items[0]!.observation.selectedPath,
      angleNumber: 1,
      chapterStart: 1,
      chapterEnd: 4,
    },
    mappingCoverage: {
      state: "complete",
      policyVersion: "synthetic-map-v1",
      unknownReasons: [],
    },
    uniqueSourceRanges: [{ startLba: 0, sectorCount: 100 }],
    uniqueSourceSectorCount: 100,
    knownUnrecoveredSourceRanges: [],
    unrecoveredUniqueSourceSectorCount: 0,
    titleMissingSourcePercentage: 0,
    knownSourceContinuityRiskRanges: [],
    sourceContinuityRiskSectorCount: 0,
    timingEvidence: {
      policyVersion: "dvd-title-damage-timing-v1",
      occurrences: [],
    },
    estimatedAffectedPlayback: {
      policyVersion: "dvd-title-damage-timing-v1",
      intervals: [],
      unknownCoverage: [],
    },
  };
  const assessmentId = `dvd-title-damage-assessment:${"e".repeat(64)}`;
  const assessment = {
    id: assessmentId,
    policyVersion: "dvd-title-damage-assessment-v1",
    checkpoint: {
      originalDiscArchiveId: archiveId,
      ...checkpoint,
      acceptedEndLbaExclusive: 1_000,
    },
    titleIdentityReviewSetIdentity: reviewSet.reviewSetIdentity,
    structuralAssessmentIdentity:
      `dvd-structural-assessment:${"f".repeat(64)}`,
    structuralFindings: {
      dvdNavigation: "valid",
      titleEnumeration: "valid",
    },
    sourceContinuity: {
      policyVersion: "dvd-title-source-continuity-v1",
      provenance: [],
      sourceContinuityRiskSectorCount: 0,
    },
    items: [assessmentItem],
    unknownTitleImpact: {
      unrecoveredSourceSectorCount: 0,
      unrecoveredSourceRanges: [],
      reasons: [],
    },
    unattributedSourceContinuityRisk: {
      sourceSectorCount: 0,
      sourceRanges: [],
    },
    noTitleMissingSourceProved: true,
    createdAt: new Date("2026-10-27T12:00:00.000Z"),
  };
  const recordPreview = vi.fn();
  const catalog = {
    listOriginalDiscArchives: () => [{
      id: archiveId,
      updatedAt: new Date("2026-10-27T12:00:00.000Z"),
      catalogReviewOutcome: "needs_review",
    }],
    findDvdArchiveEvidenceHeader: () => ({
      originalDiscArchiveId: archiveId,
      evidenceFormat: "dvd-recovery-evidence-v1",
      sourceArchiveJobId: "synthetic-archive-job",
      currentManifestId: checkpoint.manifestId,
      currentManifestRevision: checkpoint.manifestRevision,
      currentManifestDigest: checkpoint.manifestDigest,
      acceptedEndLbaExclusive: 1_000,
    }),
    readDvdTitleIdentityReviewSet: () => reviewSet,
    findArchiveRecovery: () => ({
      id: "synthetic-recovery",
      attemptId: "synthetic-attempt",
      status: "stopped",
      work: null,
    }),
    listCatalogReviewEvidenceChoices: () => [],
    listDiscSelections: () => [{
      id: "synthetic-selection-1",
      originalDiscArchiveId: archiveId,
      mediaItemId: "synthetic-movie",
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      label: null,
      createdAt: new Date("2026-10-27T12:00:00.000Z"),
      updatedAt: new Date("2026-10-27T12:00:00.000Z"),
    }],
    listMediaItems: () => [{
      id: "synthetic-movie",
      parentId: null,
      kind: "movie",
      title: "Synthetic clean movie",
      year: 2026,
      seasonNumber: null,
      episodeNumber: null,
      createdAt: new Date("2026-10-27T12:00:00.000Z"),
      updatedAt: new Date("2026-10-27T12:00:00.000Z"),
    }],
    recordDvdDamageAcceptancePreviewDecision: recordPreview,
  };
  const snapshot = {
    catalog,
    archiveJobs: {
      listForArchive: () => [{
        id: "synthetic-archive-job",
        status: "completed",
        evidenceFormat: "dvd-recovery-evidence-v1",
      }],
    },
    dvdTitleDamageAssessments: {
      inspect: () => ({
        schemaVersion: 1,
        policyVersion: "dvd-title-damage-assessment-v1",
        originalDiscArchiveId: archiveId,
        state: "current",
        checkpoint: assessment.checkpoint,
        currentAssessmentIdentity: assessmentId,
        assessment,
        unavailableReasons: [],
      }),
    },
    encodeJobs: { listForDiscSelection: () => [] },
  };
  const access = {
    ...snapshot,
    readConsistentSnapshot: (read: (value: unknown) => unknown) =>
      read(snapshot),
  } as unknown as DataAccess;

  const preview = previewDvdDamageAcceptance(
    access,
    archiveId as never,
  );

  expect(preview).toMatchObject({
    available: true,
    previewToken: expect.stringMatching(
      /^dvd-damage-acceptance-preview:/,
    ),
    acknowledgementRequired: false,
    reviewedContent: [{
      titleIdentityId: "synthetic-title-1",
      catalogMappings: [{
        mediaItem: { title: "Synthetic clean movie" },
      }],
      acknowledgementRequired: false,
    }],
    exclusions: [],
  });
  expect(recordPreview).toHaveBeenCalledWith(expect.objectContaining({
    originalDiscArchiveId: archiveId,
    excludedTitleIdentityIds: [],
    expectedPreviewEvidence: expect.stringMatching(/^[0-9a-f]{64}$/),
  }));
});
