import { join } from "node:path";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { advanceCommittedArchiveEvidence, withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import { assessmentMappings } from "./encoding-readiness.test-support.js";
import { afterEach, expect, it } from "vitest";
import { createApplicationOperations, type EncodingReadiness } from "@rip-dvd/application";
import type { EncodeJobId } from "@rip-dvd/data-access";
import { openEncodeSourceTestAccess } from "./encode-source-decision.test-support.js";
import { acceptReadinessContent, seedEncodingReadiness } from "./encoding-readiness.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("rejects stale enqueue evidence with all current identities and leaves the admission gate closed", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  const readiness = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  const decision = readiness.selections[0]!.expectedSourceDecision;
  expect(decision).toMatchObject({ checkpoint: { revision: 1 }, assessmentIdentity: expect.any(String), selectionIdentity: expect.any(String), acceptanceIdentity: null });
  const enqueue = (expected: unknown, key: string) => fixture.run(["encode-enqueue", "--key", key,
    "--disc-selection-id", seeded.selection.id, "--encoding-profile-id", seeded.profile.id,
    "--output-path", join(fixture.mediaLibraryPath, "synthetic-source.mkv"),
    "--source-decision", JSON.stringify(expected)]);
  const stale = await enqueue({ ...decision, assessmentIdentity: "synthetic-old-assessment" }, "synthetic-stale");
  expect(stale).toMatchObject({ exitCode: 2, result: { error: { code: "STALE_ENCODE_SOURCE_DECISION", current: { expectedSourceDecision: decision }, blockingReasons: [{ code: "SOURCE_DECISION_STALE" }, { code: "DVD_RECOVERY_EVIDENCE_ENCODING_UNAVAILABLE" }] } } });
  expect(await enqueue(decision, "synthetic-current")).toMatchObject({ exitCode: 2, result: { error: { code: "DVD_RECOVERY_EVIDENCE_ENCODING_UNAVAILABLE", current: { expectedSourceDecision: decision } } } });
  const access = fixture.openAccess();
  expect(access.encodeJobs.listForDiscSelection(seeded.selection.id)).toEqual([]);
  access.close();
});

