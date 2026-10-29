import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPublicationJson, encodeOutputFilesystemIdentity, sameEncodeOutputMutationSnapshot,
  type EncodeClaimSnapshot, type EncodeOutputCellCorrespondence, type EncodeOutputCellVideoMeasurement,
} from "@rip-dvd/data-access";
import type { ArchiveImageOwnershipHandle } from "@rip-dvd/worker-runtime";

const POLICY = "encode-output-exact-cell-video-v1" as const;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 4096;
const TOOL_TIMEOUT_MS = 30_000;

export interface CorrespondenceMediaToolRequest {
  executable: "ffmpeg" | "ffprobe";
  arguments_: readonly string[];
  signal: AbortSignal;
  timeoutMs: number;
}
export type CorrespondenceMediaTool = (request: CorrespondenceMediaToolRequest) => Promise<{ stdout: string; stderr: string }>;

const runMediaTool: CorrespondenceMediaTool = (request) => new Promise((resolve, reject) => {
  execFile(request.executable, [...request.arguments_], {
    encoding: "utf8", maxBuffer: 1024 * 1024, signal: request.signal, timeout: request.timeoutMs,
  }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});

interface Frame { pts: number; duration: number; sha256: string }
interface DecodedVideo {
  summary: EncodeOutputCellVideoMeasurement;
  frames: Frame[];
  originSeconds: number;
}
type UnknownCorrespondence = Extract<EncodeOutputCellCorrespondence, { status: "unknown" }>;
const unknown = (reasonCode: UnknownCorrespondence["reasonCode"]): UnknownCorrespondence => ({ policyVersion: POLICY, status: "unknown", reasonCode });

function sequenceDigest(frames: readonly Frame[]) {
  return createHash("sha256").update(frames.map((frame) => frame.sha256).join("\n")).digest("hex");
}

async function decodeVideo(path: string, signal: AbortSignal, tool: CorrespondenceMediaTool): Promise<DecodedVideo> {
  const run = async (executable: CorrespondenceMediaToolRequest["executable"], arguments_: string[]) => {
    const result = await tool({ executable, arguments_, signal, timeoutMs: TOOL_TIMEOUT_MS });
    if (result.stderr.trim()) throw new Error("Media tool reported a decoding error");
    return result;
  };
  const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries",
    "stream=width,height,pix_fmt,time_base:frame=pts,pkt_duration:format=start_time", "-show_frames", "-err_detect", "explode", "-of", "json", path])).stdout) as {
      streams?: { width: number; height: number; pix_fmt: string; time_base: string }[];
      frames?: { pts: number; pkt_duration: number }[]; format?: { start_time?: string };
    };
  const stream = probe.streams?.[0];
  const originSeconds = Number(probe.format?.start_time);
  if (probe.streams?.length !== 1 || !stream || stream.pix_fmt !== "yuv420p" ||
      !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) ||
      stream.width < 2 || stream.height < 2 || stream.width > 1920 || stream.height > 1080 ||
      !Number.isFinite(originSeconds) || !Array.isArray(probe.frames) || probe.frames.length > MAX_FRAMES) throw new Error("Unsupported measured video");
  const text = (await run("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-threads", "1", "-copyts", "-i", path,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough", "-c:v", "rawvideo", "-threads", "1",
    "-f", "framehash", "-hash", "sha256", "-"])).stdout;
  // Rawvideo encoder timestamps can be quantized to inverse frame rate. Use
  // the native decoded-frame timestamps, pairing both complete decode orders.
  const timeBaseMatch = /^(\d+)\/(\d+)$/.exec(stream.time_base);
  const dimensions = /^#dimensions 0: (\d+)x(\d+)\s*$/m.exec(text);
  const numerator = Number(timeBaseMatch?.[1]), denominator = Number(timeBaseMatch?.[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0 ||
      Number(dimensions?.[1]) !== stream.width || Number(dimensions?.[2]) !== stream.height) throw new Error("Missing frame timing");
  const frames: Frame[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split(",").map((field) => field.trim());
    const nativeFrame = probe.frames[frames.length];
    const pts = nativeFrame?.pts, duration = nativeFrame?.pkt_duration;
    if (fields.length !== 6 || fields[0] !== "0" || !Number.isSafeInteger(pts) || !Number.isSafeInteger(duration) || duration <= 0 ||
        pts === undefined || duration === undefined || !Number.isSafeInteger(pts + duration) || Number(fields[4]) !== stream.width * stream.height * 1.5 ||
        !/^[a-f0-9]{64}$/.test(fields[5]!) || frames.length >= MAX_FRAMES ||
        (frames.length > 0 && pts <= frames.at(-1)!.pts)) throw new Error("Incomplete frame sequence");
    frames.push({ pts, duration, sha256: fields[5]! });
  }
  if (frames.length === 0 || frames.length !== probe.frames.length) throw new Error("Incomplete measured video frames");
  return { frames, originSeconds, summary: {
    frameCount: frames.length, width: stream.width, height: stream.height, pixelFormat: "yuv420p",
    sequenceSha256: sequenceDigest(frames), timeBase: { numerator, denominator },
    firstPts: frames[0]!.pts, endPts: frames.at(-1)!.pts + frames.at(-1)!.duration,
  } };
}

