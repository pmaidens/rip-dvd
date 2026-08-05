import { renameSync, linkSync, writeSync } from "node:fs";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

const [
  mode,
  boundary,
  databasePath,
  finalPath,
  partialPath,
  recoveryPath,
  auxiliaryPath,
] = process.argv.slice(2);

if (
  !mode ||
  !boundary ||
  !databasePath ||
  !finalPath ||
  !partialPath ||
  !recoveryPath
) {
  throw new Error("Mutation fence kill helper arguments are incomplete");
}

function blockAt(stage) {
  writeSync(1, `${stage}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const access = createLegacySidecarDataAccess({ databasePath });

if (mode === "publication") {
  const claim = access.encodeJobs.list(["running"])[0];
  if (!claim) {
    throw new Error("Publication claim is unavailable");
  }
  access.encodeJobs.withClaimMutationFence(claim, () => {
    if (boundary === "post-authority") {
      blockAt("post-authority");
    }
    linkSync(finalPath, recoveryPath);
    if (!auxiliaryPath) {
      throw new Error("Publication replacement path is unavailable");
    }
    linkSync(partialPath, auxiliaryPath);
    if (boundary === "post-replacement-link") {
      blockAt("post-replacement-link");
    }
    renameSync(auxiliaryPath, finalPath);
  });
} else if (mode === "cleanup") {
  if (!auxiliaryPath) {
    throw new Error("Cleanup quarantine path is unavailable");
  }
  const cleanup = access.encodeJobs.listPendingPartialCleanups()[0];
  if (!cleanup) {
    throw new Error("Pending cleanup is unavailable");
  }
  access.encodeJobs.withPartialCleanupMutationFence(cleanup, () => {
    if (boundary === "post-authority") {
      blockAt("post-authority");
    }
    renameSync(finalPath, auxiliaryPath);
    blockAt("post-rename");
  });
} else {
  throw new Error(`Unsupported mutation fence mode: ${mode}`);
}
