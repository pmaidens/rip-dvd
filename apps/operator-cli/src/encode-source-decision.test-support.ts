import { createDvdRecoveryEvidenceEncodingTestAccess } from "@rip-dvd/data-access/test-support";
import type { DataAccess } from "@rip-dvd/data-access";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

// Production admission stays closed. Exercise the completed admission contract
// through the public CLI using the existing internal exclusion-test override.
export function openEncodeSourceTestAccess(fixture: ReturnType<typeof createOperatorWorkflowFixture>): DataAccess {
  return createDvdRecoveryEvidenceEncodingTestAccess({ databasePath: fixture.databasePath,
    originalsLibraryPath: fixture.originalsLibraryPath, mediaLibraryPath: fixture.mediaLibraryPath });
}
