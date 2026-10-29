import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { encodeOutputArtifactIdentity, measureEncodeSourceCell, measureEncodeOutputCell, type CorrespondenceMediaTool } from "@rip-dvd/application";
import { seedCorrespondenceClaim } from "./encode-output-correspondence.test-support.js";
import { publishSyntheticClaim, syntheticOutputValidation } from "./encode-output-provenance.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

// Only the external decoder is replaced. Linux media tests use the same
// producer with real MPEG-PS source, canonical MKV, and the supported preset.
function frames(values: readonly string[], start: number) {
  return ["#format: frame checksums", "#version: 2", "#hash: SHA256", "#tb 0: 1/25", "#dimensions 0: 64x64",
    ...values.map((value, index) => `0, ${start + index}, ${start + index}, 1, 6144, ${createHash("sha256").update(value).digest("hex")}`)].join("\n");
}

export async function publishMeasuredCorrespondenceOutput(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  options: { outputFrames?: readonly string[]; decoderFailure?: boolean } = {},
) {
  const seeded = await seedCorrespondenceClaim(fixture, { sharedSource: true, singleCell: { imageContents: Buffer.alloc(100 * 2048, "synthetic source sectors") } });
  try {
    const snapshot = seeded.access.encodeJobs.findClaimSnapshot(seeded.claim.claimToken)!;
    writeFileSync(seeded.claim.outputPath, "synthetic canonical output");
    const runMediaTool: CorrespondenceMediaTool = async (request) => {
      if (options.decoderFailure) throw new Error("Synthetic decoder failure");
      return { stdout: request.arguments_.includes("framehash")
        ? frames(request.arguments_.includes(seeded.claim.outputPath) ? options.outputFrames ?? ["lead", "a", "b", "c", "tail"] : ["a", "b", "c"], 250)
        : JSON.stringify({ streams: [{ width: 64, height: 64, pix_fmt: "yuv420p" }], format: { start_time: "10" } }), stderr: "" };
    };
    const source = await createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }).withConsistentRead({
      archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath, originalsLibraryPath: fixture.originalsLibraryPath,
      signal: new AbortController().signal,
      task: (ownership) => measureEncodeSourceCell(snapshot, seeded.archive.archivePath, ownership, runMediaTool),
    });
    const correspondence = await measureEncodeOutputCell(source, seeded.claim.outputPath, new AbortController().signal, runMediaTool);
    publishSyntheticClaim(seeded.access, seeded.claim, false, { preserveOutput: true, evidence: { ...syntheticOutputValidation, correspondence } });
    return { ...seeded, snapshot, correspondence, artifactIdentity: encodeOutputArtifactIdentity(seeded.claim.id),
      query: { assessmentIdentity: seeded.assessment.id, titleIdentityObservationId: snapshot.source.titleIdentity.id, intervalIndexes: [0] } };
  } catch (error) { seeded.access.close(); throw error; }
}
