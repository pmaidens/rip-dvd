import { expect } from "vitest";
import { claimNextEncodeJob, encodeOutputArtifactIdentity, type DamagePreviewInspection, type EncodeOutputInspection, type EncodeOutputMediaProbe } from "@rip-dvd/application";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { seedRetainedDamagePreview } from "./damage-preview.test-support.js";
import { publishSyntheticClaim } from "./encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedProvedPreviewOutput(fixture: ReturnType<typeof createOperatorWorkflowFixture>, options: { differentProfile?: boolean } = {}) {
  const seeded = await seedEncodeClaim(fixture, { clean: true });
  try {
    const previewProfile = options.differentProfile ? seeded.access.encodingProfiles.create({ key: "synthetic-other-preview", displayName: "Synthetic other settings", mediaDomain: "dvd_video", settings: { preset: "Fast 720p30", container: "mkv" } }) : seeded.profile;
    const preview = await seedRetainedDamagePreview(fixture, { ...seeded, profile: previewProfile,
      input: { ...seeded.input, encodingProfileId: previewProfile.id, assessmentIdentity: seeded.assessment!.id, intervalIndexes: [0] } });
    const claim = (await claimNextEncodeJob(seeded.access, "synthetic-retention-output-worker", fixture.originalsLibraryPath))!;
    expect(claim).not.toBeNull();
    const validation = publishSyntheticClaim(seeded.access, claim);
    const identity = encodeOutputArtifactIdentity(claim.id);
    const probe: EncodeOutputMediaProbe = async () => ({ durationSeconds: 500, streams: [] });
    const inspectOutput = async () => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
    const inspectPreview = async () => (await fixture.run(["damage-preview", "inspect", preview.id])).result as DamagePreviewInspection;
    const acknowledge = async (key: string, mediaProbe = probe) => {
      const current = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: mediaProbe })).result as EncodeOutputInspection;
      const result = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", key, "--json", JSON.stringify({ acknowledged: true, reviewToken: current.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: mediaProbe });
      expect(result.exitCode, JSON.stringify(result.result)).toBe(0);
      return result;
    };
    return { ...preview, seeded, claim, identity, validation, probe, inspectOutput, inspectPreview, acknowledge };
  } finally { seeded.access.close(); }
}
