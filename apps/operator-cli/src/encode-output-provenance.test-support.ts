import { lstatSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { encodeOutputFilesystemIdentity, type DataAccess, type RunningEncodeJob, type EncodeOutputValidationEvidence } from "@rip-dvd/data-access";
import { claimNextEncodeJob } from "@rip-dvd/application";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export const syntheticOutputValidation = {
  policyVersion: "encode-output-validation-v1" as const,
  duration: { expectedSeconds: 500, minimumRatio: 0.98, observedSeconds: 500 },
  video: { codec: "h264", profile: "High", pixelFormat: "yuv420p", firstPacketSeconds: 0 },
  audio: { firstPacketSeconds: 0, expectedSourceIds: [128], outputSourceIds: [128], observedStreams: 1, firstPacketsSeconds: [0] },
  subtitles: { expectedSourceStreams: 0, checked: true as const },
  decode: { seconds: 5, frames: 125, completed: true as const },
};

/** Stand in for validated worker publication, keeping the real ownership transaction. */
export function publishSyntheticClaim(access: DataAccess, claim: RunningEncodeJob, retainPrevious = false,
  options: EncodeOutputValidationEvidence | { evidence: EncodeOutputValidationEvidence; preserveOutput: true } = syntheticOutputValidation) {
  const evidence = "evidence" in options ? options.evidence : options;
  const retainedPath = retainPrevious ? join(realpathSync(dirname(claim.outputPath)), `${basename(claim.outputPath)}.failed.${claim.claimToken}`) : undefined;
  if (retainedPath !== undefined) {
    access.encodeJobs.recordReplacementOutputIdentity(claim, encodeOutputFilesystemIdentity(lstatSync(claim.outputPath)));
  }
  const cleanup = access.encodeJobs.registerPartialCleanup(claim, { publicationPending: true });
  const mutation = access.encodeJobs.beginPublicationMutation(claim, cleanup, retainedPath);
  if (retainedPath !== undefined) renameSync(claim.outputPath, retainedPath);
  if (!("preserveOutput" in options && options.preserveOutput)) writeFileSync(claim.outputPath, `synthetic generation ${claim.claimToken}`);
  const filesystemIdentity = encodeOutputFilesystemIdentity(lstatSync(claim.outputPath));
  const source = access.encodeJobs.findClaimSnapshot(claim.claimToken)?.source;
  const expectedSeconds = source === undefined ? evidence.duration.expectedSeconds : source.output.expectedDurationSeconds;
  const validation = access.encodeJobs.recordOutputValidation(claim, filesystemIdentity, {
    ...evidence,
    duration: { ...evidence.duration, expectedSeconds, minimumRatio: expectedSeconds === null ? null : 0.98 },
  });
  access.encodeJobs.completePublishedClaim(claim, mutation, () => true, {
    ...(retainedPath === undefined ? {} : { retainedOutputPath: retainedPath,
      retainedOutputIdentity: encodeOutputFilesystemIdentity(lstatSync(retainedPath)) }),
    publishedOutputValidation: { result: "passed", completeness: "complete", filesystemIdentity },
  });
  access.encodeJobs.completePartialCleanup(mutation);
  return validation;
}

export async function seedMixedCoverageOutput(fixture: ReturnType<typeof createOperatorWorkflowFixture>) {
  const seeded = await seedEncodeClaim(fixture, { clean: true, otherTitlePartial: true });
  try {
    const claim = (await claimNextEncodeJob(seeded.access, "synthetic-mixed-coverage-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(seeded.access, claim);
    return { job: seeded.job, assessment: seeded.assessment! };
  } finally { seeded.access.close(); }
}
