// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AutomaticCatalogProposal,
  AutomaticCatalogSuggestion,
} from "../lib/catalog-automation";
import { CatalogReviewAutomation } from "./catalog-review-automation";
import type { CatalogReviewDto } from "./catalog-review-model";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function review(selectionCount = 0): CatalogReviewDto {
  return {
    catalogRevision: "2026-08-22T06:00:00.000Z",
    automaticCataloging: { configured: true },
    archive: {
      id: "archive-1",
      discLabel: "THE_IRON_GIANT_1999",
      discKind: "dvd",
      archiveFormat: "iso",
      boundaryEvidence: null,
      integrity: "clean_read",
      badSectorCount: 0,
      badAreaCount: 0,
      badSectorRanges: [],
      archivedAt: "2026-08-22T05:00:00.000Z",
      catalogReviewedAt: null,
      catalogReviewOutcome: "needs_review",
    },
    reviewOutcome: "needs_review",
    rawScan: { titles: [] },
    coverage: {
      discSelectionCount: selectionCount,
      mediaItemsWithSelections: selectionCount,
      mappedTitles: 0,
      partiallyMappedTitles: 0,
      unmappedTitles: 1,
      mainFeatureSelections: selectionCount,
      titles: [{
        titleNumber: 1,
        status: "unmapped",
        hasOverlap: false,
      }],
    },
    mediaItems: [],
    correctionHistory: [],
    correctionEncodeHistory: [],
    correctionRetainedOutputHistory: [],
    correctionHistoryPage: {
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: false,
    },
    correctionEncodeHistoryPage: {
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: false,
    },
    correctionRetainedOutputHistoryPage: {
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: false,
    },
    discSelections: [],
    discSelectionsPage: {
      offset: 0,
      limit: 100,
      hasPrevious: false,
      hasNext: false,
    },
  };
}

function readyMovieSuggestion(): Extract<
  AutomaticCatalogSuggestion,
  { status: "ready" }
> & { proposal: Extract<AutomaticCatalogProposal, { kind: "movie" }> } {
  return {
    status: "ready",
    hints: {
      query: "The Iron Giant",
      formattedLabel: "The Iron Giant 1999",
      year: 1999,
      seasonNumber: null,
      discNumber: null,
      discCount: null,
      likelyKind: "movie",
    },
    proposal: {
      kind: "movie",
      title: "The Iron Giant",
      year: 1999,
      tmdbId: 10_350,
      confidence: "high",
      explanation: "The label and feature-length title agree.",
      scannedTitleCount: 3,
      input: {
        target: {
          choice: "create_new",
          mediaItem: {
            kind: "movie",
            title: "The Iron Giant",
            year: 1999,
            tmdbIdentity: { mediaType: "movie", tmdbId: 10_350 },
          },
        },
        discSelection: { sourceIdentity: { kind: "main_feature" } },
      },
    },
  };
}

