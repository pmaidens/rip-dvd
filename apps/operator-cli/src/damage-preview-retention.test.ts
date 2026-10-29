import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupDamagePreviewMedia, createApplicationOperations } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedRetainedDamagePreview, settleDamagePreviewMedia } from "./damage-preview.test-support.js";
import { advanceCommittedArchiveEvidence, withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import { seedProvedPreviewOutput } from "./damage-preview-source-retention.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); syncBuiltinESMExports(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });

async function setup() {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  return seedRetainedDamagePreview(fixture);
}

it("deletes media with keyed replay and stale checks while preserving request history and export absence", async () => {
  const { fixture, seeded, id, path, inspect } = await setup();
  const before = await inspect();
  const args = ["damage-preview", "delete", id, "--key", "synthetic-delete", "--json", JSON.stringify({ mediaToken: before.media.token })];
  const deleted = await fixture.run(args);
  expect(deleted).toMatchObject({ exitCode: 0, result: { media: { state: "removing", removal: { requestId: expect.any(String), cause: "explicit_deletion", state: "pending" } } } });
  expect(existsSync(path)).toBe(true);
  settleDamagePreviewMedia(fixture);
  expect(existsSync(path)).toBe(false);
  expect(await fixture.run(args)).toEqual(deleted);
  const after = await inspect();
  expect(after.provenance).toEqual(before.provenance);
  expect(after.artifacts).toEqual(before.artifacts.map((artifact) => ({ ...artifact, media: { state: "removed", reasonCode: "DAMAGE_PREVIEW_MEDIA_DELETED" } })));
  expect(after).toMatchObject({ generationStatus: before.generationStatus, progress: before.progress, reason: before.reason });
  expect(await fixture.run(["damage-preview", "export", before.artifacts[0]!.identity, "--destination", join(fixture.operatorHostPath, "deleted.mkv")])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_DELETED" } } });
  expect(await fixture.run([...args.slice(0, -1), JSON.stringify({ mediaToken: after.media.token })])).toMatchObject({ result: { error: { code: "MUTATION_KEY_CONFLICT" } } });
  expect(await fixture.run([...args.slice(0, 4), "synthetic-stale-delete", ...args.slice(5)])).toMatchObject({ result: { error: { code: "DAMAGE_PREVIEW_MEDIA_STALE", current: { media: { token: after.media.token } } } } });
  advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  expect(await fixture.run(args)).toEqual(deleted);
});

it("replays the original cancellation response after separate media deletion", async () => {
  const { fixture, id, inspect } = await setup();
  const cancelArgs = ["damage-preview", "cancel", id, "--key", "synthetic-cancel-before-delete"];
  const cancelled = await fixture.run(cancelArgs);
  expect(cancelled).toMatchObject({ exitCode: 0, result: { generationStatus: "complete", media: { state: "retained" } } });
  expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-delete-after-cancel", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })])).toMatchObject({ exitCode: 0 });
  settleDamagePreviewMedia(fixture);
  expect(await fixture.run(cancelArgs)).toEqual(cancelled);
  expect(await inspect()).toMatchObject({ media: { state: "removed", removal: { cause: "explicit_deletion" } } });
});

it("leaves the database writer available during cancellation and deletion filesystem observations", async () => {
  const { fixture, id, path, inspect } = await setup();
  const token = (await inspect()).media.token;
  const other = new DatabaseSync(fixture.databasePath);
  const original = fs.lstatSync;
  let blocked = false;
  vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
    if (args[0] === path) {
      try { other.exec("BEGIN IMMEDIATE"); other.exec("ROLLBACK"); } catch { blocked = true; }
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  try {
    expect(await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-writer-free-cancel"])).toMatchObject({ exitCode: 0 });
    expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-writer-free-delete", "--json", JSON.stringify({ mediaToken: token })])).toMatchObject({ exitCode: 0 });
    settleDamagePreviewMedia(fixture);
    expect(blocked).toBe(false);
  } finally { other.close(); }
});

it("rejects changed preview metadata after filesystem preparation without removing media", async () => {
  const { fixture, id, path, inspect } = await setup();
  const token = (await inspect()).media.token;
  const access = fixture.openAccess();
  const removeMedia = access.damagePreviews.requestMediaRemoval.bind(access.damagePreviews);
  access.damagePreviews.requestMediaRemoval = (input, prepare, present) => removeMedia(input, (record) => {
    const staged = prepare(record);
    access.damagePreviews.touchMedia(record.id);
    return staged;
  }, present);
  expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-staged-media-change", "--json", JSON.stringify({ mediaToken: token })], undefined, undefined, { openAccess: () => access })).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_STALE" } } });
  expect(existsSync(path)).toBe(true);
  expect((await inspect()).media.removal).toBeNull();
});

