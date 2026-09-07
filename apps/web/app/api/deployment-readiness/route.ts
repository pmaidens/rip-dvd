import type { ConsistentReadAccess, DataAccess } from "@rip-dvd/data-access";

import { getDataAccess } from "../../../lib/data-access";

export const dynamic = "force-dynamic";

function readDeploymentReadiness(access: ConsistentReadAccess) {
  const inspections = access.discInspections
    .list({ currentOnly: true })
    .filter(({ status }) => status === "running")
    .map(({ id, status }) => ({ kind: "disc_inspection", id, status }));
  const archiveRequests = access.archiveRequests
    .list(["pending", "running", "cancellation_requested"])
    .map(({ id, status }) => ({ kind: "archive_request", id, status }));
  const archiveJobs = access.archiveJobs
    .list(["running"])
    .map(({ id, status }) => ({ kind: "archive_job", id, status }));
  const encodeJobs = access.encodeJobs
    .list(["queued", "running", "cancellation_requested"])
    .map(({ id, status }) => ({ kind: "encode_job", id, status }));
  const opticalDrives = access.catalog.listOpticalDrives().map((drive) => ({
    id: drive.id,
    devicePath: drive.devicePath,
    serialNumber: drive.serialNumber,
    isEnabled: drive.isEnabled,
    isPresent: drive.isPresent,
  }));

  return {
    schemaVersion: 1,
    activeWork: [
      ...inspections,
      ...archiveRequests,
      ...archiveJobs,
      ...encodeJobs,
    ],
    opticalDrives,
  };
}

export function createDeploymentReadinessResponse(
  access: DataAccess,
): Response {
  return Response.json(access.readConsistentSnapshot(readDeploymentReadiness), {
    headers: { "Cache-Control": "no-store" },
  });
}

export function GET(): Response {
  try {
    return createDeploymentReadinessResponse(getDataAccess());
  } catch {
    return Response.json(
      { status: "error" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
