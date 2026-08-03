import { describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createArchiveJobsRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

describe("Archive Jobs API", () => {
  it("approves a scanned Detected Disc and queues preservation without running it", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "dashboard-approval",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");

    const response = await createArchiveJobsRoute(
      new Request("http://localhost/api/archive-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detectedDiscId: disc.id }),
      }),
      () => access,
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      job: expect.objectContaining({
        detectedDiscId: disc.id,
        status: "queued",
        progressPercent: 0,
      }),
    });
    expect(body.job.claimToken).toBeUndefined();
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);
    expect(access.archiveJobs.list()).toEqual([
      expect.objectContaining({ id: body.job.id, status: "queued" }),
    ]);
  });

  it("rejects cross-origin approval before opening data access", async () => {
    const getAccess = vi.fn();
    const response = await createArchiveJobsRoute(
      new Request("http://localhost/api/archive-jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: JSON.stringify({ detectedDiscId: "disc-id" }),
      }),
      getAccess,
    );

    expect(response.status).toBe(403);
    expect(getAccess).not.toHaveBeenCalled();
  });
});
