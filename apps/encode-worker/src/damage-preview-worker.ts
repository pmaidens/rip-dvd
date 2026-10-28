import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { reviewDamagePreviewEvidence, type DamagePreviewAvailability, type DamagePreviewInput } from "@rip-dvd/application";
import { canonicalPublicationJson, type DataAccess, type DamagePreviewRecord, type OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { acquireKernelProcessLock, inspectKernelProcessLock, defaultArchiveImageOwnership, ArchiveImageOwnershipError, type ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { DamagePreviewUnrepresentableError, createDamagePreviewGenerator, type DamagePreviewGenerator, type PreviewSourceTitle } from "./damage-preview-generator.js";
import { DamagePreviewArtifactError, finalizePreviewArtifact, previewClipPaths } from "./damage-preview-artifact.js";

const CONTENTION_GRACE_MS = 120_000;
interface Options {
  access: DataAccess;
  originalsLibraryPath: string;
  mediaLibraryPath: string;
  signal: AbortSignal;
  generator?: DamagePreviewGenerator;
  ownership?: ArchiveImageOwnership;
}
class PreviewFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function failureReason(error: unknown) {
  return {
    code: error instanceof PreviewFailure || error instanceof DamagePreviewArtifactError || error instanceof ArchiveImageOwnershipError ? error.code : error instanceof DamagePreviewUnrepresentableError ? "DAMAGE_PREVIEW_UNREPRESENTABLE" : "DAMAGE_PREVIEW_GENERATION_FAILED",
    message: error instanceof PreviewFailure || error instanceof DamagePreviewArtifactError || error instanceof DamagePreviewUnrepresentableError ? error.message : "Preview generation did not complete. No conclusion about damage can be drawn.",
  };
}
async function quiesce(generator: DamagePreviewGenerator, path: string) {
  await generator.whenInactive(path);
  while (true) {
    try { generator.requireInactive(path); return; }
    catch { await delay(100); }
  }
}
function plan(record: DamagePreviewRecord) { return JSON.parse(record.reviewJson) as DamagePreviewAvailability; }
function sourceOffset(review: DamagePreviewAvailability, title: PreviewSourceTitle): number {
  const request = review.reviewedRequest!;
  const identity = request.title!;
  if (canonicalPublicationJson(title.navigation) !== canonicalPublicationJson(identity.navigation) || canonicalPublicationJson(title.selectedPath) !== canonicalPublicationJson(identity.selectedPath)) throw new PreviewFailure("DAMAGE_PREVIEW_PATH_UNREPRESENTABLE", "The source default title path differs from the reviewed Title Identity. No substitute path was generated.");
  if (!title.chapterDurations.every((duration) => Number.isFinite(duration) && duration > 0) || identity.chapterStart < 1 || identity.chapterEnd > title.chapterDurations.length || identity.angleNumber > title.angleCount || request.streams.audio.some((stream) => !title.audio.includes(stream)) || request.streams.subtitles.some((stream) => !title.subtitles.includes(stream + 1))) {
    throw new PreviewFailure("DAMAGE_PREVIEW_UNREPRESENTABLE", "The selected path, angle or streams cannot be represented by this source and HandBrake version.");
  }
  const duration = title.chapterDurations.slice(identity.chapterStart - 1, identity.chapterEnd).reduce((sum, value) => sum + value, 0);
  if (request.playbackRange.endMilliseconds > duration + 100) throw new PreviewFailure("DAMAGE_PREVIEW_RANGE_UNREPRESENTABLE", "The requested range exceeds the selected chapter path. Choose a shorter range explicitly.");
  return title.chapterDurations.slice(0, identity.chapterStart - 1).reduce((sum, value) => sum + value, 0);
}
async function retainGeneratedMedia(record: DamagePreviewRecord, directory: string, generator: DamagePreviewGenerator, access: DataAccess) {
  const review = plan(record);
  let incomplete = false;
  for (const [index, clip] of review.clips.entries()) {
    if (index >= record.commands.length || record.artifacts.some((artifact) => artifact.identity === `damage-preview-v1.${record.id}.${index}`)) continue;
    try {
      const result = await finalizePreviewArtifact({ id: record.id, index, directory, clip, streams: review.reviewedRequest!.streams, generator });
      if (!result) { incomplete = true; continue; }
      record.artifacts.push(result.artifact);
      record.progress.completedClips = record.artifacts.length;
      incomplete ||= !result.complete;
      if (!result.complete) record.reason ??= { code: "DAMAGE_PREVIEW_INCOMPLETE_COVERAGE", message: "The sample does not cover the complete requested video interval. Actual partial coverage is recorded." };
      access.damagePreviews.update(record);
    } catch (error) { incomplete = true; record.reason ??= failureReason(error); }
  }
  return !incomplete && record.artifacts.length === review.clips.length;
}
export async function pollDamagePreviews(options: Options): Promise<void> {
  const generator = options.generator ?? createDamagePreviewGenerator();
  const ownership = options.ownership ?? defaultArchiveImageOwnership;
  const root = await realpath(options.mediaLibraryPath);
  const mediaRoot = join(root, ".damage-previews");
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  if (await realpath(mediaRoot) !== mediaRoot) throw new Error("Unsafe preview media root.");
  const workersRoot = join(mediaRoot, ".workers");
  await mkdir(workersRoot, { recursive: true, mode: 0o700 });
  const workerLockPath = (id: string) => join(workersRoot, `${id}.lock`);
  for (const abandoned of options.access.damagePreviews.list()) {
    if (!["generating", "waiting_for_checkpoint_or_ownership"].includes(abandoned.status) || abandoned.workerId === null || !/^[a-f0-9-]{36}$/.test(abandoned.workerId) || inspectKernelProcessLock(workerLockPath(abandoned.workerId)) !== "inactive") continue;
    const directory = join(mediaRoot, abandoned.id);
    let reconciliation;
    try { reconciliation = acquireKernelProcessLock(join(directory, ".reconciliation.lock")); } catch { continue; }
    try {
      const record = options.access.damagePreviews.find(abandoned.id)!;
      if (!["generating", "waiting_for_checkpoint_or_ownership"].includes(record.status)) continue;
      const review = plan(record);
      if (!ownership.inspect({ archiveId: record.originalDiscArchiveId, imagePath: review.reviewedRequest!.archive.path, originalsLibraryPath: options.originalsLibraryPath }).stableRead.available) continue;
      for (let index = 0; index < review.clips.length; index++) {
        const paths = previewClipPaths(directory, index);
        generator.requireInactive(paths.partial); generator.requireInactive(paths.final);
      }
      generator.requireInactive(join(directory, "scan.mkv"));
      await retainGeneratedMedia(record, directory, generator, options.access);
      record.status = record.artifacts.length ? "partial" : record.cancellationRequested ? "cancelled" : "interrupted";
      record.reason = { code: "DAMAGE_PREVIEW_WORKER_INTERRUPTED", message: "The worker died. Retained finalized media is partial; generation will not restart automatically." };
      options.access.damagePreviews.update(record);
    } catch { /* Uncertain reader closure keeps the execution unresolved. */ }
    finally { reconciliation.release(); }
  }
  if (!options.access.damagePreviews.list().some((candidate) => candidate.status === "queued")) return;
  const workerId = randomUUID();
  const execution = acquireKernelProcessLock(workerLockPath(workerId));
  try {
    const record = options.access.damagePreviews.claim(workerId);
    if (!record) return;
    const review = plan(record);
    const directory = join(mediaRoot, record.id);
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let contentionStarted: number | null = null;
    const monitor = setInterval(() => {
      try { execution.assertHeld(); } catch { controller.abort(new PreviewFailure("DAMAGE_PREVIEW_EXECUTION_LOST", "Preview execution ownership could not be proved.")); }
      if (options.access.damagePreviews.find(record.id)?.cancellationRequested) controller.abort(new PreviewFailure("DAMAGE_PREVIEW_CANCELLED", "The operator cancelled this request."));
      const recovery = options.access.catalog.findArchiveRecovery(record.originalDiscArchiveId as OriginalDiscArchiveId);
      if (recovery && !["stopped", "completed"].includes(recovery.status)) controller.abort(new PreviewFailure("DAMAGE_PREVIEW_RECOVERY_CHANGED", "Archive Recovery changed. Stop takes priority over preview work."));
    }, 100);
    monitor.unref();
    const previewOwnership: ArchiveImageOwnership = {
      ...ownership,
      withConsistentRead(request) {
        return ownership.withConsistentRead({ ...request, signal, previewRead: { onContention(urgent, waiting) {
          if (!waiting) { contentionStarted = null; return; }
          contentionStarted ??= Date.now();
          if (urgent || Date.now() - contentionStarted >= CONTENTION_GRACE_MS) controller.abort(new PreviewFailure("DAMAGE_PREVIEW_CONTENTION", "Preview generation yielded to the oldest eligible archive waiter."));
        } } });
      },
    };
    let generationFailure: unknown;
    try {
      await mkdir(directory, { mode: 0o700, recursive: true });
      if (await realpath(directory) !== directory) throw new Error("Unsafe preview request directory.");
      while (true) {
        execution.assertHeld();
        try {
          const outcome = await options.access.withDvdCheckpoint(record.originalDiscArchiveId as OriginalDiscArchiveId, previewOwnership, async (checkpoint, handle) => {
            execution.assertHeld();
            const current = options.access.readConsistentSnapshot((snapshot) => reviewDamagePreviewEvidence(snapshot, record.originalDiscArchiveId, JSON.parse(record.selectionJson) as DamagePreviewInput, checkpoint));
            if (current.preflightToken !== record.preflightToken || !current.available) throw new PreviewFailure("DAMAGE_PREVIEW_STALE", "The reviewed preview inputs changed before generation.");
            const request = review.reviewedRequest!;
            handle.assertOwned();
            record.status = "generating"; record.reason = null;
            options.access.damagePreviews.update(record);
            record.toolVersions = await generator.versions();
            const scanPath = join(directory, "scan.mkv");
            const title = await generator.scan({ source: request.archive.path, titleNumber: request.title!.displayTitleNumber, angleNumber: request.title!.angleNumber, chapterStart: request.title!.chapterStart, chapterEnd: request.title!.chapterEnd, outputPath: scanPath, descriptor: handle.descriptor, signal: handle.signal }).finally(() => quiesce(generator, scanPath));
            const offset = sourceOffset(review, title);
            record.deviations = ["The sample uses explicit title-time boundaries instead of the complete playback selection."];
            for (const [index, clip] of review.clips.entries()) {
              handle.signal.throwIfAborted(); handle.assertOwned(); execution.assertHeld();
              const paths = previewClipPaths(directory, index);
              const arguments_ = ["--no-dvdnav", "--title", String(request.title!.displayTitleNumber), "--angle", String(request.title!.angleNumber), "-i", request.archive.path, "-o", paths.partial, "--format", "av_mkv", "--preset", String(request.encodingProfile!.settings.preset), "--audio", request.streams.audio.length ? request.streams.audio.join(",") : "none", "--subtitle", request.streams.subtitles.length ? request.streams.subtitles.map((id) => id + 1).join(",") : "none", "--subtitle-burned=none", "--start-at", `seconds:${(offset + clip.startMilliseconds) / 1_000}`, "--stop-at", `seconds:${(clip.endMilliseconds - clip.startMilliseconds) / 1_000}`];
              record.commands.push(["rip-dvd-handbrake", ...arguments_]);
              options.access.damagePreviews.update(record);
              try {
                await generator.generate({ arguments_, outputPath: paths.partial, sourceOwnershipDescriptor: handle.descriptor, signal: handle.signal, onOutput(text) {
                  const match = /Encoding:.*?([\d.]+) %/.exec(text);
                  if (match) { record.progress.percent = Number(match[1]); options.access.damagePreviews.update(record); }
                } });
              } finally { await quiesce(generator, paths.partial); }
            }
            return true;
          });
          if (!outcome) throw new PreviewFailure("DAMAGE_PREVIEW_CHECKPOINT_UNAVAILABLE", "The reviewed checkpoint is unavailable.");
          break;
        } catch (error) {
          if (!(error instanceof ArchiveImageOwnershipError) || error.code !== "WRITER_NOT_QUIESCENT" || record.commands.length > 0 || signal.aborted) throw error;
          record.reason = { code: "WRITER_NOT_QUIESCENT", message: "The preview is waiting for archive ownership and proven process closure." };
          options.access.damagePreviews.update(record);
          await delay(100, undefined, { signal });
        }
      }
    } catch (error) { generationFailure = controller.signal.reason ?? error; record.reason = failureReason(generationFailure); }
    try {
      // Source ownership has already closed. Validation, checksums and publication
      // operate only on generated media and cannot delay Recovery Stop or waiters.
      const complete = generationFailure instanceof ArchiveImageOwnershipError ? false : await retainGeneratedMedia(record, directory, generator, options.access);
      generationFailure ??= controller.signal.reason ?? (options.signal.aborted ? options.signal.reason : undefined);
      if (record.cancellationRequested || options.access.damagePreviews.find(record.id)?.cancellationRequested) generationFailure ??= new PreviewFailure("DAMAGE_PREVIEW_CANCELLED", "The operator cancelled this request.");
      if (!generationFailure && complete) { record.status = "complete"; record.progress.percent = 100; }
      else {
        record.status = record.artifacts.length ? "partial" : record.cancellationRequested || options.access.damagePreviews.find(record.id)?.cancellationRequested ? "cancelled" : options.signal.aborted ? "interrupted" : "failed";
        record.reason ??= failureReason(generationFailure);
      }
    } finally { clearInterval(monitor); }
    options.access.damagePreviews.update(record);
  } finally { execution.release(); }
}
export async function runDamagePreviewWorker(options: Options & { pollIntervalMs: number; log(message: string): void }) {
  while (!options.signal.aborted) {
    try { await pollDamagePreviews(options); } catch { options.log("Damage Preview worker could not complete its poll."); }
    try { await delay(options.pollIntervalMs, undefined, { signal: options.signal }); } catch { if (!options.signal.aborted) throw new Error("Preview worker wait failed."); }
  }
}
