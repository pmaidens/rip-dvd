import { copyFileSync, existsSync, lstatSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { claimNextEncodeJob, encodeOutputArtifactIdentity, retainedEncodeOutputArtifactIdentity, type DamagePreviewInspection, type EncodeOutputInspection, type EncodingReadiness } from "@rip-dvd/application";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { settleDamagePreviewMedia } from "./damage-preview.test-support.js";
import { seedProvedPreviewOutput } from "./damage-preview-source-retention.test-support.js";
import { openEncodeSourceTestAccess } from "./encode-source-decision.test-support.js";
import { acceptReadinessContent, assessmentMappings } from "./encoding-readiness.test-support.js";
import { publishSyntheticClaim } from "./encode-output-provenance.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
const day = 24 * 60 * 60 * 1_000;
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });
async function setup(options?: Parameters<typeof seedProvedPreviewOutput>[1]) {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  return seedProvedPreviewOutput(fixture, options);
}

it("releases a current sample only after exact-generation source acknowledgement, then expires it at 30 idle days with durable replay", async () => {
  const { fixture, id, path, claim, inspectPreview, acknowledge, inspectOutput } = await setup();
  const before = await inspectPreview();
  expect(before).toMatchObject({ outdated: false, media: { retention: { activeCatalogReview: false, protectedForReview: true } } });
  const acknowledgement = await acknowledge("synthetic-source-retention-ack");
  const current = await inspectPreview();
  expect(current).toMatchObject({ outdated: false, media: { retention: { protectedForReview: false, awaitingFinishedOutputInspection: false } }, finishedOutputInspection: { state: "proved", retentionSatisfied: true, outputs: [{ reasonCode: null }] } });
  expect((await inspectOutput()).operatorInspection.history).toHaveLength(1);
  const args = ["damage-preview", "cleanup", id, "--key", "synthetic-proved-cleanup", "--json", JSON.stringify({ mediaToken: current.media.token })];
  expect(await fixture.run(args)).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE" } } });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 30 * day);
  const removed = await fixture.run(args);
  expect(removed).toMatchObject({ exitCode: 0, result: { generationStatus: "complete", provenance: before.provenance, media: { state: "removing", removal: { cause: "idle_cleanup", state: "pending" } } } });
  expect(existsSync(path)).toBe(true);
  settleDamagePreviewMedia(fixture);
  expect((await inspectPreview()).media.removal?.state).toBe("complete");
  expect(existsSync(path)).toBe(false);
  writeFileSync(claim.outputPath, "synthetic replacement after preview removal");
  expect(await fixture.run(args)).toEqual(removed);
  expect(acknowledgement.exitCode).toBe(0);
});

it("keeps active Catalog Review protected independently of an applicable receipt", async () => {
  const { fixture, id, seeded, inspectPreview, acknowledge } = await setup();
  await acknowledge("synthetic-reopened-source-ack");
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => db.prepare("UPDATE original_disc_archives SET catalog_reviewed_at = NULL, catalog_review_outcome = 'needs_review' WHERE id = ?").run(seeded.archive.id));
  const current = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * day);
  expect(await inspectPreview()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: true }, media: { retention: { protectedForReview: true, activeCatalogReview: true, awaitingFinishedOutputInspection: false, reasonCodes: ["CATALOG_REVIEW_ACTIVE"] } } });
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-active-review-cleanup", "--json", JSON.stringify({ mediaToken: current.media.token })])).toMatchObject({ exitCode: 2 });
});