it("replays a concurrent deletion winner when slower preparation observes stale media", async () => {
  const { fixture, id, inspect } = await setup();
  const token = (await inspect()).media.token;
  const args = ["damage-preview", "delete", id, "--key", "synthetic-concurrent-deletion", "--json", JSON.stringify({ mediaToken: token })];
  const access = fixture.openAccess();
  const other = fixture.openAccess();
  const removeMedia = access.damagePreviews.requestMediaRemoval.bind(access.damagePreviews);
  let winner: unknown;
  access.damagePreviews.requestMediaRemoval = (input, prepare, present) => removeMedia(input, (record) => {
    winner = createApplicationOperations(other).deleteDamagePreviewMedia(id, { mediaToken: token, mutationKey: input.mutationKey });
    return prepare(record);
  }, present);
  try {
    expect(await fixture.run(args, undefined, undefined, { openAccess: () => access })).toMatchObject({ exitCode: 0, result: winner });
    expect((await fixture.run(args)).result).toEqual(winner);
  } finally { other.close(); }
});

it("upgrades a historical cancellation receipt once without changing later replay", async () => {
  const { fixture, id, inspect } = await setup();
  const key = "synthetic-historical-cancel";
  const args = ["damage-preview", "cancel", id, "--key", key];
  await fixture.run(args);
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE mutation_invocations SET outcome = json_remove(outcome, '$.cancellationResult') WHERE key = ?").run(key);
  sqlite.close();
  const upgraded = await fixture.run(args);
  expect(upgraded).toMatchObject({ exitCode: 0, result: { generationStatus: "complete", media: { state: "retained" } } });
  await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-historical-delete", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })]);
  settleDamagePreviewMedia(fixture);
  expect(await fixture.run(args)).toEqual(upgraded);
});

const day = 24 * 60 * 60 * 1_000;
it("protects current review media indefinitely and expires outdated media at 30 idle days", async () => {
  const { fixture, seeded, id, path, inspect } = await setup();
  const created = Date.parse((await inspect()).updatedAt);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(created + 31 * day);
  const protectedSample = await inspect();
  expect(protectedSample.media.retention).toMatchObject({ protectedForReview: true, activeCatalogReview: true, awaitingFinishedOutputInspection: true, reasonCodes: ["CATALOG_REVIEW_ACTIVE", "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED"] });
  const cleanup = (token: string, key: string) => fixture.run(["damage-preview", "cleanup", id, "--key", key, "--json", JSON.stringify({ mediaToken: token })]);
  expect(await cleanup(protectedSample.media.token, "synthetic-protected-cleanup")).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE" } } });
  expect(existsSync(path)).toBe(true);
  advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  vi.setSystemTime(created + 30 * day - 1);
  const outdated = await inspect();
  expect(outdated).toMatchObject({ status: "outdated", media: { retention: { protectedForReview: false } } });
  expect(await cleanup(outdated.media.token, "synthetic-not-idle")).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE" } } });
  vi.setSystemTime(created + 30 * day);
  const args = ["damage-preview", "cleanup", id, "--key", "synthetic-idle-cleanup", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })];
  const cleaned = await fixture.run(args);
  expect(cleaned).toMatchObject({ exitCode: 0, result: { status: "outdated", media: { state: "removing", removal: { cause: "idle_cleanup", state: "pending" } } } });
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.removal?.state).toBe("complete");
  expect(existsSync(path)).toBe(false); expect(await fixture.run(args)).toEqual(cleaned);
  expect(await fixture.run(["damage-preview", "export", outdated.artifacts[0]!.identity, "--destination", join(fixture.operatorHostPath, "expired.mkv")])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_EXPIRED" } } });
});

