import { describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createArchiveRequestsRoute } from "../archive-requests/route";

const dataAccessFixture = useDataAccessFixture();

describe("Archive Requests API", () => {
  it("rejects a missing mutation key before opening data access", async () => {
    const getAccess = vi.fn();
    const response = await createArchiveRequestsRoute(
      new Request("http://localhost:3000/api/archive-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ detectedDiscId: "disc-id" }),
      }),
      getAccess,
      () => "http://localhost:3000",
    );
    expect(response.status).toBe(400);
    expect(getAccess).not.toHaveBeenCalled();
  });

  it("creates durable preservation intent without creating an Archive Job", async () => {
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

    const response = await createArchiveRequestsRoute(
      new Request("http://localhost:3000/api/archive-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          detectedDiscId: disc.id,
          mutationKey: "00000000-0000-4000-8000-000000000001",
        }),
      }),
      () => access,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      archiveRequest: expect.objectContaining({
        detectedDiscId: disc.id,
        status: "pending",
      }),
    });
    expect(body.archiveRequest.claimToken).toBeUndefined();
    expect(access.catalog.listDetectedDiscs(["approved"])).toEqual([
      expect.objectContaining({ id: disc.id }),
    ]);
    expect(access.archiveRequests.list()).toEqual([
      expect.objectContaining({ id: body.archiveRequest.id, status: "pending" }),
    ]);
    expect(access.archiveJobs.list()).toEqual([]);
  });

  it("returns the original web outcome for a repeated key and rejects a changed target", async () => {
    const access = dataAccessFixture.create();
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/sr0",
      isEnabled: true,
      isPresent: true,
    });
    const firstDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "synthetic-web-first",
      volumeLabel: "SYNTHETIC_DISC",
    });
    const secondDisc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "synthetic-web-second",
      volumeLabel: "SYNTHETIC_DISC",
    });
    access.catalog.updateDetectedDiscStatus(firstDisc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(secondDisc.id, "scanned");
    const submit = (detectedDiscId: string) => createArchiveRequestsRoute(
      new Request("http://localhost:3000/api/archive-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          detectedDiscId,
          mutationKey: "00000000-0000-4000-8000-000000000002",
        }),
      }),
      () => access,
      () => "http://localhost:3000",
    );
    const original = await submit(firstDisc.id);
    expect(original.status).toBe(201);
    const outcome = await original.json();
    access.archiveRequests.cancel(outcome.archiveRequest.id);
    const replay = await submit(firstDisc.id);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(outcome);
    const conflict = await submit(secondDisc.id);
    expect(conflict.status).toBe(409);
    expect(access.archiveRequests.list()).toHaveLength(1);
    expect(access.archiveJobs.list()).toEqual([]);
  });

  it("rejects cross-origin approval before opening data access", async () => {
    const getAccess = vi.fn();
    const response = await createArchiveRequestsRoute(
      new Request("http://localhost:3000/api/archive-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "localhost:3000",
          Origin: "https://example.com",
        },
        body: JSON.stringify({ detectedDiscId: "disc-id" }),
      }),
      getAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(403);
    expect(getAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["Origin", { Host: "localhost:3000" }],
    ["Host", { Origin: "http://localhost:3000" }],
  ])("rejects approval without a trusted %s header", async (_name, headers) => {
    const getAccess = vi.fn();
    const response = await createArchiveRequestsRoute(
      new Request("http://localhost:3000/api/archive-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ detectedDiscId: "disc-id" }),
      }),
      getAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(403);
    expect(getAccess).not.toHaveBeenCalled();
  });

  it("rejects a DNS-rebound Host and Origin even when they match the request URL", async () => {
    const getAccess = vi.fn();
    const response = await createArchiveRequestsRoute(
      new Request("http://attacker.example:3000/api/archive-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "attacker.example:3000",
          Origin: "http://attacker.example:3000",
        },
        body: JSON.stringify({ detectedDiscId: "disc-id" }),
      }),
      getAccess,
      () => "http://localhost:3000",
    );

    expect(response.status).toBe(403);
    expect(getAccess).not.toHaveBeenCalled();
  });
});
