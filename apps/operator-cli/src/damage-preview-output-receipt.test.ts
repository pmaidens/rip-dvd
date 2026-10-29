import { lstatSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { encodeOutputArtifactIdentity, type DamagePreviewInspection, type EncodeOutputInspection, type EncodeOutputInspectionReceipt } from "@rip-dvd/application";
import { encodeOutputFilesystemIdentity } from "@rip-dvd/data-access";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedDamagePreviewWithNormalOutput } from "./damage-preview.test-support.js";
import { withEvidenceGuardsDisabled } from "./archive-evidence.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });
const probe = async () => ({ durationSeconds: 90, streams: [] });
async function setup() {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedDamagePreviewWithNormalOutput(fixture);
  const identity = encodeOutputArtifactIdentity(seeded.output.id);
  const inspectOutput = async () => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
  const inspectPreview = async () => (await fixture.run(["damage-preview", "inspect", seeded.id], undefined, undefined, { encodeOutputMediaProbe: probe })).result as DamagePreviewInspection;
  const acknowledge = async (key: string) => {
    const reviewed = await inspectOutput();
    const result = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", key, "--json", JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe });
    expect(result.exitCode, JSON.stringify(result.result)).toBe(0);
    return (result.result as { receipt: EncodeOutputInspectionReceipt }).receipt;
  };
  return { ...seeded, fixture, identity, inspectOutput, inspectPreview, acknowledge };
}

it("recognizes an exact-generation acknowledgement without releasing media whose source relationship is unproved", async () => {
  const { fixture, id, seeded, identity, inspectOutput, inspectPreview, acknowledge } = await setup();
  expect((await inspectOutput()).operatorInspection.history).toEqual([]);
  expect((await inspectPreview()).finishedOutputInspection).toBeNull();
  expect((await inspectOutput()).operatorInspection.history).toEqual([]);
  const receipt = await acknowledge("synthetic-preview-output-ack");
  withEvidenceGuardsDisabled(fixture.databasePath, (sqlite) => {
    sqlite.prepare("UPDATE original_disc_archives SET catalog_review_outcome = 'reviewed_with_selections', catalog_reviewed_at = updated_at + 1, updated_at = updated_at + 1 WHERE id = ?").run(seeded.archive.id);
  });
  const before = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(before.updatedAt) + 31 * 24 * 60 * 60 * 1_000);
  const preview = await inspectPreview();
  expect(preview).toMatchObject({ outdated: false, media: { retention: { activeCatalogReview: false, protectedForReview: true } }, finishedOutputInspection: {
    state: "unproved", retentionSatisfied: false,
    outputs: [{ artifactIdentity: identity, generationIdentity: receipt.generationIdentity, acknowledgementStatus: "acknowledged", matchingReceipts: [receipt], reasonCode: "FINISHED_OUTPUT_SOURCE_NOT_RECORDED" }],
  } });
  expect(receipt.evidence.provenance).toMatchObject({ sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" });
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-ack-no-source-cleanup", "--json", JSON.stringify({ mediaToken: preview.media.token })])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE", reasons: [{ code: "DAMAGE_PREVIEW_REVIEW_RETENTION" }] } } });
  expect((await inspectOutput()).operatorInspection.receipts).toEqual([receipt]);
});

