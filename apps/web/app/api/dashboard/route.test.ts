import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess } from "@rip-dvd/data-access";
import { afterEach, describe, expect, it } from "vitest";

import { createDashboardResponse } from "./route";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GET /api/dashboard", () => {
  it("returns facade-backed SQLite state over a non-cacheable HTTP response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-api-"));
    temporaryDirectories.push(directory);
    const access = createDataAccess({ databasePath: join(directory, "test.sqlite") });
    access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      displayName: "Archive drive",
      isEnabled: true,
      isPresent: true,
    });

    const response = createDashboardResponse(access);
    access.close();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        opticalDrives: [
          expect.objectContaining({
            displayName: "Archive drive",
            state: "ready",
          }),
        ],
        detectedDiscs: [],
        archiveJobs: [],
        encodeJobs: [],
        catalogReview: [],
      }),
    );
  });

  it("returns a safe service-unavailable response when dashboard reads fail", async () => {
    const response = createDashboardResponse({
      catalog: {
        listOpticalDrives() {
          throw new Error("sensitive database detail");
        },
      },
    } as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "error" });
  });
});
