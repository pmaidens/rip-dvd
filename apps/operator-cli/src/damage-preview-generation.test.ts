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
  expect(request).toMatchObject({ exitCode: 0, result: { status: "waiting_for_checkpoint_or_ownership", checkpointVerified: false, recoveryPause: { state: "waiting", reason: { code: "DAMAGE_PREVIEW_PLANNED_RECOVERY_PAUSE" } } } });
  const id = (request.result as { id: string }).id;
  expect(await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-active-cancel"])).toMatchObject({ exitCode: 0, result: { status: "cancelled", recoveryPause: { state: "released" } } });
});

it.each([false, true])("retains inspectable and cancellable active preview waiting across CLI restart beyond a live writer timeout, advanced: %s", async (advance) => {
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
    const args = ["damage-preview", "request", seeded.archive.id, "--key", "synthetic-writer-wait", "--json", JSON.stringify({ selection: seeded.input, preflightToken: (review.result as { preflightToken: string }).preflightToken })];
    const requested = await fixture.run(args);
    expect(requested).toMatchObject({ exitCode: 0, result: { status: "waiting_for_checkpoint_or_ownership", checkpointVerified: false, recoveryPause: { state: "waiting" } } });
    const id = (requested.result as { id: string }).id;
    // Each public runner invocation opens a fresh persistence/application session.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(await fixture.run(["damage-preview", "inspect", id])).toMatchObject({ exitCode: 0, result: { generationStatus: "waiting_for_checkpoint_or_ownership", checkpointVerified: false } });
    expect(await fixture.run(["damage-preview", "wait", id, "--timeout-ms", "0"])).toMatchObject({ exitCode: 0, result: { wait: { terminal: false, timedOut: true } } });
    const cancel = () => fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-writer-cancel"]);
    if (!advance) expect(await cancel()).toMatchObject({ exitCode: 0, result: { generationStatus: "cancelled", artifacts: [] } });
    release(); await writer;
    expect(await fixture.run(args)).toEqual(requested);
    if (advance) expect(await cancel()).toMatchObject({ exitCode: 0, result: { generationStatus: "cancelled", artifacts: [] } });
    if (advance) expect(await fixture.run([...args.slice(0, 4), "synthetic-stale-after-wait", ...args.slice(5)])).toMatchObject({ exitCode: 2, result: { error: { code: "DAMAGE_PREVIEW_STALE" } } });
    const access = fixture.openAccess();
    try { expect(access.damagePreviews.list()).toHaveLength(1); } finally { access.close(); }
  } finally { release?.(); await writer; }
}, 25_000);
