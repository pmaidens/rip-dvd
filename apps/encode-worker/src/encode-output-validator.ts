import { execFile } from "node:child_process";

import type {
  EncodeJobFailureEvidence,
  EncodeJobFailureValidationCheck,
  EncodeOutputValidationEvidence,
} from "@rip-dvd/data-access";

import type { EncodeOutputRepairCompletion } from "./encode-output-completion.js";
import type { HandBrakeVobSubProvenance } from "./handbrake-subtitle-provenance.js";
import {
  createNodeEncodeOutputRepairer,
  type EncodeOutputRepairer,
} from "./encode-output-repairer.js";

const DEFAULT_MEDIA_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_SUBTITLE_PACKET_TIMEOUT_MS = 5 * 60_000;
const MAX_MEDIA_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_VIDEO_START_DELAY_SECONDS = 5;
const MINIMUM_FULL_TITLE_DURATION_RATIO = 0.98;
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
  prepareAndValidate(
    outputPath: string,
    signal: AbortSignal,
    expectations?: EncodeOutputValidationExpectations,
  ): Promise<EncodeOutputValidationEvidence | void>;
}

export interface EncodeOutputValidationExpectations {
  expectedAudioSourceIds?: readonly number[];
  audioOutputSourceIds?: readonly number[];
  expectedDurationSeconds?: number;
  expectedVobSubStreams?: readonly EncodeOutputVobSubExpectation[];
  vobSubProvenance?: readonly HandBrakeVobSubProvenance[];
}

export interface EncodeOutputVobSubExpectation {
  languageCode?: string;
  sourceTrackNumber?: number;
  title?: string | null;
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
  format?: unknown;
  packets?: unknown;
  streams?: unknown;
}

interface ProbeFormat {
  duration?: unknown;
}

interface SubtitleStreamMetadata extends ProbeStream {
  codec_name: string;
  disposition: Record<string, unknown>;
  index: number;
  tags?: Record<string, unknown>;
}

interface CompleteSubtitleStream extends SubtitleStreamMetadata {
  tags: Record<string, unknown>;
}

const ENGLISH_LANGUAGE_NAMES = new Intl.DisplayNames(["en"], {
  fallback: "none",
  type: "language",
});

type EncodeOutputFailureEvidence = Extract<
  EncodeJobFailureEvidence,
  { kind: "duration" | "validation_check" }
>;

export class EncodeOutputValidationError extends Error {
  repairCompletion?: EncodeOutputRepairCompletion;

  constructor(
    message: string,
    readonly evidence: EncodeOutputFailureEvidence,
    readonly retentionSafe = true,
  ) {
    super(`Encode output validation failed: ${message}`);
    this.name = "EncodeOutputValidationError";
  }
}

function validationError(
  check: EncodeJobFailureValidationCheck,
  message: string,
  evidence: EncodeOutputFailureEvidence = {
    kind: "validation_check",
    check,
  },
): EncodeOutputValidationError {
  return new EncodeOutputValidationError(message, evidence);
}