it("reuses matching damage acceptance for retry and compression changes, and canonically replays before later withdrawal", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture);
  const review = fixture.openAccess();
  review.catalog.completeCatalogReview(seeded.archive.id,
    review.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  review.close();
  await acceptReadinessContent(fixture, seeded.archive.id);
  const decision = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
  const openAccess = () => openEncodeSourceTestAccess(fixture);
  const command = (expected: unknown, key = "synthetic-accepted-enqueue") => fixture.run(["encode-enqueue", "--key", key,
    "--disc-selection-id", seeded.selection.id, "--encoding-profile-id", seeded.profile.id,
    "--output-path", join(fixture.mediaLibraryPath, "synthetic-accepted.mkv"), "--source-decision", JSON.stringify(expected)],
    undefined, undefined, { openAccess });
  const first = await command(decision);
  expect(first).toMatchObject({ exitCode: 0, result: { job: { status: "queued" } } });
  const job = (first.result as { job: { id: string } }).job;
  const db = openAccess();
  // Worker claim enforcement is a later slice. Terminate this synthetic attempt
  // without enabling a worker to read a new-format image.
  db.encodeJobs.requestCancellation(job.id as EncodeJobId);
  db.close();
  const preview = await fixture.run(["encode-requeue-preview", "--encode-job-id", job.id]);
  expect(preview.result).toMatchObject({ expectedSourceDecision: decision, available: false });
  const requeue = await fixture.run(["encode-requeue", "--key", "synthetic-retry", "--encode-job-id", job.id,
    "--source-decision", JSON.stringify(decision)], undefined, undefined, { openAccess });
  expect(requeue).toMatchObject({ exitCode: 0, result: { job: { status: "queued" } } });
  const access = openAccess();
  const compression = access.encodingProfiles.createVersion({ sourceProfileId: seeded.profile.id,
    mediaDomain: "dvd_video", settings: { ...seeded.profile.settings, quality: 20 } });
  access.encodingProfiles.setActive({ id: compression.id, mediaDomain: "dvd_video", isActive: true });
  access.close();
  expect(((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision).toEqual(decision);
  expect((await fixture.run(["encode-enqueue", "--key", "synthetic-compression", "--disc-selection-id", seeded.selection.id,
    "--encoding-profile-id", compression.id, "--output-path", join(fixture.mediaLibraryPath, "synthetic-compression.mkv"),
    "--source-decision", JSON.stringify(decision)], undefined, undefined, { openAccess })).exitCode).toBe(0);
  const withdrawal = (await fixture.run(["catalog-review", "preview-withdrawal", seeded.archive.id,
    "--accepted-decision-id", decision.acceptanceIdentity!])).result as { previewToken: string };
  expect((await fixture.run(["catalog-review", "withdraw-damage", seeded.archive.id, "--key", "synthetic-withdrawal",
    "--json", JSON.stringify({ operator: "Synthetic operator", acceptedDecisionId: decision.acceptanceIdentity,
      previewToken: withdrawal.previewToken })])).exitCode).toBe(0);
  const reversed = Object.fromEntries(Object.entries(decision).reverse());
  expect(await command(reversed)).toEqual(first);
  expect(await fixture.run(["encode-requeue", "--key", "synthetic-retry", "--encode-job-id", job.id,
    "--source-decision", JSON.stringify(reversed)], undefined, undefined, { openAccess })).toEqual(requeue);
  expect(await fixture.run(["encode-requeue", "--key", "synthetic-retry", "--encode-job-id", job.id,
    "--source-decision", JSON.stringify({ ...decision, acceptanceIdentity: null })], undefined, undefined, { openAccess }))
    .toMatchObject({ exitCode: 2, result: { error: { code: "MUTATION_KEY_CONFLICT" } } });
  expect(await fixture.run(["encode-requeue", "--key", "synthetic-fresh-stale-retry", "--encode-job-id", job.id,
    "--source-decision", JSON.stringify(decision)], undefined, undefined, { openAccess }))
    .toMatchObject({ exitCode: 2, result: { error: { code: "STALE_ENCODE_SOURCE_DECISION", current: { expectedSourceDecision: expect.objectContaining({ acceptanceIdentity: null }) } } } });
  expect(await command({ ...decision, acceptanceIdentity: null })).toMatchObject({ exitCode: 2,
    result: { error: { code: "MUTATION_KEY_CONFLICT" } } });
  expect(await command(decision, "synthetic-fresh-stale")).toMatchObject({ exitCode: 2,
    result: { error: { code: "STALE_ENCODE_SOURCE_DECISION", blockingReasons: expect.arrayContaining([{ code: "ACCEPTANCE_WITHDRAWN", message: expect.any(String), details: expect.any(Object) }]) } } });
});

it.each(["checkpoint", "selection", "assessment", "continuity"])("expires enqueue evidence after a substantive %s change", async (change) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture);
  await acceptReadinessContent(fixture, seeded.archive.id);
  const prior = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
  const access = fixture.openAccess();
  const checkpoint = change === "checkpoint" || change === "continuity"
    ? advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true }) : seeded.manifest;
  if (change === "continuity") access.catalog.recordDvdTitleIdentityObservations({
    originalDiscArchiveId: seeded.archive.id,
    checkpoint: { manifestId: checkpoint.id, manifestRevision: checkpoint.revision, manifestDigest: checkpoint.manifestDigest },
    observations: [{ ...seeded.observation, navigation: { ...seeded.observation.navigation, programChainNumber: 2 } }],
  });
  if (change === "selection") access.catalog.correctDiscSelection(seeded.selection.id, {
    originalDiscArchiveId: seeded.archive.id, catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt,
    mediaItemId: seeded.selection.mediaItemId, sourceIdentity: { kind: "dvd_chapters", titleNumber: 1, chapterStart: 2, chapterEnd: 3 }, reason: "Synthetic chapter change.",
  });
  if (change === "assessment") await access.assessDvdTitleDamage(seeded.archive.id,
    createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }), async () => assessmentMappings(seeded.assessment!.items).map((item) => ({ ...item,
      mappingCoverage: { state: "partial", policyVersion: "synthetic-substantive-map-v2", unknownReasons: [{ code: "SYNTHETIC_UNKNOWN", message: "Synthetic incomplete mapping." }] },
    })));
  access.close();
  const current = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  expect(current.current).toMatchObject({ acceptanceIdentity: null });
  // The original selection remains addressable after correction, so stale
  // requests can report its replacement and the current archive evidence.
  const selectionId = seeded.selection.id;
  const rejected = await fixture.run(["encode-enqueue", "--key", `synthetic-expired-${change}`, "--disc-selection-id", selectionId,
    "--encoding-profile-id", seeded.profile.id, "--output-path", join(fixture.mediaLibraryPath, "synthetic-expired.mkv"), "--source-decision", JSON.stringify(prior)]);
  expect(rejected).toMatchObject({ exitCode: 2, result: { error: { code: "STALE_ENCODE_SOURCE_DECISION", current: { expectedSourceDecision: change === "selection" ? null : current.selections[0]!.expectedSourceDecision } } } });
  const observer = fixture.openAccess(); expect(observer.encodeJobs.list(["queued", "running"])).toEqual([]); observer.close();
});

