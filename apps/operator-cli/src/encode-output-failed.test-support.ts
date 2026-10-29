import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeOutputFilesystemIdentity, type DataAccess, type RunningEncodeJob } from "@rip-dvd/data-access";

/** Supply the already-completed worker write at the real persistence boundary. */
export function retainSyntheticFailedOutput(access: DataAccess, claim: RunningEncodeJob, mediaLibraryPath: string, contents: string | Uint8Array = "synthetic complete failed encode") {
  const path = join(mediaLibraryPath, `synthetic-validation-failed-${claim.claimToken}.mkv`);
  writeFileSync(path, contents);
  const metadata = lstatSync(path);
  access.encodeJobs.retainValidationFailedOutput(claim, {
    outputPath: path, changeTimeMs: metadata.ctimeMs, filesystemIdentity: encodeOutputFilesystemIdentity(metadata),
    failure: { schemaVersion: 1, reasonCode: "output_validation_failed", phase: "validation", retryability: "after_action",
      diagnostic: `Synthetic media probe failed for ${path}`, evidence: { kind: "duration", expectedSeconds: 500, observedSeconds: 10 } },
  }, { preserveReplacementAuthority: claim.replaceExistingOutput });
  return access.encodeJobs.listValidationFailedOutputs(claim.id, { limit: 1 })[0]!;
}
