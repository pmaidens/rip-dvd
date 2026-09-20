import { parentPort, workerData } from "node:worker_threads";

import { readArchiveAuditRecords } from "@rip-dvd/data-access/archive-audit-records";

interface ArchiveAuditRecordWorkerRequest {
  databasePath: string;
  limit: number;
}

function isWorkerRequest(
  value: unknown,
): value is ArchiveAuditRecordWorkerRequest {
  return value !== null &&
    typeof value === "object" &&
    "databasePath" in value &&
    typeof value.databasePath === "string" &&
    "limit" in value &&
    Number.isSafeInteger(value.limit);
}

if (parentPort === null || !isWorkerRequest(workerData)) {
  throw new Error("Archive audit record worker was started incorrectly");
}

try {
  parentPort.postMessage({
    page: readArchiveAuditRecords(workerData.databasePath, workerData.limit),
  });
} catch {
  parentPort.postMessage({ failed: true });
}
