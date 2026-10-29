import { claimNextEncodeJob, encodeOutputArtifactIdentity, type BrowserRenditionAvailability, type EncodeOutputMediaProbe, type presentBrowserRendition } from "@rip-dvd/application";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { retainSyntheticFailedOutput } from "./encode-output-failed.test-support.js";

export const compatibleOutputProbe: EncodeOutputMediaProbe = async () => ({ durationSeconds: 10, streams: [
  { index: 0, kind: "video", codecName: "h264", profile: "High", pixelFormat: "yuv420p", level: 41, language: null, title: null, default: true, forced: false },
  { index: 1, kind: "audio", codecName: "aac", profile: "LC", pixelFormat: null, level: null, language: "eng", title: null, default: true, forced: false },
] });
export async function requestSyntheticRendition(fixture: ReturnType<typeof createOperatorWorkflowFixture>, failed = false, media: { probe?: EncodeOutputMediaProbe; canonicalBytes?: Uint8Array } = {}) {
  let identity: string;
  if (failed) {
    const seeded = await seedEncodeClaim(fixture, { continuityRisk: true });
    try {
      const claim = (await claimNextEncodeJob(seeded.access, "synthetic-rendition-worker", fixture.originalsLibraryPath))!;
      const retained = retainSyntheticFailedOutput(seeded.access, claim, fixture.mediaLibraryPath, media.canonicalBytes);
      identity = `encode-output-v1.failed.${retained.id}`;
    } finally { seeded.access.close(); }
  } else {
    const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: media.canonicalBytes ?? "synthetic canonical bytes" });
    identity = encodeOutputArtifactIdentity(predecessor.id);
  }
  const options = { encodeOutputMediaProbe: media.probe ?? compatibleOutputProbe, browserRenditionsEnabled: true };
  const availability = await fixture.run(["encode-output", "rendition-availability", identity], undefined, undefined, options);
  if (availability.exitCode !== 0) throw new Error(JSON.stringify(availability.result));
  const review = availability.result as BrowserRenditionAvailability;
  const args = ["encode-output", "request-rendition", identity, "--key", "synthetic-rendition-request", "--json", JSON.stringify({ reviewToken: review.reviewToken })];
  const admission = await fixture.run(args, undefined, undefined, options);
  if (admission.exitCode !== 0) throw new Error(JSON.stringify(admission.result));
  return { identity, review, args, request: admission.result as ReturnType<typeof presentBrowserRendition> };
}
