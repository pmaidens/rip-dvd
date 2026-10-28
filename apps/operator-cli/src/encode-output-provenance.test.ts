import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, writeFileSync } from "node:fs";
import { encodeOutputFilesystemIdentity } from "@rip-dvd/data-access";
import { claimNextEncodeJob, encodeOutputArtifactIdentity, retainedEncodeOutputArtifactIdentity, type EncodeOutputInspection, type EncodingReadiness } from "@rip-dvd/application";
import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { seedEncodeClaim } from "./encode-claim.test-support.js";
import { assessmentMappings } from "./encoding-readiness.test-support.js";
import { publishSyntheticClaim, seedMixedCoverageOutput, syntheticOutputValidation } from "./encode-output-provenance.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
const probe = async () => ({ durationSeconds: 500, streams: [] });

it("reports unknown impact from recorded assessment reasons with a complete selected map and no missing sectors", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedMixedCoverageOutput(fixture);
  expect(seeded.assessment.unknownTitleImpact).toMatchObject({ unrecoveredSourceSectorCount: 0,
    reasons: [expect.objectContaining({ code: "TITLE_SOURCE_MAP_INCOMPLETE" })] });
  const inspected = await fixture.run(["encode-output", "inspect", encodeOutputArtifactIdentity(seeded.job.id)],
    undefined, undefined, { encodeOutputMediaProbe: probe });
  expect(inspected).toMatchObject({ exitCode: 0, result: { artifact: {
    sourceDamage: { knownSourceDamage: false, unknownImpact: true, watchability: "not_assessed" },
    provenance: { sourceSnapshot: { source: { assessment: { unknownTitleImpact: { unrecoveredSourceSectorCount: 0 } } } } },
  } } });
});

