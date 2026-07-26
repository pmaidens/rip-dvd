import { describe, expect, it } from "vitest";

import { createDashboardResponse, createDashboardRoute } from "./route";
import { useDataAccessFixture } from "../../../test/data-access-fixture";

const dataAccessFixture = useDataAccessFixture();

describe("GET /api/dashboard", () => {
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

    const response = createDashboardResponse({
      ...access,
      encodeJobs: {
        ...access.encodeJobs,
        list() {
          throw new Error("encode queue unavailable");
        },
      },
    });
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
