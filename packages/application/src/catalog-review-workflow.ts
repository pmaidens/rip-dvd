import {
  archiveRecoveryWorkIdentity,
  CatalogMappingEvidenceUnavailableError,
  dvdTitleIdentityCatalogMappingItems,
  dvdTitleIdentityCatalogMappingProjectionDigest,
  dvdTitleDamageAssessmentRequiresAcceptance,
  dvdRecoveryEvidenceFormatForArchive,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  DomainInvariantError,
  type ArchiveJobStatus,
  type ArchiveRecoveryStatus,
  type ConsistentReadAccess,
  type DataAccess,
  type DvdCatalogReviewWorkflowEvidence,
  type OriginalDiscArchiveId,
  StaleCatalogRevisionError,
} from "@rip-dvd/data-access";

export type CatalogReviewWorkflowReasonCode =
  | "ARCHIVE_NOT_SAVED"
  | "CONSISTENCY_FAULT"
  | "ASSESSMENT_PENDING"
  | "ASSESSMENT_OUTDATED"
  | "RECOVERY_ACTIVE"
  | "RECOVERY_STOPPING"
  | "MAPPING_REVIEW_REQUIRED"
  | "SELECTION_UNIDENTIFIED"
  | "ACCEPTANCE_REQUIRED"
  | "CATALOG_REVIEW_ARCHIVE_ONLY"
  | "CATALOG_REVIEW_OPEN"
  | "CATALOG_DAMAGE_DECISION_UNAVAILABLE"
  | "STALE_CATALOG_REVISION"
  | "CATALOG_REVIEW_COMPLETION_UNAVAILABLE"
  | typeof DVD_RECOVERY_EVIDENCE_ENCODING.code;

export interface CatalogReviewWorkflowReason {
  code: CatalogReviewWorkflowReasonCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

export interface CatalogReviewWorkflowAction {
  action:
    | "catalog_mapping"
    | "damage_decision"
    | "archive_only"
    | "reopen"
    | "encode";
  available: boolean;
  reasons: readonly CatalogReviewWorkflowReason[];
  expectedInputs: readonly string[];
}

export interface CatalogReviewWorkflow {
  schemaVersion: 1;
  evidenceFormat: "dvd-recovery-evidence-v1";
  facts: {
    saved: boolean;
    recovering: boolean;
    mapped: boolean;
    mappingState: "pending" | "unmapped" | "needs_mapping_review" | "mapped";
    readyForDamageDecision: boolean;
    readyForEncoding: boolean;
    archiveOnly: boolean;
  };
  current: {
    originalDiscArchiveId: string;
    catalogRevision: string;
    catalogReviewOutcome: "needs_review" | "reviewed_with_selections" | "archive_only";
    archiveJob: { id: string; status: ArchiveJobStatus } | null;
    checkpoint: {
      revision: number;
      manifestDigest: string;
    } | null;
    recovery: {
      id: string;
      attemptId: string;
      state: ArchiveRecoveryStatus;
      work: ReturnType<typeof archiveRecoveryWorkIdentity> | null;
    } | null;
    catalogMappingProjectionId: string | null;
    titleDamageAssessmentId: string | null;
  };
  choiceHistory: readonly {
    id: string;
    choice: "archive_only" | "reopen";
    catalogRevision: string;
    checkpoint: { revision: number; manifestDigest: string };
    recovery: { id: string; attemptId: string; state: ArchiveRecoveryStatus };
    recordedAt: string;
  }[];
  choiceHistoryPage: { limit: number; truncated: boolean };
  actions: readonly CatalogReviewWorkflowAction[];
}

export class CatalogReviewCompletionUnavailableError
  extends DomainInvariantError {
  readonly code = "CATALOG_REVIEW_COMPLETION_UNAVAILABLE";
  readonly blockingReasons: readonly CatalogReviewWorkflowReason[];
  readonly current: CatalogReviewWorkflow["current"];

  constructor(workflow: CatalogReviewWorkflow) {
    const decision = workflow.actions.find(({ action }) =>
      action === "damage_decision"
    );
    if (decision === undefined) {
      throw new DomainInvariantError(
        "Catalog Review workflow is missing damage decision availability",
      );
    }
    super(
      "Legacy Catalog Review completion is unavailable for dvd-recovery-evidence-v1; use the separate damage decision workflow.",
    );
    this.name = "CatalogReviewCompletionUnavailableError";
    this.blockingReasons = [{
      code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE",
      message:
        "This evidence format uses the separate damage decision workflow instead of legacy Catalog Review completion.",
      details: {
        evidenceFormat: workflow.evidenceFormat,
        replacementAction: decision.action,
      },
    }];
    this.current = workflow.current;
  }
}

export class CatalogReviewMappingUnavailableError
  extends DomainInvariantError {
  readonly code = "CATALOG_MAPPING_UNAVAILABLE" as const;
  readonly blockingReasons: readonly CatalogReviewWorkflowReason[];
  readonly current: CatalogReviewWorkflow["current"];

  constructor(
    workflow: CatalogReviewWorkflow,
    rejectionReason?: CatalogReviewWorkflowReason,
  ) {
    const mapping = workflow.actions.find(({ action }) =>
      action === "catalog_mapping"
    );
    if (mapping === undefined) {
      throw new DomainInvariantError(
        "Catalog Review workflow is missing mapping unavailability",
      );
    }
    const blockingReasons = mapping.available
      ? rejectionReason === undefined
        ? null
        : [rejectionReason]
      : mapping.reasons;
    if (blockingReasons === null) {
      throw new DomainInvariantError(
        "Catalog Review workflow is missing mapping unavailability",
      );
    }
    super("Catalog mapping is unavailable for the current workflow evidence.");
    this.name = "CatalogReviewMappingUnavailableError";
    this.blockingReasons = blockingReasons;
    this.current = workflow.current;
  }
}

export class CatalogReviewRevisionStaleError extends DomainInvariantError {
  readonly code = "STALE_CATALOG_REVISION" as const;
  readonly blockingReasons: readonly CatalogReviewWorkflowReason[];
  readonly current: CatalogReviewWorkflow["current"] | null;

