import { expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { DvdTitleMap } from "@rip-dvd/data-access";
import { claimNextEncodeJob, encodeOutputArtifactIdentity, validationFailedEncodeOutputArtifactIdentity, type DamagePreviewInspection, type EncodeOutputInspection, type EncodeOutputMediaProbe } from "@rip-dvd/application";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { seedRetainedDamagePreview } from "./damage-preview.test-support.js";
import { publishSyntheticClaim, syntheticOutputValidation } from "./encode-output-provenance.test-support.js";
import { retainSyntheticFailedOutput } from "./encode-output-failed.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

export async function seedProvedPreviewOutput(fixture: ReturnType<typeof createOperatorWorkflowFixture>, options: { differentProfile?: boolean; selectedSubtitle?: boolean; validationFailed?: boolean } = {}) {
  const seeded = await seedEncodeClaim(fixture, { clean: false });
  try {
    if (options.selectedSubtitle) {
      const db = new DatabaseSync(fixture.databasePath);
      try {
        const row = db.prepare("SELECT scan_data FROM detected_discs WHERE id = ?").get(seeded.archive.detectedDiscId)!;
        const scan = JSON.parse(String(row.scan_data)) as DvdTitleMap;
        db.prepare("UPDATE detected_discs SET scan_data = ? WHERE id = ?").run(JSON.stringify({ ...scan, titles: scan.titles.map((title) => ({ ...title, subtitles: [{ id: 32, languageCode: "en" }] })) }), seeded.archive.detectedDiscId);
      } finally { db.close(); }
    }
    const previewProfile = options.differentProfile ? seeded.access.encodingProfiles.create({ key: "synthetic-other-preview", displayName: "Synthetic other settings", mediaDomain: "dvd_video", settings: { preset: "Fast 720p30", container: "mkv" } }) : seeded.profile;
    const preview = await seedRetainedDamagePreview(fixture, { ...seeded, profile: previewProfile,
      input: { ...seeded.input, streams: { ...seeded.input.streams, subtitles: options.selectedSubtitle ? [32] : [] }, encodingProfileId: previewProfile.id, assessmentIdentity: seeded.assessment!.id, intervalIndexes: [0] } });
    const claim = (await claimNextEncodeJob(seeded.access, "synthetic-retention-output-worker", fixture.originalsLibraryPath))!;
    expect(claim).not.toBeNull();
    const failed = options.validationFailed ? retainSyntheticFailedOutput(seeded.access, claim, fixture.mediaLibraryPath) : null;
    const validation = failed ?? publishSyntheticClaim(seeded.access, claim, false, { ...syntheticOutputValidation, subtitles: { expectedSourceStreams: options.selectedSubtitle ? 1 : 0, checked: true } });
    const identity = failed === null ? encodeOutputArtifactIdentity(claim.id) : validationFailedEncodeOutputArtifactIdentity(failed.id);
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
