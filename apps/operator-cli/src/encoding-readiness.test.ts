import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import type { EncodingReadiness } from "@rip-dvd/application";
import { seedEncodingReadiness, acceptReadinessContent, assessmentMappings } from "./encoding-readiness.test-support.js";
import { advanceCommittedArchiveEvidence, withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";
import { seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";
import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedDamagePreview } from "./damage-preview.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("reports current damage and concrete content without authorizing an Encode Job", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive } = await seedDamagePreview(fixture);
  const result = await fixture.run(["encode-readiness", archive.id]);
  expect(result.exitCode).toBe(0);
  expect(result.result).toMatchObject({
    schemaVersion: 1, evidenceFormat: "dvd-recovery-evidence-v1",
    sourceReady: false, admissionAvailable: false,
    assessment: { state: "current" },
    current: { originalDiscArchiveId: archive.id, checkpoint: { revision: 1 } },
    selections: [{ resolvedSource: null, blockingReasons: [{ code: "SELECTION_UNIDENTIFIED" }, { code: "ASSESSMENT_PENDING" }] }],
  });
});

it("shows clean fully mapped content as source ready while admission stays closed", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  const before = await fixture.run(["encode-readiness", seeded.archive.id]);
  expect(before).toMatchObject({ exitCode: 0, result: {
    sourceReady: true, admissionAvailable: false, blockingReasons: [],
    current: { checkpoint: { verified: true } },
    selections: [{ titleIdentityId: seeded.observation.titleIdentityId,
      resolvedSource: { angleNumber: 1, chapterStart: 1, chapterEnd: 4 },
      assessment: { impact: "clean" }, acceptanceRequired: false, acceptanceSatisfied: true }],
  } });
  expect((await fixture.run(["encode-enqueue", "--key", "synthetic-readiness-admission",
    "--disc-selection-id", seeded.selection.id, "--encoding-profile-id", seeded.profile.id,
    "--output-path", join(fixture.mediaLibraryPath, "synthetic-readiness.mkv"),
    "--source-decision", JSON.stringify((before.result as EncodingReadiness).selections[0]!.expectedSourceDecision)])).result)
    .toMatchObject({ error: { code: "DVD_RECOVERY_EVIDENCE_ENCODING_UNAVAILABLE" } });
  const reopened = await fixture.run(["encode-readiness", seeded.archive.id]);
  expect(reopened.result).toEqual(before.result);
});

it.each([
  ["running", "RECOVERY_ACTIVE"], ["waiting_for_disc", "RECOVERY_WAITING"],
  ["paused", "RECOVERY_PAUSED"], ["stopping", "RECOVERY_STOPPING"],
  ["eligible", "RECOVERY_ELIGIBLE"], ["faulted", "CONSISTENCY_FAULT"],
] as const)("distinguishes %s Recovery and reports every blocker in priority order", async (state, code) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive } = await seedEncodingReadiness(fixture);
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => {
    db.prepare(`UPDATE archive_recoveries SET status = ?, stop_operation_id = ?, stop_requested_at = ?, stopped_at = NULL,
      pause_reason = ?, fault_code = ? WHERE original_disc_archive_id = ?`).run(state,
      state === "stopping" ? "synthetic-stop" : null, state === "stopping" ? 1 : null,
      state === "paused" ? "no_progress" : null, state === "faulted" ? "CONSISTENCY_FAULT" : null, archive.id);
  });
  const result = await fixture.run(["encode-readiness", archive.id]);
  expect(result.exitCode).toBe(0);
  const readiness = result.result as EncodingReadiness;
  expect(readiness).toMatchObject({ sourceReady: false, current: { recovery: { state } } });
  expect(readiness.blockingReasons.map((reason) => reason.code)).toEqual(
    state === "faulted" ? ["CONSISTENCY_FAULT", "ACCEPTANCE_REQUIRED"] : ["ACCEPTANCE_REQUIRED", code]);
});