it.each(["review", "output"] as const)("cancels pending idle cleanup when %s evidence changes before the worker starts", async (change) => {
  const { fixture, id, path, claim, seeded, inspectPreview, acknowledge } = await setup();
  await acknowledge(`synthetic-before-pending-${change}`);
  const current = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * day);
  const args = ["damage-preview", "cleanup", id, "--key", `synthetic-pending-${change}`, "--json", JSON.stringify({ mediaToken: current.media.token })];
  const accepted = await fixture.run(args);
  expect(accepted).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  if (change === "review") withEvidenceGuardsDisabled(fixture.databasePath, (db) => db.prepare("UPDATE original_disc_archives SET catalog_reviewed_at = NULL, catalog_review_outcome = 'needs_review' WHERE id = ?").run(seeded.archive.id));
  else writeFileSync(claim.outputPath, "synthetic replacement before cleanup execution");
  settleDamagePreviewMedia(fixture);
  const retained = await inspectPreview();
  expect(retained).toMatchObject({ media: { state: "retained", retention: { protectedForReview: true }, removal: { state: "cancelled", outcomes: [{ outcome: "retained", reasonCode: "DAMAGE_PREVIEW_CLEANUP_RETENTION_CHANGED" }] } } });
  expect(existsSync(path)).toBe(true);
  expect(await fixture.run(args)).toEqual(accepted);
  // A cancelled cleanup no longer fences read-only review or a deliberate deletion.
  expect(await fixture.run(["damage-preview", "export", retained.artifacts[0]!.identity, "--destination", `${fixture.operatorHostPath}/retained-${change}.mkv`])).toMatchObject({ exitCode: 0 });
  const refreshed = await inspectPreview();
  expect(await fixture.run(["damage-preview", "delete", id, "--key", `synthetic-explicit-after-${change}`, "--json", JSON.stringify({ mediaToken: refreshed.media.token })])).toMatchObject({ exitCode: 0 });
  settleDamagePreviewMedia(fixture);
  expect((await inspectPreview()).media.state).toBe("removed");
});

it("protects a current preview when the acknowledged output used different versioned intended settings", async () => {
  const { inspectPreview, acknowledge } = await setup({ differentProfile: true });
  await acknowledge("synthetic-mismatched-settings-ack");
  expect(await inspectPreview()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false, outputs: [{ acknowledgementStatus: "acknowledged", reasonCode: "FINISHED_OUTPUT_SOURCE_MISMATCH" }] }, media: { retention: { protectedForReview: true, reasonCodes: ["FINISHED_OUTPUT_SOURCE_MISMATCH"] } } });
});

it("keeps selected subtitles protected when passing validation could have removed an empty track", async () => {
  const { inspectPreview, acknowledge, inspectOutput } = await setup({ selectedSubtitle: true });
  await acknowledge("synthetic-subtitle-survival-unknown");
  expect((await inspectOutput()).artifact).toMatchObject({ validation: { result: "passed", checks: { subtitles: { expectedSourceStreams: 1, checked: true } } }, provenance: { sourceSnapshot: { source: { output: { subtitleStreams: [{ id: 32 }] } } } } });
  expect(await inspectPreview()).toMatchObject({ outdated: false, provenance: { streams: { subtitles: [32] } }, finishedOutputInspection: { retentionSatisfied: false, outputs: [{ acknowledgementStatus: "acknowledged", reasonCode: "FINISHED_OUTPUT_SUBTITLE_UNPROVED" }] }, media: { retention: { protectedForReview: true } } });
});

it("rejects changed output authority between staged source proof and cleanup admission", async () => {
  const { fixture, id, path, claim, inspectPreview, acknowledge } = await setup();
  await acknowledge("synthetic-before-admission-proof-change");
  const current = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * day);
  const access = fixture.openAccess();
  const removeMedia = access.damagePreviews.requestMediaRemoval.bind(access.damagePreviews);
  access.damagePreviews.requestMediaRemoval = (input, prepare, present) => removeMedia(input, (record) => {
    const staged = prepare(record);
    const db = new DatabaseSync(fixture.databasePath);
    try { db.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1 WHERE id = ?").run(claim.id); } finally { db.close(); }
    return staged;
  }, present);
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-staged-proof-change", "--json", JSON.stringify({ mediaToken: current.media.token })], undefined, undefined, { openAccess: () => access })).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_STALE" } } });
  expect(existsSync(path)).toBe(true);
  expect((await inspectPreview()).media.removal).toBeNull();
});

it("requires passing validation recorded by the receipt and never upgrades an acknowledgement of unknown validation", async () => {
  const { inspectPreview, acknowledge } = await setup();
  await acknowledge("synthetic-unproved-validation-ack", async () => { throw new Error("Synthetic probe failure"); });
  expect(await inspectPreview()).toMatchObject({ finishedOutputInspection: { retentionSatisfied: false, outputs: [{ reasonCode: "FINISHED_OUTPUT_VALIDATION_UNPROVED" }] }, media: { retention: { protectedForReview: true } } });
  await acknowledge("synthetic-passing-validation-ack");
  expect((await inspectPreview()).finishedOutputInspection?.retentionSatisfied).toBe(true);
});

