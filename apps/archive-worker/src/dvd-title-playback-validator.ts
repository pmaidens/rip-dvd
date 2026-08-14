import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";

import {
  nodeCommandRunner,
  type CommandRunner,
} from "./optical-drive-command-runner.js";

const PLAYBACK_OUTPUT_LIMIT_BYTES = 1_048_576;
const PLAYBACK_TIMEOUT_MS = 12 * 60 * 60_000;
const MAX_PLAYBACK_FRAME_COUNT = 1_000_000_000;

export interface DvdTitlePlaybackRequest {
  imagePath: string;
  signal: AbortSignal;
  title: DvdTitle;
}

export interface DvdTitlePlaybackResult {
  audioStreamCount: number;
  decodedDurationSeconds: number;
  decodedFrameCount: number;
  failedFrameCount: number;
  terminalStatus: "completed";
  titleNumber: number;
  videoStreamCount: number;
}

export interface DvdTitlePlaybackValidator {
  validate(
    request: DvdTitlePlaybackRequest,
  ): Promise<DvdTitlePlaybackResult>;
}

function boundedFrameCount(value: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_PLAYBACK_FRAME_COUNT
  ) {
    throw new Error("DVD title playback validator returned malformed output");
  }
  return parsed;
}

function parseCompletedPlayback(
  output: string,
  titleNumber: number,
): DvdTitlePlaybackResult {
  if (
    !/libhb:\s*work result\s*=\s*0\b/.test(output) ||
    !/#\s*Job Completed!/.test(output)
  ) {
    throw new Error("DVD title playback validator returned malformed output");
  }
  const decoderPattern =
    /^.*?([a-z0-9_]+)-decoder done:\s*(\d+) frames,\s*(\d+) decoder errors\s*$/gim;
  const decoders = [...output.matchAll(decoderPattern)].map((match) => ({
    codec: match[1]!.toLowerCase(),
    decodedFrameCount: boundedFrameCount(match[2]!),
    failedFrameCount: boundedFrameCount(match[3]!),
  }));
  const videoDecoders = decoders.filter(({ codec }) => codec === "mpeg2video");
  const audioDecoders = decoders.filter(({ codec }) => codec !== "mpeg2video");
  if (videoDecoders.length > 1) {
    throw new Error("DVD title playback validator returned malformed output");
  }
  const synchronization =
    /sync:\s*got\s*(\d+) frames,\s*(\d+) expected/.exec(output);
  const frameRate =
    /sync:\s*framerate min\s*[0-9]+(?:\.[0-9]+)? fps,\s*max\s*[0-9]+(?:\.[0-9]+)? fps,\s*avg\s*([0-9]+(?:\.[0-9]+)?) fps/.exec(
      output,
    );
  if (synchronization === null || frameRate === null) {
    throw new Error("DVD title playback validator returned malformed output");
  }
  const synchronizedFrameCount = boundedFrameCount(synchronization[1]!);
  boundedFrameCount(synchronization[2]!);
  const averageFrameRate = Number(frameRate[1]);
  if (
    !Number.isFinite(averageFrameRate) ||
    averageFrameRate <= 0 ||
    averageFrameRate > 240
  ) {
    throw new Error("DVD title playback validator returned malformed output");
  }
  return {
    audioStreamCount: audioDecoders.length,
    decodedDurationSeconds: synchronizedFrameCount / averageFrameRate,
    decodedFrameCount: decoders.reduce(
      (total, decoder) => total + decoder.decodedFrameCount,
      0,
    ),
    failedFrameCount: decoders.reduce(
      (total, decoder) => total + decoder.failedFrameCount,
      0,
    ),
    terminalStatus: "completed",
    titleNumber,
    videoStreamCount: videoDecoders.length,
  };
}

export function createNodeDvdTitlePlaybackValidator({
  runner = nodeCommandRunner,
}: {
  runner?: CommandRunner;
} = {}): DvdTitlePlaybackValidator {
  return {
    async validate({ imagePath, signal, title }) {
      let playback;
      try {
        playback = await runner.run(
          "rip-dvd-handbrake",
          [
            "--input",
            imagePath,
            "--title",
            String(title.number),
            "--output",
            "/dev/null",
            "--format",
            "av_mkv",
            "--encoder",
            "x264",
            "--encoder-preset",
            "ultrafast",
            "--quality",
            "51",
            "--all-audio",
            "--aencoder",
            "av_aac",
          ],
          {
            maxBufferBytes: PLAYBACK_OUTPUT_LIMIT_BYTES,
            signal,
            timeoutMs: PLAYBACK_TIMEOUT_MS,
          },
        );
      } catch (error) {
        throw new Error("DVD title playback validation failed", {
          cause: error,
        });
      }
      if (playback.exitCode !== 0) {
        throw new Error("DVD title playback validation failed");
      }
      return parseCompletedPlayback(
        `${playback.stdout}\n${playback.stderr}`,
        title.number,
      );
    },
  };
}
