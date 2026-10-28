import { createLegacySidecarDataAccess } from "@rip-dvd/data-access/legacy-sidecars";
import { DatabaseSync } from "node:sqlite";
import { createApplicationOperations } from "@rip-dvd/application";
import { seedEncodeClaim, withdrawClaimAcceptance, injectClaimRecoveryState } from "./encode-claim.test-support.js";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claimNextEncodeJob, type EncodingReadiness } from "@rip-dvd/application";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { assessmentMappings, seedEncodingReadiness } from "./encoding-readiness.test-support.js";
import { openEncodeSourceTestAccess } from "./encode-source-decision.test-support.js";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("commits immutable concrete source evidence with the winning claim and exposes it through public inspection", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  const access = openEncodeSourceTestAccess(fixture);
  try {
    access.catalog.completeCatalogReview(seeded.archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
    const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
    const readiness = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
    const job = access.encodeJobs.enqueue({ discSelectionId: seeded.selection.id, encodingProfileId: seeded.profile.id,
      outputPath: join(fixture.mediaLibraryPath, "synthetic-claim.mkv"), expectedSourceDecision: readiness.selections[0]!.expectedSourceDecision });
    expect(access.encodeJobs.claimNext("unprepared-worker")).toBeNull();
    expect(access.encodeJobs.listSourceClaimCandidates({ limit: 1, offset: 0 }).map(({ id }) => id)).toEqual([job.id]);
    expect(access.encodeJobs.listSourceClaimCandidates({ limit: 1, offset: 1 })).toEqual([]);
    const claim = await claimNextEncodeJob(access, "synthetic-worker", fixture.originalsLibraryPath, ownership);
    expect(claim?.id).toBe(job.id);
    const snapshot = access.encodeJobs.findClaimSnapshot(claim!.claimToken)!;
    expect(snapshot).toMatchObject({ id: claim!.claimToken, encodeJobId: job.id,
      source: { checkpoint: { revision: 1 }, resolvedSource: { displayTitleNumber: 1, angleNumber: 1 },
        assessment: { id: seeded.assessment!.id }, acceptance: null,
        profile: { id: seeded.profile.id, version: seeded.profile.version },
        output: { preset: seeded.profile.settings.preset, format: "av_mkv" } } });
    const inspected = await fixture.run(["inspect", "encode-jobs", job.id]);
    expect(inspected).toMatchObject({ exitCode: 0, result: { item: { claimSnapshots: [JSON.parse(JSON.stringify(snapshot))] } } });
  } finally { access.close(); }
});

it.each(["checkpoint", "selectionIdentity", "titleIdentityId", "titleIdentityObservationId", "reviewSetIdentity",
  "catalogMappingProjectionId", "assessmentIdentity", "acceptanceIdentity", "reviewedContentIdentity", "missing"])(
  "does not claim queued work with stale %s evidence", async (field) => {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const seeded = await seedEncodeClaim(fixture);
    try {
      const decision = { ...seeded.expectedSourceDecision, [field]: field === "checkpoint"
        ? { ...seeded.expectedSourceDecision.checkpoint, revision: 2 } : "synthetic-stale-identity" };
      const db = new DatabaseSync(fixture.databasePath);
      db.prepare("UPDATE encode_jobs SET expected_source_decision = ? WHERE id = ?")
        .run(field === "missing" ? null : JSON.stringify(decision), seeded.job.id);
      db.close();
      expect(await claimNextEncodeJob(seeded.access, "synthetic-stale-worker", fixture.originalsLibraryPath)).toBeNull();
      expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("queued");
      expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toEqual([]);
    } finally { seeded.access.close(); }
  },
);

it.each(["eligible", "waiting_for_disc", "running", "paused", "stopping", "faulted"])(
  "leaves queued work unclaimed while Recovery is %s", async (state) => {
    const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
    const seeded = await seedEncodeClaim(fixture);
    try {
      injectClaimRecoveryState(fixture, seeded.archive.id, state);
      expect(await claimNextEncodeJob(seeded.access, "synthetic-recovery-worker", fixture.originalsLibraryPath)).toBeNull();
      expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("queued");
      expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toEqual([]);
    } finally { seeded.access.close(); }
  },
);