it("retains partial coverage and failure history after cleanup, with successful export resetting idle time", async () => {
  const { fixture, id, path, bytes, inspect } = await setup();
  const access = fixture.openAccess();
  const record = access.damagePreviews.find(id)!;
  record.status = "partial"; record.reason = { code: "SYNTHETIC_INTERRUPTION", message: "Synthetic interrupted generation." };
  access.damagePreviews.update(record); access.close();
  const before = await inspect();
  const created = Date.parse(before.updatedAt);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(created + 29 * day);
  const destination = join(fixture.operatorHostPath, "partial.mkv");
  expect(await fixture.run(["damage-preview", "export", before.artifacts[0]!.identity, "--destination", destination])).toMatchObject({ exitCode: 0 });
  expect(readFileSync(destination)).toEqual(bytes);
  vi.setSystemTime(created + 31 * day);
  const active = await inspect();
  expect(active.media.cleanup.available).toBe(false);
  vi.setSystemTime(created + 59 * day);
  const args = ["damage-preview", "cleanup", id, "--key", "synthetic-partial-cleanup", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })];
  expect(await fixture.run(args)).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  settleDamagePreviewMedia(fixture);
  expect(existsSync(path)).toBe(false);
  expect(await inspect()).toMatchObject({ generationStatus: "partial", reason: before.reason, progress: before.progress, provenance: before.provenance, artifacts: [{ coverage: before.artifacts[0]!.coverage }] });
});

it("allows idle cleanup after an explicit archive-only choice and reports reopened review", async () => {
  const { fixture, seeded, id, inspect } = await setup();
  const choose = async (choice: string, key: string) => {
    const review = (await fixture.run(["catalog-review", "show", seeded.archive.id])).result as { catalogRevision: string; reviewWorkflow: { current: { checkpoint: { revision: number; manifestDigest: string } } } };
    return fixture.run(["catalog-review", choice, seeded.archive.id, "--key", key, "--revision", review.catalogRevision, "--checkpoint-revision", String(review.reviewWorkflow.current.checkpoint.revision), "--checkpoint-digest", review.reviewWorkflow.current.checkpoint.manifestDigest]);
  };
  expect(await choose("archive-only", "synthetic-archive-only")).toMatchObject({ exitCode: 0 });
  const selected = await inspect();
  expect(selected.media.retention).toMatchObject({ protectedForReview: false });
  expect(await choose("reopen", "synthetic-reopen")).toMatchObject({ exitCode: 0 });
  expect(await inspect()).toMatchObject({ outdated: false, media: { retention: { activeCatalogReview: true, protectedForReview: true } } });
  expect(await choose("archive-only", "synthetic-archive-only-again")).toMatchObject({ exitCode: 0 });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(selected.updatedAt) + 31 * day);
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-archive-only-cleanup", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })])).toMatchObject({ exitCode: 0, result: { media: { state: "removing" } } });
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.state).toBe("removed");
});

it("keeps unchanged media protected after Catalog Review completion without output acknowledgement", async () => {
  const { fixture, seeded, id, inspect } = await setup();
  const before = await inspect();
  withEvidenceGuardsDisabled(fixture.databasePath, (sqlite) => {
    sqlite.prepare("UPDATE original_disc_archives SET catalog_review_outcome = 'reviewed_with_selections', catalog_reviewed_at = updated_at + 1, updated_at = updated_at + 1 WHERE id = ?").run(seeded.archive.id);
  });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(before.updatedAt) + 31 * day);
  const current = await inspect();
  expect(current).toMatchObject({ outdated: false, media: { retention: { activeCatalogReview: false, awaitingFinishedOutputInspection: true, protectedForReview: true } } });
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-completed-review", "--json", JSON.stringify({ mediaToken: current.media.token })])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE" } } });
});

it("reports expiry if cleanup wins while canonical export is validating the source", async () => {
  const { fixture, id, inspect } = await setup();
  const access = fixture.openAccess();
  const record = access.damagePreviews.find(id)!; record.status = "partial"; access.damagePreviews.update(record);
  const before = await inspect();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(before.updatedAt) + 31 * day);
  const other = fixture.openAccess();
  const token = (await inspect()).media.token;
  const touch = access.damagePreviews.touchMedia.bind(access.damagePreviews);
  access.damagePreviews.touchMedia = (requestId) => {
    createApplicationOperations(other).cleanupDamagePreviewMedia(id, { mediaToken: token, mutationKey: "synthetic-cleanup-during-export" });
    cleanupDamagePreviewMedia(other);
    return touch(requestId);
  };
  const destination = join(fixture.operatorHostPath, "expired-during-export.mkv");
  try {
    expect(await fixture.run(["damage-preview", "export", before.artifacts[0]!.identity, "--destination", destination], undefined, undefined, { openAccess: () => access })).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_EXPIRED" } } });
    expect(existsSync(destination)).toBe(false);
  } finally { other.close(); }
});

