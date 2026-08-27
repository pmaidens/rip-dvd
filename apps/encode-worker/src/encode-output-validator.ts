import { execFile } from "node:child_process";

import {
  createNodeEncodeOutputRepairer,
  type EncodeOutputRepairer,
} from "./encode-output-repairer.js";

const DEFAULT_MEDIA_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_SUBTITLE_PACKET_TIMEOUT_MS = 5 * 60_000;
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
  validate(
    outputPath: string,
    signal: AbortSignal,
    expectations?: EncodeOutputValidationExpectations,
  ): Promise<void>;
}

export interface EncodeOutputValidationExpectations {
  expectedVobSubStreams?: readonly EncodeOutputVobSubExpectation[];
}

export interface EncodeOutputVobSubExpectation {
  contentLabel?: string;
  languageCode?: string;
}

interface ProbePacket {
  pts_time?: unknown;
}

interface ProbeStream {
  codec_name?: unknown;
  disposition?: unknown;
  index?: unknown;
  nb_read_packets?: unknown;
  pix_fmt?: unknown;
  profile?: unknown;
  tags?: unknown;
}

interface ProbeResult {
  packets?: unknown;
  streams?: unknown;
}

interface CompleteSubtitleStream extends ProbeStream {
  codec_name: string;
  disposition: Record<string, unknown>;
  index: number;
  tags: Record<string, unknown>;
}

const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(["en"], {
  fallback: "none",
  type: "language",
});

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

function optionalIdentifiedMetadata(value: unknown): boolean {
  return value === undefined || identifiedMetadata(value);
}

