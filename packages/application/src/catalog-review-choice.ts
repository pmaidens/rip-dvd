import {
  DomainInvariantError,
  MutationKeyConflictError,
  StaleCatalogRevisionError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import type { CatalogReviewCommand } from "./catalog-review-command.js";
import {
  describeCatalogReviewWorkflow,
  type CatalogReviewWorkflow,
  type CatalogReviewWorkflowAction,
  type CatalogReviewWorkflowReason,
} from "./catalog-review-workflow.js";
import { parseMutationKey } from "./mutation-key.js";

export type CatalogReviewEvidenceChoiceCommand = Extract<
  CatalogReviewCommand,
  { action: "archive_only" | "reopen" }
>;

export class CatalogReviewChoiceUnavailableError
  extends DomainInvariantError {
  readonly code = "CATALOG_REVIEW_CHOICE_UNAVAILABLE" as const;
  readonly blockingReasons: readonly CatalogReviewWorkflowReason[];
  readonly current: CatalogReviewWorkflow["current"] | null;

  constructor(
    action: CatalogReviewEvidenceChoiceCommand["action"],
    workflow: CatalogReviewWorkflow | null,
    rejectionReason?: CatalogReviewWorkflowReason,
  ) {
    const availability = workflow?.actions.find((candidate) =>
      candidate.action === action
    );
    super(
      action === "archive_only"
        ? "Archive-only is unavailable for the current Catalog Review evidence."
        : "Reopening is unavailable for the current Catalog Review evidence.",
    );
    this.name = "CatalogReviewChoiceUnavailableError";
    this.blockingReasons = availability !== undefined && !availability.available
      ? availability.reasons
      : rejectionReason === undefined
      ? [{
        code: "CONSISTENCY_FAULT",
        message: "Current Catalog Review evidence is unavailable.",
        details: {
          originalDiscArchiveId:
            workflow?.current.originalDiscArchiveId ?? null,
        },
      }]
      : [rejectionReason];
    this.current = workflow?.current ?? null;
  }
}

export class CatalogReviewChoiceStaleError extends DomainInvariantError {
  readonly code = "STALE_CATALOG_REVISION" as const;
  readonly blockingReasons: readonly CatalogReviewWorkflowReason[];
  readonly current: CatalogReviewWorkflow["current"] | null;

  constructor(
    command: CatalogReviewEvidenceChoiceCommand,
    workflow: CatalogReviewWorkflow | null,
  ) {
    super("Catalog Review evidence changed; inspect it again before recording the choice.");
    this.name = "CatalogReviewChoiceStaleError";
    this.blockingReasons = [{
      code: "STALE_CATALOG_REVISION",
      message: this.message,
      details: {
        expectedCatalogRevision: command.catalogRevision,
        expectedCheckpointRevision: command.checkpointRevision,
        expectedCheckpointDigest: command.checkpointDigest,
        currentCatalogRevision: workflow?.current.catalogRevision ?? null,
        currentCheckpointRevision:
          workflow?.current.checkpoint?.revision ?? null,
        currentCheckpointDigest:
          workflow?.current.checkpoint?.manifestDigest ?? null,
      },
    }];
    this.current = workflow?.current ?? null;
  }
}

function workflowFor(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
): CatalogReviewWorkflow | null {
  return access.readConsistentSnapshot((snapshot) =>
    describeCatalogReviewWorkflow(snapshot, archiveId)
  );
}

function actionFor(
  workflow: CatalogReviewWorkflow,
  action: CatalogReviewEvidenceChoiceCommand["action"],
): CatalogReviewWorkflowAction {
  const availability = workflow.actions.find((candidate) =>
    candidate.action === action
  );
  if (availability === undefined) {
    throw new DomainInvariantError(
      `Catalog Review workflow is missing ${action} availability`,
    );
  }
  return availability;
}

export function recordCatalogReviewEvidenceChoice(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  command: CatalogReviewEvidenceChoiceCommand,
  mutationKey: unknown,
) {
  const parsedMutationKey = parseMutationKey(mutationKey);
  try {
    const result = access.catalog.recordCatalogReviewEvidenceChoice({
      originalDiscArchiveId: archiveId,
      choice: command.action,
      mutationKey: parsedMutationKey,
      catalogRevision: new Date(command.catalogRevision),
      checkpointRevision: command.checkpointRevision,
      checkpointDigest: command.checkpointDigest,
    });
    return {
      message: command.action === "archive_only"
        ? "Catalog Review set to archive-only"
        : "Catalog Review reopened",
      choice: {
        id: result.choiceId,
        action: result.choice,
        catalogRevision: result.catalogRevision.toISOString(),
        checkpoint: result.checkpoint,
        recovery: result.recovery,
        recordedAt: result.recordedAt.toISOString(),
      },
      archive: {
        id: result.resultingArchive.id,
        catalogReviewedAt:
          result.resultingArchive.catalogReviewedAt?.toISOString() ?? null,
        catalogReviewOutcome: result.resultingArchive.catalogReviewOutcome,
        catalogRevision: result.resultingArchive.updatedAt.toISOString(),
      },
    };
  } catch (error) {
    let workflow: CatalogReviewWorkflow | null = null;
    try {
      workflow = workflowFor(access, archiveId);
    } catch {
      // The transactional writer remains authoritative when even the read
      // model cannot describe corrupt evidence.
    }
    if (error instanceof StaleCatalogRevisionError) {
      throw new CatalogReviewChoiceStaleError(command, workflow);
    }
    if (error instanceof MutationKeyConflictError) throw error;
    if (error instanceof DomainInvariantError && workflow !== null) {
      const availability = actionFor(workflow, command.action);
      if (!availability.available) {
        throw new CatalogReviewChoiceUnavailableError(
          command.action,
          workflow,
        );
      }
    }
    if (error instanceof DomainInvariantError) {
      throw new CatalogReviewChoiceUnavailableError(
        command.action,
        workflow,
        {
          code: "CONSISTENCY_FAULT",
          message:
            "Current Catalog Review evidence failed consistency validation.",
          details: {
            originalDiscArchiveId: archiveId,
            rejectedBy: "transactional_archive_evidence_audit",
          },
        },
      );
    }
    throw error;
  }
}
