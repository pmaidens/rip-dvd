import type { BrowserRenditionRecord } from "@rip-dvd/data-access";
import type { EncodeOutputMediaStream } from "./encode-output-inspection.js";

export function browserVideoCanCopy(stream: EncodeOutputMediaStream) {
  return stream.codecName === "h264" && stream.pixelFormat === "yuv420p" &&
    ["Constrained Baseline", "Baseline", "Main", "High"].includes(stream.profile ?? "") &&
    stream.level != null && stream.level >= 10 && stream.level <= 42;
}
export const burnableSubtitleCodecs = ["dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "subrip", "ass", "ssa", "webvtt", "mov_text", "text"];
export function planBrowserRendition(streams: EncodeOutputMediaStream[] | null, burnSubtitleIndex: number | null): BrowserRenditionRecord["conversion"] {
  const subtitle = streams?.find((stream) => stream.kind === "subtitle" && stream.index === burnSubtitleIndex);
  const converted = streams?.filter((stream) => stream.kind === "video" || stream.kind === "audio").map((stream, outputIndex) => {
    const copy = stream.kind === "video" ? browserVideoCanCopy(stream) && !subtitle : stream.codecName === "aac" && stream.profile === "LC";
    return { sourceIndex: stream.index, outputIndex, kind: stream.kind as "video" | "audio", sourceCodec: stream.codecName,
      codec: copy ? stream.codecName! : stream.kind === "video" ? "h264" : "aac", mode: copy ? "copy" as const : "transcode" as const,
      language: stream.language, title: stream.title, default: stream.default, forced: stream.forced,
      differences: copy ? [] : stream.kind === "video" ? ["H.264 High, 8-bit yuv420p, level 4.1", "Scaled to at most 1920x1080", "30 fps", "CRF 20", ...(subtitle ? [`Subtitle stream ${subtitle.index} burned into video`] : [])]
        : ["AAC-LC", "Stereo audio", "48 kHz", "192 kbit/s"],
    };
  }) ?? null;
  return { kind: streams === null ? "undetermined" : converted?.some((stream) => stream.mode === "transcode") ? "h264_aac_transcode" : "stream_copy_remux", container: "mp4",
    copiedStreamIndexes: converted?.filter((stream) => stream.mode === "copy").map((stream) => stream.sourceIndex) ?? null,
    omittedStreamIndexes: streams?.filter((stream) => stream.kind !== "video" && stream.kind !== "audio" && stream.index !== subtitle?.index).map((stream) => stream.index) ?? null,
    subtitles: streams === null ? "unknown" : subtitle ? "burned_in" : streams.some((stream) => stream.kind === "subtitle") ? "omitted" : "none",
    containerDifferences: ["MKV to fast-start MP4", "Container metadata and chapters omitted"],
    streams: converted, burnedSubtitle: subtitle ? { sourceIndex: subtitle.index, subtitleOrdinal: streams!.filter((stream) => stream.kind === "subtitle").findIndex((stream) => stream.index === subtitle.index), codecName: subtitle.codecName!, language: subtitle.language, title: subtitle.title, forced: subtitle.forced } : null,
  };
}