it("resumes a durable worker deletion after process death, including already missing files", async () => {
  const { fixture, id, path, inspect } = await setup();
  const before = await inspect();
  const args = ["damage-preview", "delete", id, "--key", "synthetic-crash-deletion", "--json", JSON.stringify({ mediaToken: before.media.token })];
  const accepted = await fixture.run(args);
  expect(accepted).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  const access = fixture.openAccess();
  const complete = access.damagePreviews.completeMediaRemoval.bind(access.damagePreviews);
  access.damagePreviews.completeMediaRemoval = (requestId, removalId, remove) => complete(requestId, removalId, (record) => { remove(record); throw new Error("Synthetic worker death after unlink."); });
  try { expect(() => cleanupDamagePreviewMedia(access)).toThrow("Synthetic worker death"); } finally { access.close(); }
  expect(existsSync(path)).toBe(false);
  expect(await inspect()).toMatchObject({ media: { state: "removing", removal: { state: "pending" } } });
  expect(await fixture.run(args)).toEqual(accepted);
  settleDamagePreviewMedia(fixture);
  expect(await inspect()).toMatchObject({ media: { state: "removed", removal: { state: "complete", outcomes: [{ outcome: "already_missing" }] } }, provenance: before.provenance });
  expect(await fixture.run(args)).toEqual(accepted);
});

it.each([false, true])("reconciles prior idle-cleanup unlinks before retaining present media after review reopens, directory sync available: %s", async (syncAvailable) => {
  const { fixture, id, path, seeded, inspect } = await setup();
  const access = fixture.openAccess();
  const record = access.damagePreviews.find(id)!;
  const second = join(dirname(path), "1.mkv");
  writeFileSync(second, readFileSync(path));
  record.artifacts.push({ ...record.artifacts[0]!, identity: `damage-preview-v1.${id}.1`, path: second });
  access.damagePreviews.update(record);
  access.close();
  const choose = async (choice: string, key: string) => {
    const review = (await fixture.run(["catalog-review", "show", seeded.archive.id])).result as { catalogRevision: string };
    return fixture.run(["catalog-review", choice, seeded.archive.id, "--key", key, "--revision", review.catalogRevision, "--checkpoint-revision", String(seeded.manifest.revision), "--checkpoint-digest", seeded.manifest.manifestDigest]);
  };
  expect(await choose("archive-only", "synthetic-before-interrupted-cleanup")).toMatchObject({ exitCode: 0 });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse((await inspect()).updatedAt) + 31 * day);
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-interrupted-idle-cleanup", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })])).toMatchObject({ exitCode: 0 });
  const failSync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("Synthetic directory sync failure"); });
  syncBuiltinESMExports();
  const worker = fixture.openAccess();
  const complete = worker.damagePreviews.completeMediaRemoval.bind(worker.damagePreviews);
  worker.damagePreviews.completeMediaRemoval = (requestId, removalId, remove) => complete(requestId, removalId, (current) => {
    remove({ ...current, artifacts: current.artifacts.slice(0, 1) });
    throw new Error("Synthetic worker death after first unlink before directory sync");
  });
  try { expect(() => cleanupDamagePreviewMedia(worker)).toThrow("Synthetic worker death"); } finally { worker.close(); }
  expect(existsSync(path)).toBe(false); expect(existsSync(second)).toBe(true);
  expect((await inspect()).media.removal?.state).toBe("pending");
  expect(await choose("reopen", "synthetic-review-after-first-unlink")).toMatchObject({ exitCode: 0 });
  if (syncAvailable) { failSync.mockRestore(); syncBuiltinESMExports(); }
  settleDamagePreviewMedia(fixture);
  expect(existsSync(second)).toBe(true);
  expect(await inspect()).toMatchObject({ media: { removal: {
    state: syncAvailable ? "cancelled" : "failed",
    outcomes: [expect.objectContaining({ outcome: syncAvailable ? "already_missing" : "failed" }), expect.objectContaining({ outcome: "retained" })],
  } } });
  const retained = (await inspect()).artifacts[1]!;
  expect(retained.media).toEqual({ state: "retained", reasonCode: null });
  const destination = join(fixture.operatorHostPath, `retained-after-sync-${syncAvailable}.mkv`);
  expect(await fixture.run(["damage-preview", "export", retained.identity, "--destination", destination])).toMatchObject({ exitCode: 0 });
  expect(readFileSync(destination)).toEqual(readFileSync(second));
  expect((await inspect()).media.removal?.state).toBe(syncAvailable ? "cancelled" : "failed");
  const race = fixture.openAccess();
  const other = fixture.openAccess();
  const token = (await inspect()).media.token;
  const touch = race.damagePreviews.touchMedia.bind(race.damagePreviews);
  race.damagePreviews.touchMedia = (requestId, artifactIdentity) => {
    createApplicationOperations(other).deleteDamagePreviewMedia(id, { mutationKey: `synthetic-delete-after-sync-${syncAvailable}`, mediaToken: token });
    return touch(requestId, artifactIdentity);
  };
  try {
    expect(await fixture.run(["damage-preview", "export", retained.identity, "--destination", `${destination}.pending`], undefined, undefined, { openAccess: () => race })).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_REMOVING" } } });
    expect(existsSync(`${destination}.pending`)).toBe(false);
  } finally { other.close(); }
});

