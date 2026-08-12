import type {
  CatalogReviewOutcome,
  CompletedCatalogReviewOutcome,
} from "@rip-dvd/data-access";

import type { CatalogReviewCoverage } from "../lib/catalog-review-coverage";
import { formatCountLabel } from "../lib/format-count-label";

interface CatalogReviewCompletionProps {
  isSaving: boolean;
  coverage: CatalogReviewCoverage;
  reviewOutcome: CatalogReviewOutcome;
  archiveOnlySelected: boolean;
  onArchiveOnlyChange(selected: boolean): void;
  onComplete(outcome: CompletedCatalogReviewOutcome): void;
}

export function CatalogReviewCompletion({
  isSaving,
  coverage,
  reviewOutcome,
  archiveOnlySelected,
  onArchiveOnlyChange,
  onComplete,
}: CatalogReviewCompletionProps) {
  const hasSelections = coverage.discSelectionCount > 0;
  const isPending = reviewOutcome === "needs_review";
  const completionOutcome: CompletedCatalogReviewOutcome = hasSelections
    ? "reviewed_with_selections"
    : "archive_only";
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

      <div className="catalog-complete-action">
        <div className="catalog-archive-only-choice">
          <label>
            <input
              type="checkbox"
              checked={!hasSelections && archiveOnlySelected}
              disabled={isSaving || hasSelections || !isPending}
              onChange={(event) => onArchiveOnlyChange(event.target.checked)}
            />
            <span>
              Archive only — I intentionally want no content from this archive
              encoded
            </span>
          </label>
          {hasSelections ? (
            <p className="catalog-help">
              Archive only is unavailable while Disc Selections are active.
            </p>
          ) : (
            <p className="catalog-help">
              Select Archive only explicitly to distinguish this outcome from
              an incomplete review.
            </p>
          )}
        </div>
        <div className="catalog-complete-submit">
          <p>Completing review removes this archive from the dashboard queue.</p>
          <button
            type="button"
            onClick={() => onComplete(completionOutcome)}
            disabled={
              isSaving ||
              !isPending ||
              (!hasSelections && !archiveOnlySelected)
            }
          >
            Complete review
          </button>
        </div>
      </div>
    </section>
  );
}