function storageFault(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return ["EIO", "ENOSPC", "EDQUOT", "EROFS", "ESTALE", "ENODEV", "ENXIO"].includes(code) ||
    /input\/output error|no space left|disk quota exceeded|read-only file system|stale file handle/i.test(normalizeToolError(error));
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

function parseProbeResult(
  stdout: string,
  description: string,
  check: EncodeJobFailureValidationCheck,
): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw validationError(check, `${description} probe returned invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw validationError(
      check,
      `${description} probe returned an invalid result`,
    );
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

function outputDurationSeconds(result: ProbeResult): number | null {
  if (
    typeof result.format !== "object" ||
    result.format === null ||
    Array.isArray(result.format)
  ) {
    return null;
  }
  const value = (result.format as ProbeFormat).duration;
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
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

function isProbeFlag(value: unknown): boolean {
  return value === 0 || value === 1;
}

function hasValidSubtitleMetadata(
  value: unknown,
): value is SubtitleStreamMetadata {
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
    (tags.language === undefined ||
      normalizedLanguageName(tags.language) !== null) &&
    optionalIdentifiedMetadata(tags.title)
  );
}

function packetCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
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
  check: EncodeJobFailureValidationCheck,
): Promise<MediaToolRunResult> {
  let result: MediaToolRunResult;
  try {
    result = await runMediaTool(request);
  } catch (error) {
    request.signal.throwIfAborted();
    throw new EncodeOutputValidationError(`${description} failed: ${normalizeToolError(error)}`,
      { kind: "validation_check", check }, !storageFault(error));
  }
  if (storageFault(result.stderr)) {
    throw new EncodeOutputValidationError(`${description} reported a storage fault: ${result.stderr}`,
      { kind: "validation_check", check }, false);
  }
  return result;
}

function sourceVobSubStreams(
  streams: readonly CompleteSubtitleStream[],
  expectations?: readonly EncodeOutputVobSubExpectation[],
  provenance?: readonly HandBrakeVobSubProvenance[],
  declaredExpectations = expectations,
): readonly CompleteSubtitleStream[] {
  const vobSubStreams = streams.filter(
    (stream) => stream.codec_name === "dvd_subtitle",
  );
  if (provenance !== undefined) {
    if (
      !Array.isArray(provenance) ||
      !Array.isArray(expectations) ||
      expectations.some((source) =>
        typeof source !== "object" || source === null ||
        !Number.isSafeInteger(source.sourceTrackNumber) || source.sourceTrackNumber! < 1,
      ) ||
      new Set(expectations.map((source) => source.sourceTrackNumber)).size !== expectations.length
    ) {
      throw validationError("subtitle_streams", "subtitle source provenance is invalid");
    }
    if (provenance.length !== vobSubStreams.length) {
      throw validationError(
        "subtitle_streams",
        `expected ${provenance.length} VobSub output streams, found ${vobSubStreams.length}`,
      );
    }
    const sourceStreams = new Map<number, CompleteSubtitleStream>();
    let searchCount = 0;
    for (const [position, track] of provenance.entries()) {
      // A derived search track can survive cleanup of its empty source track.
      const expectation = declaredExpectations?.find(
        (source) => source.sourceTrackNumber === track?.sourceTrackNumber,
      );
      if (
        !track || !expectation ||
        typeof track.default !== "boolean" || typeof track.forced !== "boolean" ||
        (track.kind !== "source" && track.kind !== "foreign_audio_search")
      ) {
        throw validationError("subtitle_streams", "subtitle source provenance is invalid");
      }
      const stream = vobSubStreams[position]!;
      if (
        stream.disposition.default !== Number(track.default) ||
        stream.disposition.forced !== Number(track.forced)
      ) {
        throw validationError(
          "subtitle_streams",
          "a VobSub stream has a disposition inconsistent with HandBrake source provenance",
        );
      }
      if (track.kind === "source") {
        if (sourceStreams.has(track.sourceTrackNumber)) {
          throw validationError("subtitle_streams", "a source VobSub stream was counted more than once");
        }
        sourceStreams.set(track.sourceTrackNumber, stream);
      } else {
        if (++searchCount > 1 || !track.forced) {
          throw validationError("subtitle_streams", "foreign-audio-search VobSub provenance is invalid");
        }
        validateExpectedVobSubStreams([stream], [expectation]);
      }
    }
    const sources = expectations.flatMap((source) => {
      const stream = sourceStreams.get(source.sourceTrackNumber!);
      return stream ? [stream] : [];
    });
    // Exact source coverage is checked independently of derived search tracks.
    validateExpectedVobSubStreams(sources, expectations);
    return sources;
  }
  const foreignAudioSearchStreams = vobSubStreams.filter((stream) => {
    return (
      stream.disposition.default === 1 && stream.disposition.forced === 1
    );
  });
  if (foreignAudioSearchStreams.length > 1) {
    throw validationError(
      "subtitle_streams",
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
      "subtitle_streams",
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
      (expectation.languageCode !== undefined &&
        !identifiedMetadata(expectation.languageCode)) ||
      (expectation.title !== undefined && expectation.title !== null &&
        !identifiedMetadata(expectation.title))
    ) {
      throw new Error("Encode output subtitle expectation is invalid");
    }
  }
  if (sourceStreams.length !== expectations.length) {
    throw validationError(
      "subtitle_streams",
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
          "subtitle_streams",
          `source VobSub stream ${position + 1} has language ${String(sourceStreams[position]!.tags.language)}, expected ${expectation.languageCode}`,
        );
      }
    }
    if (expectation.title === undefined) {
      continue;
    }
    const expectedTitle = expectation.title?.trim().toLowerCase() ?? null;
    const actualTitle = sourceStreams[position]!.tags.title;
    const normalizedActualTitle =
      typeof actualTitle === "string" ? actualTitle.trim().toLowerCase() : null;
    if (normalizedActualTitle !== expectedTitle) {
      throw validationError(
        "subtitle_streams",
        `source VobSub stream ${position + 1} has title ${String(actualTitle)}, expected title ${String(expectation.title)}`,
      );
    }
  }
}

function validatedSubtitleStreams(result: ProbeResult): CompleteSubtitleStream[] {
  if (!Array.isArray(result.streams)) {
    throw validationError(
      "subtitle_streams",
      "subtitle probe returned an invalid result",
    );
  }
  const streams: CompleteSubtitleStream[] = [];
  const indexes = new Set<number>();
  for (const stream of result.streams) {
    if (!hasValidSubtitleMetadata(stream) || indexes.has(stream.index)) {
      throw validationError(
        "subtitle_streams",
        "subtitle stream metadata is incomplete",
      );
    }
    indexes.add(stream.index);
    // ffprobe may omit an unspecified language. Match the source scan's und
    // without treating an explicit malformed value as an unspecified language.
    streams.push({
      ...stream,
      tags: {
        ...stream.tags,
        language: stream.tags?.language === undefined ? "und" : stream.tags.language,
      },
    });
  }
  return streams;
}

function validateVobSubPacketCounts(
  result: ProbeResult,
  expectedIndexes: ReadonlySet<number>,
): ReadonlySet<number> {
  if (!Array.isArray(result.streams)) {
    throw validationError(
      "subtitle_packets",
      "subtitle packet probe returned an invalid result",
    );
  }
  const observedIndexes = new Set<number>();
  const emptyIndexes = new Set<number>();
  for (const value of result.streams) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw validationError(
        "subtitle_packets",
        "subtitle packet probe returned an invalid result",
      );
    }
    const stream = value as ProbeStream;
    if (stream.codec_name !== "dvd_subtitle") {
      continue;
    }
    if (!Number.isSafeInteger(stream.index)) {
      throw validationError(
        "subtitle_packets",
        "subtitle packet probe returned an invalid result",
      );
    }
    const index = stream.index as number;
    if (!expectedIndexes.has(index) || observedIndexes.has(index)) {
      throw validationError(
        "subtitle_packets",
        "subtitle packet probe returned an invalid result",
      );
    }
    const count =
      stream.nb_read_packets === undefined
        ? 0
        : packetCount(stream.nb_read_packets);
    if (count === null) {
      throw validationError(
        "subtitle_packets",
        "subtitle packet probe returned an invalid result",
      );
    }
    observedIndexes.add(index);
    if (count === 0) {
      emptyIndexes.add(index);
    }
  }
  for (const index of expectedIndexes) {
    if (!observedIndexes.has(index)) {
      throw validationError(
        "subtitle_packets",
        "subtitle packet probe returned an invalid result",
      );
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
  onRepairCompleted,
}: {
  onRepairCompleted(completion: EncodeOutputRepairCompletion): void;
  expectations: EncodeOutputValidationExpectations;
  outputPath: string;
  repairer: EncodeOutputRepairer;
  runMediaTool: MediaToolRunner;
  signal: AbortSignal;
  subtitlePacketTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  let removedEmptyStreams = false;
  let expectedVobSubStreams = expectations.expectedVobSubStreams;
  let vobSubProvenance = expectations.vobSubProvenance;
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
          "subtitle_streams",
        )
      ).stdout,
      "subtitle",
      "subtitle_streams",
    );
    const subtitleStreams = validatedSubtitleStreams(subtitleProbe);
    const sourceStreams = sourceVobSubStreams(
      subtitleStreams,
      expectedVobSubStreams,
      vobSubProvenance,
      expectations.expectedVobSubStreams,
    );
    validateExpectedVobSubStreams(sourceStreams, expectedVobSubStreams);
    const vobSubIndexes = new Set(
      subtitleStreams
        .filter((stream) => stream.codec_name === "dvd_subtitle")
        .map((stream) => stream.index),
    );
    if (vobSubIndexes.size === 0) {
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
      "subtitle_packets",
    );
    if (packetProbeRun.stderr.trim().length > 0) {
      throw validationError(
        "subtitle_packets",
        "subtitle packet probe reported unreadable data",
      );
    }
    const packetProbe = parseProbeResult(
      packetProbeRun.stdout,
      "subtitle packet",
      "subtitle_packets",
    );
    const emptyIndexes = validateVobSubPacketCounts(
      packetProbe,
      vobSubIndexes,
    );
    if (emptyIndexes.size === 0) {
      return;
    }
    if (removedEmptyStreams) {
      throw validationError(
        "subtitle_cleanup",
        "subtitle cleanup left an empty VobSub stream",
      );
    }
    // Match the complete declared source list before forgiving any empty tracks.
    // Filter by source position, since remuxing can renumber stream indexes.
    expectedVobSubStreams = expectedVobSubStreams?.filter(
      (_, position) => !emptyIndexes.has(sourceStreams[position]!.index),
    );
    const vobSubStreams = subtitleStreams.filter(
      (stream) => stream.codec_name === "dvd_subtitle",
    );
    vobSubProvenance = vobSubProvenance?.filter(
      (_, position) => !emptyIndexes.has(vobSubStreams[position]!.index),
    );
    try {
      const completion = await repairer.removeEmptyVobSubStreams({
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
      if (completion !== undefined) onRepairCompleted(completion);
    } catch (error) {
      signal.throwIfAborted();
      throw new EncodeOutputValidationError(`subtitle cleanup failed: ${normalizeToolError(error)}`,
        { kind: "validation_check", check: "subtitle_cleanup" }, error instanceof EncodeOutputValidationError && error.retentionSafe);
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
    repairer ?? createNodeEncodeOutputRepairer({ runMediaTool: (request) => runTool(runMediaTool, request, "subtitle cleanup", "subtitle_cleanup") });
  return {
    async prepareAndValidate(outputPath, signal, expectations = {}): Promise<EncodeOutputValidationEvidence> {
      signal.throwIfAborted();
      if (expectations.expectedAudioSourceIds !== undefined &&
        (expectations.expectedAudioSourceIds.some((id) => !Number.isSafeInteger(id) || id < 0) ||
          new Set(expectations.expectedAudioSourceIds).size !== expectations.expectedAudioSourceIds.length)) {
        throw new Error("Encode output audio expectation is invalid");
      }
      if (
        expectations.expectedDurationSeconds !== undefined &&
        (!Number.isFinite(expectations.expectedDurationSeconds) ||
          expectations.expectedDurationSeconds <= 0)
      ) {
        throw new Error("Encode output duration expectation is invalid");
      }
      let repairCompletion: EncodeOutputRepairCompletion | undefined;
      try {
        await validateSubtitleStreams({
          onRepairCompleted: (completion) => { repairCompletion = completion; },
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
                  "format=duration:stream=codec_name,profile,pix_fmt:packet=pts_time",
                  "-of",
                  "json",
                  outputPath,
                ],
                executable: "ffprobe",
                signal,
                timeoutMs,
              },
              "video probe",
              "video_metadata",
            )
          ).stdout,
          "video",
          "video_metadata",
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
          throw validationError(
            "video_metadata",
            "video stream metadata is incomplete",
          );
        }
        if (expectations.expectedDurationSeconds !== undefined) {
          const outputDuration = outputDurationSeconds(videoProbe);
          if (outputDuration === null) {
            throw validationError(
              "duration_metadata",
              "output duration metadata is unavailable",
            );
          }
          if (
            outputDuration <
            expectations.expectedDurationSeconds *
              MINIMUM_FULL_TITLE_DURATION_RATIO
          ) {
            throw validationError(
              "duration_metadata",
              `output duration ${outputDuration} seconds is materially shorter than the expected ${expectations.expectedDurationSeconds} seconds`,
              {
                kind: "duration",
                expectedSeconds: expectations.expectedDurationSeconds,
                observedSeconds: outputDuration,
              },
            );
          }
        }
        const videoFirstPts = firstPacketPts(videoProbe);
        if (videoFirstPts === null) {
          throw validationError(
            "video_packets",
            "video stream has no readable first packet",
          );
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
                  expectations.expectedAudioSourceIds === undefined ? "a:0" : "a",
                  "-read_intervals",
                  "%+#1",
                  "-show_entries",
                  expectations.expectedAudioSourceIds === undefined ? "packet=pts_time" : "stream=index:packet=pts_time",
                  "-of",
                  "json",
                  outputPath,
                ],
                executable: "ffprobe",
                signal,
                timeoutMs,
              },
              "audio probe",
              "audio_timing",
            )
          ).stdout,
          "audio",
          "audio_timing",
        );
        let audioFirstPts = firstPacketPts(audioProbe);
        const observedAudioStreams = Array.isArray(audioProbe.streams) ? audioProbe.streams.length : null;
        const audioFirstPackets: number[] | null = expectations.expectedAudioSourceIds === undefined ? null : [];
        if (expectations.expectedAudioSourceIds !== undefined) {
          const required = expectations.expectedAudioSourceIds;
          const outputs = expectations.audioOutputSourceIds;
          if (outputs === undefined || observedAudioStreams !== outputs.length ||
            outputs.some((id) => !required.includes(id)) || required.some((id) => !outputs.includes(id))) {
            throw validationError("audio_timing", "required audio source coverage does not match the source claim");
          }
          for (let index = 0; index < outputs.length; index++) {
            const packets = parseProbeResult((await runTool(runMediaTool, {
              arguments_: ["-v", "error", "-select_streams", `a:${index}`, "-read_intervals", "%+#1",
                "-show_entries", "packet=pts_time", "-of", "json", outputPath],
              executable: "ffprobe", signal, timeoutMs,
            }, "required audio packet probe", "audio_timing")).stdout, "required audio packet", "audio_timing");
            const first = firstPacketPts(packets);
            if (first === null) throw validationError("audio_timing", "required audio stream has no readable first packet");
            audioFirstPackets!.push(first);
          }
          audioFirstPts = audioFirstPackets![0] ?? null;
        }
        const videoStartDelay = videoFirstPts - (audioFirstPts ?? 0);
        if (videoStartDelay > MAX_VIDEO_START_DELAY_SECONDS) {
          throw validationError(
            "audio_timing",
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
          "video_decode",
        );
        const decodedFrames = [...decodeResult.stdout.matchAll(/^frame=(\d+)$/gm)]
          .map((match) => Number.parseInt(match[1]!, 10))
          .reduce((maximum, frames) => Math.max(maximum, frames), 0);
        if (decodedFrames === 0) {
          throw validationError(
            "video_decode",
            `the first ${VALIDATION_DECODE_SECONDS} seconds decoded zero video frames`,
          );
        }
        if (!/^progress=end$/m.test(decodeResult.stdout)) {
          throw validationError(
            "video_decode",
            "the bounded video decode did not complete",
          );
        }
        return {
          policyVersion: "encode-output-validation-v1",
          duration: { expectedSeconds: expectations.expectedDurationSeconds ?? null,
            minimumRatio: expectations.expectedDurationSeconds === undefined ? null : MINIMUM_FULL_TITLE_DURATION_RATIO,
            observedSeconds: outputDurationSeconds(videoProbe) },
          video: { codec: videoStream.codec_name as string, profile: videoStream.profile as string,
            pixelFormat: videoStream.pix_fmt as string, firstPacketSeconds: videoFirstPts },
          audio: { firstPacketSeconds: audioFirstPts, expectedSourceIds: expectations.expectedAudioSourceIds ?? null,
            outputSourceIds: expectations.audioOutputSourceIds ?? null,
            observedStreams: observedAudioStreams, firstPacketsSeconds: audioFirstPackets },
          subtitles: { expectedSourceStreams: expectations.expectedVobSubStreams?.length ?? null, checked: true },
          decode: { seconds: VALIDATION_DECODE_SECONDS, frames: decodedFrames, completed: true },
        };
      } catch (error) {
        if (error instanceof EncodeOutputValidationError && error.retentionSafe && repairCompletion !== undefined) {
          error.repairCompletion = repairCompletion;
        }
        throw error;
      }
    },
  };
}

export const nodeEncodeOutputValidator = createNodeEncodeOutputValidator();
