import { createHash } from "node:crypto";

import {
  DomainInvariantError,
  MAX_DVD_TITLES,
  RecordNotFoundError,
  type DataAccess,
  type DiscSelectionId,
  type DiscSelection,
  type DvdTitleDamageAssessmentItem,
  type DvdTitleIdentityId,
  type DvdTitleIdentityReviewSetItem,
  type EncodeJob,
  type MediaItem,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import {
  describeCatalogReviewWorkflow,
  type CatalogReviewWorkflowAction,
  type CatalogReviewWorkflowReason,
} from "./catalog-review-workflow.js";
import { createDvdTitleDamageAcceptancePreviewToken } from
  "./dvd-title-damage-acceptance-preview-token.js";

const MAX_EXCLUSIONS = MAX_DVD_TITLES;

export class InvalidDvdTitleDamageAcceptancePreviewInputError extends Error {}

function parseExcludedTitleIdentityIds(
  value: unknown,
): readonly DvdTitleIdentityId[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EXCLUSIONS) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      `excludedTitleIdentityIds must be an array with at most ${MAX_EXCLUSIONS} entries.`,
    );
  }
  const ids = value.map((candidate) => {
    if (
      typeof candidate !== "string" || candidate.length === 0 ||
      candidate.length > 128
    ) {
      throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
        "Each excluded Title Identity must be a non-empty string.",
      );
    }
    return candidate as DvdTitleIdentityId;
  });
  if (new Set(ids).size !== ids.length) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      "Excluded Title Identities must be unique.",
    );
  }
  return [...ids].sort();
}

interface MainFeatureResolution {
  discSelectionId: DiscSelectionId;
  titleIdentityId: DvdTitleIdentityId;
}

function parseMainFeatureResolutions(value: unknown): MainFeatureResolution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DVD_TITLES) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      `mainFeatureResolutions must be an array with at most ${MAX_DVD_TITLES} entries.`,
    );
  }
  const resolutions = value.map((candidate) => {
    if (
      typeof candidate !== "object" || candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
        "Each main-feature resolution must identify one Disc Selection and Title Identity.",
      );
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some((key) =>
        key !== "discSelectionId" && key !== "titleIdentityId"
      ) || typeof record.discSelectionId !== "string" ||
      record.discSelectionId.length === 0 ||
      record.discSelectionId.length > 128 ||
      typeof record.titleIdentityId !== "string" ||
      record.titleIdentityId.length === 0 ||
      record.titleIdentityId.length > 128
    ) {
      throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
        "Each main-feature resolution must identify one Disc Selection and Title Identity.",
      );
    }
    return {
      discSelectionId: record.discSelectionId as DiscSelectionId,
      titleIdentityId: record.titleIdentityId as DvdTitleIdentityId,
    };
  });
  if (new Set(resolutions.map(({ discSelectionId }) => discSelectionId)).size !==
      resolutions.length) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      "Each main-feature Disc Selection may be resolved only once.",
    );
  }
  return resolutions.sort((left, right) =>
    left.discSelectionId.localeCompare(right.discSelectionId)
  );
}

function actionFor(
  actions: readonly CatalogReviewWorkflowAction[],
): CatalogReviewWorkflowAction {
  const action = actions.find((candidate) =>
    candidate.action === "damage_decision"
  );
  if (action === undefined) {
    throw new DomainInvariantError(
      "Catalog Review workflow is missing Title Damage Acceptance preflight availability",
    );
  }
  return action;
}

