import type { CatalogReviewCoverage } from "../lib/catalog-review-coverage";

interface CatalogReviewCompletionProps {
  isSaving: boolean;
  coverage: CatalogReviewCoverage;
  reviewStatus: "needs_review" | "reviewed";
  onComplete(): void;
}

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
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
            {countLabel(
              coverage.mediaItemsWithSelections,
              "Media Item with Disc Selections",
              "Media Items with Disc Selections",
            )}
          </dd>
        </div>
        <div>
          <dt>Scanned-title coverage</dt>
          <dd>{countLabel(coverage.mappedTitles, "mapped title")}</dd>
          <dd>
            {countLabel(
              coverage.partiallyMappedTitles,
              "partially mapped title",
            )}
          </dd>
          <dd>{countLabel(coverage.unmappedTitles, "unmapped title")}</dd>
        </div>
        <div>
          <dt>Separate archive-level source</dt>
          <dd>
            {countLabel(
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
