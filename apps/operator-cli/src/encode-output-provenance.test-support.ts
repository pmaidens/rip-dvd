import { lstatSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { encodeOutputFilesystemIdentity, type DataAccess, type RunningEncodeJob } from "@rip-dvd/data-access";

export const syntheticOutputValidation = {
  policyVersion: "encode-output-validation-v1" as const,
  duration: { expectedSeconds: 500, minimumRatio: 0.98, observedSeconds: 500 },
  video: { codec: "h264", profile: "High", pixelFormat: "yuv420p", firstPacketSeconds: 0 },
  audio: { firstPacketSeconds: 0, expectedStreams: 1, observedStreams: 1 },
  subtitles: { expectedSourceStreams: 0, checked: true as const },
  decode: { seconds: 5, frames: 125, completed: true as const },
};

/** Stand in for validated worker publication, keeping the real ownership transaction. */
export function publishSyntheticClaim(access: DataAccess, claim: RunningEncodeJob, retainPrevious = false) {
  const retainedPath = retainPrevious ? join(realpathSync(dirname(claim.outputPath)), `${basename(claim.outputPath)}.failed.${claim.claimToken}`) : undefined;
  if (retainedPath !== undefined) {
    access.encodeJobs.recordReplacementOutputIdentity(claim, encodeOutputFilesystemIdentity(lstatSync(claim.outputPath)));
  }
  const cleanup = access.encodeJobs.registerPartialCleanup(claim, { publicationPending: true });
  const mutation = access.encodeJobs.beginPublicationMutation(claim, cleanup, retainedPath);
  if (retainedPath !== undefined) renameSync(claim.outputPath, retainedPath);
  writeFileSync(claim.outputPath, `synthetic generation ${claim.claimToken}`);
  const filesystemIdentity = encodeOutputFilesystemIdentity(lstatSync(claim.outputPath));
  const validation = access.encodeJobs.recordOutputValidation(claim, filesystemIdentity, syntheticOutputValidation);
  access.encodeJobs.completePublishedClaim(claim, mutation, () => true, {
    ...(retainedPath === undefined ? {} : { retainedOutputPath: retainedPath,
      retainedOutputIdentity: encodeOutputFilesystemIdentity(lstatSync(retainedPath)) }),
    publishedOutputValidation: { result: "passed", completeness: "complete", filesystemIdentity },
  });
  access.encodeJobs.completePartialCleanup(mutation);
  return validation;
}