it.each(["review", "output"] as const)("preserves remaining media when %s evidence changes during live cleanup", async (change) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, path, seeded, claim, inspectPreview, acknowledge } = await seedProvedPreviewOutput(fixture);
  const access = fixture.openAccess();
  const record = access.damagePreviews.find(id)!;
  const second = join(dirname(path), "1.mkv");
  writeFileSync(second, readFileSync(path));
  record.artifacts.push({ ...record.artifacts[0]!, identity: `damage-preview-v1.${id}.1`, path: second });
  access.damagePreviews.update(record); access.close();
  await acknowledge(`synthetic-before-live-${change}`);
  const current = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * day);
  const args = ["damage-preview", "cleanup", id, "--key", `synthetic-live-${change}-cleanup`, "--json", JSON.stringify({ mediaToken: current.media.token })];
  const accepted = await fixture.run(args);
  expect(accepted).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  const originalSync = fs.fsyncSync;
  let changed = false;
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    originalSync(descriptor);
    if (changed || existsSync(path)) return;
    changed = true;
    if (change === "review") withEvidenceGuardsDisabled(fixture.databasePath, (database) => {
      database.prepare("UPDATE original_disc_archives SET catalog_reviewed_at = NULL, catalog_review_outcome = 'needs_review' WHERE id = ?").run(seeded.archive.id);
    });
    else writeFileSync(claim.outputPath, "synthetic output changed after first preview unlink");
  });
  syncBuiltinESMExports();
  settleDamagePreviewMedia(fixture);
  expect(changed).toBe(true);
  expect(existsSync(path)).toBe(false); expect(existsSync(second)).toBe(true);
  expect(await inspectPreview()).toMatchObject({ media: { retention: { protectedForReview: true }, removal: {
    state: "cancelled", outcomes: [{ outcome: "removed" }, { outcome: "retained", reasonCode: "DAMAGE_PREVIEW_CLEANUP_RETENTION_CHANGED" }],
  } } });
  expect(await fixture.run(args)).toEqual(accepted);
});

it("keeps accepted removal durable after response projection fails and lets the worker settle it", async () => {
  const { fixture, id, path, inspect } = await setup();
  const token = (await inspect()).media.token;
  const args = ["damage-preview", "delete", id, "--key", "synthetic-removal-response-loss", "--json", JSON.stringify({ mediaToken: token })];
  const access = fixture.openAccess();
  const request = access.damagePreviews.requestMediaRemoval.bind(access.damagePreviews);
  access.damagePreviews.requestMediaRemoval = (input, prepare) => request(input, prepare, () => { throw new Error("Synthetic response loss after acceptance"); });
  expect(await fixture.run(args, undefined, undefined, { openAccess: () => access })).toMatchObject({ exitCode: 1 });
  expect(existsSync(path)).toBe(true);
  expect((await inspect()).media.removal?.state).toBe("pending");
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.removal?.state).toBe("complete");
  const replay = await fixture.run(args);
  expect(replay).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  expect(await fixture.run(args)).toEqual(replay);
});
it("rejects a substituted symlink without following it, and permits reviewed deletion after it is removed", async () => {
  const { fixture, id, path, inspect } = await setup();
  const before = await inspect();
  unlinkSync(path); symlinkSync(fixture.databasePath, path);
  const current = await inspect();
  expect(current.media.state).toBe("unsafe");
  const stale = await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-changed-file", "--json", JSON.stringify({ mediaToken: before.media.token })]);
  expect(stale).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_STALE" } } });
  expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-unsafe-removal", "--json", JSON.stringify({ mediaToken: current.media.token })])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", reasons: [{ code: "DAMAGE_PREVIEW_MEDIA_UNSAFE" }] } } });
  expect(existsSync(fixture.databasePath)).toBe(true);
  unlinkSync(path);
  expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-retry-removal", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })])).toMatchObject({ exitCode: 0, result: { media: { state: "removing" } } });
  settleDamagePreviewMedia(fixture);
  expect(await inspect()).toMatchObject({ media: { state: "removed", removal: { outcomes: [{ outcome: "already_missing" }] } } });
});

