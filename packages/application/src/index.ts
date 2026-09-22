import type { ConsistentReadAccess, DataAccess } from "@rip-dvd/data-access";

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

export function createApplicationOperations(
  access: Pick<DataAccess, "checkHealth" | "readConsistentSnapshot">,
) {
  return {
    health: () => access.checkHealth(),
    readiness: () => access.readConsistentSnapshot(readDeploymentReadiness),
  };
}