function normalizedLanguageName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toLowerCase();
  if (code === "und") {
    return "und";
  }
  try {
    return ENGLISH_LANGUAGE_NAMES.of(code)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function expectedLanguageName(languageCode: string): string {
  return normalizedLanguageName(languageCode) ?? "und";
}

function expectedVobSubTitle(contentLabel: string): string | null {
  switch (contentLabel.trim().toLowerCase()) {
    case "undefined":
    case "normal":
    case "reserved":
    case "forced":
      return null;
    case "large":
      return "large type";
    case "children":
      return "children";
    case "normal_cc":
      return "closed caption";
    case "large_cc":
      return "closed caption, large type";
    case "children_cc":
      return "closed caption, children";
    case "director":
      return "commentary";
    case "large_director":
      return "commentary, large type";
    case "children_director":
      return "commentary, children";
    default:
      throw new Error("Encode output subtitle expectation is invalid");
  }
}

function isProbeFlag(value: unknown): boolean {
  return value === 0 || value === 1;
}

function hasCompleteSubtitleMetadata(
  value: unknown,
): value is CompleteSubtitleStream {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const stream = value as ProbeStream;
  if (
    !Number.isSafeInteger(stream.index) ||
    (stream.index as number) < 0 ||
    !identifiedMetadata(stream.codec_name) ||
    typeof stream.disposition !== "object" ||
    stream.disposition === null ||
    Array.isArray(stream.disposition) ||
    (stream.tags !== undefined &&
      (typeof stream.tags !== "object" ||
        stream.tags === null ||
        Array.isArray(stream.tags)))
  ) {
    return false;
  }
  const disposition = stream.disposition as Record<string, unknown>;
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  return (
    isProbeFlag(disposition.default) &&
    isProbeFlag(disposition.forced) &&
    normalizedLanguageName(tags.language) !== null &&
    optionalIdentifiedMetadata(tags.title)
  );
}

function packetCount(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
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

function sourceVobSubStreams(
  streams: readonly CompleteSubtitleStream[],
): readonly CompleteSubtitleStream[] {
  const vobSubStreams = streams.filter(
    (stream) => stream.codec_name === "dvd_subtitle",
  );
  const foreignAudioSearchStreams = vobSubStreams.filter((stream) => {
    return (
      stream.disposition.default === 1 && stream.disposition.forced === 1
    );
  });
  if (foreignAudioSearchStreams.length > 1) {
    throw validationError(
      "more than one foreign-audio-search VobSub stream was produced",
    );
  }
  const sourceStreams = vobSubStreams.filter(
    (stream) => !foreignAudioSearchStreams.includes(stream),
  );
  if (
    sourceStreams.some(
      (stream) =>
        stream.disposition.default !== 0 || stream.disposition.forced !== 0,
    )
  ) {
    throw validationError(
      "a source VobSub stream has an unexpected default or forced disposition",
    );
  }
  return sourceStreams;
}

function validateExpectedVobSubStreams(
  sourceStreams: readonly CompleteSubtitleStream[],
  expectations: readonly EncodeOutputVobSubExpectation[] | undefined,
): void {
  if (expectations === undefined) {
    return;
  }
  if (!Array.isArray(expectations)) {
    throw new Error("Encode output subtitle expectation is invalid");
  }
  for (const expectation of expectations) {
    if (
      typeof expectation !== "object" ||
      expectation === null ||
      Array.isArray(expectation) ||
      (expectation.contentLabel !== undefined &&
        !identifiedMetadata(expectation.contentLabel)) ||
      (expectation.languageCode !== undefined &&
        !identifiedMetadata(expectation.languageCode))
    ) {
      throw new Error("Encode output subtitle expectation is invalid");
    }
  }
  if (sourceStreams.length !== expectations.length) {
    throw validationError(
      `expected ${expectations.length} source VobSub stream${expectations.length === 1 ? "" : "s"}, found ${sourceStreams.length}`,
    );
  }
  for (const [position, expectation] of expectations.entries()) {
    if (expectation.languageCode !== undefined) {
      const expectedLanguage = expectedLanguageName(expectation.languageCode);
      const actualLanguage = normalizedLanguageName(
        sourceStreams[position]!.tags.language,
      );
      if (actualLanguage !== expectedLanguage) {
        throw validationError(
          `source VobSub stream ${position + 1} has language ${String(sourceStreams[position]!.tags.language)}, expected ${expectation.languageCode}`,
        );
      }
    }
    if (expectation.contentLabel === undefined) {
      continue;
    }
    const expectedTitle = expectedVobSubTitle(expectation.contentLabel);
    const actualTitle = sourceStreams[position]!.tags.title;
    const normalizedActualTitle =
      typeof actualTitle === "string" ? actualTitle.trim().toLowerCase() : null;
    if (normalizedActualTitle !== expectedTitle) {
      throw validationError(
        `source VobSub stream ${position + 1} has title ${String(actualTitle)}, expected content ${expectation.contentLabel}`,
      );
    }
  }
}

function validatedSubtitleStreams(result: ProbeResult): CompleteSubtitleStream[] {
  if (!Array.isArray(result.streams)) {
    throw validationError("subtitle probe returned an invalid result");
  }
  const streams: CompleteSubtitleStream[] = [];
  const indexes = new Set<number>();
  for (const stream of result.streams) {
    if (!hasCompleteSubtitleMetadata(stream) || indexes.has(stream.index)) {
      throw validationError("subtitle stream metadata is incomplete");
    }
    indexes.add(stream.index);
    streams.push(stream);
  }
  return streams;
}

function validateVobSubPacketCounts(
  result: ProbeResult,
  expectedIndexes: ReadonlySet<number>,
): ReadonlySet<number> {
  if (!Array.isArray(result.streams)) {
    throw validationError("subtitle packet probe returned an invalid result");
  }
  const observedIndexes = new Set<number>();
  const emptyIndexes = new Set<number>();
  for (const value of result.streams) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw validationError("subtitle packet probe returned an invalid result");
    }
    const stream = value as ProbeStream;
    if (stream.codec_name !== "dvd_subtitle") {
      continue;
    }
    if (!Number.isSafeInteger(stream.index)) {
      throw validationError("subtitle packet probe returned an invalid result");
    }
    const index = stream.index as number;
    if (!expectedIndexes.has(index) || observedIndexes.has(index)) {
      throw validationError("subtitle packet probe returned an invalid result");
    }
    const count =
      stream.nb_read_packets === undefined
        ? 0
        : packetCount(stream.nb_read_packets);
    if (count === null) {
      throw validationError("subtitle packet probe returned an invalid result");
    }
    observedIndexes.add(index);
    if (count === 0) {
      emptyIndexes.add(index);
    }
  }
  for (const index of expectedIndexes) {
    if (!observedIndexes.has(index)) {
      throw validationError("subtitle packet probe returned an invalid result");
    }
  }
  return emptyIndexes;
}

