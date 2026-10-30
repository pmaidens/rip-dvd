import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { DamagePreviewRenditionAvailability, EncodeOutputMediaProbe, presentBrowserRendition } from "@rip-dvd/application";
import type { DamagePreviewStatus } from "@rip-dvd/data-access";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedRetainedDamagePreview } from "./damage-preview.test-support.js";
import { compatibleOutputProbe } from "./encode-output-rendition.test-support.js";

export async function requestSyntheticPreviewRendition(fixture: ReturnType<typeof createOperatorWorkflowFixture>, options: {
  probe?: EncodeOutputMediaProbe; canonicalBytes?: Uint8Array; generationStatus?: DamagePreviewStatus;
  durationMilliseconds?: number; burnSubtitleIndex?: number;
} = {}) {
  const preview = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  try {
    const record = access.damagePreviews.find(preview.id)!;
    if (options.canonicalBytes) {
      writeFileSync(preview.path, options.canonicalBytes);
      record.artifacts[0]!.sha256 = createHash("sha256").update(options.canonicalBytes).digest("hex");
      record.artifacts[0]!.sizeBytes = options.canonicalBytes.length;
    }
    if (options.generationStatus) record.status = options.generationStatus;
    if (options.durationMilliseconds) {
      record.artifacts[0]!.durationMilliseconds = options.durationMilliseconds;
      record.artifacts[0]!.coverage = { startMilliseconds: 1000, endMilliseconds: 1000 + options.durationMilliseconds };
    }
    record.artifacts[0]!.coverageMethod = "handbrake_seek_and_probed_video_packets";
    access.damagePreviews.update(record);
  } finally { access.close(); }
  const identity = `damage-preview-v1.${preview.id}.0`;
  const cliOptions = { encodeOutputMediaProbe: options.probe ?? compatibleOutputProbe, browserRenditionsEnabled: true };
  const selection = options.burnSubtitleIndex === undefined ? {} : { burnSubtitleIndex: options.burnSubtitleIndex };
  const reviewResult = await fixture.run(["damage-preview", "rendition-availability", identity, "--json", JSON.stringify(selection)], undefined, undefined, cliOptions);
  if (reviewResult.exitCode !== 0) throw new Error(JSON.stringify(reviewResult.result));
  const review = reviewResult.result as DamagePreviewRenditionAvailability;
  const args = ["damage-preview", "request-rendition", identity, "--key", "synthetic-preview-rendition-request", "--json", JSON.stringify({ reviewToken: review.reviewToken, ...selection })];
  const admission = await fixture.run(args, undefined, undefined, cliOptions);
  if (admission.exitCode !== 0) throw new Error(JSON.stringify(admission.result));
  return { ...preview, identity, review, args, cliOptions, request: admission.result as ReturnType<typeof presentBrowserRendition> };
}