interface SourceCellMeasurement {
  snapshot: EncodeClaimSnapshot;
  sourceRange: { startLba: number; sectorCount: number };
  sourceBytesSha256: string;
  video: DecodedVideo;
}
export type EncodeSourceCellMeasurement = SourceCellMeasurement | UnknownCorrespondence;

// DVD content packs are sector aligned. Reject unread zeroed sectors, encrypted
// PES payloads and incomplete packs before a decoder can silently skip them.
function completeClearDvdPacks(bytes: Buffer): boolean {
  let videoPackets = 0;
  for (let sector = 0; sector < bytes.length; sector += 2048) {
    const end = sector + 2048;
    if (bytes.readUInt32BE(sector) !== 0x000001ba || (bytes[sector + 4]! & 0xc0) !== 0x40) return false;
    let offset = sector + 14 + (bytes[sector + 13]! & 7);
    while (offset < end) {
      if (offset + 6 > end || bytes.readUIntBE(offset, 3) !== 1) return false;
      const stream = bytes[offset + 3]!, length = bytes.readUInt16BE(offset + 4);
      if (length === 0 || offset + 6 + length > end ||
          !(stream === 0xbb || stream === 0xbd || stream === 0xbe || stream === 0xbf || (stream >= 0xc0 && stream <= 0xef))) return false;
      if (stream === 0xbd || (stream >= 0xc0 && stream <= 0xef)) {
        if (length < 3 || (bytes[offset + 6]! & 0xf0) !== 0x80 || bytes[offset + 8]! > length - 3) return false;
        if (stream >= 0xe0) videoPackets++;
      }
      offset += 6 + length;
    }
  }
  return videoPackets > 0;
}

/** Bounded content identity, checked while the inspection's file fence is held. */
export async function hashEncodeOutputBytes(path: string, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || before.size <= 0 || before.size > MAX_OUTPUT_BYTES) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    if (!sameEncodeOutputMutationSnapshot(before, await file.stat())) throw new Error("Output changed");
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: before.size - 1 })) { signal.throwIfAborted(); hash.update(chunk); }
    if (!sameEncodeOutputMutationSnapshot(before, await file.stat()) ||
        !sameEncodeOutputMutationSnapshot(before, await lstat(path))) throw new Error("Output changed");
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** Sole supported source is the complete contiguous map of one concrete cell.
 * Its entire decoded video is the envelope. No estimated source time is used.
 */