  constructor(
    workflow: CatalogReviewWorkflow | null,
    expectedCatalogRevision: string,
    currentCatalogRevision: string,
  ) {
    super("Catalog review revision is stale");
    this.name = "CatalogReviewRevisionStaleError";
    this.blockingReasons = [{
      code: "STALE_CATALOG_REVISION",
      message: "Catalog Review evidence changed; reload before mapping.",
      details: { expectedCatalogRevision, currentCatalogRevision },
    }];
    this.current = workflow?.current ?? null;
  }
}

export function rethrowCatalogMappingOperationError(
  access: Pick<DataAccess, "readConsistentSnapshot">,
  originalDiscArchiveId: OriginalDiscArchiveId,
  expectedCatalogRevision: Date | undefined,
  error: unknown,
): never {
  if (
    !(error instanceof CatalogMappingEvidenceUnavailableError) &&
    !(error instanceof StaleCatalogRevisionError)
  ) {
    throw error;
  }
  const current = access.readConsistentSnapshot((snapshot) => ({
    workflow: describeCatalogReviewWorkflow(
      snapshot,
      originalDiscArchiveId,
    ),
    archive: snapshot.catalog.listOriginalDiscArchives({
      ids: [originalDiscArchiveId],
    })[0] ?? null,
  }));
  if (
    error instanceof StaleCatalogRevisionError &&
    expectedCatalogRevision !== undefined &&
    current.archive !== null &&
    current.workflow !== null
  ) {
    throw new CatalogReviewRevisionStaleError(
      current.workflow,
      expectedCatalogRevision.toISOString(),
      current.archive.updatedAt.toISOString(),
    );
  }
  if (
    error instanceof CatalogMappingEvidenceUnavailableError &&
    current.workflow !== null
  ) {
    throw new CatalogReviewMappingUnavailableError(current.workflow, {
      code: "CONSISTENCY_FAULT",
      message: error.message,
      details: {
        originalDiscArchiveId,
        rejectedBy: "transactional_catalog_mapping_guard",
      },
    });
  }
  throw error;
}

function uniqueReasons(
  reasons: readonly CatalogReviewWorkflowReason[],
): CatalogReviewWorkflowReason[] {
  const codes = new Set<CatalogReviewWorkflowReasonCode>();
  return reasons.filter((reason) => {
    if (codes.has(reason.code)) return false;
    codes.add(reason.code);
    return true;
  });
}

export function describeCatalogReviewWorkflow(
  access: ConsistentReadAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
  prefetched?: DvdCatalogReviewWorkflowEvidence,
): CatalogReviewWorkflow | null {
  const choiceHistoryLimit = 100;
  const archiveJobs = prefetched?.archiveJobs ??
    access.archiveJobs.listForArchive(originalDiscArchiveId);
  const header = prefetched === undefined
    ? access.catalog.findDvdArchiveEvidenceHeader(originalDiscArchiveId)
    : prefetched.evidenceHeader;
  if (dvdRecoveryEvidenceFormatForArchive(header, archiveJobs) === null) {
    return null;
  }
  const catalogReview = prefetched?.catalogReview ?? (() => {
    const archive = access.catalog.listOriginalDiscArchives({
      ids: [originalDiscArchiveId],
    })[0];
    return archive === undefined
      ? null
      : {
        catalogRevision: archive.updatedAt.toISOString(),
        outcome: archive.catalogReviewOutcome,
      };
  })();
  if (catalogReview === null) return null;
  const archiveOnly = catalogReview.outcome === "archive_only";
  const choiceHistoryRows = prefetched === undefined
    ? access.catalog.listCatalogReviewEvidenceChoices(
      originalDiscArchiveId,
      { limit: choiceHistoryLimit + 1 },
    )
    : prefetched.choiceHistory ?? [];
  const choiceHistory = choiceHistoryRows.slice(0, choiceHistoryLimit);

  const archiveJob = header === null
    ? archiveJobs.find((job) =>
      job.evidenceFormat === "dvd-recovery-evidence-v1"
    ) ?? null
    : archiveJobs.find((job) => job.id === header.sourceArchiveJobId) ?? null;
  const recovery = prefetched === undefined
    ? access.catalog.findArchiveRecovery(originalDiscArchiveId)
    : prefetched.recovery;
  const reviewSet = prefetched === undefined
    ? access.catalog.readDvdTitleIdentityReviewSet(originalDiscArchiveId)
    : null;
  const titleIdentity = prefetched === undefined
    ? reviewSet === null
      ? null
      : {
        catalogMappingProjectionId:
          dvdTitleIdentityCatalogMappingProjectionDigest(
            reviewSet.checkpoint,
            reviewSet.items,
          ),
        currentMappingStates: dvdTitleIdentityCatalogMappingItems(
          reviewSet.items,
        )
          .map(({ mappingState }) => mappingState),
        currentDefaultAngleTitleCount: reviewSet.items.filter((item) =>
          item.presentAtCurrentCheckpoint &&
          item.observation.angleNumber === 1
        ).length,
      }
    : prefetched.titleIdentity;
  const inspectedTitleDamage = prefetched === undefined
    ? access.dvdTitleDamageAssessments.inspect(originalDiscArchiveId)
    : null;
  const titleDamage = prefetched === undefined
    ? {
      state: inspectedTitleDamage!.state,
      currentAssessmentIdentity:
        inspectedTitleDamage!.currentAssessmentIdentity,
      acceptanceRequired: inspectedTitleDamage!.state === "current" &&
        inspectedTitleDamage!.assessment !== null &&
        dvdTitleDamageAssessmentRequiresAcceptance(
          inspectedTitleDamage!.assessment,
        ),
    }
    : prefetched.titleDamage;
  const mappingStates = titleIdentity?.currentMappingStates ?? [];
  const hasMappingReview = mappingStates.includes("needs_mapping_review");
  const hasUnmappedSelection = mappingStates.includes("unmapped");
  const mappingState = titleIdentity === null ||
      titleIdentity.currentDefaultAngleTitleCount === 0
    ? "pending" as const
    : hasMappingReview
    ? "needs_mapping_review" as const
    : hasUnmappedSelection
    ? "unmapped" as const
    : "mapped" as const;
  const recoveryWork = recovery === null || recovery.work === null
    ? null
    : archiveRecoveryWorkIdentity(recovery.work);

  const consistencyReasons: CatalogReviewWorkflowReason[] = [
    ...(archiveJob?.status === "completed"
      ? []
      : [{
        code: "ARCHIVE_NOT_SAVED" as const,
        message: "The initial Archive Job has not saved this archive.",
        details: {
          archiveJobId: archiveJob?.id ?? null,
          archiveJobStatus: archiveJob?.status ?? null,
        },
      }]),
    ...(header === null
      ? [{
        code: "CONSISTENCY_FAULT" as const,
        message: "The committed DVD checkpoint is unavailable.",
        details: {
          originalDiscArchiveId,
          checkpointRevision: null,
        },
      }]
      : []),
    ...(recovery === null
      ? [{
        code: "CONSISTENCY_FAULT" as const,
        message: "Archive Recovery state is unavailable.",
        details: {
          originalDiscArchiveId,
          archiveRecoveryId: null,
        },
      }]
      : []),
  ];
  const assessmentReasons: CatalogReviewWorkflowReason[] = titleDamage.state ===
      "current"
    ? []
    : [{
      code: titleDamage.state === "outdated"
        ? "ASSESSMENT_OUTDATED" as const
        : "ASSESSMENT_PENDING" as const,
      message: titleDamage.state === "outdated"
        ? "The Title Damage Assessment belongs to an older checkpoint."
        : "A current Title Damage Assessment is pending.",
      details: {
        checkpointRevision: header?.currentManifestRevision ?? null,
        titleDamageAssessmentId: titleDamage.currentAssessmentIdentity,
      },
    }];
  const recoveryReasons: CatalogReviewWorkflowReason[] = recovery === null
    ? []
    : recovery.status === "eligible" ||
        recovery.status === "waiting_for_disc" ||
        recovery.status === "running" || recovery.status === "paused"
    ? [{
      code: "RECOVERY_ACTIVE",
      message:
        "Archive Recovery must stop or complete before a damage decision.",
      details: {
        archiveRecoveryId: recovery.id,
        attemptId: recovery.attemptId,
        state: recovery.status,
        work: recoveryWork,
      },
    }]
    : recovery.status === "stopping"
    ? [{
      code: "RECOVERY_STOPPING",
      message:
        "Archive Recovery is stopping and has not published a stable state.",
      details: {
        archiveRecoveryId: recovery.id,
        attemptId: recovery.attemptId,
        state: recovery.status,
        work: recoveryWork,
      },
    }]
    : recovery.status === "faulted"
    ? [{
      code: "CONSISTENCY_FAULT",
      message: "Archive Recovery faulted before reaching a decision-ready state.",
      details: {
        archiveRecoveryId: recovery.id,
        attemptId: recovery.attemptId,
        state: recovery.status,
        work: recoveryWork,
      },
    }]
    : [];
  const mappingReasons: CatalogReviewWorkflowReason[] = [
    ...(archiveOnly
      ? [{
        code: "CATALOG_REVIEW_ARCHIVE_ONLY",
        message:
          "Catalog Review is archive-only; reopen it before changing catalog mapping.",
        details: { originalDiscArchiveId },
      } satisfies CatalogReviewWorkflowReason]
      : []),
    ...(hasMappingReview
      ? [{
        code: "MAPPING_REVIEW_REQUIRED",
        message: "At least one retained mapping requires operator review.",
        details: {
          catalogMappingProjectionId:
            titleIdentity?.catalogMappingProjectionId ?? null,
          mappingState,
          affectedTitleCount: mappingStates.filter((state) =>
            state === "needs_mapping_review"
          ).length,
        },
      } satisfies CatalogReviewWorkflowReason]
      : []),
    ...(mappingState === "pending" || hasUnmappedSelection
      ? [{
        code: "SELECTION_UNIDENTIFIED",
        message: mappingState === "pending"
          ? "Current title identities are not available for mapping."
          : "At least one current title has no catalog mapping.",
        details: {
          catalogMappingProjectionId:
            titleIdentity?.catalogMappingProjectionId ?? null,
          mappingState,
          affectedTitleCount: mappingState === "pending"
            ? 0
            : mappingStates.filter((state) => state === "unmapped").length,
        },
      } satisfies CatalogReviewWorkflowReason]
      : []),
  ];
  const damageReasons = uniqueReasons([
    ...consistencyReasons,
    ...(archiveOnly
      ? [{
        code: "CATALOG_REVIEW_ARCHIVE_ONLY" as const,
        message:
          "Catalog Review is archive-only; reopen it before making a damage decision.",
        details: { originalDiscArchiveId },
      }]
      : []),
    ...assessmentReasons,
    ...recoveryReasons,
    ...mappingReasons,
  ]);
  const damageDecisionAvailable = damageReasons.length === 0;
  const mappingActionReasons = uniqueReasons([
    ...consistencyReasons,
    ...recoveryReasons.filter(({ code }) => code === "CONSISTENCY_FAULT"),
    ...mappingReasons.filter(({ code }) =>
      code === "CATALOG_REVIEW_ARCHIVE_ONLY" ||
      mappingState === "pending"
    ),
  ]);
  const archiveOnlyRecoveryReasons = recoveryReasons.map((reason) =>
    reason.code === "RECOVERY_ACTIVE"
      ? {
        ...reason,
        message:
          "Archive Recovery must stop or complete before choosing archive-only.",
      }
      : reason
  );
  const archiveOnlyReasons = uniqueReasons([
    ...consistencyReasons,
    ...archiveOnlyRecoveryReasons,
    ...(catalogReview.outcome === "needs_review"
      ? []
      : [{
        code: "CATALOG_REVIEW_ARCHIVE_ONLY" as const,
        message: archiveOnly
          ? "Catalog Review is already archive-only."
          : "Catalog Review is not open for an archive-only choice.",
        details: {
          originalDiscArchiveId,
          catalogReviewOutcome: catalogReview.outcome,
        },
      }]),
  ]);
  const reopenReasons = uniqueReasons([
    ...consistencyReasons,
    ...recoveryReasons.filter(({ code }) => code === "CONSISTENCY_FAULT"),
    ...(archiveOnly
      ? []
      : [{
        code: "CATALOG_REVIEW_OPEN" as const,
        message: "Catalog Review is already open.",
        details: {
          originalDiscArchiveId,
          catalogReviewOutcome: catalogReview.outcome,
        },
      }]),
  ]);
  const damageDecisionReasons = uniqueReasons([
    ...damageReasons,
    {
      code: "CATALOG_DAMAGE_DECISION_UNAVAILABLE",
      message:
        "Damage decision operations are unavailable until web and JSON CLI support is complete.",
      details: { evidenceFormat: "dvd-recovery-evidence-v1" },
    },
  ]);
  const encodeReasons = uniqueReasons([
    ...damageReasons,
    ...(titleDamage.acceptanceRequired
      ? [{
        code: "ACCEPTANCE_REQUIRED" as const,
        message:
          "Current damage or unknown impact has not been accepted for the reviewed content set.",
        details: {
          originalDiscArchiveId,
          titleDamageAssessmentId: titleDamage.currentAssessmentIdentity,
        },
      }]
      : []),
    {
      code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
      message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
      details: { evidenceFormat: "dvd-recovery-evidence-v1" },
    },
  ]);

  return {
    schemaVersion: 1,
    evidenceFormat: "dvd-recovery-evidence-v1",
    facts: {
      saved: archiveJob?.status === "completed",
      recovering: recovery?.status === "waiting_for_disc" ||
        recovery?.status === "running" ||
        recovery?.status === "paused" ||
        recovery?.status === "stopping",
      mapped: mappingState === "mapped",
      mappingState,
      readyForDamageDecision: damageDecisionAvailable,
      readyForEncoding: false,
      archiveOnly,
    },
    current: {
      originalDiscArchiveId,
      catalogRevision: catalogReview.catalogRevision,
      catalogReviewOutcome: catalogReview.outcome,
      archiveJob: archiveJob === null
        ? null
        : { id: archiveJob.id, status: archiveJob.status },
      checkpoint: header === null
        ? null
        : {
          revision: header.currentManifestRevision,
          manifestDigest: header.currentManifestDigest,
        },
      recovery: recovery === null
        ? null
        : {
          id: recovery.id,
          attemptId: recovery.attemptId,
          state: recovery.status,
          work: recoveryWork,
        },
      catalogMappingProjectionId:
        titleIdentity?.catalogMappingProjectionId ?? null,
      titleDamageAssessmentId: titleDamage.currentAssessmentIdentity,
    },
    choiceHistory: choiceHistory.map((choice) => ({
      id: choice.id,
      choice: choice.choice,
      catalogRevision: choice.catalogRevision.toISOString(),
      checkpoint: {
        revision: choice.checkpointRevision,
        manifestDigest: choice.checkpointDigest,
      },
      recovery: {
        id: choice.archiveRecoveryId,
        attemptId: choice.archiveRecoveryAttemptId,
        state: choice.archiveRecoveryStatus,
      },
      recordedAt: choice.recordedAt.toISOString(),
    })),
    choiceHistoryPage: {
      limit: choiceHistoryLimit,
      truncated: choiceHistoryRows.length > choiceHistoryLimit,
    },
    actions: [
      {
        action: "catalog_mapping",
        available: mappingActionReasons.length === 0,
        reasons: mappingActionReasons,
        expectedInputs: ["catalogRevision", "mutationKey"],
      },
      {
        action: "damage_decision",
        available: false,
        reasons: damageDecisionReasons,
        expectedInputs: [
          "checkpointRevision",
          "assessmentIdentity",
          "reviewSetIdentity",
          "mutationKey",
        ],
      },
      {
        action: "archive_only",
        available: archiveOnlyReasons.length === 0,
        reasons: archiveOnlyReasons,
        expectedInputs: [
          "mutationKey",
          "catalogRevision",
          "checkpointRevision",
          "checkpointDigest",
        ],
      },
      {
        action: "reopen",
        available: reopenReasons.length === 0,
        reasons: reopenReasons,
        expectedInputs: [
          "mutationKey",
          "catalogRevision",
          "checkpointRevision",
          "checkpointDigest",
        ],
      },
      {
        action: "encode",
        available: false,
        reasons: encodeReasons,
        expectedInputs: [
          "checkpointRevision",
          "assessmentIdentity",
          "reviewSetIdentity",
          "acceptanceIdentity",
        ],
      },
    ],
  };
}

export function assertCatalogReviewMappingAvailable(
  access: ConsistentReadAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
  prefetched?: DvdCatalogReviewWorkflowEvidence,
): void {
  const workflow = describeCatalogReviewWorkflow(
    access,
    originalDiscArchiveId,
    prefetched,
  );
  if (workflow === null) return;
  const mapping = workflow.actions.find(({ action }) =>
    action === "catalog_mapping"
  );
  if (mapping === undefined) {
    throw new DomainInvariantError(
      "Catalog Review workflow is missing mapping availability",
    );
  }
  if (!mapping.available) {
    throw new CatalogReviewMappingUnavailableError(workflow);
  }
}

export function assertLegacyCatalogReviewCompletionAvailable(
  access: ConsistentReadAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
): void {
  const workflow = describeCatalogReviewWorkflow(
    access,
    originalDiscArchiveId,
  );
  if (workflow !== null) {
    throw new CatalogReviewCompletionUnavailableError(workflow);
  }
}
