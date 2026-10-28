import type {
  CatalogReviewWorkflow,
  CatalogReviewWorkflowAction,
} from "@rip-dvd/application";

function mappingLabel(state: CatalogReviewWorkflow["facts"]["mappingState"]) {
  switch (state) {
    case "mapped":
      return "Mapped";
    case "needs_mapping_review":
      return "Mapping review required";
    case "unmapped":
      return "Unmapped content remains";
    case "pending":
      return "Mapping evidence pending";
  }
}

function recoveryLabel(
  workflow: CatalogReviewWorkflow,
): string {
  switch (workflow.current.recovery?.state) {
    case "eligible":
      return "Eligible for recovery";
    case "running":
      return "Recovering";
    case "paused":
      return "Paused after no progress";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "completed":
      return "Complete";
    case "faulted":
      return "Faulted";
    default:
      return "State unavailable";
  }
}

function identity(value: string | number | null): string {
  return value === null ? "Unavailable" : String(value);
}

export function CatalogReviewWorkflowFacts({
  workflow,
  compact = false,
}: {
  workflow: CatalogReviewWorkflow;
  compact?: boolean;
}) {
  return (
    <dl className={compact
      ? "catalog-workflow-facts catalog-workflow-facts-compact"
      : "catalog-workflow-facts"}
    >
      <div>
        <dt>Initial Archive Job</dt>
        <dd>{workflow.facts.saved ? "Saved" : "Not saved"}</dd>
      </div>
      <div>
        <dt>Archive Recovery</dt>
        <dd>{recoveryLabel(workflow)}</dd>
      </div>
      <div>
        <dt>Catalog mapping</dt>
        <dd>{mappingLabel(workflow.facts.mappingState)}</dd>
      </div>
      <div>
        <dt>Catalog Review choice</dt>
        <dd>{workflow.facts.archiveOnly ? "Archive only" : "Open"}</dd>
      </div>
      <div>
        <dt>Damage decision</dt>
        <dd>{workflow.facts.readyForDamageDecision
          ? "Ready"
          : "Not ready"}</dd>
      </div>
      <div>
        <dt>Encoding readiness</dt>
        <dd>{workflow.facts.readyForEncoding ? "Ready" : "Not ready"}</dd>
      </div>
    </dl>
  );
}

export function CatalogReviewRecoveryStep({
  workflow,
}: {
  workflow: CatalogReviewWorkflow;
}) {
  return (
    <div className="catalog-review-step-content">
      <h3>Recovery</h3>
      <p className="catalog-help">
        The initial Archive Job is separate from ongoing Archive Recovery.
        Catalog mapping remains available while recovery runs.
      </p>
      <CatalogReviewWorkflowFacts workflow={workflow} />
      <details className="catalog-workflow-identities">
        <summary>Current workflow identities</summary>
        <dl className="catalog-summary-list">
          <div>
            <dt>Original Disc Archive</dt>
            <dd>{workflow.current.originalDiscArchiveId}</dd>
          </div>
          <div>
            <dt>Catalog revision</dt>
            <dd>{workflow.current.catalogRevision}</dd>
          </div>
          <div>
            <dt>Initial Archive Job</dt>
            <dd>{identity(workflow.current.archiveJob?.id ?? null)}</dd>
          </div>
          <div>
            <dt>Archive Recovery</dt>
            <dd>{identity(workflow.current.recovery?.id ?? null)}</dd>
          </div>
          <div>
            <dt>Recovery attempt</dt>
            <dd>{identity(workflow.current.recovery?.attemptId ?? null)}</dd>
          </div>
          <div>
            <dt>Checkpoint revision</dt>
            <dd>{identity(workflow.current.checkpoint?.revision ?? null)}</dd>
          </div>
          <div>
            <dt>Checkpoint manifest digest</dt>
            <dd>{identity(
              workflow.current.checkpoint?.manifestDigest ?? null,
            )}</dd>
          </div>
          <div>
            <dt>Catalog mapping projection</dt>
            <dd>{identity(workflow.current.catalogMappingProjectionId)}</dd>
          </div>
          <div>
            <dt>Title Damage Assessment</dt>
            <dd>{identity(workflow.current.titleDamageAssessmentId)}</dd>
          </div>
        </dl>
      </details>
      {workflow.choiceHistory.length === 0 ? null : (
        <details className="catalog-workflow-identities">
          <summary>Archive-only choice history</summary>
          <ol className="catalog-workflow-history">
            {workflow.choiceHistory.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.choice === "archive_only"
                  ? "Kept archive only"
                  : "Reopened Catalog Review"}</strong>
                <span>
                  {` at checkpoint ${entry.checkpoint.revision} while Recovery was ${entry.recovery.state} (${entry.recordedAt})`}
                </span>
              </li>
            ))}
          </ol>
          {workflow.choiceHistoryPage.truncated ? (
            <p className="catalog-help">
              Showing the 100 most recent choices. Older choices remain
              retained.
            </p>
          ) : null}
        </details>
      )}
    </div>
  );
}

