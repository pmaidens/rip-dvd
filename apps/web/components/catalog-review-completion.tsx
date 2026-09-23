import type {
  CatalogReviewCoverage,
  CatalogReviewActionAvailability,
  CatalogReviewOutcome,
  CompletedCatalogReviewOutcome,
} from "@rip-dvd/data-access";
import { useEffect, useState } from "react";

import { formatCountLabel } from "../lib/format-count-label";
import type { CatalogReviewReplacementPlan } from "./catalog-review-model";
import type { CatalogReviewReplacementEncodeInput } from "../lib/catalog-review-command";
import { CatalogReviewReplacementEncodes } from "./catalog-review-replacement-encodes";

interface CatalogReviewCompletionProps {
  isSaving: boolean;
  coverage: CatalogReviewCoverage;
  actionAvailability: CatalogReviewActionAvailability;
  reviewOutcome: CatalogReviewOutcome;
  archiveOnlySelected: boolean;
  replacementPlan?: CatalogReviewReplacementPlan;
  onArchiveOnlyChange(selected: boolean): void;
  onReplacementJobsPage?(offset: number): void;
  onReplacementProfilesPage?(offset: number): void;
  onComplete(
    outcome: CompletedCatalogReviewOutcome,
    replacements: CatalogReviewReplacementEncodeInput[],
  ): void;
}

export function CatalogReviewCompletion({
  isSaving,
  coverage,
  actionAvailability,
  reviewOutcome,
  archiveOnlySelected,
  replacementPlan,
  onArchiveOnlyChange,
  onReplacementJobsPage = () => undefined,
  onReplacementProfilesPage = () => undefined,
  onComplete,
}: CatalogReviewCompletionProps) {
  const hasSelections = coverage.discSelectionCount > 0;
  const isPending = reviewOutcome === "needs_review";
  const canCompleteWithSelections =
    actionAvailability.completeWithSelections.state === "available";
  const canCompleteArchiveOnly =
    actionAvailability.completeArchiveOnly.state === "available";
  const completionAvailability = hasSelections
    ? actionAvailability.completeWithSelections
    : actionAvailability.completeArchiveOnly;
  const completionOutcome: CompletedCatalogReviewOutcome = hasSelections
    ? "reviewed_with_selections"
    : "archive_only";
  const [selectedReplacements, setSelectedReplacements] = useState(
    new Map<string, CatalogReviewReplacementEncodeInput>(),
  );
  useEffect(() => {
    if (replacementPlan === undefined) {
      setSelectedReplacements((current) =>
        current.size === 0 ? current : new Map()
      );
    }
  }, [replacementPlan]);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onComplete(completionOutcome, [...selectedReplacements.values()]);
  };
  return (
    <section
      className="catalog-complete"
      aria-labelledby="catalog-review-coverage"
    >
      <h3 id="catalog-review-coverage">Review Coverage</h3>
      <p className="catalog-help">
        Coverage always includes the complete archive, regardless of title
        filters or collapsed sections.
      </p>
      <dl className="catalog-coverage-summary">
        <div>
          <dt>Cataloged output</dt>
          <dd>
            {formatCountLabel(
              coverage.mediaItemsWithSelections,
              "Media Item with Disc Selections",
              "Media Items with Disc Selections",
            )}
          </dd>
        </div>
        <div>
          <dt>Scanned-title coverage</dt>
          <dd>{formatCountLabel(coverage.mappedTitles, "mapped title")}</dd>
          <dd>
            {formatCountLabel(
              coverage.partiallyMappedTitles,
              "partially mapped title",
            )}
          </dd>
          <dd>
            {formatCountLabel(coverage.unmappedTitles, "unmapped title")}
          </dd>
        </div>
        <div>
          <dt>Separate archive-level source</dt>
          <dd>
            {formatCountLabel(
              coverage.mainFeatureSelections,
              "main-feature selection",
            )}
          </dd>
        </div>
      </dl>

      <form className="catalog-complete-action" onSubmit={submit}>
        {replacementPlan ? (
          <CatalogReviewReplacementEncodes
            isSaving={isSaving}
            isAvailable={canCompleteWithSelections}
            replacementPlan={replacementPlan}
            selectedReplacements={selectedReplacements}
            onSelectionChange={setSelectedReplacements}
            onJobsPage={onReplacementJobsPage}
            onProfilesPage={onReplacementProfilesPage}
          />
        ) : null}
        <div className="catalog-archive-only-choice">
          <label>
            <input
              type="checkbox"
              aria-describedby="catalog-archive-only-explanation"
              checked={!hasSelections && archiveOnlySelected}
              disabled={isSaving || !canCompleteArchiveOnly}
              onChange={(event) => onArchiveOnlyChange(event.target.checked)}
            />
            <span>
              Archive only — I intentionally want no content from this archive
              encoded
            </span>
          </label>
          {hasSelections ? (
            <p className="catalog-help" id="catalog-archive-only-explanation">
              Archive only is unavailable while Disc Selections are active.
            </p>
          ) : (
            <p className="catalog-help" id="catalog-archive-only-explanation">
              Select Archive only explicitly to distinguish this outcome from
              an incomplete review.
            </p>
          )}
        </div>
        <div className="catalog-complete-submit">
          <p id="catalog-complete-explanation">
            Completing review removes this archive from the dashboard queue.
            {!isPending
              ? " This Catalog Review is already complete."
              : completionAvailability.state === "blocked"
                ? ` ${completionAvailability.reason}`
              : !hasSelections && !archiveOnlySelected
                ? " Select Archive only before completing a review with no Disc Selections."
                : null}
          </p>
          <button
            type="submit"
            aria-describedby="catalog-complete-explanation"
            disabled={
              isSaving ||
              completionAvailability.state === "blocked" ||
              (!hasSelections && !archiveOnlySelected)
            }
          >
            {replacementPlan
              ? "Complete review and queue selected replacements"
              : "Complete review"}
          </button>
        </div>
      </form>
    </section>
  );
}
