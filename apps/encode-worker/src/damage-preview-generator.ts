import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { DamagePreviewResolvedAudio, DamagePreviewResolvedSubtitle } from "@rip-dvd/data-access";
import { nodeHandBrakeRunner, type HandBrakeRunner, type HandBrakeRunRequest } from "./handbrake-runner.js";

export class DamagePreviewUnrepresentableError extends Error {}
const execute = promisify(execFile);
async function readPreviewTitle(arguments_: string[], descriptor: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("rip-dvd-preview-title", arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe", descriptor] });
    let stdout = "";
    let failure: unknown;
    const abort = () => { failure ??= signal.reason; child.kill("SIGKILL"); };
    const timeout = setTimeout(() => { failure = new Error("Preview path verification timed out."); child.kill("SIGKILL"); }, 120_000);
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) { failure = new Error("Preview path evidence exceeded its bound."); child.kill("SIGKILL"); } });
    child.stderr!.resume();
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new DamagePreviewUnrepresentableError("The title path cannot be represented by canonical preview generation."));
      else resolve(stdout);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function videoPacketCoverage(path: string): Promise<{ startMilliseconds: number; endMilliseconds: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", path], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "", start = Infinity, end = -Infinity;
    let failure: unknown;
    const line = (text: string) => {
      const [pts, duration] = text.trim().split(",");
      if (!pts || pts === "N/A") return;
      const timestamp = Number(pts), length = Number(duration);
      if (!Number.isFinite(timestamp)) return;
      start = Math.min(start, timestamp);
      end = Math.max(end, timestamp + (Number.isFinite(length) && length > 0 ? length : 0));
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) >= 0) { line(pending.slice(0, boundary)); pending = pending.slice(boundary + 1); }
      if (pending.length > 1_024) { failure = new Error("Video packet timing is unrepresentable."); child.kill("SIGKILL"); }
    });
    child.stderr!.resume();
    const timeout = setTimeout(() => { failure = new Error("Video coverage probing timed out."); child.kill("SIGKILL"); }, 60_000);
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timeout); if (pending) line(pending);
      if (failure || code !== 0 || !Number.isFinite(end - start) || end <= start) reject(failure ?? new Error("Video coverage is unavailable."));
      else resolve({ startMilliseconds: start * 1_000, endMilliseconds: end * 1_000 });
    });
  });
}
export interface PreviewSourceTitle {
  durationMilliseconds: number;
  chapterDurations: number[];
  audio: DamagePreviewResolvedAudio[];
  subtitles: DamagePreviewResolvedSubtitle[];
  angleCount: number;
  navigation: { videoTitleSetNumber: number; titleSetTitleNumber: number; programChainNumber: number };
  selectedPath: { programNumber: number; cellNumber: number; vobId: number; cellId: number }[];
}
export interface PreviewMediaInspection {
  videoStartMilliseconds: number;
  durationMilliseconds: number;
  videoCount: number;
  audioCount: number;
  subtitleCount: number;
}
export interface DamagePreviewGenerator {
  versions(): Promise<Record<string, string>>;
  scan(input: { source: string; titleNumber: number; angleNumber: number; chapterStart: number; chapterEnd: number; outputPath: string; descriptor: number; signal: AbortSignal }): Promise<PreviewSourceTitle>;
  generate(request: HandBrakeRunRequest): Promise<void>;
  inspect(path: string): Promise<PreviewMediaInspection>;
  requireInactive(path: string): void;
  whenInactive(path: string): Promise<void>;
}
export function createDamagePreviewGenerator(runner: HandBrakeRunner = nodeHandBrakeRunner): DamagePreviewGenerator {
  return {
    async versions() {
      const [handbrake, ffprobe] = await Promise.all([
        execute("rip-dvd-handbrake", ["--version"], { timeout: 30_000, maxBuffer: 65_536 }),
        execute("ffprobe", ["-version"], { timeout: 30_000, maxBuffer: 65_536 }),
      ]);
      return { pathVerifier: "dvd-preview-title-v1", handbrake: `${handbrake.stdout}\n${handbrake.stderr}`.trim(), ffprobe: ffprobe.stdout.split("\n")[0]! };
    },
    async scan({ source, titleNumber, angleNumber, chapterStart, chapterEnd, outputPath, descriptor, signal }) {
      const path = JSON.parse(await readPreviewTitle([source, String(titleNumber), String(angleNumber), String(chapterStart), String(chapterEnd), outputPath], descriptor, signal)) as Pick<PreviewSourceTitle, "navigation" | "selectedPath"> & { audio: Omit<DamagePreviewResolvedAudio, "trackNumber">[]; subtitles: Omit<DamagePreviewResolvedSubtitle, "trackNumber">[] };
      let text = "";
      await runner.run({
        arguments_: ["--no-dvdnav", "--scan", "--json", "--title", String(titleNumber), "--min-duration", "0", "--previews", "1:0", "-i", source, "-o", outputPath],
        outputPath, sourceOwnershipDescriptor: descriptor, signal,
        onOutput() {},
        onStdout(chunk) { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Preview title scan exceeded its bound."); },
      });
      const marker = "JSON Title Set: ";
      const offset = text.indexOf(marker);
      if (offset < 0) throw new Error("Preview title scan has no stream evidence.");
      const scan = JSON.parse(text.slice(offset + marker.length)) as { TitleList: { Index: number; AngleCount?: number; Duration: { Ticks: number }; ChapterList: { Duration: { Ticks: number } }[]; AudioList: { TrackNumber: number; CodecName: string; ChannelCount: number }[]; SubtitleList: { TrackNumber: number; SourceName: string; Attributes: Record<string, boolean> }[] }[] };
      const title = scan.TitleList.find((item) => item.Index === titleNumber);
      if (!title || !Number.isFinite(title.Duration.Ticks) || !title.ChapterList.length) throw new Error("Selected title cannot be represented by HandBrake.");
      const subtitleTracks = title.SubtitleList.filter((item) => item.SourceName === "VOBSUB");
      if (path.audio.length !== title.AudioList.length || path.subtitles.length !== subtitleTracks.length) throw new DamagePreviewUnrepresentableError("The native DVD stream identities do not match HandBrake's retained tracks.");
      const audio = path.audio.map((source, index) => {
        const track = title.AudioList[index]!;
        const codec = track.CodecName.toLowerCase();
        const matches = source.codec === "mpeg" ? /mpeg|mp2/.test(codec) : source.codec === "lpcm" ? /lpcm|pcm/.test(codec) : codec.includes(source.codec);
        if (track.TrackNumber !== index + 1 || !matches || track.ChannelCount !== source.channels) throw new DamagePreviewUnrepresentableError("The source audio identity cannot be proved against HandBrake's selected track.");
        return { ...source, trackNumber: track.TrackNumber };
      });
      const subtitles = path.subtitles.map((source, index) => {
        const track = subtitleTracks[index]!;
        if (!Number.isSafeInteger(track.TrackNumber) || track.TrackNumber < 1 || track.Attributes[source.style] !== true) throw new DamagePreviewUnrepresentableError("The source subtitle display variant cannot be proved against HandBrake's selected track.");
        return { ...source, trackNumber: track.TrackNumber };
      });
      return {
        ...path,
        durationMilliseconds: title.Duration.Ticks / 90,
        chapterDurations: title.ChapterList.map((item) => item.Duration.Ticks / 90),
        audio,
        subtitles, angleCount: title.AngleCount ?? 1,
      };
    },
    generate: (request) => runner.run(request),
    async inspect(path) {
      const { stdout } = await execute("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const media = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string; start_time?: string }; streams?: { codec_type: string }[] };
      const coverage = await videoPacketCoverage(path);
      const durationMilliseconds = coverage.endMilliseconds - coverage.startMilliseconds;
      const origin = Number(media.format?.start_time ?? 0) * 1_000;
      if (!Number.isFinite(origin)) throw new Error("Sample timeline origin is unavailable.");
      const videoStartMilliseconds = Math.max(0, coverage.startMilliseconds - origin);
      if (!media.format?.format_name?.split(",").includes("matroska") || !Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) throw new Error("Preview is not a playable canonical MKV.");
      // A real bounded decode distinguishes an indexed file from playable media.
      await execute("ffmpeg", ["-v", "error", "-xerror", "-i", path, "-t", "2", "-map", "0:v:0", "-f", "null", "-"], { timeout: 60_000, maxBuffer: 65_536 });
      return { durationMilliseconds, videoStartMilliseconds, videoCount: media.streams?.filter((item) => item.codec_type === "video").length ?? 0, audioCount: media.streams?.filter((item) => item.codec_type === "audio").length ?? 0, subtitleCount: media.streams?.filter((item) => item.codec_type === "subtitle").length ?? 0 };
    },
    whenInactive: (path) => runner.whenInactive?.(path) ?? Promise.resolve(),
    requireInactive(path) {
      if (!runner.requireInactive) throw new Error("Preview process closure cannot be proved.");
      runner.requireInactive(path);
    },
  };
}
