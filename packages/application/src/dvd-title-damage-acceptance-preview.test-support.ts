import {
  createDiscSelectionSourceIdentity,
  type DataAccess,
  type DiscSelectionSourceIdentityInput,
  type DvdTitleDamageAcceptancePreviewDecisionInput,
} from "@rip-dvd/data-access";

export const DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS = {
  archiveId: "synthetic-title-damage-acceptance-archive",
  titleIdentityId: "synthetic-title-damage-identity",
  observationId: "synthetic-title-damage-observation",
  discSelectionId: "synthetic-title-damage-selection",
  mediaItemId: "synthetic-title-damage-movie",
  encodeJobId: "synthetic-title-damage-encode-job",
} as const;

export function createDvdTitleDamageAcceptancePreviewTestAccess(options: {
  assessmentState?: "current" | "outdated";
  mappingState?: "mapped" | "needs_mapping_review" | "unmapped";
  sourceIdentity?: DiscSelectionSourceIdentityInput;
  bindSelection?: boolean;
  includeAffectedWork?: boolean;
  recordPreview?: (
    input: DvdTitleDamageAcceptancePreviewDecisionInput,
  ) => void;
} = {}): DataAccess {
  const assessmentState = options.assessmentState ?? "current";
  const mappingState = options.mappingState ?? "mapped";
  const sourceIdentity = createDiscSelectionSourceIdentity(
    options.sourceIdentity ?? { kind: "dvd_title", titleNumber: 1 },
  );
  const bindSelection = options.bindSelection ?? true;
  const checkpoint = {
    manifestId: "synthetic-title-damage-manifest",
    manifestRevision: 2,
    manifestDigest: "a".repeat(64),
  };
  const observation = {
    id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.observationId,
    titleIdentityId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
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
    contentDigest: "b".repeat(64),
    continuity: {
      result: "initial" as const,
      policyVersion: "synthetic-title-identity-v1",
      previousObservationId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const reviewSet = {
    originalDiscArchiveId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
    evidenceFormat: "dvd-recovery-evidence-v1" as const,
    checkpoint,
    policyVersion: "synthetic-title-identity-v1",
    reviewSetIdentity: "c".repeat(64),
    items: [{
      titleIdentityId: observation.titleIdentityId,
      presentAtCurrentCheckpoint: true,
      observation,
      reviewContinuity: observation.continuity,
      mappingState,
      discSelectionMappings: bindSelection
        ? [{
          discSelectionId:
            DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
          discSelectionIdentity: "d".repeat(64),
          mappingState,
        }]
        : [],
    }],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const assessmentId = `dvd-title-damage-assessment:${"e".repeat(64)}`;
  const assessment = {
    id: assessmentId,
    policyVersion: "dvd-title-damage-assessment-v1" as const,
    checkpoint: {
      originalDiscArchiveId:
        DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
      ...checkpoint,
      acceptedEndLbaExclusive: 1_000,
    },
    titleIdentityReviewSetIdentity: reviewSet.reviewSetIdentity,
    structuralAssessmentIdentity:
      `dvd-structural-assessment:${"f".repeat(64)}`,
    structuralFindings: {
      dvdNavigation: "valid" as const,
      titleEnumeration: "valid" as const,
    },
    sourceContinuity: {
      policyVersion: "dvd-title-source-continuity-v1" as const,
      provenance: [],
      sourceContinuityRiskSectorCount: 0,
    },
    items: [{
      titleIdentityId: observation.titleIdentityId,
      titleIdentityObservationId: observation.id,
      displayTitleNumber: 1,
      selection: {
        selectedPath: observation.selectedPath,
        angleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      },
      mappingCoverage: {
        state: "complete" as const,
        policyVersion: "synthetic-title-damage-map-v1",
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
        policyVersion: "dvd-title-damage-timing-v1" as const,
        occurrences: [],
      },
      estimatedAffectedPlayback: {
        policyVersion: "dvd-title-damage-timing-v1" as const,
        intervals: [],
        unknownCoverage: [],
      },
    }],
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const catalog = {
    listOriginalDiscArchives: () => [{
      id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      catalogReviewOutcome: "needs_review",
    }],
    findDvdArchiveEvidenceHeader: () => ({
      originalDiscArchiveId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
      evidenceFormat: "dvd-recovery-evidence-v1",
      sourceArchiveJobId: "synthetic-title-damage-archive-job",
      currentManifestId: checkpoint.manifestId,
      currentManifestRevision: checkpoint.manifestRevision,
      currentManifestDigest: checkpoint.manifestDigest,
      acceptedEndLbaExclusive: 1_000,
    }),
    readDvdTitleIdentityReviewSet: () => reviewSet,
    findArchiveRecovery: () => ({
      id: "synthetic-title-damage-recovery",
      attemptId: "synthetic-title-damage-attempt",
      status: "stopped",
      work: null,
    }),
    listCatalogReviewEvidenceChoices: () => [],
    listDiscSelections: () => [{
      id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
      originalDiscArchiveId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
      mediaItemId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.mediaItemId,
      sourceIdentity,
      label: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }],
    listMediaItems: () => [{
      id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.mediaItemId,
      parentId: null,
      kind: "movie",
      title: "Synthetic parity movie",
      year: 2026,
      seasonNumber: null,
      episodeNumber: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }],
    recordDvdTitleDamageAcceptancePreviewDecision:
      options.recordPreview ?? (() => undefined),
  };
  const snapshot = {
    catalog,
    archiveJobs: {
      listForArchive: () => [{
        id: "synthetic-title-damage-archive-job",
        status: "completed",
        evidenceFormat: "dvd-recovery-evidence-v1",
      }],
    },
    dvdTitleDamageAssessments: {
      inspect: () => ({
        schemaVersion: 1,
        policyVersion: "dvd-title-damage-assessment-v1",
        originalDiscArchiveId:
          DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
        state: assessmentState,
        checkpoint: assessment.checkpoint,
        currentAssessmentIdentity: assessmentState === "current"
          ? assessmentId
          : null,
        assessment,
        unavailableReasons: [],
      }),
    },
    encodeJobs: {
      listForDiscSelection: () => options.includeAffectedWork
        ? [{
          id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.encodeJobId,
          discSelectionId:
            DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
          status: "queued",
        }]
        : [],
    },
  };
  return {
    ...snapshot,
    readConsistentSnapshot: (read: (value: unknown) => unknown) =>
      read(snapshot),
    close: () => undefined,
  } as unknown as DataAccess;
}