describe("CatalogReviewAutomation", () => {
  it("accepts and completes a movie proposal through one action", async () => {
    const suggestion = readyMovieSuggestion();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(suggestion)));
    const onAccept = vi.fn();

    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={review()}
          isSaving={false}
          onAcceptProposal={onAccept}
          onCompleteReview={() => undefined}
        />,
      );
    });
    await act(async () => await Promise.resolve());

    expect(container.textContent).toContain("The Iron Giant (1999)");
    expect(container.textContent).toContain("DVD main feature");
    expect(container.textContent).toContain("This saves the mapping and finishes the review.");
    const useSuggestion = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use this and continue",
    );
    if (!useSuggestion) throw new Error("Expected movie proposal action");
    await act(async () => useSuggestion.click());

    expect(onAccept).toHaveBeenCalledWith(suggestion.proposal);
  });

  it("uses a native focusable button for keyboard confirmation", async () => {
    const suggestion = readyMovieSuggestion();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(suggestion)));
    const onAccept = vi.fn();

    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={review()}
          isSaving={false}
          onAcceptProposal={onAccept}
          onCompleteReview={() => undefined}
        />,
      );
    });
    await act(async () => await Promise.resolve());

    const action = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use this and continue",
    );
    if (!action) throw new Error("Expected movie proposal action");
    action.focus();
    expect(action.tagName).toBe("BUTTON");
    expect(action.type).toBe("button");
    expect(document.activeElement).toBe(action);
    await act(async () => action.click());
    expect(onAccept).toHaveBeenCalledWith(suggestion.proposal);
  });

  it("puts completion at the top once the mapping exists", async () => {
    const onComplete = vi.fn();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={review(1)}
          isSaving={false}
          onAcceptProposal={() => undefined}
          onCompleteReview={onComplete}
        />,
      );
    });
    const finish = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Finish cataloging",
    );
    if (!finish) throw new Error("Expected completion action");
    await act(async () => finish.click());

    expect(onComplete).toHaveBeenCalledWith("reviewed_with_selections", []);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a partial episodic mapping in explicit manual review", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const partialReview = review(1);
    partialReview.coverage = {
      ...partialReview.coverage,
      mappedTitles: 1,
      unmappedTitles: 1,
      mainFeatureSelections: 0,
      titles: [
        { titleNumber: 1, status: "mapped", hasOverlap: false },
        { titleNumber: 2, status: "unmapped", hasOverlap: false },
      ],
    };

    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={partialReview}
          isSaving={false}
          onAcceptProposal={() => undefined}
          onCompleteReview={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Manual review still needed");
    expect(container.textContent).toContain("disc is not resolved");
    expect([...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Finish cataloging",
    )).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes a proposal after the catalog review reloads", async () => {
    const createSuggestion = readyMovieSuggestion();
    const reuseSuggestion: typeof createSuggestion = {
      ...createSuggestion,
      proposal: {
        ...createSuggestion.proposal,
        input: {
          ...createSuggestion.proposal.input,
          target: {
            choice: "use_existing",
            mediaItemId: "movie-1",
            tmdbIdentity: { mediaType: "movie", tmdbId: 10_350 },
          },
        },
      },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(createSuggestion))
      .mockResolvedValueOnce(Response.json(reuseSuggestion));
    vi.stubGlobal("fetch", fetcher);
    const onAccept = vi.fn();
    const initialReview = review();

    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={initialReview}
          isSaving={false}
          onAcceptProposal={onAccept}
          onCompleteReview={() => undefined}
        />,
      );
    });
    await act(async () => await Promise.resolve());
    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={{ ...initialReview }}
          isSaving={false}
          onAcceptProposal={onAccept}
          onCompleteReview={() => undefined}
        />,
      );
    });
    await act(async () => await Promise.resolve());

    expect(fetcher).toHaveBeenCalledTimes(2);
    const useSuggestion = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use this and continue",
    );
    if (!useSuggestion) throw new Error("Expected refreshed movie proposal");
    await act(async () => useSuggestion.click());
    expect(onAccept).toHaveBeenCalledWith(reuseSuggestion.proposal);
  });

  it("shows plausible TMDB matches when identification is ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      message: "TMDB returned more than one plausible match.",
      hints: {
        query: "The Thing",
        formattedLabel: "The Thing",
        year: null,
        seasonNumber: null,
        discNumber: null,
        discCount: null,
        likelyKind: "movie",
      },
      matches: [
        { id: 1, kind: "movie", title: "The Thing", year: 1982 },
        { id: 2, kind: "movie", title: "The Thing", year: 2011 },
      ],
    })));

    await act(async () => {
      root.render(
        <CatalogReviewAutomation
          review={review()}
          isSaving={false}
          onAcceptProposal={() => undefined}
          onCompleteReview={() => undefined}
        />,
      );
    });
    await act(async () => await Promise.resolve());

    expect(container.textContent).toContain("Possible matches");
    expect(container.textContent).toContain("The Thing (1982)");
    expect(container.textContent).toContain("The Thing (2011)");
  });
});
