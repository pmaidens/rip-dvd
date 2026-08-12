import type { CatalogReviewCoverage } from "../lib/catalog-review-coverage";
import { formatCountLabel } from "../lib/format-count-label";

interface CatalogReviewCompletionProps {
  isSaving: boolean;
  coverage: CatalogReviewCoverage;
  reviewStatus: "needs_review" | "reviewed";
  onComplete(): void;
}

export function CatalogReviewCompletion({
  isSaving,
  coverage,
  reviewStatus,
  onComplete,
}: CatalogReviewCompletionProps) {
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
        <p>Completing review removes this archive from the dashboard queue.</p>
        <button
          type="button"
          onClick={onComplete}
          disabled={
            isSaving ||
            coverage.discSelectionCount === 0 ||
            reviewStatus === "reviewed"
          }
        >
          Complete review
        </button>
      </div>
    </section>
  );
}
