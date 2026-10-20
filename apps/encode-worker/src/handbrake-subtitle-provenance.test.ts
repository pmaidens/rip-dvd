import { describe, expect, it } from "vitest";

import { createHandBrakeSubtitleProvenanceParser } from "./handbrake-subtitle-provenance.js";
import { subtitleLog } from "./test-fixtures/handbrake-subtitle-log.js";

const sources = [
  { sourceTrackNumber: 1, languageCode: "eng", title: null },
  { sourceTrackNumber: 2, languageCode: "eng", title: null },
];

function parse(log: string) {
  const parser = createHandBrakeSubtitleProvenanceParser();
  parser.push(log);
  return parser.finish(sources);
}

describe("HandBrake subtitle provenance", () => {
  it("maps zero-based log source numbers to the one-based JSON scan", () => {
    expect(parse(subtitleLog())).toEqual([
      { sourceTrackNumber: 1, kind: "source", default: false, forced: false },
      { sourceTrackNumber: 2, kind: "source", default: false, forced: false },
    ]);
  });

  it("counts the all-forced source selected by search exactly once in its new output position", () => {
    expect(parse(subtitleLog({ search: true, reused: true }))).toEqual([
      { sourceTrackNumber: 2, kind: "source", default: true, forced: true },
      { sourceTrackNumber: 1, kind: "source", default: false, forced: false },
    ]);
  });

  it("keeps source identity across intervening text subtitles", () => {
    const parser = createHandBrakeSubtitleProvenanceParser();
    parser.push([
      "[00:00:03] Starting Task: Encoding Pass",
      "[00:00:03] job configuration:",
      "[00:00:03]  * subtitle track 1, English (track 0, id 0x100, Text) -> Passthru",
      "[00:00:03]  * subtitle track 2, English (track 1, id 0x21bd, Picture) -> Passthru",
    ].join("\n"));
    expect(parser.finish([sources[1]!])).toEqual([
      { sourceTrackNumber: 2, kind: "source", default: false, forced: false },
    ]);
  });

  it("keeps a filtered search result separate from both complete sources", () => {
    expect(parse(subtitleLog({ search: true }))).toEqual([
      { sourceTrackNumber: 2, kind: "foreign_audio_search", default: true, forced: true },
      { sourceTrackNumber: 1, kind: "source", default: false, forced: false },
      { sourceTrackNumber: 2, kind: "source", default: false, forced: false },
    ]);
  });

  it("recognizes a complete reused source when search disables the forced-only filter", () => {
    expect(parse(subtitleLog({ search: true, noForcedHits: true }))[0]).toEqual(
      { sourceTrackNumber: 2, kind: "source", default: true, forced: false },
    );
  });

  it("handles every chunk boundary and a final line without newline", () => {
    const log = subtitleLog({ search: true, reused: true }).trimEnd();
    const expected = parse(log);
    for (let split = 0; split <= log.length; split++) {
      const parser = createHandBrakeSubtitleProvenanceParser();
      parser.push(log.slice(0, split));
      parser.push(log.slice(split));
      expect(parser.finish(sources)).toEqual(expected);
    }
  });

  it("uses the final sanitized encoding pass rather than the analysis pass", () => {
    const analysis = subtitleLog().replace("Encoding Pass", "Analysis Pass");
    expect(parse(analysis + subtitleLog({ search: true, reused: true }))).toEqual(
      parse(subtitleLog({ search: true, reused: true })),
    );
  });

  const reusedLog = subtitleLog({ search: true, reused: true });
  it.each([
    ["absent output", ""],
    ["an analysis pass without an encoding pass", subtitleLog().replace("Encoding Pass", "Analysis Pass")],
    ["absent statistics", reusedLog.replace(/^.*40 hits.*\n/m, "")],
    ["absent candidate", reusedLog.replace(/^.*Found a subtitle candidate.*\n/m, "")],
    ["a partial search masking a missing source", reusedLog.replace("40 forced", "3 forced")],
    ["an incorrect candidate identity", reusedLog.replace("candidate with id 0x21bd", "candidate with id 0x22bd")],
    ["incorrect statistics source identity", reusedLog.replace("Subtitle track 1", "Subtitle track 0")],
    ["invalid statistics", reusedLog.replace("40 forced", "41 forced")],
    ["missing forced packets", reusedLog.replace("40 forced", "0 forced")],
    ["an unknown source", reusedLog.replace("(track 1,", "(track 9,")],
    ["a burned source", reusedLog.replace("-> Passthru", "-> Render/Burn-in")],
    ["nonsequential outputs", reusedLog.replace("* subtitle track 2", "* subtitle track 3")],
    ["a duplicate source", subtitleLog().replace("(track 1,", "(track 0,")],
    ["a truncated output line", reusedLog.slice(0, -10)],
    ["an oversized line", "x".repeat(65_537) + "\n" + reusedLog],
  ])("rejects %s", (_, log) => {
    expect(() => parse(log)).toThrow("HandBrake subtitle provenance is incomplete or invalid");
  });
});
