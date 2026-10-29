import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DamagePreviewAvailability, DamagePreviewInspection, EncodeOutputInspection, EncodeOutputInspectionReceipt } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { publishMeasuredCorrespondenceOutput } from "./encode-output-measured-correspondence.test-support.js";
import { settleDamagePreviewMedia } from "./damage-preview.test-support.js";
import { withdrawClaimAcceptance } from "./encode-claim.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });

it("does not upgrade an unknown receipt after verified measured location or source withdrawal", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await publishMeasuredCorrespondenceOutput(fixture);
  try {
    const source = seeded.snapshot.source;
    const selection = { mode: "ordinary_playback", titleIdentityObservationId: source.titleIdentity.id,
      playbackRange: { startMilliseconds: 0, endMilliseconds: 5_000 }, intervalIndexes: [],
      assessmentIdentity: source.assessment.id, streams: { audio: [128], subtitles: [] }, encodingProfileId: source.profile.id };
    const availability = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(selection)])).result as DamagePreviewAvailability;
    const requested = await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-measured-preview", "--json", JSON.stringify({ selection, preflightToken: availability.preflightToken })]);
    expect(requested.exitCode, JSON.stringify(requested.result)).toBe(0);
    const record = seeded.access.damagePreviews.claim("synthetic-measured-preview-worker")!;
    const directory = join(fixture.mediaLibraryPath, ".damage-previews", record.id); mkdirSync(directory, { recursive: true });
    const path = join(directory, "0.mkv"); const bytes = Buffer.from("synthetic measured-source preview"); writeFileSync(path, bytes);
    record.status = "complete";
    record.artifacts = [{ identity: `damage-preview-v1.${record.id}.0`, path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
      mediaType: "video/x-matroska", durationMilliseconds: 5_000, coverage: selection.playbackRange }];
    seeded.access.damagePreviews.update(record);
    const unknownProbe = async () => { throw new Error("Synthetic unavailable output probe"); };
    const reviewed = (await fixture.run(["encode-output", "inspect", seeded.artifactIdentity], undefined, undefined, { encodeOutputMediaProbe: unknownProbe })).result as EncodeOutputInspection;
    const acknowledgement = await fixture.run(["encode-output", "acknowledge-inspection", seeded.artifactIdentity, "--key", "synthetic-unknown-measured-receipt", "--json",
      JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: unknownProbe });
    expect(acknowledgement.exitCode).toBe(0);
    const receipt = (acknowledgement.result as { receipt: EncodeOutputInspectionReceipt }).receipt;
    expect(receipt.evidence.validation.result).toBe("unknown");
    const located = await fixture.run(["encode-output", "intervals", seeded.artifactIdentity, "--json", JSON.stringify(seeded.query)], undefined, undefined,
      { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) });
    expect(located).toMatchObject({ exitCode: 0, result: { intervals: [{ status: "verified", outputInterval: { startMilliseconds: 40, endMilliseconds: 160 } }] } });
    const inspect = async () => (await fixture.run(["damage-preview", "inspect", record.id])).result as DamagePreviewInspection;
    expect(await inspect()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false,
      outputs: [{ matchingReceipts: [receipt], reasonCode: "FINISHED_OUTPUT_VALIDATION_UNPROVED" }] }, media: { retention: { protectedForReview: true } } });
    await withdrawClaimAcceptance(fixture, seeded.archive.id, source.decision.acceptanceIdentity!);
    const current = await inspect();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * 24 * 60 * 60 * 1_000);
    expect(await inspect()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false }, media: { retention: { protectedForReview: true } } });
    expect(await fixture.run(["damage-preview", "cleanup", record.id, "--key", "synthetic-measured-unknown-cleanup", "--json", JSON.stringify({ mediaToken: current.media.token })])).toMatchObject({ exitCode: 2 });
    settleDamagePreviewMedia(fixture); expect(existsSync(path)).toBe(true);
    const after = (await fixture.run(["encode-output", "inspect", seeded.artifactIdentity], undefined, undefined,
      { encodeOutputMediaProbe: async () => ({ durationSeconds: 1, streams: [] }) })).result as EncodeOutputInspection;
    expect(after.operatorInspection.history).toEqual([receipt]);
  } finally { seeded.access.close(); }
});
