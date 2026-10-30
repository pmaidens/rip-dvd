import { afterEach, expect, it } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedRetainedDamagePreview, settleDamagePreviewMedia } from "../../../../../../operator-cli/src/damage-preview.test-support.js";
import { advanceCommittedArchiveEvidence } from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import type { DamagePreviewRecreationReview } from "@rip-dvd/application";
import { createDamagePreviewRecreationRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

it("shares cleaned-history review, linked admission, replay, conflict, stale and unavailable results with the public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, seeded, inspect } = await seedRetainedDamagePreview(fixture);
  await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-parity-delete", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })]);
  settleDamagePreviewMedia(fixture);
  expect((await inspect()).media.state).toBe("removed");
  const access = fixture.openAccess();
  const origin = "http://localhost:3000";
  const web = (input?: unknown) => createDamagePreviewRecreationRoute(new Request(`${origin}/api/damage-previews/${id}/recreate`, input ? { method: "POST", headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) } : undefined), id, () => access, () => origin);
  try {
    const reviewed = (await fixture.run(["damage-preview", "recreate", id])).result as DamagePreviewRecreationReview;
    expect(await (await web()).json()).toEqual(reviewed);
    const input = { mode: "exact", recreationToken: reviewed.recreationToken, preflightToken: reviewed.preflight.preflightToken };
    const cli = (key: string, value = input) => fixture.run(["damage-preview", "recreate", id, "--key", key, "--json", JSON.stringify(value)]);
    const accepted = await cli("synthetic-parity-recreate");
    expect(accepted.exitCode).toBe(0);
    expect(await (await web({ ...input, mutationKey: "synthetic-parity-recreate" })).json()).toEqual(accepted.result);
    const changed = { ...input, preflightToken: "changed" };
    const conflict = await web({ ...changed, mutationKey: "synthetic-parity-recreate" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual((await cli("synthetic-parity-recreate", changed)).result);
    advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
    expect(await (await web({ ...input, mutationKey: "synthetic-parity-stale" })).json()).toEqual((await cli("synthetic-parity-stale")).result);
    expect((await cli("synthetic-parity-stale")).result).toMatchObject({ error: { code: "DAMAGE_PREVIEW_RECREATION_STALE" } });
    const unavailable = (await fixture.run(["damage-preview", "recreate", id])).result as DamagePreviewRecreationReview;
    const unavailableInput = { mode: "exact", recreationToken: unavailable.recreationToken, preflightToken: unavailable.preflight.preflightToken };
    expect(await (await web({ ...unavailableInput, mutationKey: "synthetic-parity-unavailable" })).json()).toEqual((await cli("synthetic-parity-unavailable", unavailableInput)).result);
    expect((await cli("synthetic-parity-unavailable", unavailableInput)).result).toMatchObject({ error: { code: "DAMAGE_PREVIEW_EXACT_RECREATION_UNAVAILABLE" } });
    expect(access.damagePreviews.list()).toHaveLength(2);
  } finally { access.close(); }
});

it("compares a proposed current selection without reserving work and requires trusted mutation requests", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, seeded } = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  const origin = "http://localhost:3000";
  const selection = { ...seeded.input, streams: { audio: [], subtitles: [] } };
  try {
    const request = (body: unknown, requestOrigin = origin) => createDamagePreviewRecreationRoute(new Request(`${origin}/api/damage-previews/${id}/recreate`, { method: "POST", headers: { Origin: requestOrigin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(body) }), id, () => access, () => origin);
    const inspected = await request({ mode: "review", selection });
    expect(await inspected.json()).toEqual((await fixture.run(["damage-preview", "recreate", id, "--json", JSON.stringify({ selection })])).result);
    expect((await request({ mode: "review", selection }, "http://other.example")).status).toBe(403);
    expect((await request({ mode: "review", selection, mutationKey: "unused" })).status).toBe(400);
    const review = (await fixture.run(["damage-preview", "recreate", id, "--json", JSON.stringify({ selection })])).result as DamagePreviewRecreationReview;
    const input = { mode: "current_revision", selection, recreationToken: review.recreationToken, preflightToken: review.preflight.preflightToken };
    expect((await request({ ...input, mutationKey: "synthetic-rejected-origin" }, "http://other.example")).status).toBe(403);
    expect(access.damagePreviews.list()).toHaveLength(1);
    const accepted = await fixture.run(["damage-preview", "recreate", id, "--key", "synthetic-parity-current", "--json", JSON.stringify(input)]);
    expect(await (await request({ ...input, mutationKey: "synthetic-parity-current" })).json()).toEqual(accepted.result);
  } finally { access.close(); }
});
