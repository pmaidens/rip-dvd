import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { CatalogMetadataLookup } from "@rip-dvd/application";
import { createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";
import type { MediaItemId } from "@rip-dvd/data-access";

import { createApplicationOperations } from "@rip-dvd/application";
import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";

import { runCommand } from "./command.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

function fixture() {
  const created = createOperatorWorkflowFixture();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  vi.useRealTimers();
  for (const current of fixtures.splice(0)) {
    current.dispose();
  }
});

it("dates recovered Worker Incident activity by the recovery event", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  const current = fixture();
  const access = current.openAccess();
  const identity = {
    workerKind: "archive", reasonCode: "claim_recovery_failure",
    phase: "claim_recovery", retryability: "automatic", schemaVersion: 1,
    evidence: { recoveryArea: "expired_archive_job_claim" },
  } as const;
  const incident = access.workerIncidents.record(identity);
  vi.setSystemTime(new Date("2026-09-01T00:00:01.000Z"));
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-drive", isEnabled: true, isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-incident-disc",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.archiveRequests.create({ detectedDiscId: disc.id });
  vi.setSystemTime(new Date("2026-09-01T00:00:02.000Z"));
  access.workerIncidents.resolve(identity);
  access.close();

  expect((await current.run(["inspect", "activity", "--limit", "1"])).result).toMatchObject({
    items: [{ kind: "worker-incidents", id: incident.id, status: "recovered" }],
  });
});

it("reports database health as JSON through the public command runner", async () => {
  const result = await fixture().run(["health"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(result.result).toEqual({
    status: "ok",
    sqliteVersion: expect.any(String),
    journalMode: "wal",
    busyTimeoutMs: 5_000,
  });
});

it("submits filesystem verification with replay, status, and bounded waiting", async () => {
  const current = fixture();
  const { archive } = seedCatalogReviewForReadFixture(current);
  const args = [
    "submit-filesystem-verification", "--key", "synthetic-verification-key",
    "--target", "original_disc_archive", "--id", archive.id,
  ];
  expect((await current.run(args.slice(0, 1))).result).toMatchObject({
    error: { code: "INVALID_MUTATION_KEY" },
  });
  const submitted = await current.run(args);
  expect(submitted.exitCode).toBe(0);
  expect(submitted.result).toMatchObject({ verificationRun: {
    target: "original_disc_archive", targetId: archive.id, status: "queued",
  } });
  expect((await current.run(args)).result).toEqual(submitted.result);
  const id = (submitted.result as { verificationRun: { id: string } }).verificationRun.id;
  expect((await current.run(["inspect", "filesystem-verifications", id])).result)
    .toMatchObject({ item: { id, status: "queued" } });
  const timedOut = await current.run([
    "wait", "filesystem-verifications", id, "--timeout-ms", "0",
  ]);
  expect(timedOut.exitCode).toBe(3);
  expect(timedOut.result).toMatchObject({ outcome: "timeout", current: { id, status: "queued" } });

  const worker = current.openAccess();
  const claim = worker.filesystemVerification.claimNext()!;
  await worker.filesystemVerification.execute(claim);
  worker.close();
  const settled = await current.run([
    "wait", "filesystem-verifications", id, "--timeout-ms", "0",
  ]);
  expect(settled.exitCode).toBe(0);
  expect(settled.result).toMatchObject({
    outcome: "settled", current: { id, status: "completed", resultStatus: "missing" },
  });
  expect((await current.run(args)).result).toEqual(submitted.result);
  expect((await current.run([
    "submit-filesystem-verification", "--key", "synthetic-verification-key",
    "--target", "encode_job_output", "--id", archive.id,
  ])).result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });

  const failedSubmission = await current.run([
    "submit-filesystem-verification", "--key", "synthetic-verification-failure",
    "--target", "original_disc_archive", "--id", archive.id,
  ]);
  const failedId = (failedSubmission.result as { verificationRun: { id: string } }).verificationRun.id;
  const failureWorker = current.openAccess();
  failureWorker.filesystemVerification.fail(failureWorker.filesystemVerification.claimNext()!);
  failureWorker.close();
  expect((await current.run([
    "wait", "filesystem-verifications", failedId, "--timeout-ms", "0",
  ])).result).toMatchObject({
    outcome: "settled", current: { status: "failed", failureCode: "VERIFICATION_UNAVAILABLE" },
  });
});

it("reports deployment readiness from persisted Optical Drive and Disc Inspection state", async () => {
  const current = fixture();
  const seed = current.openAccess();
  const drive = seed.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    serialNumber: "SYNTHETIC-DRIVE",
    isEnabled: true,
    isPresent: true,
  });
  const inspection = seed.discInspections.beginOrResume({
    opticalDriveId: drive.id,
    mediaGeneration: "synthetic-generation",
    mediaCapacityBytes: 2_048,
  }).inspection;
  seed.close();
  const result = await current.run(["readiness"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.result).toEqual({
    schemaVersion: 1,
    activeWork: [{ kind: "disc_inspection", id: inspection.id, status: "running" }],
    opticalDrives: [{
      id: drive.id,
      devicePath: "/dev/sr0",
      serialNumber: "SYNTHETIC-DRIVE",
      isEnabled: true,
      isPresent: true,
    }],
  });
});

