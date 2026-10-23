import {
  archiveBoundaryEvidenceFromRecord,
  decodeArchivedDvdTitles,
  DomainInvariantError,
  dvdTitleIdentityCatalogMappingItems,
  withAuthoritativeDvdArchiveIntegrity,
  type DataAccess,
  type DiscSelection,
  type DiscSelectionActionAvailability,
  type DiscSelectionId,
  type DvdArchiveEvidenceHeader,
  type DvdTitleIdentityReviewSet,
  type MediaItem,
  type MediaItemMaintenance,
  type OriginalDiscArchiveId,
  type RearchiveMappingProposalReview,
} from "@rip-dvd/data-access";
import { readMediaItemsWithAncestors } from "./media-item-ancestor-context.js";
import { describeCatalogReviewWorkflow } from "./catalog-review-workflow.js";

const CATALOG_REVIEW_SELECTION_PAGE_SIZE = 100;
const CATALOG_REVIEW_DISC_SELECTION_LOOKUP_BATCH_SIZE = 100;
const CATALOG_REVIEW_MEDIA_ITEM_MAINTENANCE_BATCH_SIZE = 100;
const CATALOG_REVIEW_CORRECTION_HISTORY_PAGE_SIZE = 100;
const CATALOG_REVIEW_CORRECTION_ENCODE_HISTORY_PAGE_SIZE = 100;
const CATALOG_REVIEW_CORRECTION_RETAINED_OUTPUT_HISTORY_PAGE_SIZE = 100;
const CATALOG_REVIEW_REPLACEMENT_PLAN_LIMIT = 100;
const CATALOG_REVIEW_REPLACEMENT_PROFILE_LIMIT = 100;

export interface CatalogReviewPageCoordinates {
  discSelectionOffset: number;
  correctionHistoryOffset: number;
  correctionEncodeHistoryOffset: number;
  correctionRetainedOutputHistoryOffset: number;
  replacementOffset: number;
  replacementProfileOffset: number;
}

export function serializeMediaItem(
  item: MediaItem,
  maintenance?: MediaItemMaintenance,
) {
  return {
    id: item.id,
    parentId: item.parentId,
    kind: item.kind,
    title: item.title,
    year: item.year,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    ...(maintenance === undefined
      ? {}
      : {
        maintenance: {
          childCount: maintenance.childCount,
          discSelectionReferenceCount:
            maintenance.discSelectionReferenceCount,
          referencedArchiveCount: maintenance.referencedArchiveCount,
          otherArchiveCount: maintenance.otherArchiveCount,
          deletionAvailability: maintenance.deletionAvailability,
        },
      }),
  };
}

export function serializeDiscSelection(selection: DiscSelection) {
  return {
    id: selection.id,
    mediaItemId: selection.mediaItemId,
    sourceIdentity: selection.sourceIdentity,
    label: selection.label,
  };
}

function serializeTitleIdentity(
  evidenceHeader: DvdArchiveEvidenceHeader | null,
  reviewSet: DvdTitleIdentityReviewSet | null,
) {
  if (evidenceHeader === null) {
    return {
      available: false as const,
      unavailableReason: "UNSUPPORTED_EVIDENCE_FORMAT" as const,
      checkpoint: null,
      policyVersion: null,
      reviewSetIdentity: null,
      items: [],
    };
  }
  const checkpoint = {
    manifestId: evidenceHeader.currentManifestId,
    manifestRevision: evidenceHeader.currentManifestRevision,
    manifestDigest: evidenceHeader.currentManifestDigest,
  };
  if (reviewSet === null) {
    return {
      available: false as const,
      unavailableReason: "TITLE_IDENTITY_NOT_RECORDED" as const,
      checkpoint,
      policyVersion: null,
      reviewSetIdentity: null,
      items: [],
    };
  }
  return {
    available: true as const,
    unavailableReason: null,
    checkpoint: reviewSet.checkpoint,
    policyVersion: reviewSet.policyVersion,
    reviewSetIdentity: reviewSet.reviewSetIdentity,
    items: reviewSet.items.map((item) => ({
      titleIdentityId: item.titleIdentityId,
      presentAtCurrentCheckpoint: item.presentAtCurrentCheckpoint,
      mappingState: item.mappingState,
      discSelectionMappings: item.discSelectionMappings,
      reviewContinuity: item.reviewContinuity,
      observation: {
        ...item.observation,
        createdAt: item.observation.createdAt.toISOString(),
      },
    })),
  };
}

