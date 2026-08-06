import { writeSync } from "node:fs";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

const [mode, databasePath] = process.argv.slice(2);

if (!mode || !databasePath) {
  throw new Error("Tentative completion kill helper arguments are incomplete");
}

function blockAt(stage) {
  writeSync(1, `${stage}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const access = createLegacySidecarDataAccess({ databasePath });
const job = access.encodeJobs.list()[0];
if (
  !job ||
  !job.partialCleanupOutputPath ||
  !job.partialCleanupClaimToken ||
  !job.publicationPending
) {
  throw new Error("Tentative completion publication provenance is unavailable");
}
const cleanup = {
  jobId: job.id,
  outputPath: job.partialCleanupOutputPath,
  claimToken: job.partialCleanupClaimToken,
  leaseToken: job.partialCleanupLeaseToken,
  publicationPending: job.publicationPending,
};
let identityChecks = 0;
const publicationMatches = () => {
  identityChecks += 1;
  if (identityChecks === 1) {
    return true;
  }
  blockAt("tentative-completed");
  return false;
};

if (mode === "normal") {
  access.encodeJobs.completePublishedClaim(job, cleanup, publicationMatches);
} else if (mode === "recovery") {
  access.encodeJobs.completePublishedPartial(cleanup, publicationMatches);
} else if (mode === "active-mutation") {
  access.encodeJobs.completePublishedMutation(cleanup, publicationMatches);
} else {
  throw new Error(`Unsupported tentative completion mode: ${mode}`);
}