it("inspects a Catalog Review and exposes metadata candidates through read-only commands", async () => {
  const current = fixture();
  const { archive, previousSelection, correctedSelection, predecessor } =
    seedCatalogReviewForReadFixture(current);
  const before = current.openAccess();
  const revision = before.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt.toISOString();
  const selectionsBefore = before.catalog.listDiscSelections({ originalDiscArchiveId: archive.id });
  before.close();

  const detail = await current.run(["catalog-review", "show", archive.id]);
  expect(detail.exitCode).toBe(0);
  expect(detail.result).toMatchObject({
    catalogRevision: revision,
    archive: { id: archive.id, detectedDiscId: archive.detectedDiscId, discLabel: "EXAMPLE_FILM_2020" },
    reviewActionAvailability: {
      completeWithSelections: { state: "available", reason: null },
      completeArchiveOnly: {
        state: "blocked",
        reason: "Archive-only Review cannot contain Disc Selections",
      },
    },
    rawScan: { titles: [{ number: 1, durationSeconds: 5_400 }] },
    correctionHistory: [{
      supersededDiscSelection: { id: previousSelection.id, sourceIdentity: { kind: "main_feature" } },
      replacementDiscSelection: { id: correctedSelection.id, sourceIdentity: { kind: "main_feature" } },
      reason: "Correct the synthetic mapping.",
    }],
    correctionEncodeHistory: [{
      replacementDiscSelectionId: correctedSelection.id,
      predecessorEncodeJob: { id: predecessor.id, status: "completed" },
    }],
    discSelections: [{
      id: correctedSelection.id,
      sourceIdentity: { kind: "main_feature" },
      actionAvailability: {
        state: "correction_lineage",
        availableActions: ["correct", "remove"],
        reason: expect.stringContaining("immutable correction lineage"),
      },
    }],
  });

  const lookup: CatalogMetadataLookup = {
    search: async () => [{ id: 42, kind: "movie", title: "Example Film", year: 2020 }],
    getTvDetails: async () => ({ seasons: [] }),
    getTvSeason: async () => { throw new Error("Unexpected season request"); },
  };
  const suggestion = await current.run(["catalog-review", "suggest", archive.id], lookup);
  expect(suggestion.exitCode).toBe(0);
  expect(suggestion.result).toMatchObject({
    status: "ready",
    candidates: [{ id: 42, kind: "movie", title: "Example Film", year: 2020 }],
    proposal: { kind: "movie", tmdbId: 42 },
  });
  const selected = await current.run(
    ["catalog-review", "suggest", archive.id, "--tmdb-id", "42", "--media-type", "movie"],
    lookup,
  );
  expect(selected.result).toMatchObject({ status: "ready", proposal: { tmdbId: 42 } });

  const after = current.openAccess();
  expect(after.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })).toEqual(selectionsBefore);
  expect(after.catalog.findMediaItemByTmdbIdentity({ mediaType: "movie", tmdbId: 42 })).toBeNull();
  after.close();

  const invalidOffset = await current.run(["catalog-review", "show", archive.id, "--selection-offset", "-1"]);
  expect(invalidOffset.exitCode).toBe(2);
  expect(invalidOffset.result).toEqual({
    error: { code: "INVALID_ARGUMENTS", message: "Invalid Catalog Review offset." },
  });
  const missing = await current.run(["catalog-review", "show", "missing-archive"]);
  expect(missing.exitCode).toBe(2);
  expect(missing.result).toEqual({
    error: { code: "REVIEW_NOT_FOUND", message: "Original Disc Archive not found." },
  });

  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const processResult = spawnSync(process.execPath, [entry, "catalog-review", "show", archive.id], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      RIP_DVD_DATABASE_PATH: current.databasePath,
      RIP_DVD_MEDIA_LIBRARY_PATH: current.mediaLibraryPath,
      RIP_DVD_ORIGINALS_LIBRARY_PATH: current.originalsLibraryPath,
    },
  });
  expect(processResult.status).toBe(0);
  expect(processResult.stderr).toBe("");
  expect(JSON.parse(processResult.stdout)).toEqual(detail.result);

  const finalize = current.openAccess();
  finalize.catalog.completeCatalogReview(
    archive.id,
    finalize.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
    "reviewed_with_selections",
  );
  finalize.close();
  const completed = await current.run(["catalog-review", "show", archive.id]);
  expect(completed.result).toMatchObject({
    reviewOutcome: "reviewed_with_selections",
    reviewActionAvailability: {
      completeWithSelections: { state: "blocked", reason: "Catalog review is already complete" },
      completeArchiveOnly: { state: "blocked", reason: "Archive-only Review cannot contain Disc Selections" },
    },
  });
});