function uniqueReasons(
  reasons: readonly CatalogReviewWorkflowReason[],
): CatalogReviewWorkflowReason[] {
  const seen = new Set<string>();
  return reasons.filter(({ code }) => {
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

function assessmentRequiresAcknowledgement(
  assessment: DvdTitleDamageAssessmentItem,
): boolean {
  return assessment.mappingCoverage.state !== "complete" ||
    assessment.unrecoveredUniqueSourceSectorCount > 0 ||
    assessment.sourceContinuityRiskSectorCount > 0;
}

function orderedCurrentItems(
  items: readonly DvdTitleIdentityReviewSetItem[],
): DvdTitleIdentityReviewSetItem[] {
  return items.filter((item) => item.presentAtCurrentCheckpoint).sort(
    (left, right) =>
      left.observation.displayTitleNumber -
        right.observation.displayTitleNumber ||
      left.observation.angleNumber - right.observation.angleNumber ||
      left.titleIdentityId.localeCompare(right.titleIdentityId),
  );
}

function mediaItemView(item: MediaItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    year: item.year,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
  };
}

function affectedWorkView(job: EncodeJob) {
  return {
    id: job.id,
    discSelectionId: job.discSelectionId,
    status: job.status,
  };
}

function resolvedMappingSourceIdentity(
  item: DvdTitleIdentityReviewSetItem,
  selection: DiscSelection,
) {
  const { observation } = item;
  return {
    resolution: "title_identity_binding" as const,
    displayTitleNumber: observation.displayTitleNumber,
    navigation: observation.navigation,
    selectedPath: observation.selectedPath,
    angleNumber: observation.angleNumber,
    angleCount: observation.angleCount,
    chapterStart: selection.sourceIdentity.kind === "dvd_chapters"
      ? selection.sourceIdentity.chapterStart
      : observation.chapterStart,
    chapterEnd: selection.sourceIdentity.kind === "dvd_chapters"
      ? selection.sourceIdentity.chapterEnd
      : observation.chapterEnd,
    chapterCount: observation.chapterCount,
    sourceExtents: observation.sourceExtents,
  };
}

function evidenceIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function previewDvdTitleDamageAcceptance(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  input: {
    excludedTitleIdentityIds?: unknown;
    mainFeatureResolutions?: unknown;
  } = {},
) {
  const excludedTitleIdentityIds = parseExcludedTitleIdentityIds(
    input.excludedTitleIdentityIds,
  );
  const mainFeatureResolutions = parseMainFeatureResolutions(
    input.mainFeatureResolutions,
  );
  const plan = access.readConsistentSnapshot((snapshot) => {
    const archive = snapshot.catalog.listOriginalDiscArchives({
      ids: [archiveId],
    })[0];
    if (archive === undefined) {
      throw new RecordNotFoundError("Original Disc Archive", archiveId);
    }
    const workflow = describeCatalogReviewWorkflow(snapshot, archiveId);
    if (workflow === null) {
      return {
        unsupported: true as const,
        archive,
      };
    }
    const reviewSet = snapshot.catalog.readDvdTitleIdentityReviewSet(archiveId);
    const titleDamage = snapshot.dvdTitleDamageAssessments.inspect(archiveId);
    const selections = snapshot.catalog.listDiscSelections({
      originalDiscArchiveId: archiveId,
      limit: MAX_DVD_TITLES,
    });
    const mediaItemIds = [...new Set(selections.map((selection) =>
      selection.mediaItemId
    ))];
    const mediaItems = mediaItemIds.length === 0
      ? []
      : snapshot.catalog.listMediaItems({ ids: mediaItemIds });
    const affectedWork = selections.flatMap((selection) =>
      snapshot.encodeJobs.listForDiscSelection(selection.id)
    );
    return {
      unsupported: false as const,
      archive,
      workflow,
      reviewSet,
      titleDamage,
      selections,
      mediaItems,
      affectedWork,
    };
  });

  if (plan.unsupported) {
    return {
      schemaVersion: 1 as const,
      evidenceFormat: null,
      available: false as const,
      previewToken: null,
      action: {
        available: false,
        reasons: [{
          code: "UNSUPPORTED_EVIDENCE_FORMAT",
          message:
            "Title Damage Acceptance preflight requires dvd-recovery-evidence-v1.",
          details: { originalDiscArchiveId: archiveId },
        }],
        expectedInputs: [
          "excludedTitleIdentityIds",
          "mainFeatureResolutions",
        ],
      },
      current: null,
      reviewSetIdentity: null,
      catalogMappingProjectionId: null,
      assessmentIdentity: null,
      reviewedContentIdentity: null,
      allContent: [],
      reviewedContent: [],
      exclusions: [],
      mainFeatureChoices: [],
      unresolvedSelections: [],
      assessmentSnapshot: null,
      acknowledgementRequired: false,
      affectedWork: [],
      damagePreview: {
        required: false,
        available: false,
        reasons: [{
          code: "DAMAGE_PREVIEW_UNAVAILABLE",
          message: "Damage Preview is optional and is not available in this slice.",
        }],
      },
    };
  }

  const {
    workflow,
    reviewSet,
    titleDamage,
    selections,
    mediaItems,
  } = plan;
  const currentItems = reviewSet === null
    ? []
    : orderedCurrentItems(reviewSet.items);
  const currentIdentityIds = new Set(currentItems.map((item) =>
    item.titleIdentityId
  ));
  const unknownExclusions = excludedTitleIdentityIds.filter((id) =>
    !currentIdentityIds.has(id)
  );
  if (unknownExclusions.length > 0) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      "An excluded Title Identity is not in the current complete review set.",
    );
  }
  const mainFeatureSelections = selections.filter((selection) =>
    selection.sourceIdentity.kind === "main_feature"
  );
  const mainFeatureSelectionIds = new Set(mainFeatureSelections.map((selection) =>
    selection.id
  ));
  const invalidMainFeatureResolutions = mainFeatureResolutions.filter(
    (resolution) =>
      !mainFeatureSelectionIds.has(resolution.discSelectionId) ||
      !currentIdentityIds.has(resolution.titleIdentityId),
  );
  if (invalidMainFeatureResolutions.length > 0) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      "A main-feature resolution does not match a current active Disc Selection and Title Identity.",
    );
  }
  const excluded = new Set(excludedTitleIdentityIds);
  const mainFeatureResolutionBySelectionId = new Map(
    mainFeatureResolutions.map((resolution) => [
      resolution.discSelectionId,
      resolution.titleIdentityId,
    ]),
  );
  const selectionById = new Map(selections.map((selection) => [
    selection.id,
    selection,
  ]));
  const mediaItemById = new Map(mediaItems.map((item) => [item.id, item]));
  const currentAssessment = titleDamage.state === "current"
    ? titleDamage.assessment
    : null;
  const assessmentByIdentity = new Map(
    (currentAssessment?.items ?? []).map((item) => [
      item.titleIdentityId,
      item,
    ]),
  );
  const allContent = currentItems.map((item) => {
    const assessment = assessmentByIdentity.get(item.titleIdentityId) ?? null;
    const boundMappings = item.discSelectionMappings.map((mapping) => {
      const selection = selectionById.get(mapping.discSelectionId);
      if (selection === undefined) {
        throw new DomainInvariantError(
          "Title Identity mapping references a missing Disc Selection",
        );
      }
      const mediaItem = mediaItemById.get(selection.mediaItemId);
      if (mediaItem === undefined) {
        throw new DomainInvariantError(
          "Title Identity mapping references a missing Media Item",
        );
      }
      return {
        discSelectionId: mapping.discSelectionId,
        discSelectionIdentity: mapping.discSelectionIdentity,
        mappingState: mapping.mappingState,
        sourceIdentity: selection.sourceIdentity,
        resolvedSourceIdentity: resolvedMappingSourceIdentity(item, selection),
        label: selection.label,
        mediaItem: mediaItemView(mediaItem),
      };
    });
    const boundSelectionIds = new Set(boundMappings.map((mapping) =>
      mapping.discSelectionId
    ));
    const resolvedMainFeatureMappings = mainFeatureSelections.flatMap(
      (selection) => {
        if (
          mainFeatureResolutionBySelectionId.get(selection.id) !==
              item.titleIdentityId || boundSelectionIds.has(selection.id)
        ) return [];
        const mediaItem = mediaItemById.get(selection.mediaItemId);
        if (mediaItem === undefined) {
          throw new DomainInvariantError(
            "Main-feature Disc Selection references a missing Media Item",
          );
        }
        return [{
          discSelectionId: selection.id,
          discSelectionIdentity: evidenceIdentity([
            "resolved-main-feature",
            selection.id,
            selection.mediaItemId,
            item.titleIdentityId,
            item.observation.id,
          ]),
          mappingState: "mapped" as const,
          sourceIdentity: selection.sourceIdentity,
          resolvedSourceIdentity: resolvedMappingSourceIdentity(
            item,
            selection,
          ),
          label: selection.label,
          mediaItem: mediaItemView(mediaItem),
        }];
      },
    );
    const mappings = [...boundMappings, ...resolvedMainFeatureMappings].sort(
      (left, right) => left.discSelectionId.localeCompare(right.discSelectionId),
    );
    return {
      titleIdentityId: item.titleIdentityId,
      titleIdentityObservationId: item.observation.id,
      included: !excluded.has(item.titleIdentityId),
      mappingState: item.mappingState,
      preflightMappingState: item.mappingState === "needs_mapping_review"
        ? "needs_mapping_review" as const
        : mappings.length > 0
        ? "mapped" as const
        : "unmapped" as const,
      reviewContinuity: item.reviewContinuity,
      sourceIdentity: {
        displayTitleNumber: item.observation.displayTitleNumber,
        navigation: item.observation.navigation,
        selectedPath: item.observation.selectedPath,
        angleNumber: item.observation.angleNumber,
        angleCount: item.observation.angleCount,
        chapterStart: item.observation.chapterStart,
        chapterEnd: item.observation.chapterEnd,
        chapterCount: item.observation.chapterCount,
        sourceExtents: item.observation.sourceExtents,
      },
      catalogMappings: mappings,
      assessmentSnapshot: assessment,
      acknowledgementRequired: assessment === null
        ? false
        : assessmentRequiresAcknowledgement(assessment),
    };
  });
  const reviewedContent = allContent.filter((item) => item.included);
  const exclusions = allContent.filter((item) => !item.included).map((item) => ({
    titleIdentityId: item.titleIdentityId,
    titleIdentityObservationId: item.titleIdentityObservationId,
    displayTitleNumber: item.sourceIdentity.displayTitleNumber,
    angleNumber: item.sourceIdentity.angleNumber,
  }));
  const currentItemById = new Map(currentItems.map((item) => [
    item.titleIdentityId,
    item,
  ]));
  const mainFeatureChoices = mainFeatureSelections.map((selection) => {
    const mediaItem = mediaItemById.get(selection.mediaItemId);
    if (mediaItem === undefined) {
      throw new DomainInvariantError(
        "Main-feature Disc Selection references a missing Media Item",
      );
    }
    const resolvedTitleIdentityId = mainFeatureResolutionBySelectionId.get(
      selection.id,
    ) ?? null;
    const resolvedItem = resolvedTitleIdentityId === null
      ? null
      : currentItemById.get(resolvedTitleIdentityId) ?? null;
    return {
      discSelectionId: selection.id,
      mediaItem: mediaItemView(mediaItem),
      resolvedTitleIdentityId,
      resolvedSourceIdentity: resolvedItem === null
        ? null
        : resolvedMappingSourceIdentity(resolvedItem, selection),
    };
  });
  const unresolvedMainFeatureSelectionIds = mainFeatureChoices
    .filter((choice) => choice.resolvedTitleIdentityId === null)
    .map((choice) => choice.discSelectionId);
  const concretelyMappedSelectionIds = new Set(allContent.flatMap((item) =>
    item.catalogMappings.map((mapping) => mapping.discSelectionId)
  ));
  const unresolvedSelections = selections.filter((selection) =>
    selection.sourceIdentity.kind !== "main_feature" &&
    !concretelyMappedSelectionIds.has(selection.id)
  ).map((selection) => {
    const mediaItem = mediaItemById.get(selection.mediaItemId);
    if (mediaItem === undefined) {
      throw new DomainInvariantError(
        "Unresolved Disc Selection references a missing Media Item",
      );
    }
    return {
      discSelectionId: selection.id,
      sourceIdentity: selection.sourceIdentity,
      label: selection.label,
      mediaItem: mediaItemView(mediaItem),
    };
  }).sort((left, right) =>
    left.discSelectionId.localeCompare(right.discSelectionId)
  );
  const preflightAction = actionFor(workflow.actions);
  const baseReasons = preflightAction.reasons.filter(({ code }) =>
    code !== "MAPPING_REVIEW_REQUIRED" && code !== "SELECTION_UNIDENTIFIED" &&
    code !== "CATALOG_DAMAGE_DECISION_UNAVAILABLE"
  );
  const mappingReviewItems = reviewedContent.filter((item) =>
    item.preflightMappingState === "needs_mapping_review"
  );
  const unidentifiedItems = reviewedContent.filter((item) =>
    item.preflightMappingState === "unmapped"
  );
  const reasons = uniqueReasons([
    ...baseReasons,
    ...(mappingReviewItems.length === 0
      ? []
      : [{
        code: "MAPPING_REVIEW_REQUIRED" as const,
        message: "At least one included mapping requires operator review.",
        details: {
          affectedTitleIdentityIds: mappingReviewItems.map((item) =>
            item.titleIdentityId
          ),
        },
      }]),
    ...(unidentifiedItems.length === 0 &&
        unresolvedMainFeatureSelectionIds.length === 0 &&
        unresolvedSelections.length === 0
      ? []
      : [{
        code: "SELECTION_UNIDENTIFIED" as const,
        message:
          "Every included content item and active Disc Selection must have a concrete current mapping and assessment.",
        details: {
          affectedTitleIdentityIds: unidentifiedItems.map((item) =>
            item.titleIdentityId
          ),
          unresolvedMainFeatureSelectionIds,
          unresolvedSelectionIds: unresolvedSelections.map((selection) =>
            selection.discSelectionId
          ),
        },
      }]),
  ]);
  const reviewedSelectionIds = new Set(reviewedContent.flatMap((item) =>
    item.catalogMappings.map((mapping) => mapping.discSelectionId)
  ));
  unresolvedMainFeatureSelectionIds.forEach((id) =>
    reviewedSelectionIds.add(id)
  );
  unresolvedSelections.forEach(({ discSelectionId }) =>
    reviewedSelectionIds.add(discSelectionId)
  );
  const affectedWork = [...new Map(plan.affectedWork
    .filter((job) => reviewedSelectionIds.has(job.discSelectionId))
    .map((job) => [job.id, affectedWorkView(job)] as const)).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const archiveImpactRequiresAcknowledgement = reviewedContent.length > 0 && (
    (currentAssessment?.unknownTitleImpact.unrecoveredSourceSectorCount ??
      0) > 0 ||
    (currentAssessment?.unknownTitleImpact.reasons.length ?? 0) > 0 ||
    (currentAssessment?.unattributedSourceContinuityRisk
      ?.sourceSectorCount ?? 0) > 0
  );
  const acknowledgementRequired = archiveImpactRequiresAcknowledgement ||
    reviewedContent.some((item) => item.acknowledgementRequired);
  const reviewedContentIdentity = reviewSet === null
    ? null
    : evidenceIdentity([
      reviewSet.reviewSetIdentity,
      allContent.map((item) => [
        item.titleIdentityId,
        item.titleIdentityObservationId,
        item.included,
        item.sourceIdentity,
        item.catalogMappings,
        item.assessmentSnapshot,
      ]),
    ]);
  const expectedPreviewEvidence = evidenceIdentity([
    workflow.current,
    reviewSet?.reviewSetIdentity ?? null,
    workflow.current.catalogMappingProjectionId,
    titleDamage.currentAssessmentIdentity,
    reviewedContentIdentity,
    acknowledgementRequired,
    affectedWork,
  ]);
  const available = reasons.length === 0 && reviewSet !== null &&
    titleDamage.state === "current";
  const previewToken = available
    ? createDvdTitleDamageAcceptancePreviewToken()
    : null;
  if (previewToken !== null) {
    access.catalog.recordDvdTitleDamageAcceptancePreviewDecision({
      previewToken,
      originalDiscArchiveId: archiveId,
      excludedTitleIdentityIds,
      mainFeatureResolutions,
      expectedPreviewEvidence,
    });
  }

  return {
    schemaVersion: 1 as const,
    evidenceFormat: "dvd-recovery-evidence-v1" as const,
    available,
    previewToken,
    action: {
      available,
      reasons,
      expectedInputs: available
        ? [
          "previewToken",
          "checkpointRevision",
          "checkpointDigest",
          "assessmentIdentity",
          "reviewSetIdentity",
          "catalogMappingProjectionId",
          "reviewedContentIdentity",
          "excludedTitleIdentityIds",
          "mainFeatureResolutions",
        ]
        : ["excludedTitleIdentityIds", "mainFeatureResolutions"],
    },
    current: workflow.current,
    reviewSetIdentity: reviewSet?.reviewSetIdentity ?? null,
    catalogMappingProjectionId:
      workflow.current.catalogMappingProjectionId,
    assessmentIdentity: titleDamage.currentAssessmentIdentity,
    reviewedContentIdentity,
    allContent,
    reviewedContent,
    exclusions,
    mainFeatureChoices,
    unresolvedSelections,
    assessmentSnapshot: currentAssessment,
    acknowledgementRequired,
    affectedWork,
    damagePreview: {
      required: false,
      available: false,
      reasons: [{
        code: "DAMAGE_PREVIEW_UNAVAILABLE",
        message: "Damage Preview is optional and is not available in this slice.",
      }],
    },
  };
}

export type DvdTitleDamageAcceptancePreview = ReturnType<
  typeof previewDvdTitleDamageAcceptance
>;
