import {
  archiveRecoveryWorkIdentity,
  dvdRecoveryEvidenceFormatForArchive,
  DVD_RECOVERY_EVIDENCE_ENCODING,
  DomainInvariantError,
  type ArchiveJobStatus,
  type ArchiveRecoveryStatus,
  type ConsistentReadAccess,
  type DvdCatalogReviewWorkflowEvidence,
  type OriginalDiscArchiveId,
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
  | "CATALOG_REVIEW_COMPLETION_UNAVAILABLE"
  | typeof DVD_RECOVERY_EVIDENCE_ENCODING.code;

export interface CatalogReviewWorkflowReason {
  code: CatalogReviewWorkflowReasonCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

export interface CatalogReviewWorkflowAction {
  action: "catalog_mapping" | "damage_decision" | "encode";
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
  };
  current: {
    originalDiscArchiveId: string;
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
    titleIdentityReviewSetId: string | null;
    titleDamageAssessmentId: string | null;
  };
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
  const archiveJobs = prefetched?.archiveJobs ??
    access.archiveJobs.listForArchive(originalDiscArchiveId);
  const header = prefetched === undefined
    ? access.catalog.findDvdArchiveEvidenceHeader(originalDiscArchiveId)
    : prefetched.evidenceHeader;
  if (dvdRecoveryEvidenceFormatForArchive(header, archiveJobs) === null) {
    return null;
  }

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
        reviewSetIdentity: reviewSet.reviewSetIdentity,
        currentMappingStates: reviewSet.items
          .filter(({ presentAtCurrentCheckpoint }) =>
            presentAtCurrentCheckpoint
          )
          .map(({ mappingState }) => mappingState),
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
        !inspectedTitleDamage!.assessment.noTitleMissingSourceProved,
    }
    : prefetched.titleDamage;
  const mappingStates = titleIdentity?.currentMappingStates ?? [];
  const hasMappingReview = mappingStates.includes("needs_mapping_review");
  const hasUnmappedSelection = mappingStates.includes("unmapped");
  const mappingState = titleIdentity === null || mappingStates.length === 0
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
    : recovery.status === "eligible" || recovery.status === "running"
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
    ...(hasMappingReview
      ? [{
        code: "MAPPING_REVIEW_REQUIRED",
        message: "At least one retained mapping requires operator review.",
        details: {
          titleIdentityReviewSetId: titleIdentity?.reviewSetIdentity ?? null,
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
          titleIdentityReviewSetId: titleIdentity?.reviewSetIdentity ?? null,
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
    ...recoveryReasons,
    ...assessmentReasons,
    ...mappingReasons,
  ]);
  const damageDecisionAvailable = damageReasons.length === 0;
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
      recovering: recovery?.status === "running" ||
        recovery?.status === "stopping",
      mapped: mappingState === "mapped",
      mappingState,
      readyForDamageDecision: damageDecisionAvailable,
      readyForEncoding: false,
    },
    current: {
      originalDiscArchiveId,
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
      titleIdentityReviewSetId: titleIdentity?.reviewSetIdentity ?? null,
      titleDamageAssessmentId: titleDamage.currentAssessmentIdentity,
    },
    actions: [
      {
        action: "catalog_mapping",
        available: true,
        reasons: [],
        expectedInputs: ["catalogRevision", "mutationKey"],
      },
      {
        action: "damage_decision",
        available: damageDecisionAvailable,
        reasons: damageReasons,
        expectedInputs: [
          "checkpointRevision",
          "assessmentIdentity",
          "reviewSetIdentity",
          "mutationKey",
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