it("maintains Media Items through keyed flags, structured input, previews, and replay", async () => {
  const current = fixture();
  expect((await current.run([
    "media-item", "create", "--kind", "movie", "--title", "Missing key",
  ])).result).toMatchObject({ error: { code: "INVALID_MUTATION_KEY" } });
  expect((await current.run([
    "media-item", "create", "--key", "media-invalid-001", "--json",
    JSON.stringify({ kind: "episode", title: "Orphan", episodeNumber: 1, parentId: "missing-season" }),
  ])).result).toMatchObject({ error: { code: "MEDIA_ITEM_NOT_FOUND" } });
  const beforeCreate = current.openAccess();
  expect(beforeCreate.catalog.listMediaItems()).toEqual([]);
  beforeCreate.close();
  const create = await current.run([
    "media-item", "create", "--key", "media-create-001",
    "--kind", "tv_show", "--title", "Example Show",
    "--tmdb-id", "42", "--tmdb-type", "tv_show",
  ]);
  expect(create.exitCode).toBe(0);
  const show = (create.result as { mediaItem: { id: string } }).mediaItem;
  expect((await current.run(["media-item", "show", show.id])).result).toMatchObject({
    mediaItem: { id: show.id, title: "Example Show" },
    tmdbIdentity: { mediaType: "tv_show", tmdbId: 42 },
  });
  const replay = await current.run([
    "media-item", "create", "--key", "media-create-001",
    "--kind", "tv_show", "--title", "Example Show",
    "--tmdb-id", "42", "--tmdb-type", "tv_show",
  ]);
  expect(replay.result).toEqual(create.result);
  const collision = await current.run([
    "media-item", "create", "--key", "media-create-001",
    "--kind", "tv_show", "--title", "Another Show",
  ]);
  expect(collision.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });

  const season = await current.run([
    "media-item", "create", "--key", "media-create-002", "--json",
    JSON.stringify({ kind: "season", title: "Season One", seasonNumber: 1, parentId: show.id }),
  ]);
  expect(season.exitCode).toBe(0);
  const seasonId = (season.result as { mediaItem: { id: string } }).mediaItem.id;
  const file = join(dirname(current.databasePath), "episode.json");
  writeFileSync(file, JSON.stringify({
    kind: "episode", title: "Pilot", episodeNumber: 1, parentId: seasonId,
  }));
  const episode = await current.run([
    "media-item", "create", "--key", "media-create-003", "--file", file,
  ]);
  expect(episode.exitCode).toBe(0);
  const episodeId = (episode.result as { mediaItem: { id: string } }).mediaItem.id;
  const search = await current.run(["media-item", "search", "--query", "Pilot"]);
  expect(search.result).toMatchObject({
    results: [{ mediaItem: { id: episodeId }, ancestors: [{ id: show.id }, { id: seasonId }] }],
  });
  const ordinary = await current.run(["media-item", "update", episodeId,
    "--key", "media-ordinary-update", "--title", "Pilot Draft"]);
  expect(ordinary.result).toMatchObject({ mediaItem: { title: "Pilot Draft" } });
  const preview = await current.run(["media-item", "preview", "update", episodeId,
    "--title", "Revised Pilot"]);
  expect(preview.result).toMatchObject({ action: "update", maintenance: { childCount: 0 },
    proposedMediaItem: { title: "Revised Pilot" }, requiresAcknowledgement: false });
  const revision = (preview.result as { revision: string }).revision;
  const changed = await current.run([
    "media-item", "update", episodeId, "--key", "media-update-001",
    "--acknowledge", revision, "--json", "-",
  ], undefined, JSON.stringify({ title: "Revised Pilot" }));
  expect(changed.result).toMatchObject({ mediaItem: { title: "Revised Pilot" } });
  expect((await current.run([
    "media-item", "update", episodeId, "--key", "media-update-001",
    "--acknowledge", revision, "--title", "Revised Pilot",
  ])).result).toEqual(changed.result);
  const stale = await current.run([
    "media-item", "update", episodeId, "--key", "media-update-002",
    "--acknowledge", revision, "--title", "Revised Pilot",
  ]);
  expect(stale.result).toMatchObject({ error: { code: "STALE_MEDIA_ITEM_REVISION" } });
  const after = current.openAccess();
  expect(after.catalog.listMediaItems({ ids: [episodeId as MediaItemId] })[0]?.title).toBe("Revised Pilot");
  expect(after.catalog.findMediaItemByTmdbIdentity({ mediaType: "tv_show", tmdbId: 42 })?.id).toBe(show.id);
  after.close();

  const showDeletePreview = await current.run(["media-item", "preview", "delete", show.id]);
  const blocked = await current.run([
    "media-item", "delete", show.id, "--key", "media-delete-001",
    "--acknowledge", (showDeletePreview.result as { revision: string }).revision,
  ]);
  expect(blocked.result).toMatchObject({ error: { code: "MEDIA_ITEM_ACTION_REJECTED" } });
  const episodeDeletePreview = await current.run(["media-item", "preview", "delete", episodeId]);
  const episodeRevision = (episodeDeletePreview.result as { revision: string }).revision;
  const deleted = await current.run([
    "media-item", "delete", episodeId, "--key", "media-delete-002",
    "--acknowledge", episodeRevision,
  ]);
  expect(deleted.result).toMatchObject({ mediaItem: { id: episodeId } });
  expect((await current.run([
    "media-item", "delete", episodeId, "--key", "media-delete-002",
    "--acknowledge", episodeRevision,
  ])).result).toEqual(deleted.result);
});

it("accepts Media Item JSON from stdin and files in the server-local executable", () => {
  const current = fixture();
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const environment = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    RIP_DVD_DATABASE_PATH: current.databasePath,
    RIP_DVD_MEDIA_LIBRARY_PATH: current.mediaLibraryPath,
    RIP_DVD_ORIGINALS_LIBRARY_PATH: current.originalsLibraryPath,
  };
  const piped = spawnSync(process.execPath, [
    entry, "media-item", "create", "--key", "media-process-001", "--json", "-",
  ], {
    encoding: "utf8",
    env: environment,
    input: JSON.stringify({ kind: "movie", title: "Piped Example" }),
  });
  expect(piped.status).toBe(0);
  expect(piped.stderr).toBe("");
  expect(JSON.parse(piped.stdout)).toMatchObject({ mediaItem: { title: "Piped Example" } });
  const file = join(dirname(current.databasePath), "media-item.json");
  writeFileSync(file, JSON.stringify({ kind: "movie", title: "File Example" }));
  const fromFile = spawnSync(process.execPath, [
    entry, "media-item", "create", "--key", "media-process-002", "--file", file,
  ], { encoding: "utf8", env: environment });
  expect(fromFile.status).toBe(0);
  expect(fromFile.stderr).toBe("");
  expect(JSON.parse(fromFile.stdout)).toMatchObject({ mediaItem: { title: "File Example" } });
  const rejected = spawnSync(process.execPath, [
    entry, "media-item", "create", "--kind", "movie", "--title", "Unkeyed Example",
  ], { encoding: "utf8", env: environment });
  expect(rejected.status).toBe(2);
  expect(JSON.parse(rejected.stdout)).toMatchObject({ error: { code: "INVALID_MUTATION_KEY" } });
});

it("discovers commands and rejects unsupported invocations without opening SQLite", async () => {
  const stdout: string[] = [];
  const io = {
    openAccess: () => { throw new Error("should not open SQLite"); },
    stdout: (text: string) => stdout.push(text),
    stderr: () => {},
  };

  expect(await runCommand([], io)).toBe(0);
  expect(JSON.parse(stdout.pop()!)).toMatchObject({
    schemaVersion: 1,
    usage: "rip-dvd-operator <command>",
    commands: expect.arrayContaining([
      expect.objectContaining({ name: "health", inputs: { arguments: [], options: [] } }),
      expect.objectContaining({ name: "readiness", example: "rip-dvd-operator readiness" }),
    ]),
  });
  expect(await runCommand(["commands"], io)).toBe(0);
  expect(JSON.parse(stdout.pop()!)).toEqual({
    schemaVersion: 1,
    commands: [
      "generate-key",
      "submit-archive-request",
      "cancel-archive-request",
      "retry-archive-request",
      "retry-disc-inspection",
      "submit-filesystem-verification",
      "catalog-review",
      "disc-selection",
      "list-encoding-profiles",
      "create-encoding-profile",
      "version-encoding-profile",
      "preview-encoding-profile-state",
      "activate-encoding-profile",
      "deactivate-encoding-profile",
      "media-item",
      "health",
      "readiness",
      "inspect",
      "wait",
      "commands",
      "help",
    ],
  });
  expect(await runCommand(["health", "--help"], io)).toBe(0);
  expect(JSON.parse(stdout.pop()!)).toMatchObject({
    command: { name: "health", usage: "rip-dvd-operator health" },
  });
  expect(await runCommand(["health", "--unexpected"], io)).toBe(2);
  expect(JSON.parse(stdout.pop()!)).toEqual({
    error: { code: "INVALID_ARGUMENTS", message: "health takes no arguments." },
  });
  expect(await runCommand(["retired-command"], io)).toBe(2);
  expect(JSON.parse(stdout.pop()!)).toEqual({
    error: { code: "UNKNOWN_COMMAND", message: "Unknown command." },
  });
});