export function CatalogReviewMappingStatus({
  workflow,
}: {
  workflow: CatalogReviewWorkflow;
}) {
  const action = actionFor(workflow, "catalog_mapping");
  if (action.available) return null;

  return (
    <section
      className="catalog-pane catalog-mapping-status"
      aria-labelledby="catalog-mapping-status-heading"
    >
      <h3 id="catalog-mapping-status-heading">
        Catalog mapping availability
      </h3>
      <p className="catalog-help">
        Catalog mapping is unavailable for the current workflow evidence.
        Draft values are preserved.
      </p>
      <ul className="catalog-workflow-reasons">
        {action.reasons.map((reason) => (
          <li key={reason.code}>
            <code>{reason.code}</code>
            <span>{reason.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function actionFor(
  workflow: CatalogReviewWorkflow,
  action: CatalogReviewWorkflowAction["action"],
) {
  const result = workflow.actions.find((candidate) =>
    candidate.action === action
  );
  if (result === undefined) {
    throw new Error(`Catalog Review workflow is missing ${action}`);
  }
  return result;
}

export function CatalogReviewDamageDecisionStatus({
  workflow,
  isSaving = false,
  onChoice = () => undefined,
}: {
  workflow: CatalogReviewWorkflow;
  isSaving?: boolean;
  onChoice?(choice: "archive_only" | "reopen"): void;
}) {
  const action = actionFor(workflow, "damage_decision");
  const choiceAction = workflow.facts.archiveOnly
    ? actionFor(workflow, "reopen")
    : actionFor(workflow, "archive_only");
  const choice = workflow.facts.archiveOnly ? "reopen" : "archive_only";
  return (
    <section
      className="catalog-pane catalog-damage-decision"
      aria-labelledby="catalog-damage-decision-heading"
    >
      <h3 id="catalog-damage-decision-heading">Damage decision readiness</h3>
      {action.available ? (
        <p className="catalog-help">
          Recovery, assessment, and mapping prerequisites are current.
        </p>
      ) : (
        <>
          <p className="catalog-help">
            {workflow.facts.readyForDamageDecision
              ? "Recovery, assessment, and mapping prerequisites are current, but the damage decision operation is not available yet."
              : "Damage decisions remain unavailable. Catalog mapping can continue."}
          </p>
          <ul className="catalog-workflow-reasons">
            {action.reasons.map((reason) => (
              <li key={reason.code}>
                <code>{reason.code}</code>
                <span>{reason.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="catalog-review-evidence-choice">
        <h4>{workflow.facts.archiveOnly
          ? "Reopen Catalog Review"
          : "Keep archive only"}</h4>
        <p className="catalog-help">
          {workflow.facts.archiveOnly
            ? "Reopen against the current checkpoint. This does not queue encoding or restore an expired damage acceptance."
            : "Keep the saved archive without accepting damage or starting encoding. Recovery may run again later, but encoding stays blocked until this review is reopened."}
        </p>
        <button
          type="button"
          disabled={isSaving || !choiceAction.available}
          onClick={() => onChoice(choice)}
        >
          {workflow.facts.archiveOnly
            ? "Reopen Catalog Review"
            : "Keep archive only"}
        </button>
        {choiceAction.available ? null : (
          <ul className="catalog-workflow-reasons">
            {choiceAction.reasons.map((reason) => (
              <li key={reason.code}>
                <code>{reason.code}</code>
                <span>{reason.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
