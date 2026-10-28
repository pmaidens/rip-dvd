import { afterEach, expect, it } from "vitest";
import { lstatSync, realpathSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeOutputArtifactIdentity, retainedEncodeOutputArtifactIdentity, type EncodeOutputInspection } from "@rip-dvd/application";
import { encodeOutputFilesystemIdentity } from "@rip-dvd/data-access";
import { createOperatorWorkflowFixture, seedCatalogReviewForReadFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

const probe = async () => ({ durationSeconds: 90, streams: [] });

it("records only an explicit acknowledgement and replays its exact evidence after restart", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, {
    validatedOutputContents: "synthetic inspected normal output",
  });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const inspect = async () => (await fixture.run(
    ["encode-output", "inspect", identity], undefined, undefined,
    { encodeOutputMediaProbe: probe },
  )).result as EncodeOutputInspection;
  const reviewed = await inspect();
  expect(reviewed.operatorInspection.history).toEqual([]);
  expect((await inspect()).operatorInspection.history).toEqual([]);
  expect((await fixture.run(["encode-output", "export", identity, "--destination", join(fixture.operatorHostPath, "reviewed.mkv")])).exitCode).toBe(0);
  expect((await inspect()).operatorInspection.history).toEqual([]);
  const input = { acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken };
  const args = ["encode-output", "acknowledge-inspection", identity,
    "--key", "synthetic-receipt-key", "--json", JSON.stringify(input)];
  const result = await fixture.run(args, undefined, undefined, { encodeOutputMediaProbe: probe });
  expect(result.exitCode).toBe(0);
  expect(result.result).toMatchObject({ receipt: {
    id: expect.any(String), artifactIdentity: identity,
    generationIdentity: reviewed.operatorInspection.generationIdentity,
    evidence: {
      file: { identity: reviewed.artifact.file.identity },
      validation: reviewed.artifact.validation,
      provenance: { sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" },
      media: { playability: "not_assessed" },
    },
  } });
  expect((await inspect()).operatorInspection.history).toEqual([
    (result.result as { receipt: unknown }).receipt,
  ]);
  expect((await fixture.run(args)).result).toEqual(result.result);
  expect((await fixture.run(args.map((arg) => arg === JSON.stringify(input)
    ? JSON.stringify({ ...input, reviewToken: "0".repeat(64) }) : arg))).result)
    .toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
});