it("returns a stable failure without exposing database errors", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCommand(["health"], {
    openAccess: () => { throw new Error("private path and SQLite detail"); },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });

  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout[0])).toEqual({
    error: {
      code: "HEALTH_UNAVAILABLE",
      message: "Application health is unavailable.",
    },
  });
  expect(stdout[0]).not.toContain("private path");
  expect(stderr).toEqual(["Application health is unavailable.\n"]);
});

it("inspects full attempts and keeps request intent separate from job attempts", async () => {
  const current = fixture();
  const access = current.openAccess();
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0", isEnabled: true, isPresent: true,
  });
  const started = access.discInspections.beginOrResume({
    opticalDriveId: drive.id,
    mediaGeneration: "synthetic-generation",
    mediaCapacityBytes: 2_048,
  });
  access.discInspections.record(started.claim!, {
    type: "fail", reasonCode: "metadata_read_failed", diagnostic: "synthetic read failure",
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: "synthetic-fingerprint",
    volumeLabel: "SYNTHETIC_DISC",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  const request = access.archiveRequests.create({ detectedDiscId: disc.id });
  access.close();

  const inspection = await current.run(["inspect", "disc-inspections", started.inspection.id]);
  expect(inspection.exitCode).toBe(0);
  expect(inspection.result).toMatchObject({
    schemaVersion: 1,
    kind: "disc-inspections",
    item: {
      id: started.inspection.id,
      mediaGeneration: "synthetic-generation",
      mediaCapacityBytes: 2_048,
      attempts: [expect.objectContaining({
        attemptNumber: 1, outcome: "failed", reasonCode: "metadata_read_failed",
      })],
      availableActions: [expect.objectContaining({ name: "retry", eligible: true })],
    },
  });
  expect(JSON.stringify(inspection.result)).not.toContain("claimToken");

  const requestDetail = await current.run(["inspect", "archive-requests", request.id]);
  expect(requestDetail.result).toMatchObject({
    item: { id: request.id, status: "pending", archiveJobs: [] },
  });
  expect((await current.run(["inspect", "detected-discs", disc.id])).result).toMatchObject({
    item: {
      id: disc.id,
      archiveRequests: [expect.objectContaining({ id: request.id })],
      currentArchiveRequest: { id: request.id, status: "pending" },
      availableActions: [expect.objectContaining({ name: "request-archive", eligible: false })],
    },
  });
  const timedOut = await current.run([
    "wait", "archive-requests", request.id, "--timeout-ms", "0",
  ]);
  expect(timedOut.exitCode).toBe(3);
  expect(timedOut.stderr).toBe("");
  expect(timedOut.result).toMatchObject({
    outcome: "timeout", current: { id: request.id, status: "pending", archiveJobs: [] },
  });
  expect((await current.run(["inspect", "archive-requests", request.id])).result)
    .toMatchObject({ item: { status: "pending" } });

  const settled = await current.run([
    "wait", "disc-inspections", started.inspection.id, "--timeout-ms", "0",
  ]);
  expect(settled.exitCode).toBe(0);
  expect(settled.result).toMatchObject({ outcome: "settled", current: { status: "failed" } });

  const retryAccess = current.openAccess();
  retryAccess.discInspections.requestRetry(started.inspection.id);
  retryAccess.close();
  const retryPending = await current.run([
    "wait", "disc-inspections", started.inspection.id, "--timeout-ms", "0",
  ]);
  expect(retryPending.exitCode).toBe(3);
  expect(retryPending.result).toMatchObject({ outcome: "timeout", current: {
    status: "failed", manualRetryRequestedAt: expect.any(String),
  } });
});

it("reports encode action eligibility and correction evidence through the public command", async () => {
  const current = fixture();
  const access = current.openAccess();
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/synthetic-drive", isEnabled: true, isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-encode-disc",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.archiveRequests.create({ detectedDiscId: disc.id });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: drive.id, mediaGeneration: "synthetic-encode-generation",
    mediaCapacityBytes: 2_048,
  });
  access.discInspections.record(started.claim, {
    type: "metadata", volumeLabel: "SYNTHETIC_DISC", titleCount: 0, chapterCount: 0,
    audioStreamCount: 0, subtitleStreamCount: 0, totalBytes: 2_048,
  });
  const inspection = access.discInspections.record(started.claim, {
    type: "complete", detectedDiscId: disc.id,
  });
  started.restoreSystemTime();
  const claim = access.archiveJobs.startForInspection(inspection.id, "synthetic-worker")!;
  const completed = access.archiveJobs.publish(claim, {
    archivePath: "/synthetic/original.iso", sizeBytes: 2_048,
    boundaryEvidence: createNormalDvdArchiveBoundaryEvidenceForTest(2_048),
    integrityEvidence: createCleanReadArchiveIntegrityEvidence("dvd-recovery-v1"),
  });
  const archive = access.catalog.listOriginalDiscArchives({ ids: [completed.originalDiscArchiveId!] })[0]!;
  const item = access.catalog.createMediaItem({ kind: "movie", title: "Synthetic Movie" });
  const selection = access.catalog.createDiscSelection({
    originalDiscArchiveId: archive.id, mediaItemId: item.id,
    sourceIdentity: { kind: "main_feature" },
  });
  const revisedArchive = access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!;
  access.catalog.completeCatalogReview(archive.id, revisedArchive.updatedAt, "reviewed_with_selections");
  const profile = access.encodingProfiles.create({
    key: "synthetic-encode", displayName: "Synthetic encode", mediaDomain: "dvd_video",
    settings: { preset: "Fast 480p30" },
  });
  const job = access.encodeJobs.enqueue({
    discSelectionId: selection.id, encodingProfileId: profile.id,
    outputPath: "/synthetic/output.mkv",
  });
  access.close();

  const result = await current.run(["inspect", "encode-jobs", job.id]);
  expect(result.exitCode).toBe(0);
  expect(result.result).toMatchObject({ item: {
    id: job.id,
    history: [expect.objectContaining({ id: job.id })],
    correctionLinks: [expect.objectContaining({ id: job.id })],
    retainedOutputs: [],
    availableActions: expect.arrayContaining([
      expect.objectContaining({ name: "requeue", eligible: false }),
      expect.objectContaining({ name: "verify-output", eligible: true }),
    ]),
  } });
  expect(JSON.stringify(result.result)).not.toContain("/synthetic/output.mkv");

  const writer = current.openAccess();
  const claimed = writer.encodeJobs.claimNext("synthetic-encode-worker")!;
  const cleanup = writer.encodeJobs.registerPartialCleanup(claimed);
  writer.encodeJobs.fail(claimed, "Synthetic encode failure");
  writer.close();
  expect((await current.run(["inspect", "encode-jobs", job.id])).result).toMatchObject({ item: {
    status: "failed",
    availableActions: expect.arrayContaining([
      expect.objectContaining({
        name: "requeue", eligible: false,
        reason: "Encode Job has pending output cleanup.",
      }),
    ]),
  } });
  const cleanupWriter = current.openAccess();
  cleanupWriter.encodeJobs.completePartialCleanup(cleanup);
  cleanupWriter.close();
  expect((await current.run(["inspect", "encode-jobs", job.id])).result).toMatchObject({ item: {
    status: "failed",
    availableActions: expect.arrayContaining([
      expect.objectContaining({ name: "requeue", eligible: true, reason: null }),
    ]),
  } });
});

