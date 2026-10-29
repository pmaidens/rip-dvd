import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { encodeOutputArtifactIdentity, type EncodeOutputInspection, type DamagePreviewInspection } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDamagePreviewWithNormalOutput, settleDamagePreviewMedia } from "../../../../../operator-cli/src/damage-preview.test-support.js";
import { createDamagePreviewRoute } from "./route";
import { createDamagePreviewMediaRemovalRoute } from "./media/route";
import { seedProvedPreviewOutput } from "../../../../../operator-cli/src/damage-preview-source-retention.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });
const probe = async () => ({ durationSeconds: 90, streams: [] });

it("shares matching receipt consumption and stale-generation protection with the public CLI without recording another acknowledgement", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, output } = await seedDamagePreviewWithNormalOutput(fixture);
  const identity = encodeOutputArtifactIdentity(output.id);
  const inspectOutput = async () => (await fixture.run(["encode-output", "inspect", identity], undefined, undefined, { encodeOutputMediaProbe: probe })).result as EncodeOutputInspection;
  const reviewed = await inspectOutput();
  const acknowledged = await fixture.run(["encode-output", "acknowledge-inspection", identity, "--key", "synthetic-web-preview-ack", "--json", JSON.stringify({ acknowledged: true, reviewToken: reviewed.operatorInspection.reviewToken })], undefined, undefined, { encodeOutputMediaProbe: probe });
  expect(acknowledged.exitCode).toBe(0);
  const history = (await inspectOutput()).operatorInspection.history;
  const access = fixture.openAccess();
  const inspectBoth = async () => {
    const cli = await fixture.run(["damage-preview", "inspect", id], undefined, undefined, { encodeOutputMediaProbe: probe });
    const web = await createDamagePreviewRoute(new Request(`http://localhost:3000/api/damage-previews/${id}`), id, () => access);
    expect(cli.exitCode).toBe(0); expect(web.status).toBe(200);
    expect(await web.json()).toEqual(cli.result);
    return cli.result as DamagePreviewInspection;
  };
  try {
    expect((await inspectBoth()).finishedOutputInspection?.outputs[0]).toMatchObject({ acknowledgementStatus: "acknowledged", matchingReceipts: history, reasonCode: "FINISHED_OUTPUT_SOURCE_NOT_RECORDED" });
    const sqlite = new DatabaseSync(fixture.databasePath);
    sqlite.prepare("UPDATE encode_jobs SET output_validated_at = output_validated_at + 1 WHERE id = ?").run(output.id);
    sqlite.close();
    const stale = await inspectBoth();
    expect(stale).toMatchObject({ media: { retention: { protectedForReview: true } }, finishedOutputInspection: { outputs: [{ acknowledgementStatus: "not_acknowledged", matchingReceipts: [] }] } });
    expect((await inspectOutput()).operatorInspection.history).toEqual(history);
    unlinkSync(output.outputPath);
    expect((await inspectBoth()).finishedOutputInspection?.outputs[0]).toMatchObject({ acknowledgementStatus: "unavailable", matchingReceipts: [], reasonCode: "FINISHED_OUTPUT_UNAVAILABLE" });
  } finally { access.close(); }
});

it("shares exact-source receipt release and keyed idle cleanup between HTTP and CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, inspectPreview, acknowledge } = await seedProvedPreviewOutput(fixture);
  await acknowledge("synthetic-http-source-proof");
  const current = await inspectPreview();
  expect(current).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: true }, media: { retention: { protectedForReview: false } } });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * 24 * 60 * 60 * 1_000);
  const access = fixture.openAccess();
  try {
    const origin = "http://localhost:3000";
    const web = await createDamagePreviewRoute(new Request(`${origin}/api/damage-previews/${id}`), id, () => access);
    expect(await web.json()).toEqual(await inspectPreview());
    const input = { mutationKey: "synthetic-http-proved-cleanup", mediaToken: current.media.token };
    const cleanup = await createDamagePreviewMediaRemovalRoute(new Request(`${origin}/api/damage-previews/${id}/media`, { method: "POST", headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) }), id, () => access, () => origin);
    expect(cleanup.status).toBe(202);
    expect(await cleanup.json()).toEqual((await fixture.run(["damage-preview", "cleanup", id, "--key", input.mutationKey, "--json", JSON.stringify({ mediaToken: input.mediaToken })])).result);
    expect((await inspectPreview()).media.removal?.state).toBe("pending");
    settleDamagePreviewMedia(fixture);
    expect((await inspectPreview()).media.removal?.state).toBe("complete");
  } finally { access.close(); }
});

it("shares retention protection for an acknowledged complete validation-failed output", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, path, identity, inspectPreview, acknowledge } = await seedProvedPreviewOutput(fixture, { validationFailed: true });
  await acknowledge("synthetic-http-failed-output-receipt");
  const current = await inspectPreview();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(current.updatedAt) + 31 * 24 * 60 * 60 * 1_000);
  const access = fixture.openAccess();
  const origin = "http://localhost:3000";
  try {
    const inspected = await createDamagePreviewRoute(new Request(`${origin}/api/damage-previews/${id}`), id, () => access);
    const protectedPreview = await inspected.json();
    expect(protectedPreview).toEqual(await inspectPreview());
    expect(protectedPreview).toMatchObject({ outdated: false, finishedOutputInspection: { retentionSatisfied: false,
      outputs: [{ artifactIdentity: identity, acknowledgementStatus: "acknowledged", reasonCode: "FINISHED_OUTPUT_VALIDATION_UNPROVED" }] }, media: { retention: { protectedForReview: true } } });
    const input = { mutationKey: "synthetic-http-failed-output-cleanup", mediaToken: current.media.token };
    const cleanup = await createDamagePreviewMediaRemovalRoute(new Request(`${origin}/api/damage-previews/${id}/media`, { method: "POST", headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) }), id, () => access, () => origin);
    expect(cleanup.status).toBe(409);
    expect(await cleanup.json()).toEqual((await fixture.run(["damage-preview", "cleanup", id, "--key", input.mutationKey, "--json", JSON.stringify({ mediaToken: input.mediaToken })])).result);
    settleDamagePreviewMedia(fixture);
    expect(existsSync(path)).toBe(true);
  } finally { access.close(); }
});
