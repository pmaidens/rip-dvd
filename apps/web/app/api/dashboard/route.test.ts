import { describe, expect, it } from "vitest";

import { createDashboardResponse, createDashboardRoute } from "./route";
import {
  completeCatalogReview,
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../../../test/data-access-fixture";

const dataAccessFixture = useDataAccessFixture();

describe("GET /api/dashboard", () => {
  it("visits every pending catalog review once when a visible review completes", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const archives = [];
    for (let index = 0; index < 21; index += 1) {
      const fingerprint = `pending-review-${index}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel: `PENDING_${index}`,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      archives.push(access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/Pending ${index}.iso`,
        fingerprint,
      }));
    }

    const firstResponse = createDashboardRoute(
      () => access,
      new Request("http://localhost:3000/api/dashboard"),
    );
    const first = await firstResponse.json();
    const completedArchive = archives.find(
      (archive) => archive.id === first.catalogReview.items[0].id,
    )!;
    const mediaItem = access.catalog.createMediaItem({
      kind: "movie",
      title: "Reviewed movie",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: completedArchive.id,
      mediaItemId: mediaItem.id,
      kind: "main_feature",
    });
    completeCatalogReview(access, completedArchive.id);

    const secondResponse = createDashboardRoute(
      () => access,
      new Request(
        `http://localhost:3000/api/dashboard?catalogReviewCursor=${encodeURIComponent(first.catalogReview.page.nextCursor)}`,
      ),
    );
    const second = await secondResponse.json();
    const finalArchive = archives.find(
      (archive) => archive.id === second.catalogReview.items[0].id,
    )!;
    access.catalog.createDiscSelection({
      originalDiscArchiveId: finalArchive.id,
      mediaItemId: mediaItem.id,
      kind: "main_feature",
    });
    completeCatalogReview(access, finalArchive.id);

    const refreshedSecondResponse = createDashboardRoute(
      () => access,
      new Request(
        `http://localhost:3000/api/dashboard?catalogReviewCursor=${encodeURIComponent(first.catalogReview.page.nextCursor)}`,
      ),
    );
    const refreshedSecond = await refreshedSecondResponse.json();
    const previousResponse = createDashboardRoute(
      () => access,
      new Request(
        `http://localhost:3000/api/dashboard?catalogReviewCursor=${encodeURIComponent(refreshedSecond.catalogReview.page.previousCursor)}`,
      ),
    );
    const previous = await previousResponse.json();

    expect(first.catalogReview.items).toHaveLength(20);
    expect(first.catalogReview.page).toEqual({
      limit: 20,
      previousCursor: null,
      nextCursor: expect.any(String),
    });
    expect(second.catalogReview.items).toHaveLength(1);
    expect(second.catalogReview.page).toEqual({
      limit: 20,
      previousCursor: expect.any(String),
      nextCursor: null,
    });
    expect(refreshedSecond.catalogReview).toEqual({
      status: "loaded",
      items: [],
      page: {
        limit: 20,
        previousCursor: expect.any(String),
        nextCursor: null,
      },
    });
    const visitedIds = [
      ...first.catalogReview.items.map((item: { id: string }) => item.id),
      ...second.catalogReview.items.map((item: { id: string }) => item.id),
    ];
    expect(new Set(visitedIds)).toHaveLength(21);
    expect(new Set(visitedIds)).toEqual(
      new Set(archives.map((archive) => archive.id)),
    );
    expect(
      new Set(
        previous.catalogReview.items.map((item: { id: string }) => item.id),
      ),
    ).toEqual(
      new Set(
        first.catalogReview.items
          .map((item: { id: string }) => item.id)
          .filter(
            (id: string) =>
              id !== completedArchive.id && id !== finalArchive.id,
          ),
      ),
    );
  });

  it("rejects malformed catalog review cursors", async () => {
    const response = createDashboardRoute(
      () => dataAccessFixture.create(),
      new Request(
        "http://localhost:3000/api/dashboard?catalogReviewCursor=not-a-cursor",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid catalog review cursor",
    });
  });

  it("returns facade-backed SQLite state over a non-cacheable HTTP response", async () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });

    const response = createDashboardResponse(access);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        opticalDrives: {
          status: "loaded",
          items: [
            expect.objectContaining({
              displayName: "Archive drive",
              state: "ready",
            }),
          ],
        },
        detectedDiscs: { status: "loaded", items: [] },
        archiveJobs: { status: "loaded", items: [] },
        encodeJobs: { status: "loaded", items: [] },
        catalogReview: { status: "loaded", items: [] },
      }),
    );
    expect(JSON.stringify(body)).not.toContain("/dev/sr0");
  });

  it("serializes independent section failures without hiding healthy sections", async () => {
    const access = dataAccessFixture.create();
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });

    const response = createDashboardResponse(withSnapshotOverrides(access, {
      encodeJobs: {
        list() {
          throw new Error("encode queue unavailable");
        },
      },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        opticalDrives: {
          status: "loaded",
          items: [
            expect.objectContaining({ displayName: "Archive drive" }),
          ],
        },
        encodeJobs: { status: "error" },
      }),
    );
  });

  it("returns a safe service-unavailable response when data access cannot open", async () => {
    const response = createDashboardRoute(() => {
      throw new Error("sensitive database detail");
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "error" });
  });
});