it("observes a later transition during a bounded wait", async () => {
  const current = fixture();
  const access = current.openAccess();
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0", isEnabled: true, isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id, discKind: "dvd", fingerprint: "synthetic-wait-disc",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  const request = access.archiveRequests.create({ detectedDiscId: disc.id });
  access.close();
  const transition = setTimeout(() => {
    const writer = current.openAccess();
    try {
      writer.archiveRequests.cancel(request.id);
    } finally {
      writer.close();
    }
  }, 20);
  try {
    const result = await current.run([
      "wait", "archive-requests", request.id,
      "--timeout-ms", "500", "--poll-ms", "100",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      outcome: "settled", current: { status: "cancelled" },
    });
    expect((await current.run(["inspect", "detected-discs", disc.id])).result).toMatchObject({
      item: {
        currentArchiveRequest: { id: request.id, status: "cancelled" },
        availableActions: [expect.objectContaining({ name: "request-archive", eligible: true })],
      },
    });
  } finally {
    clearTimeout(transition);
  }
});

it("validates inspection and wait arguments before opening the database", async () => {
  const current = fixture();
  expect((await current.run(["inspect", "disc-inspections", "--limit", "101"])).result)
    .toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  expect((await current.run(["inspect", "disc-inspections", "missing-id"])).result)
    .toMatchObject({ error: { code: "NOT_FOUND" } });
  expect((await current.run([
    "wait", "archive-jobs", "missing-id", "--timeout-ms", "0",
  ])).result).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect((await current.run([
    "wait", "archive-jobs", "missing-id", "--timeout-ms", "3600001",
  ])).result).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
});

it("runs as a separate process without the web service", () => {
  const paths = fixture();
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const environment = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    RIP_DVD_DATABASE_PATH: paths.databasePath,
    RIP_DVD_MEDIA_LIBRARY_PATH: paths.mediaLibraryPath,
    RIP_DVD_ORIGINALS_LIBRARY_PATH: paths.originalsLibraryPath,
  };
  const invoke = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: environment,
  });

  const health = invoke("health");
  expect(health.status).toBe(0);
  expect(health.stderr).toBe("");
  expect(health.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(health.stdout)).toMatchObject({ status: "ok", journalMode: "wal" });

  const readiness = invoke("readiness");
  expect(readiness.status).toBe(0);
  expect(readiness.stderr).toBe("");
  expect(JSON.parse(readiness.stdout)).toEqual({
    schemaVersion: 1,
    activeWork: [],
    opticalDrives: [],
  });

  const inspection = invoke("inspect", "activity");
  expect(inspection.status).toBe(0);
  expect(JSON.parse(inspection.stdout)).toEqual({
    schemaVersion: 1, kind: "activity", items: [],
  });

  const missingWait = invoke("wait", "archive-requests", "synthetic-missing-id", "--timeout-ms", "0");
  expect(missingWait.status).toBe(2);
  expect(JSON.parse(missingWait.stdout)).toEqual({
    error: { code: "NOT_FOUND", message: "Operational record was not found." },
  });

  const profile = invoke(
    "create-encoding-profile", "--key", "synthetic-process-profile-key-001",
    "--profile-key", "process-example", "--display-name", "Process example",
    "--preset", "Fast 480p30",
  );
  expect(profile.status).toBe(0);
  expect(profile.stderr).toBe("");
  const listedProfiles = invoke("list-encoding-profiles");
  expect(listedProfiles.status).toBe(0);
  expect(JSON.parse(listedProfiles.stdout)).toMatchObject({
    profiles: [expect.objectContaining({ key: "process-example", isActive: true })],
  });

  const invalid = invoke("health", "--invalid");
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toBe("health takes no arguments.\n");
  expect(JSON.parse(invalid.stdout)).toEqual({
    error: { code: "INVALID_ARGUMENTS", message: "health takes no arguments." },
  });

  const noConfig = spawnSync(process.execPath, [entry, "health"], {
    encoding: "utf8",
    env: {
      NODE_NO_WARNINGS: "1",
    },
  });
  expect(noConfig.status).toBe(1);
  expect(noConfig.stderr).toBe("Application configuration is missing or invalid.\n");
  expect(JSON.parse(noConfig.stdout)).toEqual({
    error: {
      code: "CONFIGURATION_ERROR",
      message: "Application configuration is missing or invalid.",
    },
  });
});

