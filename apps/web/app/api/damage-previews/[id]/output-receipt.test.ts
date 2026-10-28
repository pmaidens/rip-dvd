import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { encodeOutputArtifactIdentity, type EncodeOutputInspection, type DamagePreviewInspection } from "@rip-dvd/application";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDamagePreviewWithNormalOutput } from "../../../../../operator-cli/src/damage-preview.test-support.js";
import { createDamagePreviewRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
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
