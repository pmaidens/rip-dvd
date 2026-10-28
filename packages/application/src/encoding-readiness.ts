import {
  archiveRecoveryWorkIdentity,
  dvdRecoveryEvidenceFormatForArchive,
  dvdTitleIdentityCatalogMappingProjectionDigest,
  dvdTitleIdentityDiscSelectionDigest,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  RecordNotFoundError,
  type ConsistentReadAccess,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

export class InvalidEncodingReadinessInputError extends Error {}

export interface EncodingReadinessReason {
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

// Equal-priority reasons retain their declared order, including selection order.
function ordered(reasons: readonly EncodingReadinessReason[]) {
  const priority: Record<string, number> = {
    CONSISTENCY_FAULT: 0, WRITER_NOT_QUIESCENT: 0,
    ARCHIVE_NOT_SAVED: 1, MAPPING_REVIEW_REQUIRED: 1, SELECTION_UNIDENTIFIED: 1,
    ASSESSMENT_PENDING: 2, ASSESSMENT_OUTDATED: 2,
    ACCEPTANCE_REQUIRED: 2, ACCEPTANCE_WITHDRAWN: 2,
  };
  return reasons.map((reason, index) => ({ reason, index }))
    .sort((a, b) => (priority[a.reason.code] ?? 3) -
      (priority[b.reason.code] ?? 3) || a.index - b.index)
    .map(({ reason }) => reason);
}

function describe(
  snapshot: ConsistentReadAccess,
  archiveId: OriginalDiscArchiveId,
  ownership: ArchiveImageOwnership,
  originalsLibraryPath: string,
  checkpointVerified: boolean,
  checkpointFailure: string | null = null,
) {
  const archive = snapshot.catalog.listOriginalDiscArchives({ ids: [archiveId] })[0];
  if (!archive) throw new RecordNotFoundError("Original Disc Archive", archiveId);
  const header = snapshot.catalog.findDvdArchiveEvidenceHeader(archiveId);
  const jobs = snapshot.archiveJobs.listForArchive(archiveId);
  const evidenceFormat = dvdRecoveryEvidenceFormatForArchive(header, jobs);
  if (evidenceFormat === null) return {
    schemaVersion: 1 as const, evidenceFormat: null,
    applicable: false as const, sourceReady: null, admissionAvailable: null,
    message: "Historical archives retain their existing encoding path and integrity meanings.",
    current: { originalDiscArchiveId: archiveId },
    blockingReasons: [], selections: [], assessment: null, ownership: null,
  };
  const recovery = snapshot.catalog.findArchiveRecovery(archiveId);
  const review = snapshot.catalog.readDvdTitleIdentityReviewSet(archiveId);
  const damage = snapshot.dvdTitleDamageAssessments.inspect(archiveId);
  const decision = snapshot.catalog.inspectDvdTitleDamageDecision(archiveId);
  const imageOwnership = ownership.inspect({
    archiveId, imagePath: archive.archivePath, originalsLibraryPath,
  });
  const current = {
    originalDiscArchiveId: archiveId,
    catalogRevision: archive.updatedAt.toISOString(),
    catalogReviewOutcome: archive.catalogReviewOutcome,
    checkpoint: header === null ? null : {
      manifestId: header.currentManifestId,
      revision: header.currentManifestRevision,
      manifestDigest: header.currentManifestDigest,
      verified: checkpointVerified,
    },
    recovery: recovery === null ? null : {
      id: recovery.id, attemptId: recovery.attemptId, state: recovery.status,
      work: recovery.work === null ? null : archiveRecoveryWorkIdentity(recovery.work),
    },
    reviewSetIdentity: review?.reviewSetIdentity ?? null,
    catalogMappingProjectionId: review === null ? null :
      dvdTitleIdentityCatalogMappingProjectionDigest(review.checkpoint, review.items),
    assessmentIdentity: damage.currentAssessmentIdentity,
    acceptanceState: decision.state,
    acceptanceIdentity: decision.current?.id ?? null,
    latestAcceptanceIdentity: decision.latest?.id ?? null,
    reviewedContentIdentity: decision.current?.reviewedContentIdentity ?? null,
  };
  const reason = (code: string, message: string, details: Record<string, unknown> = {}) =>
    ({ code, message, details });
  const reasons: EncodingReadinessReason[] = imageOwnership.stableRead.blockingReasons
    .map(({ code, message }) => reason(code, message));
  if (header === null || recovery === null || recovery.status === "faulted" ||
      ((recovery.status === "stopped" || recovery.status === "completed") && recovery.work !== null) ||
      checkpointFailure !== null) {
    reasons.push(reason("CONSISTENCY_FAULT", "A consistent committed checkpoint and quiescent Recovery are required.", {
      checkpointFailure, recovery: current.recovery,
    }));
  }
  const job = jobs.find(({ id }) => id === header?.sourceArchiveJobId);
  if (job?.status !== "completed") reasons.push(reason("ARCHIVE_NOT_SAVED", "The initial Archive Job has not completed.", {
    archiveJobId: job?.id ?? null, status: job?.status ?? null,
  }));
  if (damage.state !== "current") reasons.push(reason(
    damage.state === "outdated" ? "ASSESSMENT_OUTDATED" : "ASSESSMENT_PENDING",
    damage.state === "outdated" ? "The Title Damage Assessment is outdated." : "A current Title Damage Assessment is pending.",
    { assessmentIdentity: damage.currentAssessmentIdentity, latestAssessmentIdentity: damage.assessment?.id ?? null },
  ));
  if (recovery !== null && !["stopped", "completed", "faulted"].includes(recovery.status)) {
    const code = recovery.status === "stopping" ? "RECOVERY_STOPPING"
      : recovery.status === "paused" ? "RECOVERY_PAUSED"
      : recovery.status === "waiting_for_disc" ? "RECOVERY_WAITING"
      : recovery.status === "eligible" ? "RECOVERY_ELIGIBLE" : "RECOVERY_ACTIVE";
    reasons.push(reason(code, "Archive Recovery must stop or complete before encoding.", { recovery: current.recovery }));
  }
  if (archive.catalogReviewOutcome === "archive_only") reasons.push(reason(
    "CATALOG_REVIEW_ARCHIVE_ONLY", "Catalog Review is archive-only.",
  ));
  const assessment = damage.state === "current" ? damage.assessment : null;
  const archiveUnknown = assessment !== null && (
    assessment.unknownTitleImpact.unrecoveredSourceSectorCount > 0 ||
    assessment.unknownTitleImpact.reasons.length > 0 || assessment.sourceContinuity === null ||
    assessment.unattributedSourceContinuityRisk === null
  );
  const archiveContinuityRisk = (assessment?.unattributedSourceContinuityRisk?.sourceSectorCount ?? 0) > 0;
  const selections = snapshot.catalog.listDiscSelections({ originalDiscArchiveId: archiveId })
    .sort((a, b) => a.id.localeCompare(b.id)).map((selection) => {
      const selectionIdentity = dvdTitleIdentityDiscSelectionDigest({
        discSelectionId: selection.id, mediaItemId: selection.mediaItemId, sourceIdentity: selection.sourceIdentity,
      });
      const candidates = review?.items.filter((item) => item.presentAtCurrentCheckpoint &&
        item.discSelectionMappings.some((mapping) => mapping.discSelectionId === selection.id)) ?? [];
      // Main-feature choices are concrete only when a current exact-set decision
      // retained the operator's resolution. Never infer a longest-title choice.
      const reviewedContent = decision.current?.snapshot.reviewedContent.find((item) =>
        item.catalogMappings.some((mapping) => mapping.discSelectionId === selection.id));
      const resolvedMainFeature = selection.sourceIdentity.kind === "main_feature" &&
          reviewedContent !== undefined
        ? review?.items.find((item) => item.presentAtCurrentCheckpoint &&
          item.titleIdentityId === reviewedContent.titleIdentityId &&
          item.observation.id === reviewedContent.titleIdentityObservationId)
        : undefined;
      const item = candidates.length === 1 ? candidates[0] : resolvedMainFeature;
      const observation = item?.observation;
      const chapterStart = selection.sourceIdentity.kind === "dvd_chapters"
        ? selection.sourceIdentity.chapterStart : observation?.chapterStart;
      const chapterEnd = selection.sourceIdentity.kind === "dvd_chapters"
        ? selection.sourceIdentity.chapterEnd : observation?.chapterEnd;
      const concrete = observation !== undefined && observation.selectedPath.length > 0 &&
        observation.angleNumber >= 1 && observation.angleNumber <= observation.angleCount &&
        chapterStart !== undefined && chapterEnd !== undefined &&
        chapterStart >= observation.chapterStart && chapterEnd <= observation.chapterEnd && chapterEnd >= chapterStart;
      const selectionReasons: EncodingReadinessReason[] = [];
      if (item?.mappingState === "needs_mapping_review" || item?.discSelectionMappings.some((mapping) =>
        mapping.discSelectionId === selection.id && mapping.mappingState === "needs_mapping_review")) {
        selectionReasons.push(reason("MAPPING_REVIEW_REQUIRED", "The selected Title Identity requires mapping review."));
      }
      if (!concrete) selectionReasons.push(reason("SELECTION_UNIDENTIFIED", "The selection needs a proved Title Identity, playback path, angle and chapter bounds."));
      const titleAssessment = assessment?.items.find((entry) =>
        entry.titleIdentityId === item?.titleIdentityId &&
        entry.titleIdentityObservationId === observation?.id) ?? null;
      const impact = titleAssessment === null ? "unavailable" as const
        : archiveUnknown || titleAssessment.mappingCoverage.state !== "complete" ? "unknown" as const
        : titleAssessment.unrecoveredUniqueSourceSectorCount > 0 ? "known_damage" as const
        : "clean" as const;
      const continuityRisk = archiveContinuityRisk || (titleAssessment?.sourceContinuityRiskSectorCount ?? 0) > 0;
      const acceptanceRequired = titleAssessment === null ? null : impact !== "clean" || continuityRisk;
      const covered = decision.current?.decision === "accepted" && reviewedContent !== undefined &&
        reviewedContent.titleIdentityId === item?.titleIdentityId &&
        reviewedContent.titleIdentityObservationId === observation?.id &&
        reviewedContent.catalogMappings.some((mapping) => mapping.discSelectionId === selection.id &&
          mapping.resolvedSourceIdentity.chapterStart === chapterStart &&
          mapping.resolvedSourceIdentity.chapterEnd === chapterEnd &&
          mapping.resolvedSourceIdentity.angleNumber === observation?.angleNumber);
      if (assessment !== null && titleAssessment === null) selectionReasons.push(reason(
        "ASSESSMENT_PENDING", "The current assessment has no evidence for this selection.",
      ));
      if (acceptanceRequired && !covered) selectionReasons.push(reason(
        decision.state === "withdrawn" ? "ACCEPTANCE_WITHDRAWN" : "ACCEPTANCE_REQUIRED",
        decision.state === "withdrawn" ? "Title Damage Acceptance was withdrawn." : "Current Title Damage Acceptance is required for this content.",
      ));
      return {
        discSelectionId: selection.id, selectionIdentity, mediaItemId: selection.mediaItemId,
        sourceIdentity: selection.sourceIdentity,
        titleIdentityId: item?.titleIdentityId ?? null,
        titleIdentityObservationId: observation?.id ?? null,
        resolvedSource: !concrete || observation === undefined ? null : {
          navigation: observation.navigation, selectedPath: observation.selectedPath,
          displayTitleNumber: observation.displayTitleNumber,
          angleNumber: observation.angleNumber, chapterStart, chapterEnd,
        },
        assessment: { state: damage.state, impact, sourceContinuityRisk: continuityRisk,
          evidence: titleAssessment },
        acceptanceRequired, acceptanceSatisfied: acceptanceRequired === false || covered,
        sourceReady: reasons.length === 0 && selectionReasons.length === 0,
        blockingReasons: ordered(selectionReasons.map((entry) => ({ ...entry,
          details: { ...entry.details, discSelectionId: selection.id, selectionIdentity },
        }))),
      };
    });
  if (selections.length === 0) reasons.push(reason("SELECTION_UNIDENTIFIED", "No active content is selected."));
  const blockingReasons = ordered([...reasons, ...selections.flatMap((selection) => selection.blockingReasons)]);
  return {
    schemaVersion: 1 as const, evidenceFormat, applicable: true as const,
    sourceReady: blockingReasons.length === 0, admissionAvailable: false,
    admissionReasons: [DVD_RECOVERY_EVIDENCE_ENCODING],
    current, recordedIntegrity: archive.integrity,
    assessment: { state: damage.state, identity: damage.currentAssessmentIdentity,
      latestIdentity: damage.assessment?.id ?? null },
    ownership: imageOwnership, blockingReasons, selections,
  };
}

export async function inspectEncodingReadiness(
  access: DataAccess,
  archiveId: string,
  originalsLibraryPath: string,
  ownership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(archiveId)) {
    throw new InvalidEncodingReadinessInputError("A valid archive ID is required.");
  }
  const id = archiveId as OriginalDiscArchiveId;
  const read = (verified: boolean, failure: string | null = null) => access.readConsistentSnapshot((snapshot) =>
    describe(snapshot, id, ownership, originalsLibraryPath, verified, failure));
  const initial = read(false);
  if (!initial.applicable || !initial.ownership.stableRead.available ||
      !["stopped", "completed"].includes(initial.current.recovery?.state ?? "")) return initial;
  try {
    return await access.withDvdCheckpoint(id, ownership, async () => undefined,
      () => read(true)) ?? read(false, "DVD_EVIDENCE_NOT_RECORDED");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : "DVD_EVIDENCE_UNAVAILABLE";
    return read(false, code);
  }
}

export function listEncodingReadinessArchives(access: DataAccess, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new InvalidEncodingReadinessInputError("Invalid archive offset.");
  return access.readConsistentSnapshot((snapshot) => {
    const archives = snapshot.catalog.listOriginalDiscArchives({ limit: 51, offset });
    const discs = new Map(snapshot.catalog.listDetectedDiscs(undefined, {
      ids: archives.map((archive) => archive.detectedDiscId),
    }).map((disc) => [disc.id, disc]));
    return { schemaVersion: 1, archives: archives.slice(0, 50).map((archive) => ({
      id: archive.id, label: discs.get(archive.detectedDiscId)?.volumeLabel ?? archive.id,
    })), page: { offset, limit: 50, hasNext: archives.length > 50 } };
  });
}

export type EncodingReadiness = Awaited<ReturnType<typeof inspectEncodingReadiness>>;