function serializeTitleDamage(
  inspection: ReturnType<
    DataAccess["dvdTitleDamageAssessments"]["inspect"]
  >,
) {
  if (
    inspection.unavailableReasons.some((reason) =>
      reason.code === "UNSUPPORTED_EVIDENCE_FORMAT"
    )
  ) {
    return null;
  }
  const assessment = inspection.assessment;
  if (assessment === null) {
    return {
      state: inspection.state,
      checkpointRevision: inspection.checkpoint?.manifestRevision ?? null,
      assessmentIdentity: null,
      currentAssessmentIdentity: null,
      items: [],
      truncated: false,
      unknownTitleImpact: null,
      noTitleMissingSourceProved: false,
      unavailableReasons: inspection.unavailableReasons,
    };
  }
  const items = inspection.state === "current"
    ? assessment.items.slice(0, 20)
    : [];
  return {
    state: inspection.state,
    checkpointRevision: assessment.checkpoint.manifestRevision,
    assessmentIdentity: assessment.id,
    currentAssessmentIdentity: inspection.currentAssessmentIdentity,
    items,
    truncated: inspection.state === "current" &&
      items.length < assessment.items.length,
    unknownTitleImpact: assessment.unknownTitleImpact,
    noTitleMissingSourceProved: assessment.noTitleMissingSourceProved,
    unavailableReasons: inspection.unavailableReasons,
  };
}

export function serializeArchiveEvidence(
  archive: ReturnType<DataAccess["catalog"]["listOriginalDiscArchives"]>[number],
  discLabel: string | null,
) {
  return {
    id: archive.id,
    detectedDiscId: archive.detectedDiscId,
    discLabel: discLabel ?? "Unlabeled disc",
    discKind: archive.discKind,
    archiveFormat: archive.archiveFormat,
    boundaryEvidence: archiveBoundaryEvidenceFromRecord(archive),
    integrity: archive.integrity,
    integrityPolicyVersion: archive.integrityPolicyVersion,
    badSectorCount: archive.badSectorCount,
    badAreaCount: archive.badAreaCount,
    badSectorRanges: archive.badSectorRanges,
    badSectorCountsByTitle: archive.badSectorCountsByTitle,
    archivedAt: archive.archivedAt.toISOString(),
    catalogReviewedAt: archive.catalogReviewedAt?.toISOString() ?? null,
    catalogReviewOutcome: archive.catalogReviewOutcome,
  };
}

export function serializeRearchiveMappingProposal(
  proposal: RearchiveMappingProposalReview,
  discLabels: {
    source: string | null;
    target: string | null;
  },
) {
  return {
    state: proposal.state,
    persisted: proposal.persisted,
    catalogRevision: proposal.catalogRevision,
    sourceCatalogRevision: proposal.sourceCatalogRevision,
    sourceArchive: serializeArchiveEvidence(
      proposal.sourceArchive,
      discLabels.source,
    ),
    targetArchive: serializeArchiveEvidence(
      proposal.targetArchive,
      discLabels.target,
    ),
    mappings: proposal.mappings,
  };
}

function serializeReviewDiscSelection(
  selection: DiscSelection,
  availability: DiscSelectionActionAvailability,
) {
  const { discSelectionId: _discSelectionId, ...actionAvailability } =
    availability;
  return {
    ...serializeDiscSelection(selection),
    actionAvailability,
  };
}

function readDiscSelectionsByIds(
  catalog: Pick<DataAccess["catalog"], "listDiscSelections">,
  ids: readonly DiscSelectionId[],
): DiscSelection[] {
  const selections: DiscSelection[] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += CATALOG_REVIEW_DISC_SELECTION_LOOKUP_BATCH_SIZE
  ) {
    selections.push(...catalog.listDiscSelections({
      ids: ids.slice(
        offset,
        offset + CATALOG_REVIEW_DISC_SELECTION_LOOKUP_BATCH_SIZE,
      ),
    }));
  }
  return selections;
}

