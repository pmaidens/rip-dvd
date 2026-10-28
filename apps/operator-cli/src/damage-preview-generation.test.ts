import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";
import { seedDamagePreview } from "./damage-preview.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("atomically requests reviewed preview work, replays its key, rejects changed input and cancels without a checkpoint", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture);
  const review = await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)]);
  const preflight = review.result as { preflightToken: string };
  const input = { selection: seeded.input, preflightToken: preflight.preflightToken };
  const args = ["damage-preview", "request", seeded.archive.id, "--key", "synthetic-preview-request", "--json", JSON.stringify(input)];
  const requested = await fixture.run(args);
  expect(requested).toMatchObject({ exitCode: 0, result: { status: "queued", provenance: { preflightToken: preflight.preflightToken } } });
  expect(await fixture.run(args)).toEqual(requested);
  expect(await fixture.run([...args.slice(0, -1), JSON.stringify({ ...input, preflightToken: "stale" })])).toMatchObject({ exitCode: 2, result: { error: { code: "MUTATION_KEY_CONFLICT" } } });
  const id = (requested.result as { id: string }).id;
  expect(await fixture.run(["readiness"])).toMatchObject({ exitCode: 0, result: { activeWork: expect.arrayContaining([{ kind: "damage_preview", id, status: "queued" }]) } });
  expect(await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-preview-cancel"])).toMatchObject({ exitCode: 0, result: { status: "cancelled" } });
  expect(await fixture.run(["damage-preview", "inspect", id])).toMatchObject({ exitCode: 0, result: { status: "cancelled" } });
  expect(await fixture.run(["readiness"])).toMatchObject({ exitCode: 0, result: { activeWork: [] } });
});
