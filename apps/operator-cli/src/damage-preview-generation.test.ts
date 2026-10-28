import { createArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { advanceCommittedArchiveEvidence } from "./archive-evidence.test-support.js";
import { DatabaseSync } from "node:sqlite";
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

it("admits an active Recovery preview durably and cancels its planned pause without a checkpoint", async () => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture);
  const sqlite = new DatabaseSync(fixture.databasePath);
  sqlite.prepare("UPDATE archive_recoveries SET status = 'eligible', stop_operation_id = NULL, stop_requested_at = NULL, stopped_at = NULL WHERE original_disc_archive_id = ?").run(seeded.archive.id);
  sqlite.close();
  const review = await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)]);
  expect(review).toMatchObject({ exitCode: 0, result: { available: true } });
  const preflight = review.result as { preflightToken: string };
  const request = await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-active-preview", "--json", JSON.stringify({ selection: seeded.input, preflightToken: preflight.preflightToken })]);
  expect(request).toMatchObject({ exitCode: 0, result: { status: "queued", recoveryPause: { state: "waiting", reason: { code: "DAMAGE_PREVIEW_PLANNED_RECOVERY_PAUSE" } } } });
  const id = (request.result as { id: string }).id;
  expect(await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-active-cancel"])).toMatchObject({ exitCode: 0, result: { status: "cancelled", recoveryPause: { state: "released" } } });
});

it.each([false, true])("waits through a live Recovery writer at request admission and rechecks the exact checkpoint, advanced: %s", async (advance) => {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture, "source_span", undefined, { stopRecovery: false });
  const review = await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)]);
  expect(review).toMatchObject({ exitCode: 0, result: { available: true } });
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const writer = ownership.withWriter({ archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, async task() { enter(); await released; if (advance) advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true }); } });
  try {
    await entered;
    let settled = false;
    const requested = fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-writer-wait", "--json", JSON.stringify({ selection: seeded.input, preflightToken: (review.result as { preflightToken: string }).preflightToken })]).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(settled).toBe(false);
    release(); await writer;
    expect(await requested).toMatchObject(advance ? { exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_STALE" } } } : { exitCode: 0, result: { status: "queued" } });
    const access = fixture.openAccess();
    try { expect(access.damagePreviews.list()).toHaveLength(advance ? 0 : 1); } finally { access.close(); }
  } finally { release?.(); await writer; }
}, 25_000);
