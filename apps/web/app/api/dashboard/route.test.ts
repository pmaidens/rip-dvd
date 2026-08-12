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
      sourceIdentity: { kind: "main_feature" },
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
      sourceIdentity: { kind: "main_feature" },
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

  it("keeps Reviewed paging stable when an archive returns to Needs review", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const archives = [];
    for (let index = 0; index < 21; index += 1) {
      const fingerprint = `reviewed-page-${index}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel: `REVIEWED_${index}`,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      const archive = access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/Reviewed ${index}.iso`,
        fingerprint,
      });
      access.catalog.completeCatalogReview(
        archive.id,
        archive.updatedAt,
        "archive_only",
      );
      archives.push(archive);
    }
    const reviewedUrl =
      "http://localhost:3000/api/dashboard?catalogReviewView=reviewed&catalogReviewOutcome=archive_only";
    const first = await createDashboardRoute(
      () => access,
      new Request(reviewedUrl),
    ).json();
    const second = await createDashboardRoute(
      () => access,
      new Request(
        `${reviewedUrl}&catalogReviewCursor=${encodeURIComponent(first.catalogReview.page.nextCursor)}`,
      ),
    ).json();
    const reopenedArchive = archives.find(
      (archive) => archive.id === second.catalogReview.items[0].id,
    )!;
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "New mapping after review",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: reopenedArchive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });

    const refreshedSecond = await createDashboardRoute(
      () => access,
      new Request(
        `${reviewedUrl}&catalogReviewCursor=${encodeURIComponent(first.catalogReview.page.nextCursor)}`,
      ),
    ).json();
    const previous = await createDashboardRoute(
      () => access,
      new Request(
        `${reviewedUrl}&catalogReviewCursor=${encodeURIComponent(refreshedSecond.catalogReview.page.previousCursor)}`,
      ),
    ).json();

    expect(first.catalogReview.items).toHaveLength(20);
    expect(second.catalogReview.items).toHaveLength(1);
    expect(refreshedSecond.catalogReview).toEqual({
      status: "loaded",
      items: [],
      page: {
        limit: 20,
        previousCursor: expect.any(String),
        nextCursor: null,
      },
    });
    expect(previous.catalogReview.items.map((item: { id: string }) => item.id))
      .toEqual(first.catalogReview.items.map((item: { id: string }) => item.id));
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

  it("returns searchable Reviewed Catalog Reviews with outcome summaries", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const createArchive = (suffix: string, volumeLabel: string) => {
      const fingerprint = `reviewed-dashboard-${suffix}`;
      const disc = access.catalog.registerDetectedDisc({
        opticalDriveId: drive.id,
        discKind: "dvd",
        fingerprint,
        volumeLabel,
      });
      access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
      access.catalog.updateDetectedDiscStatus(disc.id, "approved");
      return access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/${suffix}.iso`,
        fingerprint,
      });
    };
    const reviewed = createArchive("selected", "DIFFERENT_LABEL");
    const archiveOnly = createArchive("archive-only", "ARCHIVE_ONLY_DISC");
    const item = access.catalog.createMediaItem({
      kind: "movie",
      title: "Needle Feature",
    });
    access.catalog.createDiscSelection({
      originalDiscArchiveId: reviewed.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    completeCatalogReview(access, reviewed.id);
    access.catalog.completeCatalogReview(
      archiveOnly.id,
      archiveOnly.updatedAt,
      "archive_only",
    );

    const response = createDashboardRoute(
      () => access,
      new Request(
        "http://localhost:3000/api/dashboard?catalogReviewView=reviewed&catalogReviewQuery=needle&catalogReviewOutcome=reviewed_with_selections",
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.catalogReview.items).toEqual([
      expect.objectContaining({
        id: reviewed.id,
        discLabel: "DIFFERENT_LABEL",
        catalogReviewedAt: expect.any(String),
        catalogReviewOutcome: "reviewed_with_selections",
        mappedMediaItemCount: 1,
        mappedMediaItemTitles: ["Needle Feature"],
      }),
    ]);
    expect(body.catalogReview.page).toEqual({
      limit: 20,
      previousCursor: null,
      nextCursor: null,
    });
  });

  it("rejects Reviewed filters on the default Needs review view", async () => {
    const response = createDashboardRoute(
      () => dataAccessFixture.create(),
      new Request(
        "http://localhost:3000/api/dashboard?catalogReviewOutcome=archive_only",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid catalog review filters",
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
