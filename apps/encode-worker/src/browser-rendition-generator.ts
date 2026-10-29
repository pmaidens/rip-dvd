import { spawn } from "node:child_process";
import { probeEncodeOutputMedia, type EncodeOutputMediaProbe } from "@rip-dvd/application";

export function browserRenditionCommand(source: string, destination: string, streamIndexes: number[]) {
  return ["-nostdin", "-v", "error", "-n", "-i", source,
    ...streamIndexes.flatMap((index) => ["-map", `0:${index}`]),
    "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4", destination];
}
interface RemuxInput {
  source: string; destination: string; streamIndexes: number[]; executionDescriptor: number;
  signal: AbortSignal; onProgress(percent: number): void; durationSeconds: number;
}
export interface BrowserRenditionGenerator {
  probe: EncodeOutputMediaProbe;
  version(): Promise<string>;
  remux(input: RemuxInput): Promise<void>;
}
export async function runRenditionCommand(file: string, args: string[], signal?: AbortSignal, descriptor?: number, onOutput?: (text: string) => void) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { signal, stdio: ["ignore", "pipe", "ignore", ...(descriptor === undefined ? [] : [descriptor])] });
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
  async remux(input) {
    let pending = "";
    await runRenditionCommand("ffmpeg", browserRenditionCommand(input.source, input.destination, input.streamIndexes), input.signal, input.executionDescriptor, (text) => {
      pending += text;
      const lines = pending.split("\n"); pending = lines.pop()!.slice(-1024);
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) input.onProgress(Math.min(99, Number(match[1]) / (input.durationSeconds * 10_000)));
      }
    });
  },
}; }