function addScannedDisc(current: ReturnType<typeof createOperatorWorkflowFixture>, fingerprint: string) {
  const access = current.openAccess();
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/sr0",
    isEnabled: true,
    isPresent: true,
  });
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint,
    volumeLabel: "SYNTHETIC_DISC",
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.close();
  return disc.id;
}

function seedEncodeJobForProfile(
  current: ReturnType<typeof createOperatorWorkflowFixture>,
  profileId: string,
) {
  const access = createLegacySidecarDataAccess({
    databasePath: current.databasePath,
    mediaLibraryPath: current.mediaLibraryPath,
    originalsLibraryPath: current.originalsLibraryPath,
  });
  try {
    const drive = access.catalog.upsertOpticalDrive({
      devicePath: "/dev/synthetic-profile-disc", isPresent: true,
    });
    const disc = access.catalog.registerDetectedDisc({
      opticalDriveId: drive.id,
      discKind: "dvd",
      fingerprint: "synthetic-profile-history-disc",
    });
    access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    access.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = access.catalog.createOriginalDiscArchive({
      detectedDiscId: disc.id,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: join(current.originalsLibraryPath, "synthetic-history.iso"),
      fingerprint: "synthetic-profile-history-disc",
    });
    const item = access.catalog.createMediaItem({ kind: "movie", title: "Synthetic history" });
    const selection = access.catalog.createDiscSelection({
      originalDiscArchiveId: archive.id,
      mediaItemId: item.id,
      sourceIdentity: { kind: "main_feature" },
    });
    access.catalog.completeCatalogReview(
      archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      "reviewed_with_selections",
    );
    const profile = access.encodingProfiles.list({ mediaDomain: "dvd_video" })
      .find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error("Expected synthetic Encoding Profile");
    return access.encodeJobs.enqueue({
      discSelectionId: selection.id,
      encodingProfileId: profile.id,
      outputPath: join(current.mediaLibraryPath, "synthetic-history.mkv"),
    }).id;
  } finally {
    access.close();
  }
}