it.each([false, true])("requires and observes current acceptance for unknown impact=%s", async (partial) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { partial });
  const first = await fixture.run(["encode-readiness", seeded.archive.id]);
  expect(first.result).toMatchObject({ sourceReady: false,
    selections: [{ assessment: { impact: partial ? "unknown" : "known_damage" }, acceptanceRequired: true }] });
  const accepted = await acceptReadinessContent(fixture, seeded.archive.id);
  expect(accepted.exitCode).toBe(0);
  const ready = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  expect(ready).toMatchObject({ sourceReady: true, admissionAvailable: false,
    current: { acceptanceState: "accepted" }, selections: [{ acceptanceSatisfied: true }] });
  if (!ready.applicable) throw new Error("Expected evidence readiness");
  const withdrawal = (await fixture.run(["catalog-review", "preview-withdrawal", seeded.archive.id,
    "--accepted-decision-id", ready.current.acceptanceIdentity!])).result as { previewToken: string };
  expect((await fixture.run(["catalog-review", "withdraw-damage", seeded.archive.id, "--key", "synthetic-readiness-withdrawal", "--json", JSON.stringify({
    operator: "Synthetic readiness operator", acceptedDecisionId: ready.current.acceptanceIdentity,
    previewToken: withdrawal.previewToken,
  })])).exitCode).toBe(0);
  expect((await fixture.run(["encode-readiness", seeded.archive.id])).result).toMatchObject({
    sourceReady: false, blockingReasons: [{ code: "ACCEPTANCE_WITHDRAWN" }],
  });
});

it("distinguishes pending and outdated assessments and returns current identities", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive, manifest } = await seedEncodingReadiness(fixture);
  advanceCommittedArchiveEvidence(fixture, manifest, { publishFilesystemCheckpoint: true });
  const stale = (await fixture.run(["encode-readiness", archive.id])).result as EncodingReadiness;
  expect(stale).toMatchObject({ sourceReady: false, assessment: { state: "outdated", identity: null },
    current: { checkpoint: { revision: 2 } } });
  expect(stale.blockingReasons.map(({ code }) => code)).toContain("ASSESSMENT_OUTDATED");
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => {
    db.prepare("DELETE FROM dvd_title_damage_assessment_attempts").run();
    db.prepare("DELETE FROM dvd_title_damage_assessments").run();
  });
  expect((await fixture.run(["encode-readiness", archive.id])).result).toMatchObject({
    sourceReady: false, assessment: { state: "pending" },
  });
});

it("rejects a live prior writer even after its worker claim lease expires", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive } = await seedEncodingReadiness(fixture, { clean: true });
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath,
    claimLeaseDurationMs: 1, ownershipCheckIntervalMs: 60_000 });
  await ownership.withWriter({ archiveId: archive.id, imagePath: archive.archivePath,
    originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal,
    task: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await fixture.run(["encode-readiness", archive.id]);
      expect(result.result).toMatchObject({ sourceReady: false,
        ownership: { writer: { state: "active" }, workerClaim: { state: "expired" } },
        blockingReasons: [{ code: "WRITER_NOT_QUIESCENT" }],
      });
    },
  });
});

it("preserves historical semantics and reports invalid or missing input as JSON", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive } = seedCatalogReviewForReadFixture(fixture);
  expect((await fixture.run(["encode-readiness", archive.id])).result).toMatchObject({
    applicable: false, sourceReady: null, admissionAvailable: null, evidenceFormat: null,
  });
  expect((await fixture.run(["encode-readiness"])).result).toMatchObject({ archives: [{ id: archive.id }] });
  expect((await fixture.run(["encode-readiness", "synthetic-missing"]))).toMatchObject({
    exitCode: 2, result: { error: { code: "NOT_FOUND" } },
  });
  expect((await fixture.run(["encode-readiness", "../invalid"]))).toMatchObject({
    exitCode: 2, result: { error: { code: "INVALID_ARGUMENTS" } },
  });
});

it("requires source-continuity acceptance even with clean_read Archive Integrity", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { archive } = await seedEncodingReadiness(fixture, { continuityRisk: true });
  expect((await fixture.run(["encode-readiness", archive.id])).result).toMatchObject({
    recordedIntegrity: "clean_read", sourceReady: false,
    selections: [{ assessment: { impact: "clean", sourceContinuityRisk: true }, acceptanceRequired: true }],
    blockingReasons: [{ code: "ACCEPTANCE_REQUIRED" }],
  });
});

it("resolves main_feature only through a current concrete exact-set decision", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true, mainFeature: true });
  expect((await fixture.run(["encode-readiness", seeded.archive.id])).result).toMatchObject({
    sourceReady: false, selections: [{ resolvedSource: null }],
  });
  expect((await acceptReadinessContent(fixture, seeded.archive.id, [{
    discSelectionId: seeded.selection.id, titleIdentityId: seeded.observation.titleIdentityId,
  }])).exitCode).toBe(0);
  expect((await fixture.run(["encode-readiness", seeded.archive.id])).result).toMatchObject({
    sourceReady: true, current: { acceptanceState: "not_required" },
    selections: [{ resolvedSource: { displayTitleNumber: 1, angleNumber: 1, chapterStart: 1, chapterEnd: 4 }, acceptanceRequired: false }],
  });
});

