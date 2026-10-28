import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { join } from "node:path";
import type { DamagePreviewArtifact, DamagePreviewStreamMapping } from "@rip-dvd/data-access";
import type { DamagePreviewGenerator } from "./damage-preview-generator.js";

export class DamagePreviewArtifactError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function previewClipPaths(directory: string, index: number) {
  return { partial: join(directory, `${index}.partial.mkv`), final: join(directory, `${index}.mkv`) };
}
async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
// This operation reads only generated media. It never holds archive ownership.
// A final file without a database artifact can be reconciled after worker death.
export async function finalizePreviewArtifact(input: {
  id: string;
  index: number;
  directory: string;
  clip: { startMilliseconds: number; endMilliseconds: number };
  streams: DamagePreviewStreamMapping;
  generator: DamagePreviewGenerator;
}): Promise<{ artifact: DamagePreviewArtifact; complete: boolean } | null> {
  const paths = previewClipPaths(input.directory, input.index);
  const source = await exists(paths.final) ? paths.final : await exists(paths.partial) ? paths.partial : null;
  if (!source) return null;
  input.generator.requireInactive(source);
  const media = await input.generator.inspect(source);
  const clip = input.clip;
  if (!Number.isFinite(media.videoStartMilliseconds) || media.videoStartMilliseconds < 0 || media.videoStartMilliseconds >= clip.endMilliseconds - clip.startMilliseconds) {
    throw new DamagePreviewArtifactError("DAMAGE_PREVIEW_TIMING_UNREPRESENTABLE", "The sample has no proven video coverage inside the requested interval.");
  }
  if (media.videoCount !== 1 || media.audioCount !== input.streams.audio.length || media.subtitleCount !== input.streams.subtitles.length) {
    throw new DamagePreviewArtifactError("DAMAGE_PREVIEW_STREAM_UNREPRESENTABLE", "The sample did not retain the requested streams.");
  }
  const output = await open(source, constants.O_RDWR | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let sizeBytes: number;
  try {
    const stat = await output.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error("Empty sample.");
    sizeBytes = stat.size;
    for await (const chunk of output.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    await output.sync();
  } finally { await output.close(); }
  if (source !== paths.final) await rename(source, paths.final);
  const directoryHandle = await open(input.directory, constants.O_RDONLY);
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  const startMilliseconds = clip.startMilliseconds + media.videoStartMilliseconds;
  const endMilliseconds = Math.min(clip.endMilliseconds, startMilliseconds + media.durationMilliseconds);
  return {
    artifact: {
      identity: `damage-preview-v1.${input.id}.${input.index}`, path: paths.final, sizeBytes,
      sha256: hash.digest("hex"), mediaType: "video/x-matroska", coverageMethod: "handbrake_seek_and_probed_video_packets",
      durationMilliseconds: media.durationMilliseconds, coverage: { startMilliseconds, endMilliseconds },
    },
    complete: media.videoStartMilliseconds <= 100 && endMilliseconds + 100 >= clip.endMilliseconds,
  };
}