it("keeps receipts with retained normal generations through replacement and requeue", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, predecessor } = seedCatalogReviewForReadFixture(fixture, {
    validatedOutputContents: "synthetic first normal generation",
  });
  const options = { encodeOutputMediaProbe: probe };
  const inspect = async (identity: string) => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options)).result as EncodeOutputInspection;
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const first = await inspect(identity);
  const acknowledged = await fixture.run(["encode-output", "acknowledge-inspection", identity,
    "--key", "synthetic-retained-receipt", "--json", JSON.stringify({ acknowledged: true, reviewToken: first.operatorInspection.reviewToken })], undefined, undefined, options);
  expect(acknowledged.exitCode).toBe(0);
  const receipt = (acknowledged.result as { receipt: unknown }).receipt;
  const access = fixture.openAccess();
  const replacement = access.catalog.completeCatalogReviewWithReplacements(
    archive.id, access.catalog.listOriginalDiscArchives({ ids: [archive.id] })[0]!.updatedAt,
    "reviewed_with_selections", [{ predecessorEncodeJobId: predecessor.id,
      encodingProfileId: predecessor.encodingProfileId, outputPath: predecessor.outputPath }],
  ).replacementEncodeJobs[0]!;
  const publish = (bytes: string) => {
    const claim = access.encodeJobs.claimNext("synthetic-receipt-worker")!;
    access.encodeJobs.recordReplacementOutputIdentity(claim, encodeOutputFilesystemIdentity(lstatSync(claim.outputPath)));
    const cleanup = access.encodeJobs.registerPartialCleanup(claim, { publicationPending: true });
    const retainedPath = join(realpathSync(dirname(claim.outputPath)), `${basename(claim.outputPath)}.failed.${claim.claimToken}`);
    const mutation = access.encodeJobs.beginPublicationMutation(claim, cleanup, retainedPath);
    renameSync(claim.outputPath, retainedPath);
    writeFileSync(claim.outputPath, bytes);
    access.encodeJobs.completePublishedClaim(claim, mutation, () => true, {
      retainedOutputPath: retainedPath,
      retainedOutputIdentity: encodeOutputFilesystemIdentity(lstatSync(retainedPath)),
      publishedOutputValidation: { result: "passed", completeness: "complete",
        filesystemIdentity: encodeOutputFilesystemIdentity(lstatSync(claim.outputPath)) },
    });
    access.encodeJobs.completePartialCleanup(mutation);
  };
  publish("synthetic replacement generation");
  const retained = access.encodeJobs.listRetainedOutputs([predecessor.id, replacement.id])[0]!;
  const retainedIdentity = retainedEncodeOutputArtifactIdentity(retained.id);
  const preserved = await inspect(retainedIdentity);
  expect(preserved.operatorInspection).toMatchObject({
    generationIdentity: first.operatorInspection.generationIdentity, status: "not_acknowledged", receipts: [], history: [receipt],
  });
  expect((await inspect(encodeOutputArtifactIdentity(replacement.id))).operatorInspection.receipts).toEqual([]);
  const retainedAck = await fixture.run(["encode-output", "acknowledge-inspection", retainedIdentity,
    "--key", "synthetic-retained-new-receipt", "--json", JSON.stringify({ acknowledged: true, reviewToken: preserved.operatorInspection.reviewToken })], undefined, undefined, options);
  expect(retainedAck.exitCode).toBe(0);
  const replacementIdentity = encodeOutputArtifactIdentity(replacement.id);
  const second = await inspect(replacementIdentity);
  const secondAck = await fixture.run(["encode-output", "acknowledge-inspection", replacementIdentity,
    "--key", "synthetic-second-receipt", "--json", JSON.stringify({ acknowledged: true, reviewToken: second.operatorInspection.reviewToken })], undefined, undefined, options);
  expect(secondAck.exitCode).toBe(0);
  access.encodeJobs.requeue(replacement.id);
  expect((await inspect(replacementIdentity)).operatorInspection.receipts).toHaveLength(1);
  publish("synthetic third normal generation");
  access.close();
  const third = await inspect(replacementIdentity);
  expect(third.operatorInspection.generationIdentity).not.toBe(second.operatorInspection.generationIdentity);
  expect(third.operatorInspection.receipts).toEqual([]);
  expect(third.operatorInspection.history).toHaveLength(1);
  expect(third.operatorInspection.history[0]).toEqual((secondAck.result as { receipt: unknown }).receipt);
  expect((await inspect(retainedIdentity)).operatorInspection.history).toContainEqual(receipt);
});

it("rechecks staged file evidence and reports the changed identities without a partial receipt", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic stable review" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
  const access = fixture.openAccess();
  const result = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-raced-receipt", "--json",
    JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, {
    encodeOutputMediaProbe: probe,
    openAccess: () => ({ ...access, encodeOutputInspectionReceipts: {
      ...access.encodeOutputInspectionReceipts,
      record(input, prepare) {
        return access.encodeOutputInspectionReceipts.record(input, () => {
          writeFileSync(predecessor.outputPath, "synthetic changed before commit");
          return prepare();
        });
      },
    } }),
  });
  expect(result.exitCode).toBe(2);
  expect(result.result).toMatchObject({ error: { code: "OUTPUT_IDENTITY_CHANGED", current: { operatorInspection: { history: [] } } } });
});

