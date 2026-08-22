import { describe, expect, it } from "vitest";

import { useDataAccessFixture } from "../../test/data-access-fixture";
import {
  beginSettledDiscInspectionForTest,
  startArchiveJob,
} from "../../test/archive-job-fixture";
import { createArchiveRequestCancellationRoute } from "./archive-requests/[id]/route";
import { createArchiveRequestRetryRoute } from "./archive-requests/[id]/retry/route";
import { createArchiveRequestsRoute } from "./archive-requests/route";
import { createDiscInspectionRetryRoute } from "./disc-inspections/[id]/retry/route";

const fixture = useDataAccessFixture();
const trustedOrigin = "http://localhost:3000";

function mutation(
  path: string,
  method: "POST" | "DELETE" = "POST",
  body: unknown = {},
) {
  return new Request(`${trustedOrigin}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: trustedOrigin,
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function scannedDisc() {
  const access = fixture.create();
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    isEnabled: true,
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: `sha256:${"8".repeat(64)}`,
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  return { access, disc, drive };
}

describe("Disc Inspection and Archive Request mutation routes", () => {
  it("cancels a pending Archive Request immediately", async () => {
    const { access, disc } = scannedDisc();
    const archiveRequest = access.archiveRequests.create({ detectedDiscId: disc.id });

    const response = await createArchiveRequestCancellationRoute(
      mutation(`/api/archive-requests/${archiveRequest.id}`, "DELETE"),
      archiveRequest.id,
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      archiveRequest: { id: archiveRequest.id, status: "cancelled" },
    });
  });

  it("creates a new Archive Request after the previous request was cancelled", async () => {
    const { access, disc } = scannedDisc();
    const cancelled = access.archiveRequests.cancel(
      access.archiveRequests.create({ detectedDiscId: disc.id }).id,
    );

    const response = await createArchiveRequestsRoute(
      mutation("/api/archive-requests", "POST", {
        detectedDiscId: disc.id,
      }),
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      archiveRequest: {
        detectedDiscId: disc.id,
        status: "pending",
      },
    });
    expect(access.archiveRequests.list(["cancelled"])).toEqual([
      expect.objectContaining({ id: cancelled.id }),
    ]);
    expect(access.archiveRequests.list(["pending"])).toEqual([
      expect.objectContaining({ detectedDiscId: disc.id }),
    ]);
  });

  it("retries a request needing attention without rewriting its prior attempt", async () => {
    const { access, disc } = scannedDisc();
    const claim = startArchiveJob(access, disc, "failed-route-worker");
    access.archiveJobs.fail(claim, "read failed");

    const response = await createArchiveRequestRetryRoute(
      mutation(`/api/archive-requests/${claim.archiveRequestId}/retry`),
      claim.archiveRequestId,
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(200);
    expect(access.archiveRequests.list(["pending"])).toEqual([
      expect.objectContaining({ id: claim.archiveRequestId }),
    ]);
    expect(access.archiveJobs.list(["failed"])).toEqual([
      expect.objectContaining({ id: claim.id, attemptOrdinal: 1 }),
    ]);
  });

  it("requests retry of the same current failed Disc Inspection", async () => {
    const { access, drive } = scannedDisc();
    const started = beginSettledDiscInspectionForTest(access, {
      opticalDriveId: drive.id,
      mediaGeneration: "route-generation",
      mediaCapacityBytes: 2_048,
    });
    const failed = access.discInspections.record(started.claim!, {
      type: "fail",
      reasonCode: "invalid_metadata",
    });
    started.restoreSystemTime();

    const response = await createDiscInspectionRetryRoute(
      mutation(`/api/disc-inspections/${failed.id}/retry`),
      failed.id,
      () => access,
      () => trustedOrigin,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      inspection: {
        id: failed.id,
        status: "failed",
        phase: "reading_metadata",
      },
    });
    expect(access.discInspections.list({ ids: [failed.id] })[0])
      .toMatchObject({ manualRetryRequestedAt: expect.any(Date) });
  });
});
