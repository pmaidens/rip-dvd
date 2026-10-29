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
  options: { outputFrames?: readonly string[]; decoderFailure?: boolean; outputOffsetMilliseconds?: number;
    incompleteNativeFrames?: boolean; sourceFault?: "zeroed_sector" | "encrypted_packet"; legacyFrameDuration?: boolean;
    sourceMissingPts?: boolean; outputMissingPts?: boolean; outputFirstPts?: number; outputOriginSeconds?: number } = {},
) {
  const imageContents = Buffer.alloc(100 * 2048, 0xff);
  for (let offset = 0; offset < imageContents.length; offset += 2048) {
    imageContents.set([0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0, 0, 3, 0], offset);
    imageContents.set([0, 0, 1, 0xe0, 7, 0xec, 0x80, 0, 0], offset + 14);
  }
  if (options.sourceFault === "zeroed_sector") imageContents.fill(0, 10 * 2048, 11 * 2048);
  if (options.sourceFault === "encrypted_packet") imageContents[20] = 0xa0;
  const seeded = await seedCorrespondenceClaim(fixture, { sharedSource: true, singleCell: { imageContents } });
  try {
    const snapshot = seeded.access.encodeJobs.findClaimSnapshot(seeded.claim.claimToken)!;
    writeFileSync(seeded.claim.outputPath, "synthetic canonical output");
    const runMediaTool: CorrespondenceMediaTool = async (request) => {
      if (options.decoderFailure) throw new Error("Synthetic decoder failure");
      const output = request.arguments_.includes(seeded.claim.outputPath);
      const values = output ? options.outputFrames ?? ["lead", "a", "b", "c", "tail"] : ["a", "b", "c"];
      const measuredValues = options.incompleteNativeFrames ? values.slice(1) : values;
      const offset = request.arguments_.includes(seeded.claim.outputPath) ? options.outputOffsetMilliseconds ?? 0 : 0;
      const firstPts = output ? options.outputFirstPts ?? 10000 : 10000;
      const origin = output ? options.outputOriginSeconds ?? 10 : 10;
      return { stdout: request.arguments_.includes("framehash")
        ? frames(values, 250)
        : JSON.stringify({ streams: [{ width: 64, height: 64, pix_fmt: "yuv420p", time_base: "1/1000" }],
          frames: measuredValues.map((_, index) => ({ ...((output ? options.outputMissingPts : options.sourceMissingPts) && index > 0 ? {} : { pts: firstPts + offset + index * 40 }),
            ...(options.legacyFrameDuration ? { pkt_duration: 40 } : { duration: 40 }) })), format: { start_time: String(origin) } }), stderr: "" };
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
