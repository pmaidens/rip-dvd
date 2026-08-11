import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogReviewCompletion } from "./catalog-review-completion";

describe("CatalogReviewCompletion", () => {
  it.each([
    { isSaving: true, selectionCount: 1, reviewStatus: "needs_review" as const },
    { isSaving: false, selectionCount: 0, reviewStatus: "needs_review" as const },
    { isSaving: false, selectionCount: 1, reviewStatus: "reviewed" as const },
  ])("disables completion when review cannot complete", (props) => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion {...props} onComplete={() => undefined} />,
    );

    expect(html).toContain("Completing review removes this archive");
    expect(html).toContain('disabled=""');
  });

  it("enables a pending review with a Disc Selection", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion
        isSaving={false}
        selectionCount={1}
        reviewStatus="needs_review"
        onComplete={() => undefined}
      />,
    );

    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Complete review");
  });
});