it("leaves a historical receipt unknown when a later generation gains recorded source evidence", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture);
  const identity = encodeOutputArtifactIdentity(seeded.job.id);
  // A historical completed generation predates both immutable claim and
  // validation records. Do not backfill it from the now-identifiable selection.
  writeFileSync(seeded.job.outputPath, "synthetic historical generation");
  const db = new DatabaseSync(fixture.databasePath);
  try { db.prepare(`UPDATE encode_jobs SET status = 'completed', completed_at = 1,
    output_validation_result = 'passed', output_completeness = 'complete',
    output_validation_filesystem_identity = ?, output_validated_at = 1 WHERE id = ?`)
    .run(encodeOutputFilesystemIdentity(lstatSync(seeded.job.outputPath)), seeded.job.id); }
  finally { db.close(); }
  const inspect = async () => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined,
    { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
  try {
    const historical = await inspect();
    expect(historical.artifact.provenance).toMatchObject({ sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" });
    expect(historical.artifact.sourceDamage).toMatchObject({ knownSourceDamage: null, unknownImpact: true, watchability: "not_assessed" });
    const result = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-historical-source-receipt", "--json",
      JSON.stringify({ acknowledged: true, reviewToken: historical.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(result.exitCode).toBe(0);
    const receipt = (result.result as { receipt: unknown }).receipt;
    seeded.access.encodeJobs.requeue(seeded.job.id, { expectedSourceDecision: seeded.expectedSourceDecision });
    const claim = (await claimNextEncodeJob(seeded.access, "synthetic-later-source-worker", fixture.originalsLibraryPath))!;
    publishSyntheticClaim(seeded.access, claim);
    const current = await inspect();
    expect(current.artifact.provenance.sourceSnapshot?.id).toBe(claim.claimToken);
    expect(current.operatorInspection).toMatchObject({ status: "not_acknowledged", receipts: [], history: [receipt] });
    expect(current.operatorInspection.history[0]!.evidence.provenance.sourceSnapshot).toBeNull();
    expect(current.operatorInspection.history[0]!.evidence.validation.recordIdentity).toBeNull();
  } finally { seeded.access.close(); }
});

it("binds passing source evidence to the exact normal generation through replacement, retry and later decisions", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedEncodeClaim(fixture, { clean: true });
  const { access } = seeded;
  const inspect = async (identity: string) => {
    const result = await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(result.exitCode).toBe(0);
    return result.result as EncodeOutputInspection;
  };
  try {
    const firstClaim = (await claimNextEncodeJob(access, "synthetic-output-worker", fixture.originalsLibraryPath))!;
    const firstValidation = publishSyntheticClaim(access, firstClaim);
    const identity = encodeOutputArtifactIdentity(firstClaim.id);
    const first = await inspect(identity);
    expect(first.artifact).toMatchObject({ validation: { result: "passed", recordIdentity: firstValidation.id, checks: syntheticOutputValidation },
      provenance: { sourceSnapshotAvailability: "recorded", sourceSnapshot: {
        id: firstClaim.claimToken, source: { acceptance: null, sourceContinuityRisk: false,
          output: { expectedDurationSeconds: 500, audioStreams: [{ id: 128, format: "ac3" }] } },
      } }, media: { playability: "not_assessed" } });
    expect(JSON.stringify(first)).not.toContain(fixture.originalsLibraryPath);
    expect(JSON.stringify(first)).not.toContain(fixture.mediaLibraryPath);
    const ack = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-source-output-receipt", "--json",
      JSON.stringify({ acknowledged: true, reviewToken: first.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(ack.exitCode).toBe(0);
    access.catalog.correctDiscSelection(seeded.selection.id, { originalDiscArchiveId: seeded.archive.id,
      catalogRevision: access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt,
      mediaItemId: access.catalog.createMediaItem({ kind: "movie", title: "Synthetic corrected film" }).id,
      sourceIdentity: seeded.selection.sourceIdentity, reason: "Synthetic mapping correction." });
    await access.assessDvdTitleDamage(seeded.archive.id, createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }),
      async () => assessmentMappings(seeded.assessment!.items));
    const replacement = access.catalog.completeCatalogReviewWithReplacements(seeded.archive.id,
      access.catalog.listOriginalDiscArchives({ ids: [seeded.archive.id] })[0]!.updatedAt, "reviewed_with_selections",
      [{ predecessorEncodeJobId: firstClaim.id, encodingProfileId: seeded.profile.id, outputPath: firstClaim.outputPath }]).replacementEncodeJobs[0]!;
    const readiness = (await fixture.run(["encode-readiness", seeded.archive.id])).result as EncodingReadiness;
    const expectedSourceDecision = readiness.selections[0]!.expectedSourceDecision;
    // Seed the replacement's admission decision. This suite exercises generation
    // provenance; admission and corrected replacement review have separate suites.
    const admission = new DatabaseSync(fixture.databasePath);
    try { admission.prepare("UPDATE encode_jobs SET expected_source_decision = ? WHERE id = ?")
      .run(JSON.stringify(expectedSourceDecision), replacement.id); }
    finally { admission.close(); }
    const secondClaim = (await claimNextEncodeJob(access, "synthetic-second-output-worker", fixture.originalsLibraryPath))!;
    expect(secondClaim.id).toBe(replacement.id);
    const secondValidation = publishSyntheticClaim(access, secondClaim, true);
    const retained = access.encodeJobs.listRetainedOutputs([firstClaim.id, replacement.id])[0]!;
    const preserved = await inspect(retainedEncodeOutputArtifactIdentity(retained.id));
    expect(preserved.artifact.provenance.sourceSnapshot).toEqual(first.artifact.provenance.sourceSnapshot);
    expect(preserved.artifact.validation).toEqual(first.artifact.validation);
    expect(preserved.operatorInspection.generationIdentity).toBe(first.operatorInspection.generationIdentity);
    const replacementIdentity = encodeOutputArtifactIdentity(replacement.id);
    access.encodeJobs.requeue(replacement.id, { expectedSourceDecision });
    const thirdClaim = (await claimNextEncodeJob(access, "synthetic-third-output-worker", fixture.originalsLibraryPath))!;
    expect((await inspect(replacementIdentity)).artifact.validation.recordIdentity).toBe(secondValidation.id);
    expect((await inspect(replacementIdentity)).artifact.provenance.sourceSnapshot?.id).toBe(secondClaim.claimToken);
    const thirdValidation = publishSyntheticClaim(access, thirdClaim, true);
    access.encodingProfiles.createVersion({ sourceProfileId: seeded.profile.id, mediaDomain: "dvd_video", settings: { preset: "Fast 720p30" } });
    const final = await inspect(replacementIdentity);
    expect(final.artifact.validation.recordIdentity).toBe(thirdValidation.id);
    expect(final.artifact.provenance.sourceSnapshot?.id).toBe(thirdClaim.claimToken);
    expect(final.artifact.provenance.sourceSnapshot?.source.profile.version).toBe(seeded.profile.version);
    expect((await inspect(retainedEncodeOutputArtifactIdentity(retained.id))).artifact.provenance.sourceSnapshot)
      .toEqual(first.artifact.provenance.sourceSnapshot);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      expect(() => db.prepare("UPDATE encode_output_validations SET evidence = NULL WHERE id = ?").run(firstValidation.id)).toThrow("immutable");
      expect(() => db.prepare("DELETE FROM encode_output_validations WHERE id = ?").run(firstValidation.id)).toThrow("immutable");
    } finally { db.close(); }
  } finally { access.close(); }
});