async function validateSubtitleStreams({
  expectations,
  outputPath,
  repairer,
  runMediaTool,
  signal,
  subtitlePacketTimeoutMs,
  timeoutMs,
}: {
  expectations: EncodeOutputValidationExpectations;
  outputPath: string;
  repairer: EncodeOutputRepairer;
  runMediaTool: MediaToolRunner;
  signal: AbortSignal;
  subtitlePacketTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  let removedEmptyStreams = false;
  while (true) {
    const subtitleProbe = parseProbeResult(
      (
        await runTool(
          runMediaTool,
          {
            arguments_: [
              "-v",
              "error",
              "-select_streams",
              "s",
              "-show_entries",
              "stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced",
              "-of",
              "json",
              outputPath,
            ],
            executable: "ffprobe",
            signal,
            timeoutMs,
          },
          "subtitle probe",
        )
      ).stdout,
      "subtitle",
    );
    const subtitleStreams = validatedSubtitleStreams(subtitleProbe);
    const vobSubIndexes = new Set(
      subtitleStreams
        .filter((stream) => stream.codec_name === "dvd_subtitle")
        .map((stream) => stream.index),
    );
    if (vobSubIndexes.size === 0) {
      validateExpectedVobSubStreams(
        sourceVobSubStreams(subtitleStreams),
        expectations.expectedVobSubStreams,
      );
      return;
    }
    const packetProbeRun = await runTool(
      runMediaTool,
      {
        arguments_: [
          "-v",
          "error",
          "-select_streams",
          "s",
          "-count_packets",
          "-show_entries",
          "stream=index,codec_name,nb_read_packets",
          "-of",
          "json",
          outputPath,
        ],
        executable: "ffprobe",
        signal,
        timeoutMs: subtitlePacketTimeoutMs,
      },
      "subtitle packet probe",
    );
    if (packetProbeRun.stderr.trim().length > 0) {
      throw validationError("subtitle packet probe reported unreadable data");
    }
    const packetProbe = parseProbeResult(
      packetProbeRun.stdout,
      "subtitle packet",
    );
    const emptyIndexes = validateVobSubPacketCounts(
      packetProbe,
      vobSubIndexes,
    );
    if (emptyIndexes.size === 0) {
      validateExpectedVobSubStreams(
        sourceVobSubStreams(subtitleStreams),
        expectations.expectedVobSubStreams,
      );
      return;
    }
    if (removedEmptyStreams) {
      throw validationError("subtitle cleanup left an empty VobSub stream");
    }
    try {
      await repairer.removeEmptyVobSubStreams({
        emptyStreamIndexes: [...emptyIndexes],
        outputPath,
        retainedSubtitleDispositions: subtitleStreams
          .filter((stream) => !emptyIndexes.has(stream.index))
          .map((stream) => ({
            default: stream.disposition.default === 1,
            forced: stream.disposition.forced === 1,
          })),
        signal,
        timeoutMs: subtitlePacketTimeoutMs,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw validationError(
        `subtitle cleanup failed: ${normalizeToolError(error)}`,
      );
    }
    removedEmptyStreams = true;
  }
}

export function createNodeEncodeOutputValidator({
  repairer,
  runMediaTool = runNodeMediaTool,
  subtitlePacketTimeoutMs = DEFAULT_SUBTITLE_PACKET_TIMEOUT_MS,
  timeoutMs = DEFAULT_MEDIA_TOOL_TIMEOUT_MS,
}: {
  repairer?: EncodeOutputRepairer;
  runMediaTool?: MediaToolRunner;
  subtitlePacketTimeoutMs?: number;
  timeoutMs?: number;
} = {}): EncodeOutputValidator {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(subtitlePacketTimeoutMs) ||
    subtitlePacketTimeoutMs <= 0
  ) {
    throw new Error("Encode output validation timeout is invalid");
  }
  const outputRepairer =
    repairer ?? createNodeEncodeOutputRepairer({ runMediaTool });
  return {
    async validate(outputPath, signal, expectations = {}) {
      signal.throwIfAborted();
      await validateSubtitleStreams({
        expectations,
        outputPath,
        repairer: outputRepairer,
        runMediaTool,
        signal,
        subtitlePacketTimeoutMs,
        timeoutMs,
      });

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