it("preserves an applicable passing receipt after a later same-generation probe-unknown acknowledgement", async () => {
  const { inspectPreview, acknowledge } = await setup();
  const first = await acknowledge("synthetic-first-passing-source-ack");
  expect((await inspectPreview()).finishedOutputInspection?.retentionSatisfied).toBe(true);
  await acknowledge("synthetic-later-probe-unknown-source-ack", async () => { throw new Error("Synthetic later probe failure"); });
  expect(await inspectPreview()).toMatchObject({ outdated: false, media: { retention: { protectedForReview: false } }, finishedOutputInspection: { retentionSatisfied: true,
    outputs: [expect.objectContaining({ acknowledgementStatus: "acknowledged", reasonCode: null, matchingReceipts: expect.arrayContaining([(first.result as { receipt: unknown }).receipt]) })] } });
});

it("protects media from a persisted unknown-source receipt even when its file generation matches", async () => {
  const { fixture, identity, inspectOutput, inspectPreview } = await setup();
  const current = await inspectOutput();
  const evidence = { ...current.artifact, provenance: { ...current.artifact.provenance, sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" } };
  // Inconsistent durable evidence cannot gain authority from a matching job.
  const access = fixture.openAccess();
  try {
    access.encodeOutputInspectionReceipts.record({ mutationKey: "synthetic-persisted-unknown-source", artifactIdentity: identity, reviewToken: current.operatorInspection.reviewToken, acknowledged: true }, () => ({
      generationIdentity: current.operatorInspection.generationIdentity!, encodeJobId: current.artifact.provenance.encodeJobId,
      evidenceJson: JSON.stringify(evidence), assertAuthority() {},
    }));
  } finally { access.close(); }
  expect(await inspectPreview()).toMatchObject({ outdated: false, media: { retention: { protectedForReview: true } }, finishedOutputInspection: { retentionSatisfied: false,
    outputs: [{ reasonCode: "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED" }] } });
  expect((await inspectOutput()).operatorInspection.history[0]!.evidence).toEqual(evidence);
});

it("keeps a current sample after a real failed-output receipt and read-only Keep preflight", async () => {
  const { fixture, id, path, identity, inspectPreview, inspectOutput, acknowledge, probe } = await setup({ validationFailed: true });
  expect((await inspectOutput()).operatorInspection.history).toEqual([]);
  await acknowledge("synthetic-real-failed-retention-ack");
  const history = (await inspectOutput()).operatorInspection.history;
  expect(history[0]!.evidence).toMatchObject({ state: "validation_failed", validation: { result: "failed" }, provenance: { sourceSnapshotAvailability: "recorded" } });
  expect(await fixture.run(["encode-output", "keep-preflight", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).toMatchObject({ exitCode: 0 });
  const current = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * day);
  expect(await inspectPreview()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false,
    outputs: [{ artifactIdentity: identity, acknowledgementStatus: "acknowledged", matchingReceipts: history, reasonCode: "FINISHED_OUTPUT_VALIDATION_UNPROVED" }] },
    media: { retention: { protectedForReview: true, activeCatalogReview: false, reasonCodes: ["FINISHED_OUTPUT_VALIDATION_UNPROVED"] } } });
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-real-failed-cleanup", "--json", JSON.stringify({ mediaToken: current.media.token })])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE" } } });
  settleDamagePreviewMedia(fixture);
  expect(existsSync(path)).toBe(true);
  expect((await inspectOutput()).operatorInspection.history).toEqual(history);
});