it("retains earlier immutable claims through retry, profile versions and acceptance withdrawal", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { continuityRisk: true });
  try {
    const first = (await claimNextEncodeJob(seeded.access, "synthetic-first-worker", fixture.originalsLibraryPath))!;
    const evidence = seeded.access.encodeJobs.findClaimSnapshot(first.claimToken)!;
    expect(evidence.source).toMatchObject({ sourceContinuityRisk: true,
      output: { audioStreams: [{ id: 128, format: "ac3" }], subtitleStreams: [], expectedDurationSeconds: 500 },
      acceptance: { decision: "accepted" }, assessment: { sourceContinuity: { sourceContinuityRiskSectorCount: 1 } } });
    const db = new DatabaseSync(fixture.databasePath);
    expect(() => db.prepare("UPDATE encode_claim_snapshots SET source = '{}' WHERE id = ?").run(first.claimToken)).toThrow("immutable");
    expect(() => db.prepare("DELETE FROM encode_claim_snapshots WHERE id = ?").run(first.claimToken)).toThrow("immutable");
    db.close();
    seeded.access.encodeJobs.fail(first, "Synthetic retry");
    await createApplicationOperations(seeded.access).requeueEncodeJob({ encodeJobId: first.id, mutationKey: "synthetic-claim-retry",
      expectedSourceDecision: seeded.expectedSourceDecision, originalsLibraryPath: fixture.originalsLibraryPath, mediaLibraryPath: fixture.mediaLibraryPath });
    const second = (await claimNextEncodeJob(seeded.access, "synthetic-second-worker", fixture.originalsLibraryPath))!;
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(seeded.access.encodeJobs.listClaimSnapshots(first.id)).toHaveLength(2);
    seeded.access.encodingProfiles.createVersion({ sourceProfileId: seeded.profile.id, mediaDomain: "dvd_video", settings: { preset: "Fast 720p30" } });
    await withdrawClaimAcceptance(fixture, seeded.archive.id, seeded.expectedSourceDecision.acceptanceIdentity!);
    expect(seeded.access.encodeJobs.find(second.id)?.status).toBe("running");
    expect(seeded.access.encodeJobs.findClaimSnapshot(first.claimToken)).toEqual(evidence);
    expect(seeded.access.encodeJobs.findClaimSnapshot(second.claimToken)?.source).toEqual(evidence.source);
    const inspected = await fixture.run(["inspect", "encode-jobs", first.id, "--limit", "1"]);
    expect(inspected).toMatchObject({ exitCode: 0, result: { item: { claimSnapshots: [expect.any(Object)], claimSnapshotPage: { nextOffset: 1 } } } });
  } finally { seeded.access.close(); }
});

it("blocks a superseded queued selection and snapshots exact chapter bounds without a full-title duration target", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture);
  try {
    const archive = seeded.access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!;
    seeded.access.catalog.correctDiscSelection(seeded.selection.id, {
      originalDiscArchiveId: archive.id, catalogRevision: archive.updatedAt, mediaItemId: seeded.selection.mediaItemId,
      sourceIdentity: { kind: "dvd_chapters", titleNumber: 1, chapterStart: 2, chapterEnd: 3 },
      reason: "Synthetic bounded chapter selection.",
    });
    expect(await claimNextEncodeJob(seeded.access, "synthetic-old-selection-worker", fixture.originalsLibraryPath)).toBeNull();
    expect(seeded.access.encodeJobs.listClaimSnapshots(seeded.job.id)).toEqual([]);
    await seeded.access.assessDvdTitleDamage(archive.id, createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }),
      async () => assessmentMappings(seeded.assessment!.items));
    seeded.access.catalog.completeCatalogReview(archive.id,
      seeded.access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt, "reviewed_with_selections");
    const active = seeded.access.catalog.listDiscSelections({ originalDiscArchiveId: archive.id })[0]!;
    const readiness = (await fixture.run(["encode-readiness", archive.id])).result as EncodingReadiness;
    expect(readiness.blockingReasons).toEqual([]);
    const job = await createApplicationOperations(seeded.access).enqueueEncodeJob({
      discSelectionId: active.id, encodingProfileId: seeded.profile.id,
      outputPath: join(fixture.mediaLibraryPath, "synthetic-chapters.mkv"), mutationKey: "synthetic-chapter-claim",
      expectedSourceDecision: readiness.selections[0]!.expectedSourceDecision,
      originalsLibraryPath: fixture.originalsLibraryPath, mediaLibraryPath: fixture.mediaLibraryPath,
    });
    const claim = (await claimNextEncodeJob(seeded.access, "synthetic-chapter-worker", fixture.originalsLibraryPath))!;
    expect(claim.id).toBe(job.id);
    expect(seeded.access.encodeJobs.findClaimSnapshot(claim.claimToken)?.source).toMatchObject({
      resolvedSource: { chapterStart: 2, chapterEnd: 3 }, output: { expectedDurationSeconds: null,
        selectionArguments: ["--title", "1", "--angle", "1", "--chapters", "2-3", "--all-audio"] },
    });
  } finally { seeded.access.close(); }
});

