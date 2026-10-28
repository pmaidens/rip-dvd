import { createDvdRecoveryEvidenceEncodingTestAccess } from "@rip-dvd/data-access/test-support";
import type { DataAccess } from "@rip-dvd/data-access";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

// Production admission stays closed. Exercise the completed admission contract
// through the public CLI using the existing internal exclusion-test override.
export function openEncodeSourceTestAccess(fixture: ReturnType<typeof createOperatorWorkflowFixture>): DataAccess {
  return createDvdRecoveryEvidenceEncodingTestAccess({ databasePath: fixture.databasePath,
    originalsLibraryPath: fixture.originalsLibraryPath, mediaLibraryPath: fixture.mediaLibraryPath });
}

export function recordSyntheticRecoveryStorage(access: DataAccess) {
  access.dvdRecoveryStorage.record({ contractVersion: "dvd-recovery-storage-preflight-v1", status: "supported", reasonCode: null,
    facts: { filesystemType: "synthetic-local", storageClass: "local", mutationProtection: {
      status: "verified", contract: "linux-rwf-atomic-v1", unitBytes: 4096, memoryAlignmentBytes: 4096,
    }, journalReservationBytes: 1048576, journalPayloadBytes: 983040, journalReservation: "verified",
    journalSynchronization: "verified", imageSynchronization: "verified", checkpointSynchronization: "verified",
    checkpointReplacement: "verified", directorySynchronization: "verified", crossProcessWriterExclusion: "verified",
    crossHostWriterExclusion: "not_applicable", disconnectionBehavior: "not_applicable" } });
}