it.each(["file", "missing", "unsafe", "validation", "provenance", "authority"])(
  "rejects stale %s evidence without recording a receipt",
  async (change) => {
    const fixture = createOperatorWorkflowFixture();
    fixtures.push(fixture);
    const { predecessor } = seedCatalogReviewForReadFixture(fixture, {
      validatedOutputContents: "synthetic stale evidence output",
    });
    const identity = encodeOutputArtifactIdentity(predecessor.id);
    const options = { encodeOutputMediaProbe: probe };
    const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options))
      .result as EncodeOutputInspection;
    if (change === "file") writeFileSync(predecessor.outputPath, "changed synthetic bytes");
    if (change === "missing" || change === "unsafe") unlinkSync(predecessor.outputPath);
    if (change === "unsafe") symlinkSync(fixture.databasePath, predecessor.outputPath);
    if (change === "provenance") {
      const access = fixture.openAccess();
      const profile = access.encodingProfiles.createVersion({
        sourceProfileId: predecessor.encodingProfileId,
        mediaDomain: "dvd_video", settings: { preset: "Fast 720p30" },
      });
      access.close();
      const sqlite = new DatabaseSync(fixture.databasePath);
      try { sqlite.prepare("UPDATE encode_jobs SET encoding_profile_id = ? WHERE id = ?").run(profile.id, predecessor.id); }
      finally { sqlite.close(); }
    }
    if (["validation", "authority"].includes(change)) {
      const sqlite = new DatabaseSync(fixture.databasePath);
      try {
        if (change === "validation") sqlite.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1000 WHERE id = ?").run(predecessor.id);
        if (change === "authority") sqlite.prepare("UPDATE encode_jobs SET publication_pending = 1, partial_cleanup_output_path = output_path, partial_cleanup_claim_token = 'synthetic-claim-token' WHERE id = ?").run(predecessor.id);
      } finally { sqlite.close(); }
    }
    const rejected = await fixture.run(["encode-output", "acknowledge-inspection", identity,
      "--key", "synthetic-stale-receipt", "--json", JSON.stringify({
        acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken,
      })], undefined, undefined, options);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.result).toMatchObject({ error: {
      code: change === "file" ? "OUTPUT_IDENTITY_CHANGED"
        : change === "missing" ? "OUTPUT_MISSING"
        : change === "unsafe" ? "OUTPUT_NOT_REGULAR"
        : change === "authority" ? "OUTPUT_AUTHORITY_CHANGED" : "OUTPUT_INSPECTION_STALE",
      current: { operatorInspection: { history: [] } },
      currentIdentity: change === "missing" ? null : encodeOutputFilesystemIdentity(lstatSync(predecessor.outputPath)),
    } });
  },
);

it("acknowledges probe failure as an unknown without asserting validation or playability", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic unknown media" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const options = { encodeOutputMediaProbe: async () => { throw new Error("Synthetic probe failure"); } };
  const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options)).result as EncodeOutputInspection;
  const args = ["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-unknown-receipt", "--json",
    JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })];
  expect((await fixture.run(args, undefined, undefined, options)).result).toMatchObject({ receipt: { evidence: {
    validation: { result: "unknown", evidenceAvailability: "recorded" },
    inspectability: { status: "unknown", reasonCode: "OUTPUT_PROBE_FAILED" },
    media: { durationSeconds: null, streams: null, playability: "not_assessed" },
    provenance: { sourceSnapshotAvailability: "not_recorded" },
  } } });
});

it.each([
  { input: ["--json", "{"], code: "INVALID_ARGUMENTS" },
  { input: ["--json", "{}", "--stdin"], code: "INVALID_ARGUMENTS" },
  { input: ["--file", "synthetic-missing-receipt-input.json"], code: "INVALID_INPUT" },
])("reports structured input errors as operator input failures: $code", async ({ input, code }) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const identity = "encode-output-v1.published.00000000-0000-4000-8000-000000000000";
  const result = await fixture.run(["encode-output", "acknowledge-inspection", identity,
    "--key", "synthetic-invalid-receipt-input", ...input], undefined, "{}", {
    openAccess: () => { throw new Error("Invalid input must not open persistence"); },
  });
  expect(result).toMatchObject({ exitCode: 2, result: { error: { code } } });
});

