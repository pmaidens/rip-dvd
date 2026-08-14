import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatalogReviewCoverage } from "@rip-dvd/data-access";

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
      status: "mapped",
      hasOverlap: false,
    },
    {
      titleNumber: 2,
      status: "partially_mapped",
      hasOverlap: true,
    },
    {
      titleNumber: 3,
      status: "unmapped",
      hasOverlap: false,
    },
    {
      titleNumber: 4,
      status: "unmapped",
      hasOverlap: false,
    },
  ],
} satisfies CatalogReviewCoverage;

describe("CatalogReviewCompletion", () => {
  it.each([
    {
      isSaving: true,
      coverage,
      reviewOutcome: "needs_review" as const,
      archiveOnlySelected: false,
    },
    {
      isSaving: false,
      coverage: { ...coverage, discSelectionCount: 0 },
      reviewOutcome: "needs_review" as const,
      archiveOnlySelected: false,
    },
    {
      isSaving: false,
      coverage,
      reviewOutcome: "reviewed_with_selections" as const,
      archiveOnlySelected: false,
    },
    {
      isSaving: false,
      coverage: { ...coverage, discSelectionCount: 0 },
      reviewOutcome: "archive_only" as const,
      archiveOnlySelected: true,
    },
  ])("disables completion when review cannot complete", (props) => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion
        {...props}
        onArchiveOnlyChange={() => undefined}
        onComplete={() => undefined}
      />,
    );

    expect(html).toContain("Completing review removes this archive");
    expect(html).toContain('disabled=""');
  });

  it("reports complete archive coverage beside the inline completion action", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion
        isSaving={false}
        coverage={coverage}
        reviewOutcome="needs_review"
        archiveOnlySelected={false}
        onArchiveOnlyChange={() => undefined}
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
    expect(html).toContain('<button type="submit">Complete review</button>');
    expect(html).toContain("Archive only");
    expect(html).toContain(
      "Archive only is unavailable while Disc Selections are active",
    );
  });

  it("enables zero-selection completion only after the inline Archive-only choice is selected", () => {
    const zeroSelectionCoverage = {
      ...coverage,
      discSelectionCount: 0,
      mediaItemsWithSelections: 0,
      mappedTitles: 0,
      partiallyMappedTitles: 0,
      unmappedTitles: 4,
      mainFeatureSelections: 0,
    };
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion
        isSaving={false}
        coverage={zeroSelectionCoverage}
        reviewOutcome="needs_review"
        archiveOnlySelected
        onArchiveOnlyChange={() => undefined}
        onComplete={() => undefined}
      />,
    );

    expect(html).toContain("Archive only");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain(
      "I intentionally want no content from this archive encoded",
    );
    expect(html).toContain("Complete review");
    expect(html).not.toContain('type="button" disabled=""');
    expect(html).not.toContain("dialog");
  });

  it("shows corrected replacement jobs as explicit unchecked choices with prior defaults", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewCompletion
        isSaving={false}
        coverage={coverage}
        reviewOutcome="needs_review"
        archiveOnlySelected={false}
        replacementPlan={{
          jobs: [{
            predecessorEncodeJobId: "predecessor-1",
            predecessorStatus: "cancellation_requested",
            predecessorReady: false,
            replacementDiscSelectionId: "replacement-selection-1",
            proposedEncodingProfileId: "profile-prior",
            proposedOutputPath: "/media/movies/Prior output.mkv",
          }],
          encodingProfiles: [
            {
              id: "profile-prior",
              displayName: "Prior profile",
              version: 2,
              isActive: false,
            },
            {
              id: "profile-active",
              displayName: "Active profile",
              version: 3,
              isActive: true,
            },
          ],
          jobsPage: {
            offset: 0,
            limit: 100,
            hasPrevious: false,
            hasNext: false,
          },
          encodingProfilesPage: {
            offset: 0,
            limit: 100,
            hasPrevious: false,
            hasNext: false,
          },
        }}
        onArchiveOnlyChange={() => undefined}
        onComplete={() => undefined}
      />,
    );

    expect(html).toContain("Corrected replacement encodes");
    expect(html).toContain("Waiting for previous encode to stop");
    expect(html).toContain("Queue corrected replacement");
    expect(html).toContain("Encode Job predecessor-1");
    expect(html).toContain('name="replacement:predecessor-1:selected"');
    expect(html).not.toContain('name="replacement:predecessor-1:selected" checked');
    expect(html).toContain('value="profile-prior" selected');
    expect(html).toContain('value="/media/movies/Prior output.mkv"');
    expect(html).toContain("Complete review and queue selected replacements");
  });
});
