import { describe, expect, it } from "vitest";
import { createApplicationOperations } from "@rip-dvd/application";

import { useDataAccessFixture } from "../../test/data-access-fixture";
import {
  beginSettledDiscInspectionForTest,
  startArchiveJob,
} from "../../test/archive-job-fixture";
import { createArchiveRequestCancellationRoute } from "./archive-requests/[id]/route";
import { createArchiveRequestRetryRoute } from "./archive-requests/[id]/retry/route";
import { createArchiveRequestsRoute } from "./archive-requests/route";
import { createDiscInspectionRetryRoute } from "./disc-inspections/[id]/retry/route";
import { createRearchiveRequestsRoute } from "./rearchive-requests/route";

const fixture = useDataAccessFixture();
const trustedOrigin = "http://localhost:3000";

function mutation(
  path: string,
  method: "POST" | "DELETE" = "POST",
  body: unknown = { mutationKey: "00000000-0000-4000-8000-000000000001" },
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
  it("requires a key and replays web cancellation through shared operations", async () => {
    const { access, disc } = scannedDisc();
    const request = access.archiveRequests.create({ detectedDiscId: disc.id });
    const path = `/api/archive-requests/${request.id}`;
    const missing = await createArchiveRequestCancellationRoute(
      mutation(path, "DELETE", {}), request.id, () => access, () => trustedOrigin,
    );
    expect(missing.status).toBe(400);
    expect(access.archiveRequests.find(request.id)?.status).toBe("pending");
    const key = "00000000-0000-4000-8000-000000000011";
    const invoke = () => createArchiveRequestCancellationRoute(
      mutation(path, "DELETE", { mutationKey: key }), request.id,
      () => access, () => trustedOrigin,
    );
    const first = await invoke();
    expect(first.status).toBe(200);
    const outcome = await first.json();
    expect(await (await invoke()).json()).toEqual(outcome);
    expect(createApplicationOperations(access).cancelArchiveRequest({
      mutationKey: key, archiveRequestId: request.id,
    })).toEqual(outcome);
    const blocked = await createArchiveRequestCancellationRoute(
      mutation(path, "DELETE", { mutationKey: "00000000-0000-4000-8000-000000000012" }),
      request.id, () => access, () => trustedOrigin,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: {
      code: "ACTION_BLOCKED", blockingReasons: [{ code: "INVALID_TRANSITION" }],
    } });
  });

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
        mutationKey: "00000000-0000-4000-8000-000000000001",
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

  it("creates and replays a Re-archive Request through shared application logic", async () => {
    const { access, disc } = scannedDisc();
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const source = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/originals/synthetic-rearchive-source.iso",
      fingerprint: disc.fingerprint,
    });
    const key = "00000000-0000-4000-8000-000000000347";
    const invoke = () => createRearchiveRequestsRoute(
      mutation("/api/rearchive-requests", "POST", {
        mutationKey: key,
        sourceArchiveId: source.id,
      }),
      () => access,
      () => trustedOrigin,
    );

    const first = await invoke();
    expect(first.status).toBe(201);
    const outcome = await first.json();
    expect(outcome).toMatchObject({
      archiveRequest: {
        rearchiveSourceArchiveId: source.id,
        status: "pending",
        waiting: { code: "matching_disc_required" },
      },
    });
    expect(await (await invoke()).json()).toEqual(outcome);
    expect(createApplicationOperations(access).submitRearchiveRequest({
      mutationKey: key,
      sourceArchiveId: source.id,
    })).toEqual(outcome);
    expect(access.archiveRequests.list(["pending"])).toEqual([
      expect.objectContaining({ rearchiveSourceArchiveId: source.id }),
    ]);
    expect(access.archiveRequests.list(["fulfilled"])).toHaveLength(1);
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