it("does not transfer a failed-output receipt to a later passing generation of the same job", async () => {
  const { fixture, seeded, identity, claim, inspectPreview, inspectOutput, acknowledge, probe } = await setup({ validationFailed: true });
  await acknowledge("synthetic-failed-before-normal-receipt");
  const failedReceipt = (await inspectOutput()).operatorInspection.receipts[0]!;
  const access = openEncodeSourceTestAccess(fixture);
  try {
    access.encodeJobs.requeue(claim.id, { expectedSourceDecision: seeded.expectedSourceDecision });
    const next = (await claimNextEncodeJob(access, "synthetic-normal-after-failed-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(access, next);
    const normalIdentity = encodeOutputArtifactIdentity(next.id);
    const normal = (await fixture.run(["encode-output", "inspect", normalIdentity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
    expect(normal.operatorInspection).toMatchObject({ receipts: [], history: [failedReceipt] });
    expect(normal.operatorInspection.generationIdentity).not.toBe(failedReceipt.generationIdentity);
    expect(await inspectPreview()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false }, media: { retention: { protectedForReview: true } } });
    expect(await fixture.run(["encode-output", "acknowledge-inspection", normalIdentity, "--key", "synthetic-normal-after-failed-ack", "--json", JSON.stringify({ acknowledged: true, reviewToken: normal.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe })).toMatchObject({ exitCode: 0 });
    expect(await inspectPreview()).toMatchObject({ finishedOutputInspection: { retentionSatisfied: true, outputs: expect.arrayContaining([
      expect.objectContaining({ artifactIdentity: normalIdentity, reasonCode: null }),
      expect.objectContaining({ artifactIdentity: identity, reasonCode: "FINISHED_OUTPUT_VALIDATION_UNPROVED" }),
    ]) } });
  } finally { access.close(); }
});

it("rejects a rewritten failed artifact even after its size and modification time are restored", async () => {
  const { validation, inspectPreview, acknowledge } = await setup({ validationFailed: true });
  await acknowledge("synthetic-failed-before-restored-mtime");
  const before = lstatSync(validation.outputPath);
  writeFileSync(validation.outputPath, "SYNTHETIC COMPLETE FAILED ENCODE");
  utimesSync(validation.outputPath, before.atime, before.mtime);
  expect(lstatSync(validation.outputPath).size).toBe(before.size);
  expect(await inspectPreview()).toMatchObject({ finishedOutputInspection: { retentionSatisfied: false,
    outputs: [{ acknowledgementStatus: "unavailable", matchingReceipts: [], reasonCode: "FINISHED_OUTPUT_UNAVAILABLE" }] }, media: { retention: { protectedForReview: true } } });
});

it.each(["bytes", "validation"] as const)("protects previously releasable media when the exact output %s changes", async (changed) => {
  const { fixture, claim, inspectPreview, acknowledge } = await setup();
  await acknowledge(`synthetic-before-${changed}-replacement`);
  expect((await inspectPreview()).finishedOutputInspection?.retentionSatisfied).toBe(true);
  if (changed === "bytes") writeFileSync(claim.outputPath, "synthetic replacement normal output bytes");
  else {
    const db = new DatabaseSync(fixture.databasePath);
    try { db.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1 WHERE id = ?").run(claim.id); } finally { db.close(); }
  }
  expect(await inspectPreview()).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false }, media: { retention: { protectedForReview: true } } });
});

it("proves an explicitly acknowledged retained normal generation independently of newer requeued bytes", async () => {
  const { fixture, seeded, claim, inspectPreview, acknowledge, probe } = await setup();
  await acknowledge("synthetic-before-requeue-receipt");
  const access = openEncodeSourceTestAccess(fixture);
  try {
    access.catalog.correctDiscSelection(seeded.selection.id, { originalDiscArchiveId: seeded.archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt,
      mediaItemId: access.catalog.createMediaItem({ kind: "movie", title: "Synthetic corrected retention mapping" }).id,
      sourceIdentity: seeded.selection.sourceIdentity, reason: "Synthetic replacement mapping." });
    await access.assessDvdTitleDamage(seeded.archive.id, createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }), async () => assessmentMappings(seeded.assessment!.items));
    const replacement = access.catalog.completeCatalogReviewWithReplacements(seeded.archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections",
      [{ predecessorEncodeJobId: claim.id, encodingProfileId: seeded.profile.id, outputPath: claim.outputPath }]).replacementEncodeJobs[0]!;
    expect(await acceptReadinessContent(fixture, seeded.archive.id, [], "synthetic-replacement-retention-acceptance")).toMatchObject({ exitCode: 0 });
    const readiness = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
    const expectedSourceDecision = readiness.selections[0]!.expectedSourceDecision;
    const db = new DatabaseSync(fixture.databasePath);
    try { db.prepare("UPDATE encode_jobs SET expected_source_decision = ? WHERE id = ?").run(JSON.stringify(expectedSourceDecision), replacement.id); } finally { db.close(); }
    const next = (await claimNextEncodeJob(access, "synthetic-replacement-retention-worker", fixture.originalsLibraryPath))!;
    expect(next, JSON.stringify(readiness)).not.toBeNull();
    publishSyntheticClaim(access, next, true);
    expect(((await fixture.run(["encode-output", "inspect", encodeOutputArtifactIdentity(next.id)], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection).operatorInspection.receipts).toEqual([]);
    access.encodeJobs.requeue(next.id, { expectedSourceDecision });
    expect((await inspectPreview()).finishedOutputInspection?.retentionSatisfied).toBe(false);
    const retained = access.encodeJobs.listRetainedOutputs([claim.id, next.id])[0]!;
    const identity = retainedEncodeOutputArtifactIdentity(retained.id);
    const old = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
    expect(old.artifact.provenance.sourceSnapshot?.id).toBe(claim.claimToken);
    expect(await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-retained-proof-ack", "--json", JSON.stringify({ acknowledged: true, reviewToken: old.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe })).toMatchObject({ exitCode: 0 });
    expect(await inspectPreview()).toMatchObject({ outdated: true, finishedOutputInspection: { retentionSatisfied: true,
      outputs: expect.arrayContaining([expect.objectContaining({ artifactIdentity: identity, acknowledgementStatus: "acknowledged", reasonCode: null })]) } });
  } finally { access.close(); }
});

it.each(["checkpoint", "title", "path", "angle", "playback", "audio", "subtitles"] as const)("does not prove a recorded preview's mismatched %s from the output snapshot", async (changed) => {
  const { fixture, id, path, acknowledge } = await setup();
  await acknowledge(`synthetic-source-mismatch-${changed}`);
  const access = fixture.openAccess();
  try {
    const record = access.damagePreviews.find(id)!;
    const saved = JSON.parse(record.reviewJson) as { reviewedRequest: NonNullable<DamagePreviewInspection["provenance"]> };
    const request = saved.reviewedRequest;
    if (changed === "checkpoint") request.checkpoint!.manifestDigest = "f".repeat(64);
    if (changed === "title") request.title!.contentDigest = "synthetic-different-title";
    if (changed === "path") request.title!.selectedPath = [];
    if (changed === "angle") request.title!.angleNumber = 2;
    if (changed === "playback") request.playbackRange!.endMilliseconds = 501_000;
    if (changed === "audio") request.streams!.audio = [999];
    if (changed === "subtitles") request.streams!.subtitles = [999];
    // Seed a separate historical request with its original differing evidence;
    // the original admitted request and its immutable provenance stay untouched.
    const historical = access.damagePreviews.submit({ archiveId: record.originalDiscArchiveId,
      mutationKey: `synthetic-historical-${changed}`, preflightToken: `synthetic-historical-${changed}`, selectionJson: record.selectionJson }, () => JSON.stringify(saved));
    const retained = access.damagePreviews.claim("synthetic-historical-preview-worker")!;
    expect(retained.id).toBe(historical.id);
    const directory = join(fixture.mediaLibraryPath, ".damage-previews", retained.id);
    mkdirSync(directory, { recursive: true });
    const historicalPath = join(directory, "0.mkv"); copyFileSync(path, historicalPath);
    retained.status = "complete";
    retained.artifacts = record.artifacts.map((artifact) => ({ ...artifact, identity: `damage-preview-v1.${retained.id}.0`, path: historicalPath }));
    access.damagePreviews.update(retained);
    const inspected = (await fixture.run(["damage-preview", "inspect", retained.id])).result as DamagePreviewInspection;
    expect(inspected.finishedOutputInspection).toMatchObject({ retentionSatisfied: false, outputs: [{ reasonCode: "FINISHED_OUTPUT_SOURCE_MISMATCH" }] });
  } finally { access.close(); }
});
