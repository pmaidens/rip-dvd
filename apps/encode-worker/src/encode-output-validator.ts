import { execFile } from "node:child_process";

const DEFAULT_MEDIA_TOOL_TIMEOUT_MS = 30_000;
const MAX_MEDIA_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_VIDEO_START_DELAY_SECONDS = 5;
const VALIDATION_DECODE_SECONDS = 5;

export interface MediaToolRunRequest {
  arguments_: readonly string[];
  executable: "ffmpeg" | "ffprobe";
  signal: AbortSignal;
  timeoutMs: number;
}

export interface MediaToolRunResult {
  stderr: string;
  stdout: string;
}

export type MediaToolRunner = (
  request: MediaToolRunRequest,
) => Promise<MediaToolRunResult>;

export interface EncodeOutputValidator {
  validate(outputPath: string, signal: AbortSignal): Promise<void>;
}

interface ProbePacket {
  pts_time?: unknown;
}

interface ProbeStream {
  codec_name?: unknown;
  pix_fmt?: unknown;
  profile?: unknown;
}

interface ProbeResult {
  packets?: unknown;
  streams?: unknown;
}

function validationError(message: string): Error {
  return new Error(`Encode output validation failed: ${message}`);
}

function normalizeToolError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function runNodeMediaTool(
  request: MediaToolRunRequest,
): Promise<MediaToolRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      request.executable,
      [...request.arguments_],
      {
        encoding: "utf8",
        maxBuffer: MAX_MEDIA_TOOL_OUTPUT_BYTES,
        signal: request.signal,
        timeout: request.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stderr, stdout });
      },
    );
  });
}

function parseProbeResult(stdout: string, description: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw validationError(`${description} probe returned invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw validationError(`${description} probe returned an invalid result`);
  }
  return parsed as ProbeResult;
}

function firstPacketPts(result: ProbeResult): number | null {
  if (!Array.isArray(result.packets) || result.packets.length === 0) {
    return null;
  }
  const packet = result.packets[0] as ProbePacket;
  const pts =
    typeof packet.pts_time === "string"
      ? Number.parseFloat(packet.pts_time)
      : Number.NaN;
  return Number.isFinite(pts) ? pts : null;
}

function identifiedMetadata(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== "unknown"
  );
}

async function runTool(
  runMediaTool: MediaToolRunner,
  request: MediaToolRunRequest,
  description: string,
): Promise<MediaToolRunResult> {
  try {
    return await runMediaTool(request);
  } catch (error) {
    request.signal.throwIfAborted();
    throw validationError(
      `${description} failed: ${normalizeToolError(error)}`,
    );
  }
}

export function createNodeEncodeOutputValidator({
  runMediaTool = runNodeMediaTool,
  timeoutMs = DEFAULT_MEDIA_TOOL_TIMEOUT_MS,
}: {
  runMediaTool?: MediaToolRunner;
  timeoutMs?: number;
} = {}): EncodeOutputValidator {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Encode output validation timeout is invalid");
  }
  return {
    async validate(outputPath, signal) {
      signal.throwIfAborted();
      const videoProbe = parseProbeResult(
        (
          await runTool(
            runMediaTool,
            {
              arguments_: [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-read_intervals",
                "%+#1",
                "-show_entries",
                "stream=codec_name,profile,pix_fmt:packet=pts_time",
                "-of",
                "json",
                outputPath,
              ],
              executable: "ffprobe",
              signal,
              timeoutMs,
            },
            "video probe",
          )
        ).stdout,
        "video",
      );
      const videoStream = Array.isArray(videoProbe.streams)
        ? (videoProbe.streams[0] as ProbeStream | undefined)
        : undefined;
      if (
        videoStream === undefined ||
        !identifiedMetadata(videoStream.codec_name) ||
        !identifiedMetadata(videoStream.profile) ||
        !identifiedMetadata(videoStream.pix_fmt)
      ) {
        throw validationError("video stream metadata is incomplete");
      }
      const videoFirstPts = firstPacketPts(videoProbe);
      if (videoFirstPts === null) {
        throw validationError("video stream has no readable first packet");
      }

      const audioProbe = parseProbeResult(
        (
          await runTool(
            runMediaTool,
            {
              arguments_: [
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-read_intervals",
                "%+#1",
                "-show_entries",
                "packet=pts_time",
                "-of",
                "json",
                outputPath,
              ],
              executable: "ffprobe",
              signal,
              timeoutMs,
            },
            "audio probe",
          )
        ).stdout,
        "audio",
      );
      const videoStartDelay = videoFirstPts - (firstPacketPts(audioProbe) ?? 0);
      if (videoStartDelay > MAX_VIDEO_START_DELAY_SECONDS) {
        throw validationError(
          `first video frame starts ${videoStartDelay.toFixed(3)} seconds after the audio baseline`,
        );
      }

      const decodeResult = await runTool(
        runMediaTool,
        {
          arguments_: [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            outputPath,
            "-map",
            "0:v:0",
            "-an",
            "-t",
            String(VALIDATION_DECODE_SECONDS),
            "-fps_mode",
            "passthrough",
            "-progress",
            "pipe:1",
            "-nostats",
            "-f",
            "null",
            "-",
          ],
          executable: "ffmpeg",
          signal,
          timeoutMs,
        },
        "video decode",
      );
      const decodedFrames = [...decodeResult.stdout.matchAll(/^frame=(\d+)$/gm)]
        .map((match) => Number.parseInt(match[1]!, 10))
        .reduce((maximum, frames) => Math.max(maximum, frames), 0);
      if (decodedFrames === 0) {
        throw validationError(
          `the first ${VALIDATION_DECODE_SECONDS} seconds decoded zero video frames`,
        );
      }
      if (!/^progress=end$/m.test(decodeResult.stdout)) {
        throw validationError("the bounded video decode did not complete");
      }
    },
  };
}

export const nodeEncodeOutputValidator = createNodeEncodeOutputValidator();
