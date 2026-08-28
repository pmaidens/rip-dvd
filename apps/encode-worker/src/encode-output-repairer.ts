import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";

import { requireNonEmptyRegularEncodeOutput } from "./encode-output-filesystem-identity.js";
import type { MediaToolRunner } from "./encode-output-validator.js";

export interface RetainedSubtitleDisposition {
  default: boolean;
  forced: boolean;
}

export interface RemoveEmptyVobSubStreamsRequest {
  emptyStreamIndexes: readonly number[];
  outputPath: string;
  retainedSubtitleDispositions: readonly RetainedSubtitleDisposition[];
  signal: AbortSignal;
  timeoutMs: number;
}

export interface EncodeOutputRepairer {
  removeEmptyVobSubStreams(
    request: RemoveEmptyVobSubStreamsRequest,
  ): Promise<void>;
}

type ReplaceEncodeOutput = (
  replacementPath: string,
  outputPath: string,
) => Promise<void>;

async function replaceNodeEncodeOutput(
  replacementPath: string,
  outputPath: string,
): Promise<void> {
  await requireNonEmptyRegularEncodeOutput(
    replacementPath,
    "subtitle cleanup did not produce a regular output file",
  );
  await rename(replacementPath, outputPath);
}

function copiedSubtitleDisposition(
  disposition: RetainedSubtitleDisposition,
): string {
  return `${disposition.default ? "+default" : "-default"}${
    disposition.forced ? "+forced" : "-forced"
  }`;
}

export function createNodeEncodeOutputRepairer({
  replaceOutput = replaceNodeEncodeOutput,
  runMediaTool,
}: {
  replaceOutput?: ReplaceEncodeOutput;
  runMediaTool: MediaToolRunner;
}): EncodeOutputRepairer {
  return {
    async removeEmptyVobSubStreams({
      emptyStreamIndexes,
      outputPath,
      retainedSubtitleDispositions,
      signal,
      timeoutMs,
    }) {
      const replacementPath =
        `${outputPath}.${randomUUID()}.rip-dvd-subtitle-remux`;
      try {
        await runMediaTool({
          arguments_: [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            outputPath,
            "-map",
            "0",
            ...emptyStreamIndexes.flatMap((index) => ["-map", `-0:${index}`]),
            "-c",
            "copy",
            "-map_metadata",
            "0",
            "-map_chapters",
            "0",
            ...retainedSubtitleDispositions.flatMap((disposition, position) => [
              `-disposition:s:${position}`,
              copiedSubtitleDisposition(disposition),
            ]),
            "-f",
            "matroska",
            replacementPath,
          ],
          executable: "ffmpeg",
          signal,
          timeoutMs,
        });
        signal.throwIfAborted();
        await replaceOutput(replacementPath, outputPath);
      } finally {
        await unlink(replacementPath).catch(() => {});
      }
    },
  };
}
