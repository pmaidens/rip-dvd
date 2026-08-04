import { describe, expect, it } from "vitest";

import { createDashboardResponse, createDashboardRoute } from "./route";
import {
  useDataAccessFixture,
  withSnapshotOverrides,
} from "../../../test/data-access-fixture";

const dataAccessFixture = useDataAccessFixture();

describe("GET /api/dashboard", () => {
  it("pages every pending catalog review beyond the activity history bound", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
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
      access.catalog.createOriginalDiscArchive({
        detectedDiscId: disc.id,
        discKind: "dvd",
        archiveFormat: "iso",
        archivePath: `/media/originals/Pending ${index}.iso`,
        fingerprint,
      });
    }

    const firstResponse = createDashboardRoute(
      () => access,
      new Request("http://localhost:3000/api/dashboard?catalogReviewOffset=0"),
    );
    const first = await firstResponse.json();
    const secondResponse = createDashboardRoute(
      () => access,
      new Request("http://localhost:3000/api/dashboard?catalogReviewOffset=20"),
    );
    const second = await secondResponse.json();

    expect(first.catalogReview.items).toHaveLength(20);
    expect(first.catalogReview.page).toEqual({
      offset: 0,
      limit: 20,
      hasPrevious: false,
      hasNext: true,
    });
    expect(second.catalogReview.items).toHaveLength(1);
    expect(second.catalogReview.page).toEqual({
      offset: 20,
      limit: 20,
      hasPrevious: true,
      hasNext: false,
    });
    expect(new Set([
      ...first.catalogReview.items.map((item: { id: string }) => item.id),
      ...second.catalogReview.items.map((item: { id: string }) => item.id),
    ])).toHaveLength(21);
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
