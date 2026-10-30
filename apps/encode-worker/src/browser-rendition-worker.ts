import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserRenditionConfig } from "@rip-dvd/config";
import { DamagePreviewRejectedError, EncodeOutputExportRejectedError, exportEncodeOutput, exportDamagePreview, inspectDamagePreviewRenditionCondition, inspectDamagePreviewRenditionAvailability, inspectEncodeOutputRenditionAvailability, measureBrowserRenditionTimeline } from "@rip-dvd/application";
import { canonicalPublicationJson, encodeOutputFilesystemIdentity, type DataAccess } from "@rip-dvd/data-access";
import { acquireKernelProcessLock } from "@rip-dvd/worker-runtime";

import { createBrowserRenditionGenerator, browserRenditionCommand, type BrowserRenditionGenerator } from "./browser-rendition-generator.js";
export type { BrowserRenditionGenerator } from "./browser-rendition-generator.js";

const generator = createBrowserRenditionGenerator();
interface Options {
  access: DataAccess; mediaLibraryPath: string; signal: AbortSignal;
  generator?: BrowserRenditionGenerator; enabled?: boolean;
}
export async function pollBrowserRenditions(options: Options) {
  if (!(options.enabled ?? browserRenditionConfig().enabled)) return;
  const root = join(await realpath(options.mediaLibraryPath), ".browser-renditions");
  await mkdir(root, { mode: 0o700, recursive: true });
  if (await realpath(root) !== root) throw new Error("Unsafe Browser Viewing Rendition directory.");
  // The media process inherits this lock. A dead parent cannot cause another
  // worker to reconcile files while its surviving ffmpeg process writes them.
  let lock;
  try { lock = acquireKernelProcessLock(join(root, ".execution.lock")); } catch { return; }
  try {
    for (const abandoned of options.access.browserRenditions.active().filter((record) => record.status === "generating")) {
      abandoned.status = "interrupted";
      abandoned.reason = { code: "RENDITION_WORKER_INTERRUPTED", message: "Rendition generation was interrupted and will not restart automatically." };
      abandoned.media = null;
      await rm(join(root, abandoned.id), { recursive: true, force: true });
      options.access.browserRenditions.update(abandoned);
    }
    // Canonical deletion revokes derived playback immediately. Remove its
    // worker-owned bytes under the same execution lock before admitting work.
    for (const retained of options.access.browserRenditions.retainedPreviewMedia()) {
      const condition = inspectDamagePreviewRenditionCondition(options.access, retained.sourceIdentity);
      if (["removed", "missing"].includes(condition.canonicalMedia.state)) {
        await rm(join(root, retained.id), { recursive: true, force: true });
        // Commit durable absence before SQLite stops tracking these owned bytes.
        // If synchronization fails, leave the media record available for retry.
        const rootDirectory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await rootDirectory.sync(); } finally { await rootDirectory.close(); }
        retained.media = null;
        retained.reason = { code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", message: "Canonical sample media was removed or is missing. Derived media was removed; request history remains." };
        options.access.browserRenditions.update(retained);
      }
    }
    options.signal.throwIfAborted();
    const record = options.access.browserRenditions.claim();
    if (!record) return;
    const directory = join(root, record.id);
    const media = options.generator ?? generator;
    try {
      await mkdir(directory, { mode: 0o700 });
      if (await realpath(directory) !== directory) throw new Error("Unsafe Browser Viewing Rendition request directory.");
      const selection = record.conversion.burnedSubtitle ? { burnSubtitleIndex: record.conversion.burnedSubtitle.sourceIndex } : {};
      const review = record.sourceKind === "damage_preview"
        ? await inspectDamagePreviewRenditionAvailability(options.access, record.sourceIdentity, media.probe, true, selection)
        : await inspectEncodeOutputRenditionAvailability(options.access, record.sourceIdentity, media.probe, true, selection);
      const authorityRevision = "sourceRevision" in review.current ? review.current.sourceRevision : review.current.authorityRevision;
      if (!review.available || authorityRevision !== record.sourceAuthorityRevision ||
          canonicalPublicationJson(review.source) !== record.sourceJson ||
          (record.conversion.streams && canonicalPublicationJson(review.conversion) !== canonicalPublicationJson(record.conversion))) throw new Error("RENDITION_SOURCE_CHANGED");
      const source = join(directory, "source.mkv"), partial = join(directory, "partial.mp4"), final = join(directory, "view.mp4");
      try {
        if (record.sourceKind === "damage_preview") await exportDamagePreview(options.access, record.sourceIdentity, source);
        else if ("authorityRevision" in review.current) await exportEncodeOutput(options.access, { artifactIdentity: record.sourceIdentity, destination: source, expectedEvidence: review.current });
      } catch (error) {
        if (record.sourceKind === "damage_preview" && (error instanceof DamagePreviewRejectedError ||
            (typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP", "ESTALE"].includes(String(error.code))))) throw new Error("RENDITION_SOURCE_CHANGED");
        if (error instanceof EncodeOutputExportRejectedError && error.reasonCode.startsWith("OUTPUT_")) throw new Error("RENDITION_SOURCE_CHANGED");
        throw error;
      }
      const snapshot = await media.probe(source);
      if (canonicalPublicationJson(snapshot) !== canonicalPublicationJson({ durationSeconds: review.source.media.durationSeconds, streams: review.source.media.streams })) throw new Error("RENDITION_SOURCE_CHANGED");
      const copiedStreamIndexes = record.conversion.copiedStreamIndexes;
      if (copiedStreamIndexes === null) throw new Error("RENDITION_SOURCE_CHANGED");
      record.toolVersion = await media.version();
      record.command = ["ffmpeg", ...browserRenditionCommand(record.sourceKind === "damage_preview" ? "<canonical-preview-snapshot>" : "<canonical-output-snapshot>", "<browser-rendition>", record.conversion)];
      options.access.browserRenditions.update(record);
      lock.assertHeld();
      await media.generate({ source, destination: partial, conversion: record.conversion, executionDescriptor: lock.descriptor,
        signal: options.signal, durationSeconds: snapshot.durationSeconds!, onProgress(percent) {
          record.progress.percent = percent; options.access.browserRenditions.update(record);
        } });
      options.signal.throwIfAborted(); lock.assertHeld();
      const inspected = await media.probe(partial);
      record.mediaProbeJson = canonicalPublicationJson(inspected);
      // MP4 muxing can shift duration through AAC padding and timestamp rounding.
      // This tolerance concerns container timing only, never source watchability.
      record.durationCoverage = { sourceSeconds: snapshot.durationSeconds!, renditionSeconds: inspected.durationSeconds, toleranceSeconds: 0.25 };
      if (inspected.durationSeconds === null || Math.abs(inspected.durationSeconds - snapshot.durationSeconds!) > record.durationCoverage.toleranceSeconds) throw new Error("RENDITION_INCOMPLETE_COVERAGE");
      const expected = record.conversion.streams ?? snapshot.streams.filter((stream) => copiedStreamIndexes.includes(stream.index)).map((stream) => ({ kind: stream.kind, codec: stream.codecName, mode: "copy" }));
      if (inspected.durationSeconds <= 0 || inspected.streams.length !== expected.length || inspected.streams.some((stream, index) => {
        const target = expected[index]!;
        return stream.kind !== target.kind || stream.codecName !== target.codec ||
          (target.kind === "video" && target.mode === "transcode" && (stream.pixelFormat !== "yuv420p" || stream.profile !== "High" || stream.level !== 41)) ||
          (target.kind === "audio" && target.mode === "transcode" && stream.profile !== "LC");
      })) throw new Error("RENDITION_CONVERSION_FAILED");
      // Video conversion may change decoded frames. Preserve ordinary playback
      // when a bounded exact clock proof cannot be established.
      record.timeline = record.conversion.streams?.find((stream) => stream.kind === "video")?.mode === "transcode"
        ? { policyVersion: "browser-rendition-exact-video-v1", status: "unknown", reasonCode: "RENDITION_TIMELINE_UNVERIFIED" }
        : await (media.measureTimeline ?? measureBrowserRenditionTimeline)(source, partial, options.signal);
      const file = await open(partial, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile() || (await file.stat()).size === 0) throw new Error("RENDITION_CONVERSION_FAILED");
        await file.sync();
      } finally { await file.close(); }
      if (record.sourceKind === "damage_preview" && inspectDamagePreviewRenditionCondition(options.access, record.sourceIdentity).canonicalMedia.reasonCode) throw new Error("RENDITION_SOURCE_CHANGED");
      await rename(partial, final);
      const directoryFile = await open(directory, constants.O_RDONLY);
      try { await directoryFile.sync(); } finally { await directoryFile.close(); }
      const finalFile = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await finalFile.stat();
        record.media = { identity: `browser-rendition-v1.${record.id}`, path: final, filesystemIdentity: encodeOutputFilesystemIdentity(metadata), changeTimeMs: metadata.ctimeMs, sizeBytes: metadata.size };
      } finally { await finalFile.close(); }
      await rm(source, { force: true });
      record.status = "complete"; record.progress.percent = 100;
    } catch (error) {
      record.status = options.signal.aborted ? "interrupted" : "failed";
      const changed = error instanceof Error && error.message === "RENDITION_SOURCE_CHANGED";
      const incomplete = error instanceof Error && error.message === "RENDITION_INCOMPLETE_COVERAGE";
      record.reason = { code: changed ? "RENDITION_SOURCE_CHANGED" : incomplete ? "RENDITION_INCOMPLETE_COVERAGE" : options.signal.aborted ? "RENDITION_INTERRUPTED" : record.conversion.kind === "stream_copy_remux" ? "RENDITION_REMUX_FAILED" : "RENDITION_CONVERSION_FAILED", message: changed ? "The canonical media changed after the rendition request. Review its current identity and make a new request." : "Rendition generation did not complete. No playback or validation conclusion was recorded." };
      record.media = null;
    }
    if (record.status !== "complete") await rm(directory, { recursive: true, force: true });
    options.access.browserRenditions.update(record);
  } finally { lock.release(); }
}
export async function runBrowserRenditionWorker(options: Options & { pollIntervalMs: number; log(message: string): void }) {
  while (!options.signal.aborted) {
    try { await pollBrowserRenditions(options); } catch { options.log("Browser Viewing Rendition worker could not complete its poll."); }
    try { await delay(options.pollIntervalMs, undefined, { signal: options.signal }); } catch { if (!options.signal.aborted) throw new Error("Rendition worker wait failed."); }
  }
}