it("retains acceptance and the decision identity after an identical assessment rerun", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture);
  await acceptReadinessContent(fixture, seeded.archive.id);
  const before = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  const access = fixture.openAccess();
  await access.assessDvdTitleDamage(seeded.archive.id, createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }), async () => assessmentMappings(seeded.assessment!.items));
  access.close();
  expect(((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision).toEqual(before.selections[0]!.expectedSourceDecision);
});

it.each([["running", "RECOVERY_ACTIVE"], ["waiting_for_disc", "RECOVERY_WAITING"], ["paused", "RECOVERY_PAUSED"], ["stopping", "RECOVERY_STOPPING"], ["faulted", "CONSISTENCY_FAULT"]] as const)("returns all blockers without queueing against %s Recovery", async (state, code) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture);
  const decision = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => db.prepare(`UPDATE archive_recoveries SET status = ?, stop_operation_id = ?, stop_requested_at = ?, stopped_at = NULL,
    pause_reason = ?, fault_code = ? WHERE original_disc_archive_id = ?`).run(state,
    state === "stopping" ? "synthetic-stop" : null, state === "stopping" ? 1 : null,
    state === "paused" ? "no_progress" : null, state === "faulted" ? "CONSISTENCY_FAULT" : null, seeded.archive.id));
  const result = await fixture.run(["encode-enqueue", "--key", `synthetic-blocked-${state}`, "--disc-selection-id", seeded.selection.id,
    "--encoding-profile-id", seeded.profile.id, "--output-path", join(fixture.mediaLibraryPath, "synthetic-blocked.mkv"), "--source-decision", JSON.stringify(decision)]);
  expect(result).toMatchObject({ exitCode: 2, result: { error: { code: "ENCODE_SOURCE_UNAVAILABLE", blockingReasons: expect.arrayContaining([
    expect.objectContaining({ code }), expect.objectContaining({ code: "ACCEPTANCE_REQUIRED" }),
  ]) } } });
});

it("rejects enqueue against a live old writer despite lease expiry", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  const decision = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath, claimLeaseDurationMs: 1, ownershipCheckIntervalMs: 60_000 });
  await ownership.withWriter({ archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath,
    originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, async task() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await fixture.run(["encode-enqueue", "--key", "synthetic-live-writer", "--disc-selection-id", seeded.selection.id,
        "--encoding-profile-id", seeded.profile.id, "--output-path", join(fixture.mediaLibraryPath, "synthetic-live-writer.mkv"), "--source-decision", JSON.stringify(decision)]))
        .toMatchObject({ exitCode: 2, result: { error: { blockingReasons: [expect.objectContaining({ code: "WRITER_NOT_QUIESCENT" }), expect.anything()] } } });
    } });
  const access = fixture.openAccess(); expect(access.encodeJobs.list(["queued", "running"])).toEqual([]); access.close();
});

it.each(["enqueue", "requeue"] as const)("requires owned checkpoint preparation when an initial writer blocker clears before %s", async (operation) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  const access = openEncodeSourceTestAccess(fixture);
  access.catalog.completeCatalogReview(seeded.archive.id, access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections");
  const decision = ((await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness).selections[0]!.expectedSourceDecision;
  const input = { mutationKey: "synthetic-settled-writer", discSelectionId: seeded.selection.id,
    encodingProfileId: seeded.profile.id, outputPath: join(fixture.mediaLibraryPath, "synthetic-settled-writer.mkv"),
    expectedSourceDecision: decision, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath };
  const job = operation === "requeue" ? access.encodeJobs.enqueue({ ...input, mutationKey: undefined }) : null;
  if (job) access.encodeJobs.requestCancellation(job.id);
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
  let inspections = 0;
  const operations = createApplicationOperations(access, { archiveImageOwnership: {
    ...ownership,
    inspect(value) {
      const current = ownership.inspect(value);
      return inspections++ === 0 ? { ...current, stableRead: { available: false,
        blockingReasons: [{ code: "WRITER_NOT_QUIESCENT", message: "Synthetic prior writer is finishing." }] } } : current;
    },
  } });
  try {
    await expect(operation === "enqueue" ? operations.enqueueEncodeJob(input)
      : operations.requeueEncodeJob({ ...input, encodeJobId: job!.id })).rejects.toMatchObject({
        code: "ENCODE_SOURCE_UNAVAILABLE", blockingReasons: expect.arrayContaining([
          expect.objectContaining({ code: "CONSISTENCY_FAULT", details: expect.objectContaining({ checkpointFailure: "DVD_EVIDENCE_CHECKPOINT_UNVERIFIED" }) }),
        ]),
      });
    expect(access.encodeJobs.list(["queued", "running"])).toEqual([]);
  } finally { access.close(); }
});
