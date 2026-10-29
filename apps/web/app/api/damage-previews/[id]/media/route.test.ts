import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedRetainedDamagePreview, settleDamagePreviewMedia } from "../../../../../../operator-cli/src/damage-preview.test-support.js";
import { advanceCommittedArchiveEvidence, withEvidenceGuardsDisabled } from "../../../../../../operator-cli/src/archive-evidence.test-support.js";
import { createDamagePreviewMediaRemovalRoute } from "./route";
import { createDamagePreviewRoute } from "../route";
import { createDamagePreviewMediaRoute } from "../../../damage-preview-media/[artifactIdentity]/route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); syncBuiltinESMExports(); fixtures.splice(0).forEach((fixture) => fixture.dispose()); });
it("shares deletion authorization, availability, stale evidence and replay with the public CLI", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, path, inspect } = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  const origin = "http://localhost:3000";
  const body = { mutationKey: "synthetic-web-deletion", mediaToken: (await inspect()).media.token };
  const web = (input = body, trusted = true, method = "DELETE") => createDamagePreviewMediaRemovalRoute(new Request(`${origin}/api/damage-previews/${id}/media`, { method, headers: { Origin: trusted ? origin : "http://untrusted.invalid", Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) }), id, () => access, () => origin);
  const cli = (action: string, input = body) => fixture.run(["damage-preview", action, id, "--key", input.mutationKey, "--json", JSON.stringify({ mediaToken: input.mediaToken })]);
  try {
    const cancelKey = "synthetic-web-cancel-before-delete";
    const cancelled = await fixture.run(["damage-preview", "cancel", id, "--key", cancelKey]);
    expect((await web(body, false)).status).toBe(403); expect(existsSync(path)).toBe(true);
    const unavailable = await web(body, true, "POST");
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual((await cli("cleanup")).result);
    const stale = { ...body, mediaToken: "stale-media-token" };
    expect(await web(stale).then((response) => response.json())).toEqual((await cli("delete", stale)).result);
    const deleted = await cli("delete");
    expect(deleted.exitCode).toBe(0);
    expect(await web().then((response) => response.json())).toEqual(deleted.result);
    expect(existsSync(path)).toBe(true);
    settleDamagePreviewMedia(fixture);
    expect(existsSync(path)).toBe(false);
    const replayedCancel = await createDamagePreviewRoute(new Request(`${origin}/api/damage-previews/${id}`, { method: "DELETE", headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ mutationKey: cancelKey }) }), id, () => access, () => origin);
    expect(replayedCancel.status).toBe(200);
    expect(await replayedCancel.json()).toEqual(cancelled.result);
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
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual((await fixture.run(["damage-preview", "cleanup", id, "--key", input.mutationKey, "--json", JSON.stringify({ mediaToken: input.mediaToken })])).result);
    expect(existsSync(path)).toBe(true);
    settleDamagePreviewMedia(fixture);
    expect(existsSync(path)).toBe(false);
    expect(await inspect()).toMatchObject({ provenance: before.provenance, artifacts: [{ coverage: before.artifacts[0]!.coverage }], media: { removal: { cause: "idle_cleanup" } } });
  } finally { access.close(); }
});

it("keeps retained clips downloadable after a partial cleanup failure and rejects a later pending deletion", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const { id, path, seeded, inspect } = await seedRetainedDamagePreview(fixture);
  const access = fixture.openAccess();
  const record = access.damagePreviews.find(id)!;
  const second = join(dirname(path), "1.mkv");
  const bytes = readFileSync(path); writeFileSync(second, bytes);
  record.artifacts.push({ ...record.artifacts[0]!, identity: `damage-preview-v1.${id}.1`, path: second });
  access.damagePreviews.update(record);
  withEvidenceGuardsDisabled(fixture.databasePath, (database) => database.prepare("UPDATE original_disc_archives SET catalog_review_outcome = 'archive_only', catalog_reviewed_at = updated_at WHERE id = ?").run(seeded.archive.id));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse((await inspect()).updatedAt) + 31 * 24 * 60 * 60 * 1_000);
  expect(await fixture.run(["damage-preview", "cleanup", id, "--key", "synthetic-http-partial-failure", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })])).toMatchObject({ exitCode: 0 });
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
    withEvidenceGuardsDisabled(fixture.databasePath, (database) => database.prepare("UPDATE original_disc_archives SET catalog_review_outcome = 'needs_review', catalog_reviewed_at = NULL WHERE id = ?").run(seeded.archive.id));
    throw new Error("Synthetic directory sync failure after review reopened");
  });
  syncBuiltinESMExports();
  try {
    settleDamagePreviewMedia(fixture);
    const retained = await inspect();
    expect(retained).toMatchObject({ media: { state: "removal_failed", removal: { state: "failed" }, cleanup: { available: false } }, artifacts: [{ media: { state: "removal_failed" } }, { media: { state: "retained" } }] });
    const identity = retained.artifacts[1]!.identity;
    const download = () => createDamagePreviewMediaRoute(new Request(`http://localhost:3000/api/damage-preview-media/${identity}`), identity, () => access);
    const response = await download();
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const destination = join(fixture.operatorHostPath, "retained-after-failed-cleanup.mkv");
    expect(await fixture.run(["damage-preview", "export", identity, "--destination", destination])).toMatchObject({ exitCode: 0 });
    expect(readFileSync(destination)).toEqual(bytes);
    expect((await inspect()).media.removal?.state).toBe("failed");
    expect(await fixture.run(["damage-preview", "delete", id, "--key", "synthetic-http-pending-after-failure", "--json", JSON.stringify({ mediaToken: (await inspect()).media.token })])).toMatchObject({ exitCode: 0 });
    expect(await download().then((pending) => pending.json())).toMatchObject({ error: { code: "DAMAGE_PREVIEW_MEDIA_REMOVING" } });
  } finally { access.close(); }
});