it.each(["validation", "bytes"] as const)("does not transfer a receipt after %s changes within the same output job", async (change) => {
  const { fixture, output, identity, inspectOutput, inspectPreview, acknowledge } = await setup();
  const receipt = await acknowledge(`synthetic-old-${change}-receipt`);
  const sqlite = new DatabaseSync(fixture.databasePath);
  if (change === "validation") sqlite.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1 WHERE id = ?").run(output.id);
  else {
    writeFileSync(output.outputPath, "synthetic replacement bytes belonging to a distinct normal generation");
    sqlite.prepare("UPDATE encode_jobs SET output_validation_filesystem_identity = ? WHERE id = ?").run(encodeOutputFilesystemIdentity(lstatSync(output.outputPath)), output.id);
  }
  sqlite.close();
  const current = await inspectOutput();
  expect(current.operatorInspection.history).toEqual([receipt]);
  expect(current.operatorInspection.generationIdentity).not.toBe(receipt.generationIdentity);
  expect(await inspectPreview()).toMatchObject({ media: { retention: { protectedForReview: true } }, finishedOutputInspection: {
    retentionSatisfied: false, outputs: [{ artifactIdentity: identity, generationIdentity: current.operatorInspection.generationIdentity, acknowledgementStatus: "not_acknowledged", matchingReceipts: [], reasonCode: "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED" }],
  } });
});

it("uses matching generation receipts even when another generation heads bounded history", async () => {
  const { fixture, output, inspectOutput, inspectPreview, acknowledge } = await setup();
  const first = await acknowledge("synthetic-matching-history-receipt");
  const sqlite = new DatabaseSync(fixture.databasePath);
  const original = sqlite.prepare("SELECT output_validated_at FROM encode_jobs WHERE id = ?").get(output.id)!;
  sqlite.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1 WHERE id = ?").run(output.id);
  const other = await acknowledge("synthetic-other-history-receipt");
  sqlite.prepare("UPDATE encode_jobs SET output_validated_at = ? WHERE id = ?").run(Number(original.output_validated_at), output.id);
  sqlite.close();
  expect((await inspectOutput()).operatorInspection.history).toEqual([other, first]);
  expect((await inspectPreview()).finishedOutputInspection?.outputs[0]).toMatchObject({ generationIdentity: first.generationIdentity, acknowledgementStatus: "acknowledged", matchingReceipts: [first] });
});

it("keeps an acknowledged historical source unknown after later catalog evidence changes", async () => {
  const { fixture, seeded, output, inspectOutput, inspectPreview, acknowledge } = await setup();
  const receipt = await acknowledge("synthetic-unknown-source-receipt");
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE disc_selections SET label = 'Synthetic later mapping label' WHERE id = ?").run(output.discSelectionId);
  sqlite.close();
  const preview = await inspectPreview();
  expect(preview.provenance).toMatchObject({ checkpoint: { manifestRevision: seeded.manifest.revision } });
  expect(preview.finishedOutputInspection?.outputs[0]?.matchingReceipts).toEqual([receipt]);
  expect((await inspectOutput()).operatorInspection.receipts[0]?.evidence.provenance).toMatchObject({ sourceSnapshot: null, sourceSnapshotAvailability: "not_recorded" });
  expect(preview.media.retention?.protectedForReview).toBe(true);
});

it("finds retained normal-generation acknowledgement evidence independently of a later job cancellation", async () => {
  const { fixture, output, inspectOutput, inspectPreview, acknowledge } = await setup();
  const receipt = await acknowledge("synthetic-normal-before-cancel");
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE encode_jobs SET status = 'cancelled', replace_existing_output = 1 WHERE id = ?").run(output.id);
  sqlite.close();
  expect((await inspectOutput()).operatorInspection.receipts).toEqual([receipt]);
  expect((await inspectPreview()).finishedOutputInspection?.outputs[0]).toMatchObject({ generationIdentity: receipt.generationIdentity, matchingReceipts: [receipt] });
});

it("keeps a preview wait independent of an unrelated output probe", async () => {
  const { fixture, id, acknowledge } = await setup();
  await acknowledge("synthetic-ack-before-preview-wait");
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  try {
    const waited = await fixture.run(["damage-preview", "wait", id, "--timeout-ms", "0"], undefined, undefined, { encodeOutputMediaProbe: async () => { await blocked; return probe(); } });
    expect(waited).toMatchObject({ exitCode: 0, result: { status: "complete", finishedOutputInspection: null, wait: { terminal: true, timedOut: false } } });
  } finally { finish(); }
});
