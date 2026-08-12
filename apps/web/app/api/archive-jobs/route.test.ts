import { describe, expect, it, vi } from "vitest";

import { useDataAccessFixture } from "../../../test/data-access-fixture";
import { createArchiveRequestsRoute } from "../archive-requests/route";

const dataAccessFixture = useDataAccessFixture();

describe("Archive Requests API", () => {
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
        body: JSON.stringify({ detectedDiscId: disc.id }),
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
