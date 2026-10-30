import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeOutputFilesystemIdentity } from "@rip-dvd/data-access";
import type { BrowserRenditionAvailability, presentBrowserRendition } from "@rip-dvd/application";
import { publishMeasuredCorrespondenceOutput } from "./encode-output-measured-correspondence.test-support.js";
import { compatibleOutputProbe } from "./encode-output-rendition.test-support.js";
import type { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export const seekProbe = async (path: string) => ({ ...(await compatibleOutputProbe(path)), durationSeconds: 10 });
export const seekOptions = { encodeOutputMediaProbe: seekProbe, browserRenditionsEnabled: true };
export async function seedOutputSeek(fixture: ReturnType<typeof createOperatorWorkflowFixture>, state: "verified" | "absent" | "unknown" = "verified") {
  const seeded = await publishMeasuredCorrespondenceOutput(fixture, {
    sharedSource: state !== "absent", ...(state === "unknown" ? { outputFrames: ["a", "c"] } : {}),
  });
  try {
    const availability = await fixture.run(["encode-output", "rendition-availability", seeded.artifactIdentity], undefined, undefined, seekOptions);
    const review = availability.result as BrowserRenditionAvailability;
    const admission = await fixture.run(["encode-output", "request-rendition", seeded.artifactIdentity, "--key", "synthetic-seek-rendition", "--json", JSON.stringify({ reviewToken: review.reviewToken })], undefined, undefined, seekOptions);
    if (admission.exitCode !== 0) throw new Error("Synthetic seek rendition admission failed");
    const rendition = admission.result as ReturnType<typeof presentBrowserRendition>;
    // Supply finalized worker evidence at the real persistence boundary. These
    // authored bytes and clocks do not stand in for the separate real-media gate.
    const record = seeded.access.browserRenditions.find(rendition.id)!;
    const path = join(fixture.operatorHostPath, "synthetic-view.mp4");
    writeFileSync(path, "synthetic finalized viewing bytes");
    const metadata = lstatSync(path);
    record.status = "complete";
    record.media = { identity: `browser-rendition-v1.${record.id}`, path, filesystemIdentity: encodeOutputFilesystemIdentity(metadata), changeTimeMs: metadata.ctimeMs, sizeBytes: metadata.size };
    record.timeline = { policyVersion: "browser-rendition-exact-video-v1", status: "verified",
      canonicalBytesSha256: createHash("sha256").update(readFileSync(seeded.claim.outputPath)).digest("hex"),
      renditionBytesSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      frames: Array.from({ length: 5 }, (_, index) => ({
        canonical: { startMilliseconds: index * 40, endMilliseconds: (index + 1) * 40 },
        rendition: { startMilliseconds: 2000 + index * 40, endMilliseconds: 2000 + (index + 1) * 40 },
      })),
    };
    seeded.access.browserRenditions.update(record);
    return { ...seeded, renditionId: record.id, query: { ...seeded.query,
      ...(state === "absent" ? { titleIdentityObservationId: seeded.omitted.id } : {}), renditionId: record.id } };
  } catch (error) { seeded.access.close(); throw error; }
}
