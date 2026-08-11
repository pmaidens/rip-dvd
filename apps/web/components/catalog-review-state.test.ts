import { describe, expect, it } from "vitest";

import {
  createCatalogReviewRequestScope,
  mutateCatalogReview,
  requestCatalogReview,
} from "./catalog-review-state";

describe("catalog review request state", () => {
  it("rejects superseded archive loads and old archive continuations", () => {
    const scope = createCatalogReviewRequestScope("archive-a");
    const archiveALoad = scope.begin("archive-a");
    if (archiveALoad === null) {
      throw new Error("Expected archive A load to begin");
    }

    scope.activate("archive-b");
    const archiveBLoad = scope.begin("archive-b");
    if (archiveBLoad === null) {
      throw new Error("Expected archive B load to begin");
    }

    expect(scope.isCurrent("archive-a", archiveALoad)).toBe(false);
    expect(scope.begin("archive-a")).toBeNull();
    expect(scope.isCurrent("archive-b", archiveBLoad)).toBe(true);

    const newerArchiveBLoad = scope.begin("archive-b");
    if (newerArchiveBLoad === null) {
      throw new Error("Expected newer archive B load to begin");
    }
    expect(scope.isCurrent("archive-b", archiveBLoad)).toBe(false);
    expect(scope.isCurrent("archive-b", newerArchiveBLoad)).toBe(true);
  });

  it("rejects the current page load as soon as a replacement page is requested", () => {
    const scope = createCatalogReviewRequestScope("archive-a");
    const firstPageLoad = scope.begin("archive-a");
    if (firstPageLoad === null) {
      throw new Error("Expected first page load to begin");
    }

    scope.invalidate("archive-a");

    expect(scope.isCurrent("archive-a", firstPageLoad)).toBe(false);
    const secondPageLoad = scope.begin("archive-a");
    if (secondPageLoad === null) {
      throw new Error("Expected second page load to begin");
    }
    expect(scope.isCurrent("archive-a", secondPageLoad)).toBe(true);
  });

  it("requests the edited Media Item as context while paging parent choices", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({});
    };

    await requestCatalogReview("archive-1", 100, 200, "episode-1", fetcher);

    expect(requestedUrl).toBe(
      "/api/catalog-reviews/archive-1?mediaOffset=100&selectionOffset=200&editingMediaItemId=episode-1",
    );
  });

  it("reports when removal is blocked to preserve Encode Job history", async () => {
    const fetcher = async () => Response.json({
      error:
        "Disc Selection selection-1 cannot be deleted because Encode Job history must be preserved",
    }, { status: 409 });

    await expect(mutateCatalogReview(
      "archive-1",
      {
        action: "delete_disc_selection",
        discSelectionId: "selection-1",
      },
      fetcher,
    )).rejects.toThrow(
      "Disc Selection selection-1 cannot be deleted because Encode Job history must be preserved",
    );
  });
});