it("keeps an unflushed worker unlink failed across explicit retries until directory sync succeeds", async () => {
  const { fixture, id, path, inspect } = await setup();
  const before = await inspect();
  const failSync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("Synthetic directory sync failure"), { code: "EIO" }); });
  syncBuiltinESMExports();
  const remove = (key: string, mediaToken: string) => fixture.run(["damage-preview", "delete", id, "--key", key, "--json", JSON.stringify({ mediaToken })]);
  const accepted = await remove("synthetic-unflushed-unlink", before.media.token);
  expect(accepted).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.removal?.state).toBe("failed");
  expect(existsSync(path)).toBe(false);
  expect(await remove("synthetic-unflushed-unlink", before.media.token)).toEqual(accepted);
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.removal?.state).toBe("failed");
  // A new explicit request observes ENOENT, but must still synchronize the directory.
  expect(await remove("synthetic-still-unflushed", (await inspect()).media.token)).toMatchObject({ exitCode: 0 });
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.removal?.state).toBe("failed");
  failSync.mockRestore(); syncBuiltinESMExports();
  expect(await remove("synthetic-synchronized-removal", (await inspect()).media.token)).toMatchObject({ exitCode: 0 });
  settleDamagePreviewMedia(fixture);
  expect(await inspect()).toMatchObject({ media: { state: "removed", removal: { state: "complete", outcomes: [{ outcome: "already_missing" }] }, history: [{ state: "failed" }, { state: "failed" }] } });
});
it("reports storage inspection failure separately from proven missing media", async () => {
  const { fixture, id, path, inspect } = await setup();
  const before = await inspect();
  const original = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((...args: unknown[]) => {
    if (args[0] === path) throw Object.assign(new Error("Synthetic storage fault"), { code: "EIO" });
    return Reflect.apply(original, fs, args);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  const unavailable = await inspect();
  expect(unavailable).toMatchObject({ generationStatus: "complete", artifacts: [{ media: { state: "unavailable", reasonCode: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE" } }], media: { state: "unavailable", deletion: { available: false } } });
  expect(await fixture.run(["damage-preview", "export", before.artifacts[0]!.identity, "--destination", join(fixture.operatorHostPath, "unavailable.mkv")])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE" } } });
  expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-storage-fault-delete", "--json", JSON.stringify({ mediaToken: unavailable.media.token })])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE" } } });
});

it("preserves a replacement file when the worker resumes an admitted removal", async () => {
  const { fixture, id, path, inspect } = await setup();
  const before = await inspect();
  const args = ["damage-preview", "delete", id, "--key", "synthetic-replacement-before-worker", "--json", JSON.stringify({ mediaToken: before.media.token })];
  const accepted = await fixture.run(args);
  expect(accepted.exitCode).toBe(0);
  const replacement = Buffer.from("synthetic replacement media that was not reviewed");
  writeFileSync(path, replacement);
  settleDamagePreviewMedia(fixture);
  expect(await fixture.run(args)).toEqual(accepted);
  expect(readFileSync(path)).toEqual(replacement);
  expect(await inspect()).toMatchObject({ provenance: before.provenance, media: { removal: { state: "failed" } } });
});
it("does not adopt a replacement file during deletion admission", async () => {
  const { fixture, id, path, inspect } = await setup();
  const before = await inspect();
  const access = fixture.openAccess();
  const readSnapshot = access.readConsistentSnapshot.bind(access);
  const replacement = Buffer.from("synthetic replacement during admission");
  let replaced = false;
  access.readConsistentSnapshot = (read) => {
    const result = readSnapshot(read);
    if (!replaced) { replaced = true; writeFileSync(path, replacement); }
    return result;
  };
  const args = ["damage-preview", "delete", id, "--key", "synthetic-admission-file-race", "--json", JSON.stringify({ mediaToken: before.media.token })];
  expect(await fixture.run(args, undefined, undefined, { openAccess: () => access })).toMatchObject({ exitCode: 0, result: { media: { removal: { state: "pending" } } } });
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.removal?.state).toBe("failed");
  expect(readFileSync(path)).toEqual(replacement);
});
