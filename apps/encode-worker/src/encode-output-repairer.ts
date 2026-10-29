import { randomUUID } from "node:crypto";
import { lstat, rename, unlink } from "node:fs/promises";

import { requireNonEmptyRegularEncodeOutput, sameEncodeOutputMutationSnapshot, sameEncodeOutputAuthoritySnapshot } from "./encode-output-filesystem-identity.js";
import { fingerprintCompletedEncodeOutput, type EncodeOutputRepairCompletion } from "./encode-output-completion.js";
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
  ): Promise<EncodeOutputRepairCompletion | void>;
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
        const source = await requireNonEmptyRegularEncodeOutput(outputPath, "subtitle cleanup source is incomplete");
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
        const completed = await fingerprintCompletedEncodeOutput(replacementPath, signal);
        if (!sameEncodeOutputMutationSnapshot(source, await lstat(outputPath)) ||
            !sameEncodeOutputMutationSnapshot(completed.metadata, await lstat(replacementPath))) {
          throw new Error("subtitle cleanup input or output changed before replacement");
        }
        await replaceOutput(replacementPath, outputPath);
        const output = await lstat(outputPath);
        if (!sameEncodeOutputAuthoritySnapshot(completed.metadata, output)) throw new Error("subtitle cleanup output changed during replacement");
        return { source, output, sha256: completed.sha256 };
      } finally {
        await unlink(replacementPath).catch(() => {});
      }
    },
  };
}
