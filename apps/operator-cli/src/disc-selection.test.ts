import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { afterEach, expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
const key = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function fixture() {
  const current = createOperatorWorkflowFixture();
  fixtures.push(current);
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-disc", isPresent: true,
  });
  const contentId = `sha256:${"b".repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    volumeLabel: "SYNTHETIC_DISC",
    scanData: { schemaVersion: 2, contentId, titles: [
      { number: 1, durationSeconds: 4_000, chapters: 12, audioStreams: [], subtitles: [] },
      { number: 2, durationSeconds: 3_000, chapters: 8, audioStreams: [], subtitles: [] },
    ] },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  const archive = access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id, discKind: "dvd", archiveFormat: "iso",
    archivePath: "/media/originals/synthetic-disc.iso", fingerprint: contentId,
  });
  const first = access.catalog.createMediaItem({ kind: "movie", title: "Synthetic Film" });
  const second = access.catalog.createMediaItem({ kind: "movie", title: "Alternative Film" });
  access.close();
  return { current, archive, first, second };
}

afterEach(() => {
  for (const current of fixtures.splice(0)) current.dispose();
});

it("accepts equivalent flags, inline JSON, stdin, and optional file input without requiring a file", async () => {
  const { current, archive, first } = fixture();
  const json = JSON.stringify({ mediaItemId: first.id, sourceIdentity: { kind: "dvd_title", titleNumber: 1 } });
  const flags = ["--media-item-id", first.id, "--source-kind", "dvd_title", "--title-number", "1"];
  const created = await current.run(["disc-selection", "create", archive.id, "--key", key(1), ...flags]);
  expect(created.exitCode).toBe(0);
  expect(created.result).toMatchObject({ discSelection: { mediaItemId: first.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 } } });
  const replay = await current.run(["disc-selection", "create", archive.id, "--key", key(1), "--json", json]);
  expect(replay.result).toEqual(created.result);
  const stdinReplay = await current.run(["disc-selection", "create", archive.id, "--key", key(1), "--stdin"], null, json);
  expect(stdinReplay.result).toEqual(created.result);
  const filePath = join(current.mediaLibraryPath, "selection.json");
  writeFileSync(filePath, json);
  const fileReplay = await current.run(["disc-selection", "create", archive.id, "--key", key(1), "--file", filePath]);
  expect(fileReplay.result).toEqual(created.result);
  const conflict = await current.run(["disc-selection", "create", archive.id, "--key", key(1), "--json",
    JSON.stringify({ mediaItemId: first.id, sourceIdentity: { kind: "dvd_title", titleNumber: 2 } })]);
  expect(conflict.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });

  const stdin = await current.run(["disc-selection", "create", archive.id, "--key", key(2), "--stdin"], null,
    JSON.stringify({ mediaItemId: first.id, sourceIdentity: { kind: "dvd_title", titleNumber: 2 } }));
  expect(stdin.exitCode).toBe(0);
  writeFileSync(filePath, JSON.stringify({ mediaItemId: first.id,
    sourceIdentity: { kind: "dvd_chapters", titleNumber: 1, chapterStart: 1, chapterEnd: 2 } }));
  const file = await current.run(["disc-selection", "create", archive.id, "--key", key(3), "--file", filePath]);
  expect(file.exitCode).toBe(0);
  const access = current.openAccess();
  expect(access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toHaveLength(3);
  access.close();
});

it("previews consequential changes, rejects stale decisions, and applies eligible updates and deletions", async () => {
  const { current, archive, first, second } = fixture();
  const created = await current.run(["disc-selection", "create", archive.id,
    "--key", key(4), "--media-item-id", first.id, "--source-kind", "main_feature"]);
  expect(created.exitCode).toBe(0);
  const selectionId = (created.result as { discSelection: { id: string } }).discSelection.id;
  const preview = await current.run(["disc-selection", "preview", "update", archive.id, selectionId,
    "--media-item-id", second.id]);
  expect(preview.result).toMatchObject({ actionAvailability: { state: "editable" },
    historicalEncodeJobCount: 0, proposedDiscSelection: { mediaItemId: second.id } });
  const unchanged = await current.run(["disc-selection", "show", archive.id, selectionId]);
  expect(unchanged.result).toMatchObject({ discSelection: { mediaItemId: first.id } });
  const replacementDecision = preview.result as { catalogRevision: string; previewToken: string };
  const unreviewedReplacement = await current.run(["disc-selection", "update", archive.id, selectionId,
    "--key", key(12), "--media-item-id", second.id]);
  expect(unreviewedReplacement.result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  const replaced = await current.run(["disc-selection", "update", archive.id, selectionId,
    "--key", key(12), "--media-item-id", second.id,
    "--revision", replacementDecision.catalogRevision, "--preview-token", replacementDecision.previewToken,
    "--acknowledge"]);
  expect(replaced.result).toMatchObject({ discSelection: { mediaItemId: second.id } });
  const mismatched = await current.run(["disc-selection", "update", archive.id, selectionId,
    "--key", key(13), "--source-kind", "dvd_title", "--title-number", "1",
    "--revision", replacementDecision.catalogRevision, "--preview-token", replacementDecision.previewToken,
    "--acknowledge"]);
  expect(mismatched.result).toMatchObject({ error: { code: "SELECTION_REJECTED" } });
  const deletionPreview = await current.run(["disc-selection", "preview", "delete", archive.id, selectionId]);
  const staleDecision = deletionPreview.result as { catalogRevision: string; previewToken: string };
  const updated = await current.run(["disc-selection", "update", archive.id, selectionId,
    "--key", key(5), "--label", "Main feature"]);
  expect(updated.result).toMatchObject({ discSelection: { label: "Main feature" } });
  const stale = await current.run(["disc-selection", "delete", archive.id, selectionId,
    "--key", key(6), "--revision", staleDecision.catalogRevision,
    "--preview-token", staleDecision.previewToken, "--acknowledge"]);
  expect(stale.result).toMatchObject({ error: { code: "STALE_CATALOG_REVISION" } });
  const fresh = await current.run(["disc-selection", "preview", "delete", archive.id, selectionId]);
  const currentDecision = fresh.result as { catalogRevision: string; previewToken: string };
  const deleted = await current.run(["disc-selection", "delete", archive.id, selectionId,
    "--key", key(6), "--revision", currentDecision.catalogRevision,
    "--preview-token", currentDecision.previewToken, "--acknowledge"]);
  expect(deleted.result).toMatchObject({ deletionComplete: true, discSelection: { id: selectionId } });
  const replay = await current.run(["disc-selection", "delete", archive.id, selectionId,
    "--key", key(6), "--revision", currentDecision.catalogRevision,
    "--preview-token", currentDecision.previewToken, "--acknowledge"]);
  expect(replay.result).toEqual(deleted.result);
});

it("rejects invalid sources and protects locked Encode Job provenance", async () => {
  const { current, archive, first, second } = fixture();
  const invalid = await current.run(["disc-selection", "create", archive.id,
    "--key", key(7), "--media-item-id", first.id, "--source-kind", "dvd_title", "--title-number", "99"]);
  expect(invalid.result).toMatchObject({ error: { code: "SELECTION_REJECTED" } });
  const created = await current.run(["disc-selection", "create", archive.id,
    "--key", key(8), "--media-item-id", first.id, "--source-kind", "main_feature"]);
  const selectionId = (created.result as { discSelection: { id: string } }).discSelection.id;
  const access = current.openAccess();
  const profile = access.encodingProfiles.create({ key: "synthetic-profile", displayName: "Synthetic profile",
    mediaDomain: "dvd_video", settings: { preset: "Fast 480p30" } });
  access.catalog.completeCatalogReview(archive.id,
    access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  access.encodeJobs.enqueue({ discSelectionId: selectionId as Parameters<typeof access.encodeJobs.enqueue>[0]["discSelectionId"],
    encodingProfileId: profile.id, outputPath: join(current.mediaLibraryPath, "synthetic-film.mkv") });
  access.close();
  const detail = await current.run(["disc-selection", "show", archive.id, selectionId]);
  expect(detail.result).toMatchObject({ actionAvailability: { state: "locked_provenance",
    availableActions: ["correct"] }, affectedEncodeJobs: [{ status: "queued" }] });
  const updated = await current.run(["disc-selection", "preview", "update", archive.id, selectionId,
    "--media-item-id", second.id]);
  expect(updated.result).toMatchObject({ state: "blocked", actionAvailability: {
    state: "locked_provenance", availableActions: ["correct"] } });
  const deleted = await current.run(["disc-selection", "preview", "delete", archive.id, selectionId]);
  expect(deleted.result).toMatchObject({ state: "blocked", actionAvailability: {
    state: "locked_provenance", availableActions: ["correct"] } });
  const invalidProposal = await current.run(["disc-selection", "preview", "correct", archive.id, selectionId,
    "--media-item-id", second.id, "--source-kind", "dvd_title", "--title-number", "99"]);
  expect(invalidProposal.result).toMatchObject({ error: { code: "SELECTION_REJECTED" } });
  const preview = await current.run(["disc-selection", "preview", "correct", archive.id, selectionId,
    "--media-item-id", second.id, "--source-kind", "main_feature"]);
  expect(preview.result).toMatchObject({ proposedDiscSelection: { mediaItemId: second.id } });
  expect(preview.result).toMatchObject({ state: "available", consequences: {
    currentSelection: "superseded", createsReplacementSelection: true,
    requestsEncodeJobCancellation: [expect.any(String)],
    preservesEncodeJobHistory: true, reopensCatalogReview: true,
  } });
  const afterPreview = await current.run(["disc-selection", "show", archive.id, selectionId]);
  expect(afterPreview.result).toMatchObject({ affectedEncodeJobs: [{ status: "queued" }] });
  const decision = preview.result as { catalogRevision: string; previewToken: string };
  const corrected = await current.run(["disc-selection", "correct", archive.id, selectionId,
    "--key", key(11), "--revision", decision.catalogRevision, "--preview-token", decision.previewToken,
    "--acknowledge",
    "--media-item-id", second.id, "--source-kind", "main_feature"]);
  expect(corrected.result).toMatchObject({ discSelection: { mediaItemId: second.id },
    supersession: { supersededDiscSelectionId: selectionId } });
  expect((corrected.result as { discSelection: { id: string } }).discSelection.id).not.toBe(selectionId);
  const review = await current.run(["catalog-review", "show", archive.id]);
  expect(review.result).toMatchObject({ reviewOutcome: "needs_review", correctionHistory: [
    { supersededDiscSelection: { id: selectionId },
      replacementDiscSelection: { id: (corrected.result as { discSelection: { id: string } }).discSelection.id } },
  ] });
  const jobId = (detail.result as { affectedEncodeJobs: { id: string }[] }).affectedEncodeJobs[0]!.id;
  expect((await current.run(["inspect", "encode-jobs", jobId])).result).toMatchObject({
    item: { id: jobId, history: [expect.objectContaining({ discSelectionId: selectionId })] },
  });
});

it("previews unsafe legacy repair and quarantine while preserving completed Encode Job history", async () => {
  const { current, archive, first, second } = fixture();
  const access = current.openAccess();
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id, mediaItemId: first.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
  });
  const other = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id, mediaItemId: second.id,
    sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
  });
  const profile = access.encodingProfiles.create({ key: "legacy-recovery", displayName: "Legacy recovery",
    mediaDomain: "dvd_video", settings: {} });
  access.catalog.completeCatalogReview(archive.id,
    access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  const firstJob = access.encodeJobs.enqueue({ discSelectionId: selection.id,
    encodingProfileId: profile.id, outputPath: join(current.mediaLibraryPath, "first.mkv") });
  const secondJob = access.encodeJobs.enqueue({ discSelectionId: other.id,
    encodingProfileId: profile.id, outputPath: join(current.mediaLibraryPath, "second.mkv") });
  const firstClaim = access.encodeJobs.claimNext("synthetic-repair-worker")!;
  access.encodeJobs.complete(firstClaim);
  const secondClaim = access.encodeJobs.claimNext("synthetic-repair-worker")!;
  access.encodeJobs.fail(secondClaim, "Synthetic failed encode");
  access.close();
  const sqlite = new DatabaseSync(current.databasePath);
  sqlite.prepare("update disc_selections set source_key = 'legacy:noncanonical' where id in (?, ?)")
    .run(selection.id, other.id);
  sqlite.close();

  const show = await current.run(["disc-selection", "show", archive.id, selection.id]);
  expect(show.result).toMatchObject({ actionAvailability: { state: "needs_repair",
    availableActions: ["repair", "remove"] }, historicalEncodeJobCount: 1 });
  const blockedCorrection = await current.run(["disc-selection", "preview", "correct", archive.id,
    selection.id, "--media-item-id", second.id, "--source-kind", "dvd_title", "--title-number", "1"]);
  expect(blockedCorrection.result).toMatchObject({ state: "blocked", action: "correct_disc_selection",
    actionAvailability: { state: "needs_repair" } });
  expect(blockedCorrection.result).not.toHaveProperty("previewToken");

  const proposal = ["--media-item-id", second.id, "--source-kind", "dvd_title", "--title-number", "1"];
  const repairPreview = await current.run(["disc-selection", "preview", "repair", archive.id,
    selection.id, ...proposal]);
  expect(repairPreview.result).toMatchObject({ state: "available", consequences: {
    currentSelection: "deactivated", createsReplacementSelection: true,
    requestsEncodeJobCancellation: [], preservesEncodeJobHistory: true, reopensCatalogReview: true,
  } });
  const repairDecision = repairPreview.result as { catalogRevision: string; previewToken: string };
  const repaired = await current.run(["disc-selection", "repair", archive.id, selection.id,
    "--key", key(20), "--revision", repairDecision.catalogRevision,
    "--preview-token", repairDecision.previewToken, "--acknowledge", ...proposal]);
  expect(repaired.result).toMatchObject({ discSelection: { mediaItemId: second.id } });
  const replacementId = (repaired.result as { discSelection: { id: string } }).discSelection.id;
  expect(replacementId).not.toBe(selection.id);
  expect((await current.run(["disc-selection", "show", archive.id, replacementId])).result)
    .toMatchObject({ actionAvailability: { state: "editable", availableActions: ["update", "remove"] } });
  expect((await current.run(["inspect", "encode-jobs", firstJob.id])).result)
    .toMatchObject({ item: { history: [expect.objectContaining({ discSelectionId: selection.id })] } });

  const removal = await current.run(["disc-selection", "preview", "delete", archive.id, other.id]);
  expect(removal.result).toMatchObject({ state: "available", consequences: {
    currentSelection: "deactivated", createsReplacementSelection: false,
    preservesEncodeJobHistory: true,
  } });
  const removalDecision = removal.result as { catalogRevision: string; previewToken: string };
  const quarantined = await current.run(["disc-selection", "delete", archive.id, other.id,
    "--key", key(21), "--revision", removalDecision.catalogRevision,
    "--preview-token", removalDecision.previewToken, "--acknowledge"]);
  expect(quarantined.result).toMatchObject({ deletionComplete: true });
  expect((await current.run(["inspect", "encode-jobs", secondJob.id])).result)
    .toMatchObject({ item: { history: [expect.objectContaining({ discSelectionId: other.id })] } });
  expect((await current.run(["catalog-review", "show", archive.id])).result)
    .toMatchObject({ reviewOutcome: "needs_review",
      discSelections: [expect.objectContaining({ id: replacementId })] });
});

it("returns a structured blocked repair while an unsafe legacy selection has active work", async () => {
  const { current, archive, first } = fixture();
  const access = current.openAccess();
  const selection = access.catalog.createDiscSelection({ originalDiscArchiveId: archive.id,
    mediaItemId: first.id, sourceIdentity: { kind: "dvd_title", titleNumber: 1 } });
  const profile = access.encodingProfiles.create({ key: "active-repair", displayName: "Active repair",
    mediaDomain: "dvd_video", settings: {} });
  access.catalog.completeCatalogReview(archive.id,
    access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  const job = access.encodeJobs.enqueue({ discSelectionId: selection.id, encodingProfileId: profile.id,
    outputPath: join(current.mediaLibraryPath, "active.mkv") });
  access.close();
  const sqlite = new DatabaseSync(current.databasePath);
  sqlite.prepare("update disc_selections set source_key = 'legacy:noncanonical' where id = ?").run(selection.id);
  sqlite.close();
  const preview = await current.run(["disc-selection", "preview", "repair", archive.id, selection.id,
    "--media-item-id", first.id, "--source-kind", "dvd_title", "--title-number", "1"]);
  expect(preview.exitCode).toBe(0);
  expect(preview.result).toMatchObject({ state: "blocked", relatedEncodeJob: { id: job.id, status: "queued" },
    actionAvailability: { state: "needs_repair", availableActions: [] },
    reason: expect.stringContaining("direct mutation is unavailable") });
  expect(preview.result).not.toHaveProperty("previewToken");
});
