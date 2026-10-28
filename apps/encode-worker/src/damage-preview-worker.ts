import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { reviewDamagePreviewEvidence, type DamagePreviewAvailability, type DamagePreviewInput } from "@rip-dvd/application";
import { canonicalPublicationJson, type DataAccess, type DamagePreviewRecord, type OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { archiveProcessIdentity, defaultArchiveImageOwnership, ArchiveImageOwnershipError, type ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { DamagePreviewUnrepresentableError, createDamagePreviewGenerator, type DamagePreviewGenerator, type PreviewSourceTitle } from "./damage-preview-generator.js";

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
async function quiesce(generator: DamagePreviewGenerator, path: string) {
  await generator.whenInactive(path);
  while (true) {
    try { generator.requireInactive(path); return; }
    catch { await delay(100); }
  }
}
function workerIdentity() { return `damage-preview:${process.pid}:${archiveProcessIdentity(process.pid)}`; }
function workerIsAlive(identity: string | null) {
  const match = /^damage-preview:(\d+):(.+)$/.exec(identity ?? "");
  return match !== null && archiveProcessIdentity(Number(match[1])) === match[2];
}
function plan(record: DamagePreviewRecord) { return JSON.parse(record.reviewJson) as DamagePreviewAvailability; }
function sourceOffset(review: DamagePreviewAvailability, title: PreviewSourceTitle): number {
  const request = review.reviewedRequest!;
  const identity = request.title!;
  if (canonicalPublicationJson(title.navigation) !== canonicalPublicationJson(identity.navigation) || canonicalPublicationJson(title.selectedPath) !== canonicalPublicationJson(identity.selectedPath)) throw new PreviewFailure("DAMAGE_PREVIEW_PATH_UNREPRESENTABLE", "The source default title path differs from the reviewed Title Identity. No substitute path was generated.");
  if (!title.chapterDurations.every((duration) => Number.isFinite(duration) && duration > 0) || identity.chapterStart < 1 || identity.chapterEnd > title.chapterDurations.length || identity.angleNumber > title.angleCount ||
    request.streams.audio.some((stream) => !title.audio.includes(stream)) || request.streams.subtitles.some((stream) => !title.subtitles.includes(stream + 1))) {
    throw new PreviewFailure("DAMAGE_PREVIEW_UNREPRESENTABLE", "The selected path, angle or streams cannot be represented by this source and HandBrake version.");
  }
  const duration = title.chapterDurations.slice(identity.chapterStart - 1, identity.chapterEnd).reduce((sum, value) => sum + value, 0);
  if (request.playbackRange.endMilliseconds > duration + 100) throw new PreviewFailure("DAMAGE_PREVIEW_RANGE_UNREPRESENTABLE", "The requested range exceeds the selected chapter path. Choose a shorter range explicitly.");
  return title.chapterDurations.slice(0, identity.chapterStart - 1).reduce((sum, value) => sum + value, 0);
}
export async function pollDamagePreviews(options: Options): Promise<void> {
  const generator = options.generator ?? createDamagePreviewGenerator();
  const ownership = options.ownership ?? defaultArchiveImageOwnership;
  const root = await realpath(options.mediaLibraryPath);
  const mediaRoot = join(root, ".damage-previews");
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  if (await realpath(mediaRoot) !== mediaRoot) throw new Error("Unsafe preview media root.");
  const workerId = workerIdentity();
  // An abandoned execution is terminal. Never turn it back into queued work.
  for (const record of options.access.damagePreviews.list()) {
    if (!["generating", "waiting_for_checkpoint_or_ownership"].includes(record.status) || workerIsAlive(record.workerId)) continue;
    const review = plan(record);
    const image = review.reviewedRequest!.archive.path;
    const inspection = ownership.inspect({ archiveId: record.originalDiscArchiveId, imagePath: image, originalsLibraryPath: options.originalsLibraryPath });
    if (!inspection.stableRead.available) continue;
    try {
      for (let index = 0; index < review.clips.length; index++) generator.requireInactive(join(mediaRoot, record.id, `${index}.partial.mkv`));
      generator.requireInactive(join(mediaRoot, record.id, "scan.mkv"));
      record.status = record.artifacts.length ? "partial" : record.cancellationRequested ? "cancelled" : "interrupted";
      record.reason = { code: "DAMAGE_PREVIEW_WORKER_INTERRUPTED", message: "The worker died. This request will not restart automatically." };
      options.access.damagePreviews.update(record);
    } catch { /* A surviving process retains ownership until it is quiescent. */ }
  }
  const record = options.access.damagePreviews.list().find((item) => item.workerId === workerId && item.status === "waiting_for_checkpoint_or_ownership") ?? options.access.damagePreviews.claim(workerId);
  if (!record) return;
  const review = plan(record);
  const directory = join(mediaRoot, record.id);

  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let contentionStarted: number | null = null;
  const monitor = setInterval(() => {
    if (options.access.damagePreviews.find(record.id)?.cancellationRequested) controller.abort(new PreviewFailure("DAMAGE_PREVIEW_CANCELLED", "The operator cancelled this request."));
    const recovery = options.access.catalog.findArchiveRecovery(record.originalDiscArchiveId as OriginalDiscArchiveId);
    if (recovery && !["stopped", "completed"].includes(recovery.status)) controller.abort(new PreviewFailure("DAMAGE_PREVIEW_RECOVERY_CHANGED", "Archive Recovery changed. Stop takes priority over preview work."));
  }, 100);
  monitor.unref();
  const previewOwnership: ArchiveImageOwnership = {
    ...ownership,
    withConsistentRead(request) {
      return ownership.withConsistentRead({ ...request, signal,
        previewRead: { onContention(urgent, waiting) {
          if (!waiting) { contentionStarted = null; return; }
          contentionStarted ??= Date.now();
          if (urgent || Date.now() - contentionStarted >= CONTENTION_GRACE_MS) controller.abort(new PreviewFailure("DAMAGE_PREVIEW_CONTENTION", "Preview generation yielded to the oldest eligible archive waiter."));
        } },
      });
    },
  };
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (await realpath(directory) !== directory) throw new Error("Unsafe preview request directory.");
    const outcome = await options.access.withDvdCheckpoint(record.originalDiscArchiveId as OriginalDiscArchiveId, previewOwnership, async (checkpoint, handle) => {
      const current = options.access.readConsistentSnapshot((snapshot) => reviewDamagePreviewEvidence(snapshot, record.originalDiscArchiveId, JSON.parse(record.selectionJson) as DamagePreviewInput, checkpoint));
      if (current.preflightToken !== record.preflightToken || !current.available) throw new PreviewFailure("DAMAGE_PREVIEW_STALE", "The reviewed preview inputs changed before generation.");
      const request = review.reviewedRequest!;
      handle.assertOwned();
      record.toolVersions = await generator.versions();
      const scanPath = join(directory, "scan.mkv");
      const title = await generator.scan({ source: request.archive.path, titleNumber: request.title!.displayTitleNumber, angleNumber: request.title!.angleNumber, chapterStart: request.title!.chapterStart, chapterEnd: request.title!.chapterEnd, outputPath: scanPath, descriptor: handle.descriptor, signal: handle.signal }).finally(() => quiesce(generator, scanPath));
      const offset = sourceOffset(review, title);
      record.deviations = ["The sample uses explicit title-time boundaries instead of the complete playback selection."];
      record.status = "generating";
      options.access.damagePreviews.update(record);
      for (const [index, clip] of review.clips.entries()) {
        handle.signal.throwIfAborted();
        handle.assertOwned();
        const partial = join(directory, `${index}.partial.mkv`);
        const final = join(directory, `${index}.mkv`);
        const arguments_ = ["--no-dvdnav", "--title", String(request.title!.displayTitleNumber), "--angle", String(request.title!.angleNumber), "-i", request.archive.path, "-o", partial, "--format", "av_mkv", "--preset", String(request.encodingProfile!.settings.preset), "--audio", request.streams.audio.length ? request.streams.audio.join(",") : "none", "--subtitle", request.streams.subtitles.length ? request.streams.subtitles.map((id) => id + 1).join(",") : "none", "--subtitle-burned=none", "--start-at", `seconds:${(offset + clip.startMilliseconds) / 1_000}`, "--stop-at", `seconds:${(clip.endMilliseconds - clip.startMilliseconds) / 1_000}`];
        record.commands.push(["rip-dvd-handbrake", ...arguments_]);
        options.access.damagePreviews.update(record);
        let generationError: unknown;
        try {
          await generator.generate({ arguments_, outputPath: partial, sourceOwnershipDescriptor: handle.descriptor, signal: handle.signal, onOutput(text) {
            const match = /Encoding:.*?([\d.]+) %/.exec(text);
            if (match) { record.progress.percent = Number(match[1]); options.access.damagePreviews.update(record); }
          } });
        } catch (error) { generationError = error; }
        // Keep this proof inside the ownership callback. Throwing before process
        // closure would let the worker drop its descriptor prematurely.
        await quiesce(generator, partial);
        try {
          const media = await generator.inspect(partial);
          if (media.videoCount !== 1 || media.audioCount !== request.streams.audio.length || media.subtitleCount !== request.streams.subtitles.length) throw new PreviewFailure("DAMAGE_PREVIEW_STREAM_UNREPRESENTABLE", "The sample did not retain the requested streams.");
          const output = await open(partial, constants.O_RDWR | constants.O_NOFOLLOW);
          let sizeBytes: number;
          const hash = createHash("sha256");
          try {
            const stat = await output.stat();
            if (!stat.isFile() || stat.size === 0) throw new Error("Empty sample.");
            sizeBytes = stat.size;
            for await (const chunk of output.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
            await output.sync();
          } finally { await output.close(); }
          await rename(partial, final);
          const directoryHandle = await open(directory, constants.O_RDONLY);
          try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
          const duration = Math.min(media.durationMilliseconds, clip.endMilliseconds - clip.startMilliseconds);
          record.artifacts.push({ identity: `damage-preview-v1.${record.id}.${index}`, path: final, sizeBytes, sha256: hash.digest("hex"), mediaType: "video/x-matroska", coverageMethod: "handbrake_seek_and_probed_duration", durationMilliseconds: media.durationMilliseconds, coverage: { startMilliseconds: clip.startMilliseconds, endMilliseconds: clip.startMilliseconds + duration } });
          record.progress.completedClips = record.artifacts.length;
          options.access.damagePreviews.update(record);
          if (media.durationMilliseconds + 100 < clip.endMilliseconds - clip.startMilliseconds) generationError ??= new PreviewFailure("DAMAGE_PREVIEW_INCOMPLETE_COVERAGE", "The sample ended before the requested interval. Actual partial coverage is recorded.");
        } catch (error) { generationError ??= error; }
        if (generationError) throw generationError;
      }
      return true;
    });
    if (!outcome) throw new PreviewFailure("DAMAGE_PREVIEW_CHECKPOINT_UNAVAILABLE", "The reviewed checkpoint is unavailable.");
    record.status = "complete";
    record.progress.percent = 100;
  } catch (error) {
    const reason = controller.signal.reason ?? error;
    record.status = reason instanceof ArchiveImageOwnershipError && reason.code === "WRITER_NOT_QUIESCENT" && record.commands.length === 0 ? "waiting_for_checkpoint_or_ownership" : record.artifacts.length > 0 ? "partial" : record.cancellationRequested || options.access.damagePreviews.find(record.id)?.cancellationRequested ? "cancelled" : options.signal.aborted ? "interrupted" : "failed";
    record.reason = { code: reason instanceof PreviewFailure || reason instanceof ArchiveImageOwnershipError ? reason.code : reason instanceof DamagePreviewUnrepresentableError ? "DAMAGE_PREVIEW_UNREPRESENTABLE" : "DAMAGE_PREVIEW_GENERATION_FAILED", message: reason instanceof PreviewFailure || reason instanceof DamagePreviewUnrepresentableError ? reason.message : "Preview generation did not complete. No conclusion about damage can be drawn." };
  } finally { clearInterval(monitor); }
  options.access.damagePreviews.update(record);
}
export async function runDamagePreviewWorker(options: Options & { pollIntervalMs: number; log(message: string): void }) {
  while (!options.signal.aborted) {
    try { await pollDamagePreviews(options); } catch { options.log("Damage Preview worker could not complete its poll."); }
    try { await delay(options.pollIntervalMs, undefined, { signal: options.signal }); } catch { if (!options.signal.aborted) throw new Error("Preview worker wait failed."); }
  }
}
