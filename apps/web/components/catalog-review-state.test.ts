import { describe, expect, it } from "vitest";

import {
  mutateCatalogReview,
  requestCatalogReview,
} from "./catalog-review-state";

describe("catalog review request state", () => {
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
