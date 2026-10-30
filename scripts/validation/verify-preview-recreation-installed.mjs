import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** The caller supplies an already isolated, worker-deleted synthetic fixture. */
export async function verifyInstalledRecreation(fixture, run) {
  const command = (args, status = 0) => run(["damage-preview", ...args], status);
  const removed = await command(["inspect", fixture.id]);
  assert.equal(removed.media.state, "removed");
  assert.equal(removed.media.removal.state, "complete");
  assert.deepEqual(removed.provenance, fixture.original.provenance);
  assert.equal(removed.generationStatus, fixture.original.generationStatus);
  assert.deepEqual(removed.reason, fixture.original.reason);
  const review = await command(["recreate", fixture.id]);
  assert.equal(review.exact.available, true); assert.deepEqual(review.differences, []);
  const exact = { mode: "exact", recreationToken: review.recreationToken, preflightToken: review.preflight.preflightToken };
  const exactArgs = ["recreate", fixture.id, "--key", "synthetic-installed-exact-recreation", "--json", JSON.stringify(exact)];
  const accepted = await command(exactArgs);
  assert.notEqual(accepted.id, fixture.id);
  assert.equal(accepted.recreation.sourceRequestId, fixture.id); assert.equal(accepted.recreation.mode, "exact");
  assert.equal(accepted.generationStatus, "queued");
  assert.deepEqual(await command(exactArgs), accepted);
  const conflict = await command([...exactArgs.slice(0, -1), JSON.stringify({ ...exact, preflightToken: "changed" })], 2);
  assert.equal(conflict.error.code, "MUTATION_KEY_CONFLICT");
  await command(["cancel", accepted.id, "--key", "synthetic-installed-exact-cancel"]);
  assert.equal((await command(["inspect", accepted.id])).generationStatus, "cancelled");

  const selection = { ...fixture.selection, streams: { audio: [], subtitles: [] } };
  const current = await command(["recreate", fixture.id, "--json", JSON.stringify({ selection })]);
  assert.equal(current.exact.available, false); assert.equal(current.preflight.available, true);
  assert.ok(current.differences.some((difference) => difference.field === "streams"));
  const input = { mode: "current_revision", selection, recreationToken: current.recreationToken, preflightToken: current.preflight.preflightToken };
  const stale = await command(["recreate", fixture.id, "--key", "synthetic-installed-stale-recreation", "--json", JSON.stringify({ ...input, recreationToken: review.recreationToken })], 2);
  assert.equal(stale.error.code, "DAMAGE_PREVIEW_RECREATION_STALE");
  const currentArgs = ["recreate", fixture.id, "--key", "synthetic-installed-current-recreation", "--json", JSON.stringify(input)];
  const deliberate = await command(currentArgs);
  assert.equal(deliberate.recreation.sourceRequestId, fixture.id); assert.equal(deliberate.recreation.mode, "current_revision");
  assert.ok(deliberate.recreation.differences.some((difference) => difference.field === "streams"));
  assert.deepEqual(await command(currentArgs), deliberate);
  await command(["cancel", deliberate.id, "--key", "synthetic-installed-current-cancel"]);
  assert.equal((await command(["inspect", deliberate.id])).generationStatus, "cancelled");
  const history = await command(["inspect", fixture.id]);
  assert.deepEqual(history.provenance, removed.provenance); assert.equal(history.generationStatus, removed.generationStatus);
  assert.deepEqual(history.reason, removed.reason); assert.deepEqual(history.media.removal, removed.media.removal);
  assert.deepEqual(history.media.history, removed.media.history);
  // This scenario proves installed admission/history. Real generation belongs to the native roundtrip.
  return { schemaVersion: 1, exactAdmission: true, currentRevisionAdmission: true, replay: true, conflict: true, staleRejected: true, workerDeletedHistoryPreserved: true, generationExecuted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [executable, fixturePath] = process.argv.slice(2);
  if (!executable || !fixturePath || !isAbsolute(executable) || !isAbsolute(fixturePath)) throw new Error("Supply absolute installed CLI and isolated fixture descriptor paths.");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const run = (args, expectedStatus) => {
    const outcome = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.status, expectedStatus, `Installed command failed: ${args[1] ?? args[0]}`);
    return JSON.parse(outcome.stdout);
  };
  process.stdout.write(`${JSON.stringify(await verifyInstalledRecreation(fixture, run))}\n`);
}
