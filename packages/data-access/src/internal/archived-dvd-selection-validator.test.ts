import { describe, expect, it } from "vitest";

import { DVD_TITLE_MAP_SCHEMA_VERSION } from "../dvd-scan.js";
import { createArchivedDvdSelectionValidator } from "./archived-dvd-selection-validator.js";

const archivedScan = {
  schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
  contentId: `sha256:${"a".repeat(64)}`,
  titles: [
    {
      number: 2,
      durationSeconds: 2_400,
      chapters: 8,
      audioStreams: [],
      subtitles: [],
    },
  ],
};

describe("archived DVD selection validator", () => {
  it("returns canonical coordinates and source keys from archived title evidence", () => {
    const validator = createArchivedDvdSelectionValidator(archivedScan);

    expect(validator.validate({
      kind: "dvd_chapters",
      titleNumber: 2,
      chapterStart: 3,
      chapterEnd: 6,
    })).toEqual({
      coordinates: {
        titleNumber: 2,
        chapterStart: 3,
        chapterEnd: 6,
      },
      sourceKey: "dvd:title:2:chapters:3-6",
    });
  });

  it("canonicalizes main feature and whole-title selections", () => {
    const validator = createArchivedDvdSelectionValidator(archivedScan);

    expect(validator.validate({ kind: "main_feature" })).toEqual({
      coordinates: {
        titleNumber: null,
        chapterStart: null,
        chapterEnd: null,
      },
      sourceKey: "dvd:main-feature",
    });
    expect(validator.validate({
      kind: "dvd_title",
      titleNumber: 2,
    })).toEqual({
      coordinates: {
        titleNumber: 2,
        chapterStart: null,
        chapterEnd: null,
      },
      sourceKey: "dvd:title:2",
    });
  });

  it("applies the same archived scan, title, and chapter bounds", () => {
    expect(() =>
      createArchivedDvdSelectionValidator(undefined).validate({
        kind: "dvd_title",
        titleNumber: 2,
      })
    ).toThrow(/reviewable DVD title map/);

    const validator = createArchivedDvdSelectionValidator(archivedScan);
    expect(() => validator.validate({
      kind: "dvd_title",
      titleNumber: 1,
    })).toThrow(/DVD title 1 is not present/);
    expect(() => validator.validate({
      kind: "dvd_chapters",
      titleNumber: 2,
      chapterStart: 6,
      chapterEnd: 5,
    })).toThrow(/greater than or equal to chapterStart/);
    expect(() => validator.validate({
      kind: "dvd_chapters",
      titleNumber: 2,
      chapterStart: 7,
      chapterEnd: 9,
    })).toThrow(/must not exceed DVD title 2's 8 chapters/);
  });

  it("rejects noncanonical persisted source keys before reading title evidence", () => {
    const validator = createArchivedDvdSelectionValidator(undefined);

    expect(() => validator.validate({
      kind: "dvd_title",
      titleNumber: 2,
    }, { persistedSourceKey: "caller:title-two" })).toThrow(
      /canonical Disc Selection source keys/,
    );
  });
});
