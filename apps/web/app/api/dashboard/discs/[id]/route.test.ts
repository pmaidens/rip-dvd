import { describe, expect, it } from "vitest";

import { useDataAccessFixture } from "../../../../../test/data-access-fixture";
import { createDashboardDiscDetailResponse } from "./route";

const dataAccessFixture = useDataAccessFixture();

describe("GET /api/dashboard/discs/:id", () => {
  it("returns only the requested Detected Disc version and review details", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const contentId = `sha256:${"a".repeat(64)}`;
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: contentId,
      scanData: {
        schemaVersion: 2,
        contentId,
        titles: [{
          number: 1,
          durationSeconds: 60,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        }],
      },
    });

    const response = createDashboardDiscDetailResponse(
      access,
      disc.id,
      disc.detectedAt.toISOString(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      id: disc.id,
      detectedAt: disc.detectedAt.toISOString(),
      titles: [{
        number: 1,
        durationSeconds: 60,
        chapters: 1,
        audioStreams: [],
        subtitles: [],
      }],
    });
  });

  it("rejects a stale requested version without returning newer details", () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: `sha256:${"b".repeat(64)}`,
    });

    expect(
      createDashboardDiscDetailResponse(
        access,
        disc.id,
        "2026-01-01T00:00:00.000Z",
      ).status,
    ).toBe(409);
  });
});
