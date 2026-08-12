import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CatalogReviewCoverage } from "../lib/catalog-review-coverage";
import { CatalogReviewCompletion } from "./catalog-review-completion";

const coverage = {
  discSelectionCount: 5,
  mediaItemsWithSelections: 3,
  mappedTitles: 1,
  partiallyMappedTitles: 1,
  unmappedTitles: 2,
  mainFeatureSelections: 1,
  titles: [
    {
      titleNumber: 1,
      durationSeconds: 5_400,
      status: "mapped",
      hasOverlap: false,
    },
    {
      titleNumber: 2,
      durationSeconds: 2_400,
      status: "partially_mapped",
      hasOverlap: true,
    },
    {
      titleNumber: 3,
      durationSeconds: 300,
      status: "unmapped",
      hasOverlap: false,
    },
    {
      titleNumber: 4,
      durationSeconds: 90,
      status: "unmapped",
      hasOverlap: false,
    },
  ],
} satisfies CatalogReviewCoverage;

describe("CatalogReviewCompletion", () => {
  it.each([
    { isSaving: true, coverage, reviewStatus: "needs_review" as const },
    {
      isSaving: false,
      coverage: { ...coverage, discSelectionCount: 0 },
      reviewStatus: "needs_review" as const,
    },
    { isSaving: false, coverage, reviewStatus: "reviewed" as const },
  ])("disables completion when review cannot complete", (props) => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion {...props} onComplete={() => undefined} />,
    );

    expect(html).toContain("Completing review removes this archive");
    expect(html).toContain('disabled=""');
  });

  it("reports complete archive coverage beside the inline completion action", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion
        isSaving={false}
        coverage={coverage}
        reviewStatus="needs_review"
        onComplete={() => undefined}
      />,
    );

    expect(html).toContain("Review Coverage");
    expect(html).toContain("3 Media Items with Disc Selections");
    expect(html).toContain("1 mapped title");
    expect(html).toContain("1 partially mapped title");
    expect(html).toContain("2 unmapped titles");
    expect(html).toContain("1 main-feature selection");
    expect(html).toContain("Coverage always includes the complete archive");
    expect(html).toContain("Complete review");
    expect(html).not.toContain('disabled=""');
  });
});
