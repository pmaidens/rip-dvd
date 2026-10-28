import { createHash } from "node:crypto";

import {
  DomainInvariantError,
  RecordNotFoundError,
  type DataAccess,
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

const MAX_EXCLUSIONS = 100;

export class InvalidDvdTitleDamageAcceptancePreviewInputError extends Error {}

function parseExcludedTitleIdentityIds(
  value: unknown,
): readonly DvdTitleIdentityId[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EXCLUSIONS) {
    throw new InvalidDvdTitleDamageAcceptancePreviewInputError(
      "excludedTitleIdentityIds must be an array with at most 100 entries.",
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
  input: { excludedTitleIdentityIds?: unknown } = {},
) {
  const excludedTitleIdentityIds = parseExcludedTitleIdentityIds(
    input.excludedTitleIdentityIds,
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
    if (reviewSet === null) {
      return {
        unsupported: false as const,
        archive,
        workflow,
        reviewSet,
        titleDamage,
        selections: [] as DiscSelection[],
        mediaItems: [] as MediaItem[],
        affectedWork: [] as EncodeJob[],
      };
    }
    const selectionIds = reviewSet.items.flatMap((item) =>
      item.discSelectionMappings.map((mapping) => mapping.discSelectionId)
    );
    const selections = selectionIds.length === 0
      ? []
      : snapshot.catalog.listDiscSelections({ ids: selectionIds });
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
        expectedInputs: ["excludedTitleIdentityIds"],
      },
      current: null,
      reviewSetIdentity: null,
      catalogMappingProjectionId: null,
      assessmentIdentity: null,
      reviewedContentIdentity: null,
      allContent: [],
      reviewedContent: [],
      exclusions: [],
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
  const excluded = new Set(excludedTitleIdentityIds);
  const selectionById = new Map(selections.map((selection) => [
    selection.id,
    selection,
  ]));
  const mediaItemById = new Map(mediaItems.map((item) => [item.id, item]));
  const assessmentByIdentity = new Map(
    (titleDamage.assessment?.items ?? []).map((item) => [
      item.titleIdentityId,
      item,
    ]),
  );
  const allContent = currentItems.map((item) => {
    const assessment = assessmentByIdentity.get(item.titleIdentityId) ?? null;
    const mappings = item.discSelectionMappings.map((mapping) => {
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
    return {
      titleIdentityId: item.titleIdentityId,
      titleIdentityObservationId: item.observation.id,
      included: !excluded.has(item.titleIdentityId),
      mappingState: item.mappingState,
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
  const preflightAction = actionFor(workflow.actions);
  const baseReasons = preflightAction.reasons.filter(({ code }) =>
    code !== "MAPPING_REVIEW_REQUIRED" && code !== "SELECTION_UNIDENTIFIED" &&
    code !== "CATALOG_DAMAGE_DECISION_UNAVAILABLE"
  );
  const mappingReviewItems = reviewedContent.filter((item) =>
    item.mappingState === "needs_mapping_review"
  );
  const unidentifiedItems = reviewedContent.filter((item) =>
    item.mappingState === "unmapped" || item.catalogMappings.length === 0
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
    ...(unidentifiedItems.length === 0
      ? []
      : [{
        code: "SELECTION_UNIDENTIFIED" as const,
        message:
          "Every included content item must have a concrete current mapping and assessment.",
        details: {
          affectedTitleIdentityIds: unidentifiedItems.map((item) =>
            item.titleIdentityId
          ),
        },
      }]),
  ]);
  const reviewedSelectionIds = new Set(reviewedContent.flatMap((item) =>
    item.catalogMappings.map((mapping) => mapping.discSelectionId)
  ));
  const affectedWork = [...new Map(plan.affectedWork
    .filter((job) => reviewedSelectionIds.has(job.discSelectionId))
    .map((job) => [job.id, affectedWorkView(job)] as const)).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const archiveImpactRequiresAcknowledgement = reviewedContent.length > 0 && (
    (titleDamage.assessment?.unknownTitleImpact.unrecoveredSourceSectorCount ??
      0) > 0 ||
    (titleDamage.assessment?.unknownTitleImpact.reasons.length ?? 0) > 0 ||
    (titleDamage.assessment?.unattributedSourceContinuityRisk
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
        ]
        : ["excludedTitleIdentityIds"],
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
    assessmentSnapshot: titleDamage.assessment,
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
