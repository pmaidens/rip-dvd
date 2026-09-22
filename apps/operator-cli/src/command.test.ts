import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";
import type { CatalogMetadataLookup } from "@rip-dvd/application";
import { createCleanReadArchiveIntegrityEvidence } from "@rip-dvd/data-access";
import {
  beginSettledDiscInspectionForTest,
  createNormalDvdArchiveBoundaryEvidenceForTest,
} from "@rip-dvd/data-access/test-support";

import { createApplicationOperations } from "@rip-dvd/application";

import { runCommand } from "./command.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

function fixture() {
  const created = createOperatorWorkflowFixture();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const current of fixtures.splice(0)) {
    current.dispose();
  }
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
      "catalog-review",
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

  const inspection = current.run(["inspect", "disc-inspections", started.inspection.id]);
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

  const requestDetail = current.run(["inspect", "archive-requests", request.id]);
  expect(requestDetail.result).toMatchObject({
    item: { id: request.id, status: "pending", archiveJobs: [] },
  });
  expect(current.run(["inspect", "detected-discs", disc.id]).result).toMatchObject({
    item: {
      id: disc.id,
      archiveRequests: [expect.objectContaining({ id: request.id })],
      availableActions: [{ name: "request-archive", eligible: false }],
    },
  });
  const timedOut = await current.runAsync([
    "wait", "archive-requests", request.id, "--timeout-ms", "0",
  ]);
  expect(timedOut.exitCode).toBe(3);
  expect(timedOut.stderr).toBe("");
  expect(timedOut.result).toMatchObject({
    outcome: "timeout", current: { id: request.id, status: "pending", archiveJobs: [] },
  });
  expect(current.run(["inspect", "archive-requests", request.id]).result)
    .toMatchObject({ item: { status: "pending" } });

  const settled = await current.runAsync([
    "wait", "disc-inspections", started.inspection.id, "--timeout-ms", "0",
  ]);
  expect(settled.exitCode).toBe(0);
  expect(settled.result).toMatchObject({ outcome: "settled", current: { status: "failed" } });

  const retryAccess = current.openAccess();
  retryAccess.discInspections.requestRetry(started.inspection.id);
  retryAccess.close();
  const retryPending = await current.runAsync([
    "wait", "disc-inspections", started.inspection.id, "--timeout-ms", "0",
  ]);
  expect(retryPending.exitCode).toBe(3);
  expect(retryPending.result).toMatchObject({ outcome: "timeout", current: {
    status: "failed", manualRetryRequestedAt: expect.any(String),
  } });
});

it("reports encode action eligibility and correction evidence through the public command", () => {
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

  const result = current.run(["inspect", "encode-jobs", job.id]);
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
  expect(current.run(["inspect", "encode-jobs", job.id]).result).toMatchObject({ item: {
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
  expect(current.run(["inspect", "encode-jobs", job.id]).result).toMatchObject({ item: {
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
    const result = await current.runAsync([
      "wait", "archive-requests", request.id,
      "--timeout-ms", "500", "--poll-ms", "100",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      outcome: "settled", current: { status: "cancelled" },
    });
  } finally {
    clearTimeout(transition);
  }
});

it("validates inspection and wait arguments before opening the database", async () => {
  const current = fixture();
  expect(current.run(["inspect", "disc-inspections", "--limit", "101"]).result)
    .toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  expect(current.run(["inspect", "disc-inspections", "missing-id"]).result)
    .toMatchObject({ error: { code: "NOT_FOUND" } });
  expect((await current.runAsync([
    "wait", "archive-jobs", "missing-id", "--timeout-ms", "0",
  ])).result).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect((await current.runAsync([
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