it("does no source-candidate scan or historical backlog materialization while admission is closed", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  seedCatalogReviewForReadFixture(fixture);
  const access = fixture.openAccess();
  const db = new DatabaseSync(fixture.databasePath);
  db.prepare("UPDATE encode_jobs SET status = 'queued', claim_token = NULL").run();
  db.prepare("UPDATE original_disc_archives SET catalog_review_outcome = 'needs_review', catalog_reviewed_at = NULL").run();
  db.close();
  try {
    const list = vi.spyOn(access.encodeJobs, "list").mockImplementation(() => { throw new Error("Historical backlog must not be materialized"); });
    const sourceReads = vi.spyOn(access.catalog, "listDiscSelections");
    expect(await claimNextEncodeJob(access, "synthetic-idle-worker", fixture.originalsLibraryPath)).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(sourceReads).not.toHaveBeenCalled();
    expect(access.encodeJobs.listSourceClaimCandidates({ limit: 1, offset: 0 })).toEqual([]);
  } finally { vi.restoreAllMocks(); access.close(); }
});

it("claims eligible historical work ahead of a stale new-format queue entry when the source gate is enabled", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture);
  try {
    const historical = createLegacySidecarDataAccess({ databasePath: fixture.databasePath });
    const drive = historical.catalog.upsertOpticalDrive({ devicePath: "/dev/synthetic-mixed-drive", isPresent: true });
    const disc = historical.catalog.registerDetectedDisc({ opticalDriveId: drive.id, discKind: "dvd", fingerprint: `sha256:${"d".repeat(64)}` });
    historical.catalog.updateDetectedDiscStatus(disc.id, "scanned");
    historical.catalog.updateDetectedDiscStatus(disc.id, "approved");
    const archive = historical.catalog.createOriginalDiscArchive({ detectedDiscId: disc.id, discKind: "dvd", archiveFormat: "iso",
      archivePath: join(fixture.originalsLibraryPath, "synthetic-historical.iso"), fingerprint: disc.fingerprint });
    const movie = historical.catalog.createMediaItem({ kind: "movie", title: "Synthetic historical film" });
    const selection = historical.catalog.createDiscSelection({ originalDiscArchiveId: archive.id, mediaItemId: movie.id,
      sourceIdentity: { kind: "main_feature" } });
    historical.catalog.completeCatalogReview(archive.id, historical.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
      "reviewed_with_selections");
    const legacy = historical.encodeJobs.enqueue({ discSelectionId: selection.id, encodingProfileId: seeded.profile.id,
      outputPath: join(fixture.mediaLibraryPath, "synthetic-historical-ready.mkv") });
    historical.close();
    const db = new DatabaseSync(fixture.databasePath);
    db.prepare("UPDATE encode_jobs SET priority = 100, expected_source_decision = ? WHERE id = ?")
      .run(JSON.stringify({ ...seeded.expectedSourceDecision, assessmentIdentity: "synthetic-stale-assessment" }), seeded.job.id);
    db.close();
    expect((await claimNextEncodeJob(seeded.access, "synthetic-mixed-worker", fixture.originalsLibraryPath))?.id).toBe(legacy.id);
    expect(seeded.access.encodeJobs.listClaimSnapshots(legacy.id)).toEqual([]);
    expect(seeded.access.encodeJobs.find(seeded.job.id)?.status).toBe("queued");
  } finally { seeded.access.close(); }
});
