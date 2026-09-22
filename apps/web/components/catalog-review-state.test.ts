import { describe, expect, it } from "vitest";

import {
  mutateCatalogReview,
  requestCatalogReview,
  resumePendingCatalogReviewMutation,
} from "./catalog-review-state";

function availablePreview(
  action: "update_disc_selection" | "repair_disc_selection" |
    "correct_disc_selection" | "delete_disc_selection" = "delete_disc_selection",
) {
  return {
    state: "available",
    action,
    catalogRevision: "2026-08-11T06:00:00.000Z",
    previewToken: "preview-token",
    affectedEncodeJobs: [{ id: "encode-job-1", status: "queued" }],
    outputReservationReleaseJobs: [],
    consequences: {
      currentSelection: "deactivated",
      createsReplacementSelection: false,
      requestsEncodeJobCancellation: ["encode-job-1"],
      releasesOutputReservations: [],
      preservesEncodeJobHistory: true,
      reopensCatalogReview: true,
    },
  } as const;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

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

  it("resumes an acknowledged mutation after reload without reconstructing its command", async () => {
    const bodies: Record<string, unknown>[] = [];
    let applyAttempts = 0;
    let confirmations = 0;
    const storage = memoryStorage();
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.preview === true) {
        return Response.json(availablePreview());
      }
      applyAttempts += 1;
      if (applyAttempts === 1) {
        return Response.json({ error: "Upstream response unavailable" }, { status: 503 });
      }
      return Response.json({ message: "Mapping changed; review required" });
    };
    const command = { action: "delete_disc_selection" as const, discSelectionId: "selection-2" };
    const options = {
      storage,
      confirmDiscSelectionPreview: () => {
        confirmations += 1;
        return true;
      },
    };

    await expect(mutateCatalogReview("archive-2", command, fetcher, options))
      .rejects.toThrow("Upstream response unavailable");
    await expect(resumePendingCatalogReviewMutation("archive-2", fetcher, { storage })).resolves.toEqual({
      message: "Mapping changed; review required",
    });

    expect(confirmations).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ ...command, preview: true });
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[1]).toMatchObject({ ...command,
      mutationKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedCatalogRevision: "2026-08-11T06:00:00.000Z",
      previewToken: "preview-token", acknowledge: true });
  });

  it("does not apply a consequential change until its affected jobs are confirmed", async () => {
    const bodies: Record<string, unknown>[] = [];
    const preview = availablePreview();
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return Response.json(preview);
    };
    let inspected: unknown;

    await expect(mutateCatalogReview(
      "archive-3",
      { action: "delete_disc_selection", discSelectionId: "selection-3" },
      fetcher,
      {
        storage: memoryStorage(),
        confirmDiscSelectionPreview: (value) => {
          inspected = value;
          return false;
        },
      },
    )).resolves.toEqual({ message: null, cancelled: true });

    expect(inspected).toEqual(preview);
    expect(bodies).toEqual([{
      action: "delete_disc_selection",
      discSelectionId: "selection-3",
      preview: true,
    }]);
  });

  it("accepts a correction preview that retains a failed job output reservation", async () => {
    const base = availablePreview("correct_disc_selection");
    const preview = {
      ...base,
      affectedEncodeJobs: [{ id: "encode-job-failed", status: "failed" }],
      outputReservationReleaseJobs: [{ id: "encode-job-failed", status: "failed" }],
      consequences: {
        ...base.consequences,
        requestsEncodeJobCancellation: [],
        releasesOutputReservations: [],
      },
    } as const;
    const bodies: Record<string, unknown>[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return body.preview === true
        ? Response.json(preview)
        : Response.json({ message: "Mapping changed; review required" });
    };
    const command = {
      action: "correct_disc_selection" as const,
      discSelectionId: "selection-4",
      catalogRevision: "2026-08-11T06:00:00.000Z",
      selection: {
        mediaItemId: "media-item-2",
        sourceIdentity: { kind: "dvd_title" as const, titleNumber: 2 },
      },
    };

    await expect(mutateCatalogReview("archive-4", command, fetcher, {
      storage: memoryStorage(),
      confirmDiscSelectionPreview: () => true,
    })).resolves.toEqual({ message: "Mapping changed; review required" });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ ...command, preview: true });
    expect(bodies[1]).toMatchObject({ ...command, acknowledge: true });
  });
});
