import { expect, it, vi } from "vitest";

import {
  createDvdTitleDamageAcceptancePreviewTestAccess,
  DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS,
} from "./dvd-title-damage-acceptance-preview.test-support.js";
import { previewDvdTitleDamageAcceptance } from
  "./dvd-title-damage-acceptance-preview.js";

it("resolves a main-feature choice without a representative-title heuristic", () => {
  const recordPreview = vi.fn();
  const access = createDvdTitleDamageAcceptancePreviewTestAccess({
    mappingState: "unmapped",
    sourceIdentity: { kind: "main_feature" },
    bindSelection: false,
    recordPreview,
  });

  const preview = previewDvdTitleDamageAcceptance(
    access,
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
    {
      mainFeatureResolutions: [{
        discSelectionId:
          DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
        titleIdentityId:
          DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
      }],
    },
  );

  expect(preview).toMatchObject({
    available: true,
    previewToken: expect.stringMatching(
      /^dvd-title-damage-acceptance-preview:/,
    ),
    acknowledgementRequired: false,
    reviewedContent: [{
      titleIdentityId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
      preflightMappingState: "mapped",
      catalogMappings: [{
        discSelectionId:
          DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
        mediaItem: { title: "Synthetic parity movie" },
        sourceIdentity: { kind: "main_feature" },
        resolvedSourceIdentity: {
          resolution: "title_identity_binding",
          displayTitleNumber: 1,
          angleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
      }],
      acknowledgementRequired: false,
    }],
    mainFeatureChoices: [{
      discSelectionId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
      resolvedTitleIdentityId:
        DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
    }],
    exclusions: [],
  });
  expect(recordPreview).toHaveBeenCalledWith(expect.objectContaining({
    originalDiscArchiveId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId,
    excludedTitleIdentityIds: [],
    mainFeatureResolutions: [{
      discSelectionId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
      titleIdentityId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
    }],
    expectedPreviewEvidence: expect.stringMatching(/^[0-9a-f]{64}$/),
  }));
});

it("includes episode, season, and TV-show identity in mapped content", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({ episodicMedia: true }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
  );

  expect(preview.reviewedContent[0]?.catalogMappings[0]?.mediaItem).toMatchObject({
    id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.episodeId,
    kind: "episode",
    title: "Synthetic Episode",
    episodeNumber: 2,
    episodicContext: {
      tvShow: {
        id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.tvShowId,
        title: "Synthetic Series",
        year: 2024,
      },
      season: {
        id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.seasonId,
        title: "Season One",
        seasonNumber: 1,
      },
    },
  });
});

it("blocks an unresolved main-feature choice", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({
      mappingState: "unmapped",
      sourceIdentity: { kind: "main_feature" },
      bindSelection: false,
    }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
  );

  expect(preview).toMatchObject({
    available: false,
    previewToken: null,
    mainFeatureChoices: [{
      discSelectionId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
      resolvedTitleIdentityId: null,
    }],
    action: {
      reasons: [{
        code: "SELECTION_UNIDENTIFIED",
        details: {
          unresolvedMainFeatureSelectionIds: [
            DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
          ],
        },
      }],
    },
  });
});

it("keeps an active unbound title selection visible and blocked", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({
      mappingState: "unmapped",
      bindSelection: false,
      includeAffectedWork: true,
    }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
    {
      excludedTitleIdentityIds: [
        DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
      ],
    },
  );

  expect(preview).toMatchObject({
    available: false,
    previewToken: null,
    reviewedContent: [],
    unresolvedSelections: [{
      discSelectionId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      mediaItem: { title: "Synthetic parity movie" },
    }],
    affectedWork: [{
      id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.encodeJobId,
      discSelectionId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
    }],
    action: {
      reasons: [
        {
          code: "MAPPING_REVIEW_REQUIRED",
          details: {
            affectedDiscSelectionIds: [
              DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
            ],
          },
        },
        {
          code: "SELECTION_UNIDENTIFIED",
          details: {
            affectedTitleIdentityIds: [],
            unresolvedSelectionIds: [
              DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
            ],
          },
        },
      ],
    },
  });
});

it("orders a paused workflow after pending assessment evidence", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({
      assessmentState: "pending",
      recoveryStatus: "paused",
    }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
  );

  expect(preview.action.reasons.map(({ code }) => code)).toEqual([
    "ASSESSMENT_PENDING",
    "RECOVERY_ACTIVE",
  ]);
});

it("does not project an outdated assessment as current evidence", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({
      assessmentState: "outdated",
    }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
  );

  expect(preview).toMatchObject({
    available: false,
    assessmentIdentity: null,
    assessmentSnapshot: null,
    acknowledgementRequired: false,
    allContent: [{ assessmentSnapshot: null }],
    action: { reasons: [{ code: "ASSESSMENT_OUTDATED" }] },
  });
});

it("blocks an empty exact set and keeps its affected work visible", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({
      includeAffectedWork: true,
    }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
    {
      excludedTitleIdentityIds: [
        DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.titleIdentityId,
      ],
    },
  );

  expect(preview).toMatchObject({
    available: false,
    previewToken: null,
    reviewedContent: [],
    affectedWork: [{
      id: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.encodeJobId,
      discSelectionId: DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.discSelectionId,
    }],
    action: {
      reasons: [{
        code: "SELECTION_UNIDENTIFIED",
        details: {
          emptyReviewedContent: true,
          missingReviewSet: false,
        },
      }],
    },
  });
});

it("does not report terminal Encode Job history as affected work", () => {
  const preview = previewDvdTitleDamageAcceptance(
    createDvdTitleDamageAcceptancePreviewTestAccess({
      includeAffectedWork: true,
      affectedWorkStatus: "completed",
    }),
    DVD_TITLE_DAMAGE_ACCEPTANCE_TEST_IDS.archiveId as never,
  );

  expect(preview.affectedWork).toEqual([]);
});
