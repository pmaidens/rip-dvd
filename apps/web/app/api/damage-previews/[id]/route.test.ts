import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import { seedDamagePreview } from "../../../../../operator-cli/src/damage-preview.test-support.js";
import { advanceCommittedArchiveEvidence } from "../../../../../operator-cli/src/archive-evidence.test-support.js";
import { pollDamagePreviews } from "../../../../../encode-worker/src/damage-preview-worker.js";
import { bytes, media } from "../../../../../encode-worker/src/damage-preview.test-support.js";
import type { DamagePreviewGenerator } from "../../../../../encode-worker/src/damage-preview-generator.js";
import { ArchiveImageOwnershipError, createArchiveImageOwnership, acquireKernelProcessLock, type ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { createApplicationOperations, type DamagePreviewInspection, type DamagePreviewAvailability } from "@rip-dvd/application";
import { createDamagePreviewRoute } from "./route";
import { createDamagePreviewMediaRoute } from "../../damage-preview-media/[artifactIdentity]/route";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));
async function setup(activeRecovery = false) {
  const fixture = createOperatorWorkflowFixture(); fixtures.push(fixture);
  const seeded = await seedDamagePreview(fixture);
  if (activeRecovery) {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE archive_recoveries SET status = 'eligible', stop_operation_id = NULL, stop_requested_at = NULL, stopped_at = NULL WHERE original_disc_archive_id = ?").run(seeded.archive.id);
    database.close();
  }
  const review = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(seeded.input)])).result as DamagePreviewAvailability;
  const input = { preflightToken: review.preflightToken, selection: seeded.input };
  const request = async (key = "synthetic-request") => fixture.run(["damage-preview", "request", seeded.archive.id, "--key", key, "--json", JSON.stringify(input)]);
  const access = fixture.openAccess();
  return { fixture, seeded, review, input, request, access,
    async generate(generator = media()) {
      await pollDamagePreviews({ access, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, generator, ownership: createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath }) });
    },
  };
}
it("shares request, replay, changed-input conflict, wait and checkpoint-free cancellation with the public CLI", async () => {
  const { fixture, seeded, input, access, request } = await setup(true);
  try {
    const origin = "http://localhost:3000";
    const webRequest = (id: string, method: string, body?: unknown, query = "") => createDamagePreviewRoute(new Request(`${origin}/api/damage-previews/${id}${query}`, { method, ...(body ? { headers: { Origin: origin, Host: "localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }), id, () => access, () => origin);
    const cli = await request();
    const web = await webRequest(seeded.archive.id, "POST", { ...input, mutationKey: "synthetic-request" });
    expect(web.status).toBe(200); expect(await web.json()).toEqual(cli.result);
    const conflict = await webRequest(seeded.archive.id, "POST", { ...input, preflightToken: "changed", mutationKey: "synthetic-request" });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
    const id = (cli.result as DamagePreviewInspection).id;
    const waiting = await webRequest(id, "GET", undefined, "?timeoutMs=0");
    expect(await waiting.json()).toEqual((await fixture.run(["damage-preview", "wait", id, "--timeout-ms", "0"])).result);
    advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
    const cancelled = await webRequest(id, "DELETE", { mutationKey: "synthetic-cancel" });
    expect(await cancelled.json()).toEqual((await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-cancel"])).result);
    expect(await webRequest(seeded.archive.id, "POST", { ...input, mutationKey: "synthetic-stale" }).then((response) => response.json())).toMatchObject({ error: { code: "DAMAGE_PREVIEW_STALE", current: { current: { checkpoint: { manifestRevision: 2 } } } } });
    expect(access.damagePreviews.list()).toHaveLength(1);
  } finally { access.close(); }
});
it("generates every reviewed group, retains provenance, exports canonical bytes and reports outdated media without changing damage decisions", async () => {
  const { fixture, seeded, request, generate, access } = await setup();
  try {
    const id = ((await request()).result as DamagePreviewInspection).id;
    await generate();
    const completed = (await fixture.run(["damage-preview", "inspect", id])).result as DamagePreviewInspection;
    expect(completed).toMatchObject({ status: "complete", generationStatus: "complete", progress: { completedClips: 2, totalClips: 2 }, provenance: { checkpoint: { manifestRevision: 1 }, toolVersions: { handbrake: "synthetic-handbrake-v1" }, clips: [{ startMilliseconds: 0, endMilliseconds: 45_000 }, { startMilliseconds: 66_000, endMilliseconds: 405_000 }] } });
    expect(completed.provenance.commands).toHaveLength(2);
    expect(completed.provenance).toMatchObject({ streams: { audio: [128], subtitles: [] }, streamMapping: { policyVersion: "dvd-preview-stream-map-v1", audio: [{ sourceId: 128, physicalId: 128, trackNumber: 1 }], subtitles: [] } });
    expect(completed.provenance.commands[0]).toEqual(expect.arrayContaining(["--audio", "1", "--subtitle", "none"]));
    expect(completed.artifacts.map((artifact) => artifact.coverage)).toEqual([{ startMilliseconds: 0, endMilliseconds: 45_000 }, { startMilliseconds: 66_000, endMilliseconds: 405_000 }]);
    const identity = completed.artifacts[0]!.identity;
    const destination = join(fixture.operatorHostPath, "selected-preview.mkv");
    const exported = await fixture.run(["damage-preview", "export", identity, "--destination", destination]);
    expect(exported).toMatchObject({ exitCode: 0, result: { artifactIdentity: identity, mediaType: "video/x-matroska", sizeBytes: bytes.length, path: destination } });
    expect(readFileSync(destination)).toEqual(bytes);
    const prototypeProbe = await open(join(fixture.operatorHostPath, "write-probe"), "wx");
    const prototype = Object.getPrototypeOf(prototypeProbe);
    await prototypeProbe.close();
    const originalWrite = prototype.write;
    const shortWrite = vi.spyOn(prototype, "write").mockImplementation(async function(this: FileHandle, ...arguments_: unknown[]) {
      const buffer = arguments_[0];
      if (!Buffer.isBuffer(buffer)) throw new Error("Synthetic short-write fixture expects bytes.");
      return originalWrite.call(this, buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2))));
    });
    try {
      const shortDestination = join(fixture.operatorHostPath, "complete-buffer-export.mkv");
      expect(await fixture.run(["damage-preview", "export", identity, "--destination", shortDestination])).toMatchObject({ exitCode: 0 });
      expect(readFileSync(shortDestination)).toEqual(bytes);
    } finally { shortWrite.mockRestore(); }

    expect(exported.stdout).not.toContain(bytes.toString());
    expect(await fixture.run(["damage-preview", "export", identity, "--destination", destination])).toMatchObject({ exitCode: 1 });
    const response = await createDamagePreviewMediaRoute(new Request("http://localhost/api/damage-preview-media/test"), identity, () => access);
    expect(response.headers.get("Content-Type")).toBe("video/x-matroska");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
    expect((await fixture.run(["damage-preview", "inspect", id])).result).toMatchObject({ status: "outdated", generationStatus: "complete", provenance: { checkpoint: { manifestRevision: 1 } } });
    const outdatedDownload = await createDamagePreviewMediaRoute(new Request("http://localhost/api/damage-preview-media/test"), identity, () => access);
    expect(outdatedDownload.headers.get("X-Damage-Preview-Status")).toBe("outdated");
    expect(outdatedDownload.headers.get("X-Damage-Preview-Generation-Status")).toBe("complete");
    await outdatedDownload.arrayBuffer();
    expect((await request()).result).toMatchObject({ id, status: "queued" });
  } finally { access.close(); }
});
it("keeps actual partial coverage, failures and cancellation distinct, and never restarts abandoned work", async () => {
  for (const outcome of ["partial", "failed", "cancelled", "interrupted"] as const) {
    const { fixture, request, generate, access } = await setup(true);
    try {
      const id = ((await request()).result as DamagePreviewInspection).id;
      if (outcome === "interrupted") {
        const workerId = "11111111-2222-4333-8444-666666666666";
        const lock = acquireKernelProcessLock(join(fixture.mediaLibraryPath, ".damage-previews", ".workers", `${workerId}.lock`));
        lock.release();
        const record = access.damagePreviews.claim(workerId)!;
        expect(record.id).toBe(id);
        await generate();
        await generate();
      } else {
        await generate(media({
          ...(outcome === "failed" ? { scan: async () => { throw new Error("synthetic scan failure"); } } : {}),
          ...(outcome === "cancelled" ? { generate: async (request) => { await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-cancel-running"]); throw request.signal.reason ?? new Error("cancelled"); } } : {}),
          ...(outcome === "partial" ? { inspect: async () => ({ videoStartMilliseconds: 0, durationMilliseconds: 1_000, videoCount: 1, audioCount: 1, subtitleCount: 0 }) } : {}),
        }));
      }
      const inspected = (await fixture.run(["damage-preview", "inspect", id])).result as DamagePreviewInspection;
      expect(inspected.generationStatus).toBe(outcome);
      if (outcome === "partial") expect(inspected.artifacts[0]?.coverage).toEqual({ startMilliseconds: 0, endMilliseconds: 1_000 });
      expect(inspected.warning).toContain("never means no damage");
    } finally { access.close(); }
  }
});

it.skipIf(process.platform !== "linux")("lets a long preview continue without waiters, applies two minutes of contention grace, and proves quiescence before oldest-waiter admission", async () => {
  const { fixture, seeded, request, access } = await setup(true);
  const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let quiesce!: () => void;
  const quiescent = new Promise<void>((resolve) => { quiesce = resolve; });
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let clock = 1_000_000;
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  let generationSignal: AbortSignal | undefined;
  try {
    const id = ((await request()).result as DamagePreviewInspection).id;
    const generating = pollDamagePreviews({ access, mediaLibraryPath: fixture.mediaLibraryPath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, ownership, generator: media({
      async generate(input) {
        writeFileSync(input.outputPath, bytes); generationSignal = input.signal; enter();
        await new Promise<void>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      },
      whenInactive: (path) => path.endsWith("scan.mkv") ? Promise.resolve() : quiescent,
    }) });
    await entered;
    clock += 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(generationSignal!.aborted).toBe(false);
    const order: number[] = [];
    const base = { archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal };
    const first = ownership.withConsistentRead({ ...base, async task() { order.push(1); await firstDone; } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = ownership.withConsistentRead({ ...base, async task() { order.push(2); } });
    expect(generationSignal!.aborted).toBe(false);
    clock += 120_001;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(generationSignal!.aborted).toBe(true);
    expect(order).toEqual([]);
    quiesce();
    await generating;
    for (let attempt = 0; attempt < 50 && order.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([1]);
    releaseFirst(); await first; await second;
    expect(order).toEqual([1, 2]);
    expect((await fixture.run(["damage-preview", "inspect", id])).result).toMatchObject({ generationStatus: "partial", reason: { code: "DAMAGE_PREVIEW_CONTENTION" } });
  } finally { quiesce?.(); releaseFirst?.(); now.mockRestore(); access.close(); }
});
it("rejects unsupported streams and path substitution and marks older media outdated after reviewed stream or intended-profile changes", async () => {
  const { fixture, seeded, request, generate, access } = await setup();
  try {
    const id = ((await request()).result as DamagePreviewInspection).id;
    await generate();
    const assessmentBefore = access.dvdTitleDamageAssessments.inspect(seeded.archive.id).currentAssessmentIdentity;
    const changed = { ...seeded.input, streams: { audio: [], subtitles: [] } };
    const reviewed = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(changed)])).result as DamagePreviewAvailability;
    expect(await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-stream-change", "--json", JSON.stringify({ selection: changed, preflightToken: reviewed.preflightToken })])).toMatchObject({ exitCode: 0 });
    expect((await fixture.run(["damage-preview", "inspect", id])).result).toMatchObject({ status: "outdated", provenance: { streams: { audio: [128], subtitles: [] } } });
    const unsupported = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify({ ...seeded.input, streams: { audio: [2], subtitles: [] } })])).result as DamagePreviewAvailability;
    expect(unsupported.available).toBe(false);
    expect(unsupported.blockingReasons.map((reason) => reason.code)).toContain("DAMAGE_PREVIEW_STREAM_UNREPRESENTABLE");
    await generate(media({ scan: async () => ({ navigation: { videoTitleSetNumber: 2, titleSetTitleNumber: 1, programChainNumber: 1 }, selectedPath: [], durationMilliseconds: 500_000, chapterDurations: [125_000, 125_000, 125_000, 125_000], audio: [{ sourceId: 128, physicalId: 128, trackNumber: 1, codec: "ac3", channels: 2 }], subtitles: [], angleCount: 1 }) }));
    const failed = access.damagePreviews.list().at(-1)!;
    expect((await fixture.run(["damage-preview", "inspect", failed.id])).result).toMatchObject({ generationStatus: "failed", artifacts: [], reason: { code: "DAMAGE_PREVIEW_PATH_UNREPRESENTABLE" } });
    access.encodingProfiles.setActive({ id: seeded.profile.id, mediaDomain: "dvd_video", isActive: false });
    expect((await fixture.run(["damage-preview", "inspect", id])).result).toMatchObject({ status: "outdated", provenance: { encodingProfile: { isActive: true, version: 1 } } });
    expect(access.dvdTitleDamageAssessments.inspect(seeded.archive.id).currentAssessmentIdentity).toBe(assessmentBefore);
  } finally { access.close(); }
});

it("commits request admission only after final ownership validation and returns current identities for acquisition races", async () => {
  for (const kind of ["before-task", "before-commit"] as const) {
    const { fixture, seeded, input, access } = await setup();
    try {
      const base = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
      const ownership: ArchiveImageOwnership = { ...base, withConsistentRead(request) {
        return base.withConsistentRead({ ...request,
          async task(handle) {
            if (kind === "before-task") advanceCommittedArchiveEvidence(fixture, seeded.manifest, { publishFilesystemCheckpoint: true });
            return request.task(handle);
          },
          commit(prepared, handle) {
            if (kind === "before-commit") throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
            return request.commit ? request.commit(prepared, handle) : prepared;
          },
        });
      } };
      const operations = createApplicationOperations(access, { archiveImageOwnership: ownership });
      await expect(operations.requestDamagePreview(seeded.archive.id, { ...input, mutationKey: "synthetic-owned-race" })).rejects.toMatchObject({
        code: kind === "before-task" ? "DAMAGE_PREVIEW_STALE" : "DAMAGE_PREVIEW_UNAVAILABLE",
        current: { originalDiscArchiveId: seeded.archive.id, current: { checkpoint: { manifestRevision: kind === "before-task" ? 2 : 1 } } },
      });
      expect(access.damagePreviews.list()).toEqual([]);
      if (kind === "before-commit") expect(await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-owned-race", "--json", JSON.stringify(input)])).toMatchObject({ exitCode: 0, result: { status: "queued" } });
    } finally { access.close(); }
  }
});
it("releases source ownership before slow artifact validation and acknowledges cancellation as partial media", async () => {
  const { fixture, seeded, request, generate, access } = await setup();
  let entered!: () => void, finish!: () => void;
  const validating = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { finish = resolve; });
  try {
    const id = ((await request()).result as DamagePreviewInspection).id;
    const running = generate(media({ inspect: async (path) => { entered(); await released; return { videoStartMilliseconds: 0, durationMilliseconds: /\/0(?:\.partial)?\.mkv$/.test(path) ? 45_000 : 339_000, videoCount: 1, audioCount: 1, subtitleCount: 0 }; } }));
    await validating;
    const ownership = createArchiveImageOwnership({ authorityRootPath: fixture.originalsLibraryPath });
    await expect(ownership.withConsistentRead({ archiveId: seeded.archive.id, imagePath: seeded.archive.archivePath, originalsLibraryPath: fixture.originalsLibraryPath, signal: new AbortController().signal, async task() {} })).resolves.toBeUndefined();
    await fixture.run(["damage-preview", "cancel", id, "--key", "synthetic-postprocessing-cancel"]);
    finish(); await running;
    expect((await fixture.run(["damage-preview", "inspect", id])).result).toMatchObject({ generationStatus: "partial", cancellationRequested: true, artifacts: [{}, {}] });
  } finally { finish?.(); access.close(); }
});
it("reconciles a finalized MKV after worker death before artifact persistence without restarting source generation", async () => {
  const { fixture, request, generate, access } = await setup();
  try {
    const id = ((await request()).result as DamagePreviewInspection).id;
    const workerId = "11111111-2222-4333-8444-777777777777";
    const lock = acquireKernelProcessLock(join(fixture.mediaLibraryPath, ".damage-previews", ".workers", `${workerId}.lock`));
    const record = access.damagePreviews.claim(workerId)!;
    const directory = join(fixture.mediaLibraryPath, ".damage-previews", id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const command = ["synthetic-generator", "-o", join(directory, "0.partial.mkv")];
    record.streamMapping = { policyVersion: "dvd-preview-stream-map-v1", audio: [{ sourceId: 128, physicalId: 128, trackNumber: 1, codec: "ac3", channels: 2 }], subtitles: [] };
    record.commands = [command]; record.status = "generating"; access.damagePreviews.update(record);
    writeFileSync(join(directory, "0.mkv"), bytes);
    lock.release();
    await generate(); await generate();
    const inspected = (await fixture.run(["damage-preview", "inspect", id])).result as DamagePreviewInspection;
    expect(inspected).toMatchObject({ generationStatus: "partial", reason: { code: "DAMAGE_PREVIEW_WORKER_INTERRUPTED" }, provenance: { commands: [command] }, artifacts: [{ identity: `damage-preview-v1.${id}.0`, sizeBytes: bytes.length }] });
    const destination = join(fixture.operatorHostPath, "reconciled-preview.mkv");
    expect(await fixture.run(["damage-preview", "export", inspected.artifacts[0]!.identity, "--destination", destination])).toMatchObject({ exitCode: 0 });
    expect(readFileSync(destination)).toEqual(bytes);
  } finally { access.close(); }
});

it("maps logical DVD source IDs to track ordinals, retains subtitle variants and refuses a missing source mapping", async () => {
  for (const representable of [true, false]) {
    const { fixture, seeded, generate, access } = await setup();
    try {
      const sqlite = new DatabaseSync(fixture.databasePath);
      sqlite.prepare("UPDATE detected_discs SET scan_data = ? WHERE id = ?").run(JSON.stringify({ schemaVersion: 2, contentId: seeded.archive.fingerprint, titles: [{ number: 1, durationSeconds: 500, chapters: 4, audioStreams: [{ id: 128, format: "ac3" }, { id: 129, format: "ac3" }], subtitles: [{ id: 32, language: "fr" }] }] }), seeded.archive.detectedDiscId);
      sqlite.close();
      const selection = { ...seeded.input, streams: { audio: [129], subtitles: [32] } };
      const review = (await fixture.run(["damage-preview", "availability", seeded.archive.id, "--json", JSON.stringify(selection)])).result as DamagePreviewAvailability;
      expect(review.available).toBe(true);
      const requested = await fixture.run(["damage-preview", "request", seeded.archive.id, "--key", "synthetic-source-mapping", "--json", JSON.stringify({ selection, preflightToken: review.preflightToken })]);
      const id = (requested.result as DamagePreviewInspection).id;
      const audio = [
        { sourceId: 128, physicalId: 129, trackNumber: 1, codec: "ac3", channels: 2 },
        { sourceId: 129, physicalId: 128, trackNumber: 2, codec: "ac3", channels: 2 },
      ];
      const subtitles = [
        { sourceId: 32, physicalId: 34, trackNumber: 1, style: "Wide" },
        { sourceId: 32, physicalId: 35, trackNumber: 2, style: "Letterbox" },
      ];
      const base = media();
      const generation = vi.fn(base.generate);
      await generate(media({ scan: async () => ({ ...await base.scan({ source: "", titleNumber: 1, angleNumber: 1, chapterStart: 1, chapterEnd: 4, outputPath: "", descriptor: 0, signal: new AbortController().signal }), audio: representable ? audio : audio.slice(0, 1), subtitles }), generate: generation, inspect: async (path) => ({ ...await base.inspect(path), subtitleCount: 2 }) }));
      const inspected = (await fixture.run(["damage-preview", "inspect", id])).result as DamagePreviewInspection;
      if (representable) {
        expect(inspected).toMatchObject({ generationStatus: "complete", provenance: { streams: selection.streams, streamMapping: { audio: [audio[1]], subtitles } } });
        expect(inspected.provenance.commands[0]).toEqual(expect.arrayContaining(["--audio", "2", "--subtitle", "1,2"]));
      } else {
        expect(inspected).toMatchObject({ generationStatus: "failed", reason: { code: "DAMAGE_PREVIEW_STREAM_UNREPRESENTABLE" }, artifacts: [] });
        expect(generation).not.toHaveBeenCalled();
      }
    } finally { access.close(); }
  }
});