export function readCatalogReview(
  access: DataAccess,
  id: OriginalDiscArchiveId,
  coordinates: CatalogReviewPageCoordinates,
  automaticCatalogingConfigured: boolean,
) {
  const {
    discSelectionOffset,
    correctionHistoryOffset,
    correctionEncodeHistoryOffset,
    correctionRetainedOutputHistoryOffset,
    replacementOffset,
    replacementProfileOffset,
  } = coordinates;
  return access.readConsistentSnapshot((snapshot) => {
    const persistedArchive = snapshot.catalog
      .listOriginalDiscArchives({ ids: [id] })[0];
    if (!persistedArchive) {
      return null;
    }
    const evidenceArchiveIds = [...new Set([
      id,
      ...(persistedArchive.rearchiveSourceArchiveId === null ||
          persistedArchive.catalogReviewedAt !== null
        ? []
        : [persistedArchive.rearchiveSourceArchiveId]),
    ])];
    const evidenceHeaders = snapshot.catalog.findDvdArchiveEvidenceHeaders(
      evidenceArchiveIds,
    );
    const titleIdentityReviewSet = snapshot.catalog
      .readDvdTitleIdentityReviewSet(id);
    const titleDamageInspection = snapshot.dvdTitleDamageAssessments.inspect(id);
    const titleDamage = serializeTitleDamage(titleDamageInspection);
    const archive = withAuthoritativeDvdArchiveIntegrity(
      persistedArchive,
      evidenceHeaders.get(id) ?? null,
    );
    const disc = snapshot.catalog.listDetectedDiscs(undefined, {
      ids: [archive.detectedDiscId],
    })[0];
    if (!disc) {
      throw new DomainInvariantError(
        "Original Disc Archive is missing its Detected Disc provenance",
      );
    }
    const rawTitles = decodeArchivedDvdTitles(disc.scanData) ?? [];
    const persistedRearchiveProposal = snapshot.catalog
      .readRearchiveMappingProposal(id);
    const rearchiveProposal = persistedRearchiveProposal === null
      ? null
      : {
        ...persistedRearchiveProposal,
        sourceArchive: withAuthoritativeDvdArchiveIntegrity(
          persistedRearchiveProposal.sourceArchive,
          evidenceHeaders.get(persistedRearchiveProposal.sourceArchive.id) ??
            null,
        ),
        targetArchive: withAuthoritativeDvdArchiveIntegrity(
          persistedRearchiveProposal.targetArchive,
          evidenceHeaders.get(persistedRearchiveProposal.targetArchive.id) ??
            null,
        ),
      };
    const rearchiveSourceDisc = rearchiveProposal === null
      ? undefined
      : snapshot.catalog.listDetectedDiscs(undefined, {
          ids: [rearchiveProposal.sourceArchive.detectedDiscId],
        })[0];
    if (rearchiveProposal !== null && rearchiveSourceDisc === undefined) {
      throw new DomainInvariantError(
        "Re-archive Mapping Proposal is missing source Detected Disc provenance",
      );
    }
    const coverage = snapshot.catalog.getCatalogReviewCoverage(id);
    const reviewWorkflow = describeCatalogReviewWorkflow(snapshot, id, {
      archiveJobs: snapshot.archiveJobs.listForArchive(id),
      evidenceHeader: evidenceHeaders.get(id) ?? null,
      recovery: snapshot.catalog.findArchiveRecovery(id),
      titleIdentity: titleIdentityReviewSet === null
        ? null
        : {
          reviewSetIdentity: titleIdentityReviewSet.reviewSetIdentity,
          currentMappingStates: dvdTitleIdentityCatalogMappingItems(
            titleIdentityReviewSet.items,
          )
            .map(({ mappingState }) => mappingState),
        },
      titleDamage: {
        state: titleDamageInspection.state,
        currentAssessmentIdentity:
          titleDamageInspection.currentAssessmentIdentity,
        acceptanceRequired: titleDamageInspection.state === "current" &&
          titleDamageInspection.assessment !== null &&
          !titleDamageInspection.assessment.noTitleMissingSourceProved,
      },
    });
    const reviewActionAvailability = snapshot.catalog.getCatalogReviewActionAvailability(id);
    const discSelectionRows = snapshot.catalog.listDiscSelections({
      originalDiscArchiveId: id,
      limit: CATALOG_REVIEW_SELECTION_PAGE_SIZE + 1,
      offset: discSelectionOffset,
    });
    const hasNextDiscSelections = discSelectionRows.length >
      CATALOG_REVIEW_SELECTION_PAGE_SIZE;
    const discSelectionsPage = discSelectionRows.slice(
      0,
      CATALOG_REVIEW_SELECTION_PAGE_SIZE,
    );
    const correctionHistoryRows = snapshot.catalog
      .listDiscSelectionSupersessions({
        originalDiscArchiveId: id,
        limit: CATALOG_REVIEW_CORRECTION_HISTORY_PAGE_SIZE + 1,
        offset: correctionHistoryOffset,
      });
    const hasNextCorrectionHistory = correctionHistoryRows.length >
      CATALOG_REVIEW_CORRECTION_HISTORY_PAGE_SIZE;
    const correctionHistoryPage = correctionHistoryRows.slice(
      0,
      CATALOG_REVIEW_CORRECTION_HISTORY_PAGE_SIZE,
    );
    const correctionSelectionIds = correctionHistoryPage.flatMap(
      (supersession) => [
        supersession.supersededDiscSelectionId,
        supersession.replacementDiscSelectionId,
      ],
    );
    const correctionSelectionsById = new Map(
      readDiscSelectionsByIds(snapshot.catalog, correctionSelectionIds).map(
        (selection) => [selection.id, selection],
      ),
    );
    const correctionEncodeHistoryRows = snapshot.encodeJobs
      .listDiscSelectionCorrectionEncodeJobLinks({
        originalDiscArchiveId: id,
        limit: CATALOG_REVIEW_CORRECTION_ENCODE_HISTORY_PAGE_SIZE + 1,
        offset: correctionEncodeHistoryOffset,
      });
    const hasNextCorrectionEncodeHistory = correctionEncodeHistoryRows.length >
      CATALOG_REVIEW_CORRECTION_ENCODE_HISTORY_PAGE_SIZE;
    const correctionEncodeHistoryPage = correctionEncodeHistoryRows.slice(
      0,
      CATALOG_REVIEW_CORRECTION_ENCODE_HISTORY_PAGE_SIZE,
    );
    const correctionRetainedOutputHistoryRows = snapshot.encodeJobs
      .listDiscSelectionCorrectionRetainedOutputSummaries({
        originalDiscArchiveId: id,
        limit:
          CATALOG_REVIEW_CORRECTION_RETAINED_OUTPUT_HISTORY_PAGE_SIZE + 1,
        offset: correctionRetainedOutputHistoryOffset,
      });
    const hasNextCorrectionRetainedOutputHistory =
      correctionRetainedOutputHistoryRows.length >
        CATALOG_REVIEW_CORRECTION_RETAINED_OUTPUT_HISTORY_PAGE_SIZE;
    const correctionRetainedOutputHistoryPage =
      correctionRetainedOutputHistoryRows.slice(
        0,
        CATALOG_REVIEW_CORRECTION_RETAINED_OUTPUT_HISTORY_PAGE_SIZE,
      );
    const selectionsWithHistory = new Map(
      discSelectionsPage.map((selection) => [selection.id, selection]),
    );
    for (const selection of correctionSelectionsById.values()) {
      selectionsWithHistory.set(selection.id, selection);
    }
    const correctionHistory = correctionHistoryPage.map((supersession) => {
      const supersededDiscSelection = correctionSelectionsById.get(
        supersession.supersededDiscSelectionId,
      );
      const replacementDiscSelection = correctionSelectionsById.get(
        supersession.replacementDiscSelectionId,
      );
      if (!supersededDiscSelection || !replacementDiscSelection) {
        throw new DomainInvariantError(
          `Disc Selection supersession for ${supersession.replacementDiscSelectionId} is missing historical provenance`,
        );
      }
      return {
        supersededDiscSelection:
          serializeDiscSelection(supersededDiscSelection),
        replacementDiscSelection:
          serializeDiscSelection(replacementDiscSelection),
        reason: supersession.reason,
        correctedAt: supersession.createdAt.toISOString(),
      };
    });
    const actionAvailability = snapshot.catalog
      .listDiscSelectionActionAvailability({
        ids: discSelectionsPage.map((selection) => selection.id),
      });
    const actionAvailabilityById = new Map(
      actionAvailability.map((availability) => [
        availability.discSelectionId,
        availability,
      ]),
    );
    const reviewMediaItems = readMediaItemsWithAncestors(
      snapshot.catalog,
      [...selectionsWithHistory.values()].map(
        (selection) => selection.mediaItemId,
      ).concat(
        rearchiveProposal?.mappings.map(
          (mapping) => mapping.proposedMapping.mediaItemId,
        ) ?? [],
        rearchiveProposal?.mappings.flatMap(
          (mapping) => mapping.priorMapping === null
            ? []
            : [mapping.priorMapping.mediaItemId],
        ) ?? [],
      ),
    );
    const mediaItemMaintenance: MediaItemMaintenance[] = [];
    for (
      let offset = 0;
      offset < reviewMediaItems.length;
      offset += CATALOG_REVIEW_MEDIA_ITEM_MAINTENANCE_BATCH_SIZE
    ) {
      mediaItemMaintenance.push(
        ...snapshot.catalog.listMediaItemMaintenance({
          ids: reviewMediaItems.slice(
            offset,
            offset + CATALOG_REVIEW_MEDIA_ITEM_MAINTENANCE_BATCH_SIZE,
          ).map((item) => item.id),
          currentArchiveId: id,
        }),
      );
    }
    const maintenanceByMediaItemId = new Map(
      mediaItemMaintenance.map((maintenance) => [
        maintenance.mediaItemId,
        maintenance,
      ]),
    );
    const replacementJobs =
      rearchiveProposal?.persisted === true &&
        rearchiveProposal.state === "ready"
        ? snapshot.catalog.listRearchiveEncodeReplacementPlans({
          targetArchiveId: id,
          limit: CATALOG_REVIEW_REPLACEMENT_PLAN_LIMIT + 1,
          offset: replacementOffset,
        })
        : snapshot.catalog.listCorrectedEncodeReplacementPlans({
          originalDiscArchiveId: id,
          limit: CATALOG_REVIEW_REPLACEMENT_PLAN_LIMIT + 1,
          offset: replacementOffset,
        });
    const hasNextReplacementJobs = replacementJobs.length >
      CATALOG_REVIEW_REPLACEMENT_PLAN_LIMIT;
    const replacementJobPage = replacementJobs.slice(
      0,
      CATALOG_REVIEW_REPLACEMENT_PLAN_LIMIT,
    );
    const priorProfileIds = [...new Set(
      replacementJobPage.map((job) => job.proposedEncodingProfileId),
    )];
    const activeReplacementProfiles = snapshot.encodingProfiles.list({
      mediaDomain: "dvd_video",
      activeOnly: true,
      limit: CATALOG_REVIEW_REPLACEMENT_PROFILE_LIMIT + 1,
      offset: replacementProfileOffset,
    });
    const hasNextReplacementProfiles = activeReplacementProfiles.length >
      CATALOG_REVIEW_REPLACEMENT_PROFILE_LIMIT;
    const replacementProfilesById = new Map(
      [
        ...snapshot.encodingProfiles.list({ ids: priorProfileIds }),
        ...activeReplacementProfiles.slice(
          0,
          CATALOG_REVIEW_REPLACEMENT_PROFILE_LIMIT,
        ),
      ].map((profile) => [profile.id, profile]),
    );
    return {
      catalogRevision: archive.updatedAt.toISOString(),
      automaticCataloging: {
        configured: reviewWorkflow === null && automaticCatalogingConfigured,
      },
      archive: serializeArchiveEvidence(archive, disc.volumeLabel),
      reviewOutcome: archive.catalogReviewOutcome,
      ...(reviewWorkflow === null ? {} : { reviewWorkflow }),
      rawScan: {
        titles: rawTitles,
      },
      titleIdentity: serializeTitleIdentity(
        evidenceHeaders.get(id) ?? null,
        titleIdentityReviewSet,
      ),
      ...(titleDamage === null ? {} : { titleDamage }),
      coverage,
      reviewActionAvailability,
      ...(rearchiveProposal === null || rearchiveSourceDisc === undefined
        ? {}
        : {
          rearchiveProposal: serializeRearchiveMappingProposal(
            rearchiveProposal,
            {
              source: rearchiveSourceDisc.volumeLabel,
              target: disc.volumeLabel,
            },
          ),
        }),
      mediaItems: reviewMediaItems.map((item) =>
        serializeMediaItem(item, maintenanceByMediaItemId.get(item.id))
      ),
      correctionHistory,
      correctionEncodeHistory: correctionEncodeHistoryPage.map((link) => {
        const replacementEncodeJob = link.replacementEncodeJob;
        return {
          replacementDiscSelectionId: link.replacementDiscSelectionId,
          predecessorEncodeJob: {
            id: link.predecessorEncodeJob.id,
            status: link.predecessorEncodeJob.status,
            replacementEncodeJobId: replacementEncodeJob?.id ?? null,
          },
          replacementEncodeJob: replacementEncodeJob === null
            ? null
            : {
              id: replacementEncodeJob.id,
              status: replacementEncodeJob.status,
              predecessorEncodeJobId: link.predecessorEncodeJob.id,
            },
        };
      }),
      correctionRetainedOutputHistory:
        correctionRetainedOutputHistoryPage.map((entry) => ({
          replacementDiscSelectionId: entry.replacementDiscSelectionId,
          retainedOutput: {
            id: entry.retainedOutput.id,
            predecessorEncodeJobId:
              entry.retainedOutput.predecessorEncodeJobId,
            replacementEncodeJobId:
              entry.retainedOutput.replacementEncodeJobId,
            state: entry.retainedOutput.state,
            cleanupEligible: entry.retainedOutput.cleanupEligible,
            retainedAt: entry.retainedOutput.retainedAt.toISOString(),
          },
        })),
      ...(replacementJobPage.length === 0 && replacementOffset === 0
        ? {}
        : {
          replacementPlan: {
            jobs: replacementJobPage.map((job) => ({
              predecessorEncodeJobId: job.predecessorEncodeJobId,
              ...("sourceDiscSelectionId" in job
                ? { sourceDiscSelectionId: job.sourceDiscSelectionId }
                : {
                  replacementDiscSelectionId:
                    job.replacementDiscSelectionId,
                }),
              proposedEncodingProfileId: job.proposedEncodingProfileId,
              proposedOutputPath: job.proposedOutputPath,
              predecessorStatus: job.predecessorStatus,
              predecessorReady: job.predecessorReady,
            })),
            encodingProfiles: [...replacementProfilesById.values()].map(
              (profile) => ({
                id: profile.id,
                displayName: profile.displayName,
                version: profile.version,
                isActive: profile.isActive,
              }),
            ),
            jobsPage: {
              offset: replacementOffset,
              limit: CATALOG_REVIEW_REPLACEMENT_PLAN_LIMIT,
              hasPrevious: replacementOffset > 0,
              hasNext: hasNextReplacementJobs,
            },
            encodingProfilesPage: {
              offset: replacementProfileOffset,
              limit: CATALOG_REVIEW_REPLACEMENT_PROFILE_LIMIT,
              hasPrevious: replacementProfileOffset > 0,
              hasNext: hasNextReplacementProfiles,
            },
          },
        }),
      correctionHistoryPage: {
        offset: correctionHistoryOffset,
        limit: CATALOG_REVIEW_CORRECTION_HISTORY_PAGE_SIZE,
        hasPrevious: correctionHistoryOffset > 0,
        hasNext: hasNextCorrectionHistory,
      },
      correctionEncodeHistoryPage: {
        offset: correctionEncodeHistoryOffset,
        limit: CATALOG_REVIEW_CORRECTION_ENCODE_HISTORY_PAGE_SIZE,
        hasPrevious: correctionEncodeHistoryOffset > 0,
        hasNext: hasNextCorrectionEncodeHistory,
      },
      correctionRetainedOutputHistoryPage: {
        offset: correctionRetainedOutputHistoryOffset,
        limit: CATALOG_REVIEW_CORRECTION_RETAINED_OUTPUT_HISTORY_PAGE_SIZE,
        hasPrevious: correctionRetainedOutputHistoryOffset > 0,
        hasNext: hasNextCorrectionRetainedOutputHistory,
      },
      discSelections: discSelectionsPage.map((selection) => {
        const availability = actionAvailabilityById.get(selection.id);
        if (!availability) {
          throw new DomainInvariantError(
            `Disc Selection ${selection.id} is missing action availability`,
          );
        }
        return serializeReviewDiscSelection(
          selection,
          availability,
        );
      }),
      discSelectionsPage: {
        offset: discSelectionOffset,
        limit: CATALOG_REVIEW_SELECTION_PAGE_SIZE,
        hasPrevious: discSelectionOffset > 0,
        hasNext: hasNextDiscSelections,
      },
    };
  });
}
