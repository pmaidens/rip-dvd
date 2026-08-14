import { describe, expect, it } from "vitest";

import {
  mutateCatalogReview,
  requestCatalogReview,
} from "./catalog-review-state";

describe("catalog review request state", () => {
  it("requests only the bounded Disc Selection page", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({});
    };

    await requestCatalogReview(
      "archive-1",
      { discSelectionOffset: 200 },
      fetcher,
    );

    expect(requestedUrl).toBe(
      "/api/catalog-reviews/archive-1?selectionOffset=200&correctionOffset=0",
    );
  });

  it("requests a bounded correction-history page independently", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({});
    };

    await requestCatalogReview(
      "archive-1",
      { discSelectionOffset: 100, correctionHistoryOffset: 300 },
      fetcher,
    );

    expect(requestedUrl).toBe(
      "/api/catalog-reviews/archive-1?selectionOffset=100&correctionOffset=300",
    );
  });

  it("requests a bounded correction Encode Job page independently", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({});
    };

    await requestCatalogReview(
      "archive-1",
      {
        discSelectionOffset: 100,
        correctionHistoryOffset: 200,
        correctionEncodeHistoryOffset: 300,
      },
      fetcher,
    );

    expect(requestedUrl).toBe(
      "/api/catalog-reviews/archive-1?selectionOffset=100&correctionOffset=200&correctionJobOffset=300",
    );
  });

  it("requests a bounded correction Retained Output page independently", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({});
    };

    await requestCatalogReview(
      "archive-1",
      {
        discSelectionOffset: 100,
        correctionHistoryOffset: 200,
        correctionEncodeHistoryOffset: 300,
        correctionRetainedOutputHistoryOffset: 400,
      },
      fetcher,
    );

    expect(requestedUrl).toBe(
      "/api/catalog-reviews/archive-1?selectionOffset=100&correctionOffset=200&correctionJobOffset=300&correctionOutputOffset=400",
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
