import { afterEach, expect, it } from "vitest";
import { verifyInstalledRecreation } from "../../../../../../../scripts/validation/verify-preview-recreation-installed.mjs";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedRetainedDamagePreview, settleDamagePreviewMedia } from "../../../../../../operator-cli/src/damage-preview.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("checks the installed-command assertion harness against public CLI persistence after actual worker removal", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedRetainedDamagePreview(fixture);
  const original = await seeded.inspect();
  await fixture.run(["damage-preview", "delete", seeded.id, "--key", "synthetic-harness-delete", "--json", JSON.stringify({ mediaToken: original.media.token })]);
  settleDamagePreviewMedia(fixture);
  const result = await verifyInstalledRecreation({ id: seeded.id, selection: seeded.seeded.input, original }, async (args: readonly string[], status: number) => {
    const response = await fixture.run(args); expect(response.exitCode).toBe(status); return response.result;
  });
  expect(result).toMatchObject({ exactAdmission: true, currentRevisionAdmission: true, staleRejected: true, workerDeletedHistoryPreserved: true, generationExecuted: false });
});
