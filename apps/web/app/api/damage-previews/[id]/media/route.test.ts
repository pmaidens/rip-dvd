import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedRetainedDamagePreview } from "../../../../../../operator-cli/src/damage-preview.test-support.js";
import { advanceCommittedArchiveEvidence } from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import { createDamagePreviewMediaRemovalRoute } from "./route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });
it("shares deletion authorization, availability, stale evidence and replay with the public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, path, inspect } = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  const origin = "http://localhost:3000";
  const body = { mutationKey: "synthetic-web-deletion", mediaToken: (await inspect()).media.token };
  const web = (input = body, trusted = true, method = "DELETE") => createDamagePreviewMediaRemovalRoute(new Request(`${origin}/api/damage-previews/${id}/media`, { method, headers: { Origin: trusted ? origin : "http://untrusted.invalid", Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) }), id, () => access, () => origin);
  const cli = (action: string, input = body) => fixture.run(["damage-preview", action, id, "--key", input.mutationKey, "--json", JSON.stringify({ mediaToken: input.mediaToken })]);
  try {
    expect((await web(body, false)).status).toBe(403); expect(existsSync(path)).toBe(true);
    const unavailable = await web(body, true, "POST");
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual((await cli("cleanup")).result);
    const stale = { ...body, mediaToken: "stale-media-token" };
    expect(await web(stale).then((response) => response.json())).toEqual((await cli("delete", stale)).result);
    const deleted = await cli("delete");
    expect(deleted.exitCode).toBe(0);
    expect(await web().then((response) => response.json())).toEqual(deleted.result);
    expect(existsSync(path)).toBe(false);
    expect(await web({ ...body, mediaToken: "changed" }).then((response) => response.json())).toEqual((await cli("delete", { ...body, mediaToken: "changed" })).result);
  } finally { access.close(); }
});

it("shares idle cleanup outcomes through HTTP and CLI while preserving original coverage", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, path, seeded, inspect } = await seedRetainedDamagePreview(fixture);
  const before = await inspect();
  advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(before.updatedAt) + 31 * 24 * 60 * 60 * 1_000);
  const access = fixture.openAccess();
  try {
    const input = { mutationKey: "synthetic-web-cleanup", mediaToken: (await inspect()).media.token };
    const response = await createDamagePreviewMediaRemovalRoute(new Request(`http://localhost:3000/api/damage-previews/${id}/media`, { method: "POST", headers: { Origin: "http://localhost:3000", Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) }), id, () => access, () => "http://localhost:3000");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual((await fixture.run(["damage-preview", "cleanup", id, "--key", input.mutationKey, "--json", JSON.stringify({ mediaToken: input.mediaToken })])).result);
    expect(existsSync(path)).toBe(false);
    expect(await inspect()).toMatchObject({ provenance: before.provenance, artifacts: [{ coverage: before.artifacts[0]!.coverage }], media: { removal: { cause: "idle_cleanup" } } });
  } finally { access.close(); }
});