it("requires an explicit acknowledgement, artifact authority and an exact token", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture);
  writeFileSync(predecessor.outputPath, "synthetic historical unowned file");
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const options = { encodeOutputMediaProbe: probe };
  const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options)).result as EncodeOutputInspection;
  for (const input of [{}, { acknowledged: false, reviewToken: reviewed.operatorInspection.reviewToken }, { acknowledged: true }]) {
    expect((await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-explicit-receipt", "--json", JSON.stringify(input)], undefined, undefined, options)).result)
      .toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  }
  expect((await fixture.run(["encode-output", "acknowledge-inspection", identity,
    "--key", "synthetic-explicit-receipt", "--json", JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, options)).result)
    .toMatchObject({ error: { code: "OUTPUT_IDENTITY_NOT_RECORDED", current: { operatorInspection: { history: [] } } } });
});

it("never applies a receipt to changed same-inode bytes with a restored modification time", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic original bytes" });
  // A whole-second synthetic timestamp makes the adversarial restoration exact
  // on filesystems with different timestamp precision.
  utimesSync(predecessor.outputPath, 1_700_000_000, 1_700_000_000);
  const sqlite = new DatabaseSync(fixture.databasePath);
  try { sqlite.prepare("UPDATE encode_jobs SET output_validation_filesystem_identity = ? WHERE id = ?")
    .run(encodeOutputFilesystemIdentity(lstatSync(predecessor.outputPath)), predecessor.id); }
  finally { sqlite.close(); }
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const options = { encodeOutputMediaProbe: probe };
  const inspect = async () => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options)).result as EncodeOutputInspection;
  const reviewed = await inspect();
  const accepted = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-ctime-receipt", "--json",
    JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, options);
  expect(accepted.exitCode).toBe(0);
  const before = lstatSync(predecessor.outputPath);
  writeFileSync(predecessor.outputPath, "synthetic modified bytes");
  utimesSync(predecessor.outputPath, before.atime, before.mtime);
  const changed = await inspect();
  expect(changed.artifact.file.identity).toBe(reviewed.artifact.file.identity);
  expect(changed.operatorInspection.generationIdentity).toBe(reviewed.operatorInspection.generationIdentity);
  expect(changed.operatorInspection).toMatchObject({ status: "not_acknowledged", receipts: [], history: [(accepted.result as { receipt: unknown }).receipt] });
  expect(changed.artifact.file.mutationRevision).not.toBe(reviewed.artifact.file.mutationRevision);
});

it("replays a concurrent winner even when the waiting retry observes changed media", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic concurrent acknowledgement" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
  const args = ["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-concurrent-receipt", "--json",
    JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })];
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const probing = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = fixture.run(args, undefined, undefined, { encodeOutputMediaProbe: async () => {
    entered(); await held; return probe();
  } });
  await probing;
  const winner = await fixture.run(args, undefined, undefined, { encodeOutputMediaProbe: probe });
  writeFileSync(predecessor.outputPath, "synthetic bytes changed after the winning acknowledgement");
  release();
  expect(winner.exitCode).toBe(0);
  expect((await waiting).result).toEqual(winner.result);
});

it("pages bounded acknowledgement history independently of the latest matching receipt", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic paged receipt history" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const options = { encodeOutputMediaProbe: probe };
  const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, options)).result as EncodeOutputInspection;
  const recorded: unknown[] = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", `synthetic-paged-receipt-${index}`, "--json",
      JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, options);
    expect(result.exitCode).toBe(0);
    recorded.unshift((result.result as { receipt: unknown }).receipt);
  }
  const collected: unknown[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = (await fixture.run(["encode-output", "inspect", identity, "--receipt-limit", "2", "--receipt-offset", String(offset)], undefined, undefined, options)).result as EncodeOutputInspection;
    expect(page.operatorInspection.receipts).toEqual([recorded[0]]);
    expect(page.operatorInspection.history.length).toBeLessThanOrEqual(2);
    collected.push(...page.operatorInspection.history);
    offset = page.operatorInspection.historyNextOffset;
  }
  expect(collected).toEqual(recorded);
});

it("returns current validation identities when evidence changes during the acknowledgement probe", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { predecessor } = seedCatalogReviewForReadFixture(fixture, { validatedOutputContents: "synthetic changing validation" });
  const identity = encodeOutputArtifactIdentity(predecessor.id);
  const reviewed = (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
  let changed = false;
  const result = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-validation-race", "--json",
    JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, {
    encodeOutputMediaProbe: async () => {
      if (!changed) {
        changed = true;
        const sqlite = new DatabaseSync(fixture.databasePath);
        try { sqlite.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1000 WHERE id = ?").run(predecessor.id); }
        finally { sqlite.close(); }
      }
      return probe();
    },
  });
  const updatedTime = new Date(new Date(reviewed.artifact.validation.evidence!.validatedAt).getTime() + 1000).toISOString();
  expect(result.exitCode).toBe(2);
  expect(result.result).toMatchObject({ error: { code: "OUTPUT_AUTHORITY_CHANGED", current: {
    artifact: { validation: { evidence: { validatedAt: updatedTime } } },
    operatorInspection: { history: [] },
  } } });
});
