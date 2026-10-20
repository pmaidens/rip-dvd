import { MAX_DVD_SUBTITLES_PER_TITLE } from "@rip-dvd/data-access";

import {
  EncodeOutputValidationError,
  type EncodeOutputVobSubExpectation,
} from "./encode-output-validator.js";

const MAX_LINE_LENGTH = 65_536;
// Allow both closed-caption formats and one additional search result.
const MAX_OUTPUT_SUBTITLE_TRACKS = MAX_DVD_SUBTITLES_PER_TITLE + 3;

export interface HandBrakeVobSubProvenance {
  sourceTrackNumber: number;
  kind: "source" | "foreign_audio_search";
  default: boolean;
  forced: boolean;
}

interface SubtitleSelection {
  sourceTrackNumber: number;
  id: string;
  picture: boolean;
  default: boolean;
  forced: boolean;
}

interface SubtitleStatistics {
  sourceTrackNumber: number;
  hits: number;
  forced: number;
}

function invalidProvenance(): never {
  throw new EncodeOutputValidationError(
    "HandBrake subtitle provenance is incomplete or invalid",
    { kind: "validation_check", check: "subtitle_streams" },
  );
}

// HandBrake 1.9.2 logs the sanitized output list after foreign-audio search.
// Log source tracks are zero-based; JSON scan TrackNumber is one-based.
// Its scan statistics distinguish a complete source reused by the search from
// an additional forced-only subset. Keep only this bounded evidence, not logs.
// See libhb/work.c: analyze_subtitle_scan, sanitize_subtitles, hb_display_job_info.
export function createHandBrakeSubtitleProvenanceParser() {
  let buffer = "";
  let invalid = false;
  let task = "";
  let configuration = false;
  let selectedId: string | undefined;
  const statistics = new Map<string, SubtitleStatistics>();
  let selections: SubtitleSelection[] = [];

  function line(text: string): void {
    if (invalid) return;
    const value = text.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
    if (value.startsWith("Starting Task: ")) {
      task = value.slice("Starting Task: ".length);
      configuration = false;
      if (task === "Subtitle Scan") {
        statistics.clear();
        selectedId = undefined;
      }
      return;
    }
    if (value === "job configuration:") {
      configuration = task === "Encoding Pass" || task === "Analysis Pass";
      if (configuration) selections = [];
      return;
    }
    if (task === "Subtitle Scan") {
      const stats = /^Subtitle track (\d+) \(id 0x([\da-f]+)\) '.*': (\d+) hits \((\d+) forced\)$/.exec(value);
      if (stats) {
        const [, track, id, hits, forced] = stats;
        const count = Number(hits);
        const forcedCount = Number(forced);
        if (
          statistics.has(id!) ||
          statistics.size >= MAX_DVD_SUBTITLES_PER_TITLE ||
          !Number.isSafeInteger(count) ||
          !Number.isSafeInteger(forcedCount) ||
          forcedCount > count
        ) {
          invalid = true;
          return;
        }
        statistics.set(id!, {
          sourceTrackNumber: Number(track) + 1,
          hits: count,
          forced: forcedCount,
        });
      }
      const candidate = /^Found a subtitle candidate with id 0x([\da-f]+)(?: \(contains forced subs\))?$/.exec(value);
      if (candidate) {
        if (selectedId !== undefined) invalid = true;
        selectedId = candidate[1];
      }
    }
    if (configuration && value.startsWith("* subtitle track ")) {
      const selection = /^\* subtitle track (\d+), .* \(track (\d+), id 0x([\da-f]+), (Picture|Text)\) -> Passthru(, Forced Only)?(, Default)?$/.exec(value);
      if (
        !selection ||
        Number(selection[1]) !== selections.length + 1 ||
        selections.length >= MAX_OUTPUT_SUBTITLE_TRACKS
      ) {
        invalid = true;
        return;
      }
      selections.push({
        sourceTrackNumber: Number(selection[2]) + 1,
        id: selection[3]!,
        picture: selection[4] === "Picture",
        forced: selection[5] !== undefined,
        default: selection[6] !== undefined,
      });
    }
  }

  return {
    push(text: string) {
      // Consume stderr separately so stdout progress cannot split evidence lines.
      for (const part of text.split(/(?<=[\r\n])/)) {
        buffer += part;
        if (buffer.length > MAX_LINE_LENGTH) {
          invalid = true;
          buffer = "";
        }
        if (/[\r\n]$/.test(part)) {
          line(buffer.trimEnd());
          buffer = "";
        }
      }
    },
    finish(
      expectations: readonly EncodeOutputVobSubExpectation[],
    ): readonly HandBrakeVobSubProvenance[] {
      if (buffer) line(buffer);
      buffer = "";
      if (invalid || !configuration || task !== "Encoding Pass") invalidProvenance();
      const sourceNumbers = new Set(
        expectations.map((source) => source.sourceTrackNumber),
      );
      if (
        sourceNumbers.size !== expectations.length ||
        [...sourceNumbers].some((number) => !Number.isSafeInteger(number) || number! < 1)
      ) invalidProvenance();
      const result: HandBrakeVobSubProvenance[] = [];
      let searchCount = 0;
      for (const selection of selections.filter((selection) => selection.picture)) {
        if (!sourceNumbers.has(selection.sourceTrackNumber)) invalidProvenance();
        let kind: HandBrakeVobSubProvenance["kind"] = "source";
        if (selection.default || selection.forced) {
          const stats = statistics.get(selection.id);
          if (
            ++searchCount > 1 ||
            selection.id !== selectedId ||
            !stats ||
            stats.sourceTrackNumber !== selection.sourceTrackNumber ||
            stats.hits === 0 ||
            (selection.forced && stats.forced === 0)
          ) invalidProvenance();
          if (selection.forced && stats.forced < stats.hits) {
            kind = "foreign_audio_search";
          }
        }
        result.push({
          sourceTrackNumber: selection.sourceTrackNumber,
          kind,
          default: selection.default,
          forced: selection.forced,
        });
      }
      // A partial search result can never stand in for its complete source.
      for (const sourceTrackNumber of sourceNumbers) {
        const completeSources = result.filter(
          (track) => track.kind === "source" && track.sourceTrackNumber === sourceTrackNumber,
        );
        if (completeSources.length !== 1) invalidProvenance();
      }
      return result;
    },
  };
}
