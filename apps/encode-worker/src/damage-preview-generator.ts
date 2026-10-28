import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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
export interface PreviewSourceTitle {
  durationMilliseconds: number;
  chapterDurations: number[];
  audio: number[];
  subtitles: number[];
  angleCount: number;
  navigation: { videoTitleSetNumber: number; titleSetTitleNumber: number; programChainNumber: number };
  selectedPath: { programNumber: number; cellNumber: number; vobId: number; cellId: number }[];
}
export interface PreviewMediaInspection {
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
      const path = JSON.parse(await readPreviewTitle([source, String(titleNumber), String(angleNumber), String(chapterStart), String(chapterEnd), outputPath], descriptor, signal)) as Pick<PreviewSourceTitle, "navigation" | "selectedPath">;
      let text = "";
      await runner.run({
        arguments_: ["--no-dvdnav", "--scan", "--json", "--title", String(titleNumber), "--min-duration", "0", "--previews", "1:0", "-i", source, "-o", outputPath],
        outputPath, sourceOwnershipDescriptor: descriptor, signal,
        onOutput(chunk) { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Preview title scan exceeded its bound."); },
      });
      const marker = "JSON Title Set: ";
      const offset = text.indexOf(marker);
      if (offset < 0) throw new Error("Preview title scan has no stream evidence.");
      const scan = JSON.parse(text.slice(offset + marker.length)) as { TitleList: { Index: number; AngleCount?: number; Duration: { Ticks: number }; ChapterList: { Duration: { Ticks: number } }[]; AudioList: { TrackNumber: number }[]; SubtitleList: { TrackNumber: number }[] }[] };
      const title = scan.TitleList.find((item) => item.Index === titleNumber);
      if (!title || !Number.isFinite(title.Duration.Ticks) || !title.ChapterList.length) throw new Error("Selected title cannot be represented by HandBrake.");
      return {
        ...path,
        durationMilliseconds: title.Duration.Ticks / 90,
        chapterDurations: title.ChapterList.map((item) => item.Duration.Ticks / 90),
        audio: title.AudioList.map((item) => item.TrackNumber),
        subtitles: title.SubtitleList.map((item) => item.TrackNumber), angleCount: title.AngleCount ?? 1,
      };
    },
    generate: (request) => runner.run(request),
    async inspect(path) {
      const { stdout } = await execute("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const media = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: { codec_type: string }[] };
      const durationMilliseconds = Number(media.format?.duration) * 1_000;
      if (!media.format?.format_name?.split(",").includes("matroska") || !Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) throw new Error("Preview is not a playable canonical MKV.");
      // A real bounded decode distinguishes an indexed file from playable media.
      await execute("ffmpeg", ["-v", "error", "-xerror", "-i", path, "-t", "2", "-map", "0:v:0", "-f", "null", "-"], { timeout: 60_000, maxBuffer: 65_536 });
      return { durationMilliseconds, videoCount: media.streams?.filter((item) => item.codec_type === "video").length ?? 0, audioCount: media.streams?.filter((item) => item.codec_type === "audio").length ?? 0, subtitleCount: media.streams?.filter((item) => item.codec_type === "subtitle").length ?? 0 };
    },
    whenInactive: (path) => runner.whenInactive?.(path) ?? Promise.resolve(),
    requireInactive(path) {
      if (!runner.requireInactive) throw new Error("Preview process closure cannot be proved.");
      runner.requireInactive(path);
    },
  };
}