export async function measureEncodeSourceCell(
  snapshot: EncodeClaimSnapshot, imagePath: string, ownership: ArchiveImageOwnershipHandle,
  tool: CorrespondenceMediaTool = runMediaTool,
): Promise<EncodeSourceCellMeasurement> {
  ownership.assertOwned(); ownership.signal.throwIfAborted();
  const source = snapshot.source;
  const selected = source.assessment.items.find((item) => item.titleIdentityObservationId === source.titleIdentity.id);
  const contentRanges = source.titleIdentity.sourceExtents;
  const range = contentRanges[0];
  if (!selected || selected.mappingCoverage.state !== "complete" || selected.mappingCoverage.unknownReasons.length > 0 ||
      contentRanges.length !== 1 || !range || range.sectorCount * 2048 > MAX_SOURCE_BYTES ||
      !selected.uniqueSourceRanges.some((mapped) => mapped.startLba <= range.startLba &&
        mapped.startLba + mapped.sectorCount >= range.startLba + range.sectorCount) ||
      source.resolvedSource.selectedPath.length !== 1 || source.resolvedSource.angleNumber !== 1 || source.titleIdentity.angleCount !== 1 ||
      source.title.chapters !== 1 || source.titleIdentity.chapterCount !== 1 ||
      source.resolvedSource.chapterStart !== 1 || source.resolvedSource.chapterEnd !== 1 ||
      canonicalPublicationJson(selected.selection) !== canonicalPublicationJson({
        selectedPath: source.resolvedSource.selectedPath, angleNumber: 1, chapterStart: 1, chapterEnd: 1,
      }) || selected.timingEvidence?.occurrences.length !== 1 || selected.timingEvidence.occurrences[0]?.playbackOccurrence !== 1) {
    return unknown("OUTPUT_CELL_UNSUPPORTED");
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "rip-dvd-cell-"));
    const bytes = Buffer.alloc(range.sectorCount * 2048);
    const image = await open(imagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await image.stat();
      if (!before.isFile() || before.size < (range.startLba + range.sectorCount) * 2048) throw new Error("Source extent unavailable");
      let offset = 0;
      while (offset < bytes.byteLength) {
        ownership.assertOwned(); ownership.signal.throwIfAborted();
        const read = await image.read(bytes, offset, Math.min(65536, bytes.byteLength - offset), range.startLba * 2048 + offset);
        if (!read.bytesRead) throw new Error("Incomplete source read");
        offset += read.bytesRead;
      }
      if (!sameEncodeOutputMutationSnapshot(before, await image.stat()) ||
          !sameEncodeOutputMutationSnapshot(before, await lstat(imagePath))) throw new Error("Source changed");
    } finally { await image.close(); }
    if (!completeClearDvdPacks(bytes)) return unknown("OUTPUT_CELL_UNSUPPORTED");
    const path = join(directory, "cell.mpg");
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const video = await decodeVideo(path, ownership.signal, tool);
    ownership.assertOwned(); ownership.signal.throwIfAborted();
    return { snapshot, sourceRange: { startLba: range.startLba, sectorCount: range.sectorCount }, sourceBytesSha256: createHash("sha256").update(bytes).digest("hex"), video };
  } catch {
    ownership.signal.throwIfAborted(); ownership.assertOwned();
    return unknown("OUTPUT_MEASUREMENT_FAILED");
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

// KMP bounds matching work even for long runs of repeated identical frames.
function matches(source: readonly Frame[], output: readonly Frame[]): number[] {
  const prefix = Array<number>(source.length).fill(0);
  for (let i = 1, j = 0; i < source.length; i++) {
    while (j > 0 && source[i]!.sha256 !== source[j]!.sha256) j = prefix[j - 1]!;
    if (source[i]!.sha256 === source[j]!.sha256) j++;
    prefix[i] = j;
  }
  const found: number[] = [];
  for (let i = 0, j = 0; i < output.length; i++) {
    while (j > 0 && output[i]!.sha256 !== source[j]!.sha256) j = prefix[j - 1]!;
    if (output[i]!.sha256 === source[j]!.sha256) j++;
    if (j === source.length) {
      found.push(i - j + 1);
      if (found.length === 2) break;
      j = prefix[j - 1]!;
    }
  }
  return found;
}

export async function measureEncodeOutputCell(
  source: EncodeSourceCellMeasurement, outputPath: string, signal: AbortSignal,
  tool: CorrespondenceMediaTool = runMediaTool,
): Promise<EncodeOutputCellCorrespondence> {
  signal.throwIfAborted();
  if ("status" in source) return source;
  try {
    const before = await lstat(outputPath);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_OUTPUT_BYTES) return unknown("OUTPUT_CELL_UNSUPPORTED");
    const outputBytesSha256 = await hashEncodeOutputBytes(outputPath, signal);
    if (outputBytesSha256 === null) return unknown("OUTPUT_CELL_UNSUPPORTED");
    const output = await decodeVideo(outputPath, signal, tool);
    if (!sameEncodeOutputMutationSnapshot(before, await lstat(outputPath))) throw new Error("Output changed");
    if (source.video.summary.width !== output.summary.width || source.video.summary.height !== output.summary.height) return unknown("OUTPUT_CONTENT_UNRESOLVED");
    const found = matches(source.video.frames, output.frames);
    if (found.length !== 1) return unknown(found.length > 1 ? "OUTPUT_CONTENT_AMBIGUOUS" : "OUTPUT_CONTENT_UNRESOLVED");
    const matchingFrames = output.frames.slice(found[0]!, found[0]! + source.video.frames.length);
    const firstPts = matchingFrames[0]!.pts, endPts = matchingFrames.at(-1)!.pts + matchingFrames.at(-1)!.duration;
    const milliseconds = (pts: number) => Number(((pts * output.summary.timeBase.numerator / output.summary.timeBase.denominator - output.originSeconds) * 1000).toFixed(6));
    const outputInterval = { startMilliseconds: milliseconds(firstPts), endMilliseconds: milliseconds(endPts) };
    if (outputInterval.startMilliseconds < 0 || outputInterval.endMilliseconds <= outputInterval.startMilliseconds) throw new Error("Unsupported output origin");
    const snapshot = source.snapshot;
    return { policyVersion: POLICY, status: "measured", claimSnapshotId: snapshot.id,
      assessmentIdentity: snapshot.source.assessment.id, titleIdentityObservationId: snapshot.source.titleIdentity.id,
      checkpoint: snapshot.source.checkpoint, resolvedSource: snapshot.source.resolvedSource, sourceRange: source.sourceRange,
      sourceBytesSha256: source.sourceBytesSha256, sourceVideo: source.video.summary,
      outputFileIdentity: encodeOutputFilesystemIdentity(before), outputBytesSha256,
      outputVideo: { ...output.summary, frameCount: matchingFrames.length, firstPts, endPts, sequenceSha256: sequenceDigest(matchingFrames) },
      outputTimelineOriginSeconds: output.originSeconds, outputInterval };
  } catch {
    signal.throwIfAborted();
    return unknown("OUTPUT_MEASUREMENT_FAILED");
  }
}
