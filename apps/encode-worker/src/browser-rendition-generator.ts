import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { probeEncodeOutputMedia, type EncodeOutputMediaProbe, type measureBrowserRenditionTimeline } from "@rip-dvd/application";

type Conversion = import("@rip-dvd/data-access").BrowserRenditionRecord["conversion"];
export function browserRenditionCommand(source: string, destination: string, conversion: Conversion) {
  const streams = conversion.streams;
  if (!streams) return ["-nostdin", "-v", "error", "-n", "-i", source,
    ...(conversion.copiedStreamIndexes ?? []).flatMap((index) => ["-map", `0:${index}`]),
    "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", destination];
  const args = ["-nostdin", "-v", "error", "-n", "-i", source, "-map_metadata", "-1", "-map_chapters", "-1"];
  const video = streams.find((stream) => stream.kind === "video")!;
  const subtitle = conversion.burnedSubtitle;
  if (video.mode === "transcode") {
    const format = "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p";
    let filter = `[0:${video.sourceIndex}]${format}[view]`;
    if (subtitle) {
      filter = ["dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle"].includes(subtitle.codecName)
        ? `[0:${video.sourceIndex}][0:${subtitle.sourceIndex}]overlay=eof_action=pass:repeatlast=0,${format}[view]`
        // The worker runs in its private snapshot directory. This fixed filename
        // avoids interpreting an operator's media-library path as filter syntax.
        : `[0:${video.sourceIndex}]subtitles=filename=source.mkv:si=${subtitle.subtitleOrdinal},${format}[view]`;
    }
    args.push("-filter_complex_threads", "1", "-filter_complex", filter);
  }
  for (const stream of streams) {
    args.push("-map", stream.kind === "video" && stream.mode === "transcode" ? "[view]" : `0:${stream.sourceIndex}`);
    const index = stream.outputIndex;
    args.push(`-c:${index}`, stream.mode === "copy" ? "copy" : stream.kind === "video" ? "libx264" : "aac");
    if (stream.mode === "transcode") {
      if (stream.kind === "video") args.push(`-profile:${index}`, "high", `-level:${index}`, "4.1", `-crf:${index}`, "20", `-preset:${index}`, "medium", `-threads:${index}`, "1");
      else args.push(`-profile:${index}`, "aac_low", `-ac:${index}`, "2", `-ar:${index}`, "48000", `-b:${index}`, "192k");
    }
    if (stream.language) args.push(`-metadata:s:${index}`, `language=${stream.language}`);
    if (stream.title) args.push(`-metadata:s:${index}`, `title=${stream.title}`);
    args.push(`-disposition:${index}`, [stream.default ? "default" : "", stream.forced ? "forced" : ""].filter(Boolean).join("+") || "0");
  }
  return [...args, "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", destination];
}
interface ConversionInput {
  source: string; destination: string; conversion: Conversion; executionDescriptor: number;
  signal: AbortSignal; onProgress(percent: number): void; durationSeconds: number;
}
export interface BrowserRenditionGenerator {
  measureTimeline?: typeof measureBrowserRenditionTimeline;
  probe: EncodeOutputMediaProbe;
  version(): Promise<string>;
  generate(input: ConversionInput): Promise<void>;
}
export async function runRenditionCommand(file: string, args: string[], signal?: AbortSignal, descriptor?: number, onOutput?: (text: string) => void, cwd?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { signal, cwd, stdio: ["ignore", "pipe", "ignore", ...(descriptor === undefined ? [] : [descriptor])] });
    let output = "", failure: Error | undefined;
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (!failure) {
        try { onOutput?.(text); }
        catch (error) { failure = error instanceof Error ? error : new Error("Rendition progress could not be recorded."); child.kill("SIGTERM"); }
      }
      output = (output + text).slice(-16_384);
    });
    child.stdout!.on("error", (error) => { failure ??= error; child.kill("SIGTERM"); });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => failure ? reject(failure) : code === 0 ? resolve(output) : reject(new Error("Rendition media command failed.")));
  });
}
export function createBrowserRenditionGenerator(): BrowserRenditionGenerator { return {
  probe: probeEncodeOutputMedia,
  version: async () => (await runRenditionCommand("ffmpeg", ["-version"])).split("\n")[0]!.slice(0, 512),
  async generate(input) {
    let pending = "";
    await runRenditionCommand("ffmpeg", browserRenditionCommand(input.source, input.destination, input.conversion), input.signal, input.executionDescriptor, (text) => {
      pending += text;
      const lines = pending.split("\n"); pending = lines.pop()!.slice(-1024);
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) input.onProgress(Math.min(99, Number(match[1]) / (input.durationSeconds * 10_000)));
      }
    }, dirname(input.source));
  },
}; }