it("expires source decisions after chapter remapping and requires mapping review before assessment freshness", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture);
  expect((await acceptReadinessContent(fixture, seeded.archive.id)).exitCode).toBe(0);
  const access = fixture.openAccess();
  const archive = access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!;
  const corrected = access.catalog.correctDiscSelection(seeded.selection.id, {
    originalDiscArchiveId: archive.id, catalogRevision: archive.updatedAt, mediaItemId: seeded.selection.mediaItemId,
    sourceIdentity: { kind: "dvd_chapters", titleNumber: 1, chapterStart: 2, chapterEnd: 3 },
    reason: "Select synthetic chapter bounds.",
  });
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
  await access.assessDvdTitleDamage(archive.id, ownership, async () => assessmentMappings(seeded.assessment!.items));
  access.close();
  const remapped = (await fixture.run(["encode-readiness", archive.id])).result;
  expect(remapped).toMatchObject({ sourceReady: false, current: { acceptanceState: "expired" },
    selections: [{ discSelectionId: corrected.discSelection.id,
      resolvedSource: { chapterStart: 2, chapterEnd: 3 }, acceptanceSatisfied: false }],
    blockingReasons: [{ code: "ACCEPTANCE_REQUIRED" }],
  });
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => {
    db.prepare("UPDATE dvd_title_identity_selection_bindings SET state = 'needs_mapping_review'").run();
  });
  const review = (await fixture.run(["encode-readiness", archive.id])).result as EncodingReadiness;
  expect(review.blockingReasons.map(({ code }) => code)).toEqual(["MAPPING_REVIEW_REQUIRED", "ASSESSMENT_OUTDATED"]);
});

it("reports a damaged durable checkpoint as a consistency fault with current database identities", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  writeFileSync(seeded.archive.archivePath, "synthetic changed source");
  expect((await fixture.run(["encode-readiness", seeded.archive.id])).result).toMatchObject({
    sourceReady: false, current: { checkpoint: { revision: 1, verified: false } },
    blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
  });
});

it("reports corrupt persisted evidence as consistency blockers while retaining readable identities", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture, { clean: true });
  withEvidenceGuardsDisabled(fixture.databasePath, (db) => {
    db.prepare("UPDATE dvd_title_identity_observations SET content_digest = ?").run("0".repeat(64));
  });
  const result = await fixture.run(["encode-readiness", seeded.archive.id]);
  expect(result).toMatchObject({ exitCode: 0, result: { sourceReady: false,
    current: { originalDiscArchiveId: seeded.archive.id, checkpoint: { revision: 1 }, recovery: { state: "stopped" } },
    ownership: { writer: { state: "inactive" } }, selections: [{ discSelectionId: seeded.selection.id }],
  } });
  const codes = (result.result as EncodingReadiness).blockingReasons.map(({ code }) => code);
  expect(codes[0]).toBe("CONSISTENCY_FAULT");
  expect(codes).toContain("SELECTION_UNIDENTIFIED");
});

it("retains disappeared Title Identities and their mapping-review blockers", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodingReadiness(fixture);
  const next = advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  const access = fixture.openAccess();
  access.catalog.recordDvdTitleIdentityObservations({ originalDiscArchiveId: seeded.archive.id,
    checkpoint: { manifestId: next.id, manifestRevision: next.revision, manifestDigest: next.manifestDigest },
    observations: [{ displayTitleNumber: 2,
      navigation: { videoTitleSetNumber: 1, titleSetTitleNumber: 2, programChainNumber: 1 },
      selectedPath: seeded.observation.selectedPath, angleNumber: 1, angleCount: 1,
      chapterStart: 1, chapterEnd: 4, chapterCount: 4, sourceExtents: [{ startLba: 200, sectorCount: 100 }],
    }],
  });
  access.close();
  const result = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
  expect(result).toMatchObject({ sourceReady: false, selections: [{
    titleIdentityId: seeded.observation.titleIdentityId, presentAtCurrentCheckpoint: false, resolvedSource: null,
  }] });
  expect(result.blockingReasons.map(({ code }) => code)).toEqual([
    "MAPPING_REVIEW_REQUIRED", "SELECTION_UNIDENTIFIED", "ASSESSMENT_OUTDATED",
  ]);
});