it("generates a key without submitting work and rejects a missing key before opening SQLite", async () => {
  const current = fixture();
  const generated = await current.run(["generate-key"]);
  expect(generated.exitCode).toBe(0);
  expect(generated.result).toEqual({
    mutationKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  const reader = current.openAccess();
  expect(reader.archiveRequests.list()).toEqual([]);
  reader.close();

  let opened = false;
  const stdout: string[] = [];
  const exitCode = await runCommand(["submit-archive-request", "--detected-disc-id", "disc-id"], {
    openAccess: () => { opened = true; throw new Error("unexpected open"); },
    stdout: (text) => stdout.push(text),
    stderr: () => {},
  });
  expect(exitCode).toBe(2);
  expect(opened).toBe(false);
  expect(JSON.parse(stdout.join(""))).toMatchObject({ error: { code: "INVALID_MUTATION_KEY" } });
});

it("rejects missing Encoding Profile mutation keys before opening SQLite", async () => {
  for (const args of [
    ["create-encoding-profile", "--profile-key", "synthetic", "--display-name", "Synthetic", "--preset", "Fast 480p30"],
    ["version-encoding-profile", "--source-profile-id", "synthetic-id", "--preset", "Fast 480p30"],
    ["activate-encoding-profile", "--id", "synthetic-id", "--revision", "synthetic-revision", "--acknowledge"],
    ["deactivate-encoding-profile", "--id", "synthetic-id", "--revision", "synthetic-revision", "--acknowledge"],
  ]) {
    let opened = false;
    const stdout: string[] = [];
    const exitCode = await runCommand(args, {
      openAccess: () => { opened = true; throw new Error("unexpected open"); },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    expect(exitCode).toBe(2);
    expect(opened).toBe(false);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ error: { code: "INVALID_MUTATION_KEY" } });
  }
});

it("replays the original Archive Request outcome after a lost response and restart", async () => {
  const current = fixture();
  const detectedDiscId = addScannedDisc(current, "synthetic-replay-disc");
  const mutationKey = "00000000-0000-4000-8000-000000000101";
  const access = current.openAccess();
  const committed = createApplicationOperations(access).submitArchiveRequest({
    mutationKey,
    detectedDiscId,
  });
  access.archiveRequests.cancel(committed.archiveRequest.id);
  access.close();

  const replay = await current.run([
    "submit-archive-request", "--key", mutationKey,
    "--detected-disc-id", detectedDiscId,
  ]);
  expect(replay.exitCode).toBe(0);
  expect(replay.result).toEqual(committed);
  const reader = current.openAccess();
  expect(reader.archiveRequests.list()).toHaveLength(1);
  expect(reader.archiveRequests.list()[0]?.status).toBe("cancelled");
  expect(reader.archiveJobs.list()).toEqual([]);
  reader.close();
});

it("cancels waiting work immediately and replays the original outcome", async () => {
  const current = fixture();
  const detectedDiscId = addScannedDisc(current, "synthetic-cancel-disc");
  const access = current.openAccess();
  const request = access.archiveRequests.create({ detectedDiscId });
  access.close();
  const key = "00000000-0000-4000-8000-000000000201";
  const args = ["cancel-archive-request", "--key", key, "--archive-request-id", request.id];

  const cancelled = await current.run(args);
  expect(cancelled.exitCode).toBe(0);
  expect(cancelled.result).toEqual({ archiveRequest: { id: request.id, status: "cancelled" } });
  expect((await current.run(["inspect", "archive-requests", request.id])).result)
    .toMatchObject({ item: { status: "cancelled", archiveJobs: [] } });
  expect((await current.run(args)).result).toEqual(cancelled.result);

  const blocked = await current.run([
    "cancel-archive-request", "--key", "00000000-0000-4000-8000-000000000202",
    "--archive-request-id", request.id,
  ]);
  expect(blocked.result).toMatchObject({ error: {
    code: "ACTION_BLOCKED",
    blockingReasons: [{ code: "INVALID_TRANSITION" }],
  } });
  const conflict = await current.run([
    "retry-archive-request", "--key", key, "--archive-request-id", request.id,
  ]);
  expect(conflict.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});

it("retries unsuccessful Archive Requests and failed Disc Inspections while retaining attempts", async () => {
  const current = fixture();
  const detectedDiscId = addScannedDisc(current, "synthetic-retry-disc");
  const access = current.openAccess();
  const drive = access.catalog.listOpticalDrives()[0]!;
  const request = access.archiveRequests.create({ detectedDiscId });
  const started = beginSettledDiscInspectionForTest(access, {
    opticalDriveId: drive.id,
    mediaGeneration: "synthetic-retry-generation",
    mediaCapacityBytes: 2_048,
  });
  access.discInspections.record(started.claim, {
    type: "metadata", volumeLabel: "SYNTHETIC_DISC", titleCount: 0, chapterCount: 0,
    audioStreamCount: 0, subtitleStreamCount: 0, totalBytes: 2_048,
  });
  const completedInspection = access.discInspections.record(started.claim, {
    type: "complete", detectedDiscId,
  });
  started.restoreSystemTime();
  const firstClaim = access.archiveJobs.startForInspection(completedInspection.id, "synthetic-worker")!;
  access.archiveJobs.fail(firstClaim, "Synthetic read failure");
  access.close();

  const key = "00000000-0000-4000-8000-000000000203";
  const args = ["retry-archive-request", "--key", key, "--archive-request-id", request.id];
  const retried = await current.run(args);
  expect(retried.result).toEqual({ archiveRequest: { id: request.id, status: "pending" } });
  expect((await current.run(["inspect", "archive-requests", request.id])).result).toMatchObject({
    item: { status: "pending", archiveJobs: [{ id: firstClaim.id, status: "failed", attemptOrdinal: 1 }] },
  });
  const resumedAccess = current.openAccess();
  const secondClaim = resumedAccess.archiveJobs.startForInspection(completedInspection.id, "synthetic-worker")!;
  resumedAccess.close();
  expect(secondClaim.archiveRequestId).toBe(request.id);
  expect(secondClaim.attemptOrdinal).toBe(2);
  expect((await current.run(args)).result).toEqual(retried.result);

  const cancel = await current.run([
    "cancel-archive-request", "--key", "00000000-0000-4000-8000-000000000204",
    "--archive-request-id", request.id,
  ]);
  expect(cancel.result).toEqual({
    archiveRequest: { id: request.id, status: "cancellation_requested" },
  });
  const cancellationAccess = current.openAccess();
  expect(cancellationAccess.archiveJobs.find(secondClaim.id)?.status).toBe("running");
  cancellationAccess.archiveJobs.abort(secondClaim, "Synthetic operator cancellation");
  cancellationAccess.close();
  expect((await current.run(["inspect", "archive-requests", request.id])).result)
    .toMatchObject({ item: { status: "cancelled", archiveJobs: [
      { id: firstClaim.id, status: "failed" }, { id: secondClaim.id, status: "aborted" },
    ] } });

  const failedAccess = current.openAccess();
  const failedStart = beginSettledDiscInspectionForTest(failedAccess, {
    opticalDriveId: drive.id,
    mediaGeneration: "synthetic-failed-generation",
    mediaCapacityBytes: 2_048,
  });
  const failed = failedAccess.discInspections.record(failedStart.claim, {
    type: "fail", reasonCode: "invalid_metadata",
  });
  failedStart.restoreSystemTime();
  failedAccess.close();
  const inspectionKey = "00000000-0000-4000-8000-000000000205";
  const inspectionArgs = ["retry-disc-inspection", "--key", inspectionKey,
    "--disc-inspection-id", failed.id];
  const inspectionRetry = await current.run(inspectionArgs);
  expect(inspectionRetry.result).toMatchObject({ inspection: { id: failed.id, status: "failed" } });
  expect((await current.run(["inspect", "disc-inspections", failed.id])).result)
    .toMatchObject({ item: {
      manualRetryRequestedAt: expect.any(String),
      availableActions: [expect.objectContaining({ eligible: false,
        blockingReasons: [{ code: "INVALID_TRANSITION", message: "Retry already requested." }] })],
    } });
  expect((await current.run(inspectionArgs)).result).toEqual(inspectionRetry.result);
});

it("keeps invocation keys separate from same-name Detected Discs and eligibility", async () => {
  const current = fixture();
  const firstId = addScannedDisc(current, "synthetic-disc-one");
  const secondId = addScannedDisc(current, "synthetic-disc-two");
  const key = "00000000-0000-4000-8000-000000000102";
  const first = await current.run([
    "submit-archive-request", "--key", key, "--detected-disc-id", firstId,
  ]);
  const changedTarget = await current.run([
    "submit-archive-request", "--key", key, "--detected-disc-id", secondId,
  ]);
  const second = await current.run([
    "submit-archive-request", "--key", "00000000-0000-4000-8000-000000000103",
    "--detected-disc-id", secondId,
  ]);
  expect(first.exitCode).toBe(0);
  expect(changedTarget.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
  expect(second.exitCode).toBe(0);
  expect(second.result).not.toEqual(first.result);
  const reader = current.openAccess();
  expect(reader.archiveRequests.list()).toHaveLength(2);
  reader.close();
});

it("serializes concurrent submissions from separate processes", async () => {
  const current = fixture();
  const detectedDiscId = addScannedDisc(current, "synthetic-concurrent-disc");
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const environment = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    RIP_DVD_DATABASE_PATH: current.databasePath,
    RIP_DVD_MEDIA_LIBRARY_PATH: current.mediaLibraryPath,
    RIP_DVD_ORIGINALS_LIBRARY_PATH: current.originalsLibraryPath,
  };
  const invoke = () => new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [entry, "submit-archive-request", "--key",
      "00000000-0000-4000-8000-000000000104", "--detected-disc-id", detectedDiscId], {
      env: environment,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("close", (status) => resolve({ status, stdout }));
  });
  const [first, second] = await Promise.all([invoke(), invoke()]);
  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
  const reader = current.openAccess();
  expect(reader.archiveRequests.list()).toHaveLength(1);
  expect(reader.archiveJobs.list()).toEqual([]);
  reader.close();
});

it("manages Encoding Profile versions with durable replay and revision-bound state changes", async () => {
  const current = fixture();
  const createKey = "00000000-0000-4000-8000-000000000201";
  const createArgs = [
    "create-encoding-profile", "--key", createKey,
    "--profile-key", "synthetic-dvd", "--display-name", "Synthetic DVD",
    "--preset", "Fast 480p30",
  ];
  const created = await current.run(createArgs);
  expect(created.exitCode).toBe(0);
  const first = (created.result as { profile: { id: string } }).profile;
  const historicalJobId = seedEncodeJobForProfile(current, first.id);
  expect((await current.run(["list-encoding-profiles"])).result).toMatchObject({
    schemaVersion: 1,
    profiles: [expect.objectContaining({
      id: first.id, version: 1, isActive: true,
      eligibility: expect.objectContaining({ newEncodeJobs: true, blockingReasons: [] }),
    })],
  });
  const changedInput = await current.run([...createArgs.slice(0, -1), "HQ 480p30 Surround"]);
  expect(changedInput.result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
  expect((await current.run([
    "version-encoding-profile", "--key", createKey,
    "--source-profile-id", first.id, "--preset", "HQ 480p30 Surround",
  ])).result).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });

  const versionArgs = [
    "version-encoding-profile", "--key", "00000000-0000-4000-8000-000000000202",
    "--source-profile-id", first.id, "--preset", "HQ 480p30 Surround",
  ];
  const versioned = await current.run(versionArgs);
  expect(versioned.exitCode).toBe(0);
  const second = (versioned.result as { profile: { id: string } }).profile;
  expect((await current.run(versionArgs)).result).toEqual(versioned.result);
  const oldPreview = (await current.run([
    "preview-encoding-profile-state", "--id", first.id, "--active", "true",
  ])).result as { revision: string };
  const preview = (await current.run([
    "preview-encoding-profile-state", "--id", second.id, "--active", "true",
  ])).result as { revision: string; replacesActiveVersion: boolean };
  expect(preview.replacesActiveVersion).toBe(true);
  const activateArgs = [
    "activate-encoding-profile", "--key", "00000000-0000-4000-8000-000000000203",
    "--id", second.id, "--revision", preview.revision, "--acknowledge",
  ];
  expect((await current.run(activateArgs.slice(0, -1))).result).toMatchObject({
    error: { code: "INVALID_ENCODING_PROFILE" },
  });
  const activated = await current.run(activateArgs);
  expect(activated.exitCode).toBe(0);
  expect((await current.run([
    "activate-encoding-profile", "--key", "00000000-0000-4000-8000-000000000204",
    "--id", first.id, "--revision", oldPreview.revision, "--acknowledge",
  ])).result).toMatchObject({ error: { code: "STALE_PROFILE_PREVIEW" } });
  const activeList = (await current.run(["list-encoding-profiles"])).result as {
    profiles: Array<{ id: string; isActive: boolean; settings: { preset: string } }>;
  };
  expect(activeList.profiles).toEqual([
    expect.objectContaining({ id: first.id, isActive: false, settings: { preset: "Fast 480p30", container: "mkv" } }),
    expect.objectContaining({ id: second.id, isActive: true, settings: { preset: "HQ 480p30 Surround", container: "mkv" } }),
  ]);
  const deactivatePreview = (await current.run([
    "preview-encoding-profile-state", "--id", second.id, "--active", "false",
  ])).result as { revision: string };
  expect((await current.run([
    "deactivate-encoding-profile", "--key", "00000000-0000-4000-8000-000000000205",
    "--id", second.id, "--revision", deactivatePreview.revision, "--acknowledge",
  ])).exitCode).toBe(0);
  expect((await current.run(activateArgs)).result).toEqual(activated.result);
  expect((await current.run(["list-encoding-profiles"])).result).toMatchObject({
    profiles: [
      expect.objectContaining({ id: first.id, isActive: false }),
      expect.objectContaining({ id: second.id, isActive: false }),
    ],
  });
  const history = current.openAccess();
  expect(history.encodeJobs.list().find((job) => job.id === historicalJobId)?.encodingProfileId)
    .toBe(first.id);
  expect(history.encodingProfiles.list({ mediaDomain: "dvd_video" })[0]?.settings)
    .toEqual({ preset: "Fast 480p30", container: "mkv" });
  history.close();
});

it("validates Encoding Profile inputs before mutation and keeps media domains separate", async () => {
  const current = fixture();
  const key = "00000000-0000-4000-8000-000000000206";
  expect((await current.run([
    "create-encoding-profile", "--key", key,
    "--profile-key", "synthetic", "--display-name", "Synthetic",
    "--preset", "Unsupported preset",
  ])).result).toMatchObject({ error: { code: "INVALID_ENCODING_PROFILE" } });
  const access = current.openAccess();
  const audio = access.encodingProfiles.create({
    key: "synthetic-audio", displayName: "Synthetic audio", mediaDomain: "audio",
    settings: { codec: "flac" },
  });
  access.close();
  expect((await current.run([
    "version-encoding-profile", "--key", key,
    "--source-profile-id", audio.id, "--preset", "Fast 480p30",
  ])).result).toMatchObject({ error: { code: "ENCODING_PROFILE_REJECTED" } });
  expect((await current.run(["list-encoding-profiles"])).result).toEqual({ schemaVersion: 1, profiles: [] });
});

it("serializes concurrent same-key Encoding Profile creation across CLI processes", async () => {
  const current = fixture();
  const entry = fileURLToPath(new URL("../dist/entry.js", import.meta.url));
  const environment = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    RIP_DVD_DATABASE_PATH: current.databasePath,
    RIP_DVD_MEDIA_LIBRARY_PATH: current.mediaLibraryPath,
    RIP_DVD_ORIGINALS_LIBRARY_PATH: current.originalsLibraryPath,
  };
  const invoke = () => new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [entry,
      "create-encoding-profile", "--key", "synthetic-concurrent-profile-key-001",
      "--profile-key", "concurrent-synthetic", "--display-name", "Concurrent synthetic",
      "--preset", "Fast 480p30",
    ], { env: environment });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("close", (status) => resolve({ status, stdout }));
  });
  const [first, second] = await Promise.all([invoke(), invoke()]);
  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
  expect((await current.run(["list-encoding-profiles"])).result).toMatchObject({
    profiles: [expect.objectContaining({ key: "concurrent-synthetic" })],
  });
});
