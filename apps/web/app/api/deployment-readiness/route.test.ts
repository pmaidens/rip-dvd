import { beforeEach, describe, expect, it, vi } from "vitest";

const listOpticalDrives = vi.fn();
const listInspections = vi.fn();
const listArchiveRequests = vi.fn();
const listArchiveJobs = vi.fn();
const listEncodeJobs = vi.fn();
const readConsistentSnapshot = vi.fn((read: (access: unknown) => unknown) =>
  read({
    catalog: { listOpticalDrives },
    discInspections: { list: listInspections },
    archiveRequests: { list: listArchiveRequests },
    archiveJobs: { list: listArchiveJobs },
    encodeJobs: { list: listEncodeJobs },
  }),
);

vi.mock("../../../lib/data-access", () => ({
  getDataAccess: () => ({ readConsistentSnapshot }),
}));

import { GET } from "./route";

describe("GET /api/deployment-readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOpticalDrives.mockReturnValue([
      {
        id: "drive-a",
        devicePath: "/dev/sr1",
        serialNumber: "SERIAL-A",
        isEnabled: true,
        isPresent: true,
      },
    ]);
    listInspections.mockReturnValue([]);
    listArchiveRequests.mockReturnValue([]);
    listArchiveJobs.mockReturnValue([]);
    listEncodeJobs.mockReturnValue([]);
  });

  it("returns global active work and authoritative optical-drive identities", async () => {
    listArchiveRequests.mockReturnValue([
      { id: "waiting-for-reinsertion", status: "pending" },
    ]);
    listEncodeJobs.mockReturnValue([{ id: "encode-1", status: "running" }]);

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      activeWork: [
        {
          kind: "archive_request",
          id: "waiting-for-reinsertion",
          status: "pending",
        },
        { kind: "encode_job", id: "encode-1", status: "running" },
      ],
      opticalDrives: [
        {
          id: "drive-a",
          devicePath: "/dev/sr1",
          serialNumber: "SERIAL-A",
          isEnabled: true,
          isPresent: true,
        },
      ],
    });
    expect(listArchiveRequests).toHaveBeenCalledWith([
      "pending",
      "running",
      "cancellation_requested",
    ]);
  });

  it("fails closed when any readiness query fails", async () => {
    listArchiveRequests.mockImplementation(() => {
      throw new Error("database detail");
    });

    const response = GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "error" });
  });
});
