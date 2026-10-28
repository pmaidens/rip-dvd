import { beforeEach, describe, expect, it, vi } from "vitest";

const listDamagePreviews = vi.fn();
const listOpticalDrives = vi.fn();
const listInspections = vi.fn();
const listArchiveRequests = vi.fn();
const listArchiveJobs = vi.fn();
const listEncodeJobs = vi.fn();
const listVerificationRuns = vi.fn();
const listArchiveAudits = vi.fn();
const listDvdRecoveryReconciliations = vi.fn();
const readDvdRecoveryStoragePreflight = vi.fn();
const readConsistentSnapshot = vi.fn((read: (access: unknown) => unknown) =>
  read({
    catalog: { listOpticalDrives },
    damagePreviews: { list: listDamagePreviews },
    discInspections: { list: listInspections },
    archiveRequests: { list: listArchiveRequests },
    archiveJobs: { list: listArchiveJobs },
    encodeJobs: { list: listEncodeJobs },
    filesystemVerification: { listActive: listVerificationRuns },
    archiveAudits: { listActive: listArchiveAudits },
    dvdRecoveryReconciliations: {
      listActive: listDvdRecoveryReconciliations,
    },
    dvdRecoveryStorage: { readCurrent: readDvdRecoveryStoragePreflight },
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
    listDamagePreviews.mockReturnValue([]);
    listInspections.mockReturnValue([]);
    listArchiveRequests.mockReturnValue([]);
    listArchiveJobs.mockReturnValue([]);
    listEncodeJobs.mockReturnValue([]);
    listVerificationRuns.mockReturnValue([]);
    listArchiveAudits.mockReturnValue([]);
    listDvdRecoveryReconciliations.mockReturnValue([]);
    readDvdRecoveryStoragePreflight.mockReturnValue(null);
  });

  it("returns global active work and authoritative optical-drive identities", async () => {
    listArchiveRequests.mockReturnValue([
      { id: "waiting-for-reinsertion", status: "pending" },
    ]);
    listEncodeJobs.mockReturnValue([{ id: "encode-1", status: "running" }]);
    listDamagePreviews.mockReturnValue([{ id: "preview-1", status: "generating" }, { id: "preview-2", status: "complete" }]);
    listDvdRecoveryReconciliations.mockReturnValue([{
      id: "reconciliation-1",
      status: "queued",
    }]);

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      dvdRecoveryStorage: {
        available: false,
        blockingReasons: [{
          code: "STORAGE_UNSUPPORTED",
          message:
            "The Originals Library storage has not been examined for DVD Archive Recovery.",
        }],
        preflight: {
          contractVersion: "dvd-recovery-storage-preflight-v1",
          status: "unsupported",
          reasonCode: "STORAGE_UNSUPPORTED",
          reason:
            "The Originals Library storage has not been examined for DVD Archive Recovery.",
          facts: null,
          checkedAt: null,
        },
      },
      activeWork: [
        { kind: "damage_preview", id: "preview-1", status: "generating" },
        {
          kind: "archive_request",
          id: "waiting-for-reinsertion",
          status: "pending",
        },
        { kind: "encode_job", id: "encode-1", status: "running" },
        {
          kind: "dvd_recovery_reconciliation",
          id: "reconciliation-1",
          status: "queued",
        },
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
    expect(listDvdRecoveryReconciliations).toHaveBeenCalledWith();
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
