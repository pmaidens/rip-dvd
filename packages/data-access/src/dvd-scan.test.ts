import { describe, expect, it } from "vitest";

import {
  decodeArchivedDvdTitles,
  decodeDvdTitleMap,
  isDvdContentId,
  MAX_DVD_AUDIO_STREAMS_PER_TITLE,
  MAX_DVD_SCAN_INTEGER,
  MAX_DVD_TITLES,
} from "./dvd-scan.js";

describe("versioned DVD title-map contract", () => {
  it("shares the versioned content identity validator", () => {
    expect(isDvdContentId(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isDvdContentId(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isDvdContentId("sha256:short")).toBe(false);
  });

  it("decodes bounded reviewable stream metadata from schema version 2", () => {
    const scan = {
      schemaVersion: 2,
      contentId:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      titles: [
        {
          number: 1,
          durationSeconds: 5_711,
          chapters: 12,
          audioStreams: [
            {
              id: 128,
              languageCode: "en",
              language: "English",
              format: "ac3",
              channels: 6,
            },
          ],
          subtitles: [
            {
              id: 32,
              languageCode: "fr",
              language: "Francais",
              content: "Normal",
            },
          ],
        },
      ],
    } as const;

    expect(decodeDvdTitleMap(scan)).toEqual(scan);
  });

  it("rejects unsupported, malformed, and resource-exhausting scan shapes", () => {
    const validTitle = {
      number: 1,
      durationSeconds: 60,
      chapters: 1,
      audioStreams: [],
      subtitles: [],
    };
    const contentId =
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    for (const value of [
      { schemaVersion: 1, contentId, titles: [validTitle] },
      { schemaVersion: 2, contentId: "summary-only", titles: [validTitle] },
      {
        schemaVersion: 2,
        contentId,
        titles: Array.from({ length: MAX_DVD_TITLES + 1 }, () => validTitle),
      },
      {
        schemaVersion: 2,
        contentId,
        titles: [
          {
            ...validTitle,
            audioStreams: Array.from(
              { length: MAX_DVD_AUDIO_STREAMS_PER_TITLE + 1 },
              (_, id) => ({ id }),
            ),
          },
        ],
      },
      {
        schemaVersion: 2,
        contentId,
        titles: [{ ...validTitle, durationSeconds: Number.MAX_SAFE_INTEGER }],
      },
    ]) {
      expect(decodeDvdTitleMap(value)).toBeNull();
    }
  });

  it("rejects duplicate source IDs within each title stream kind", () => {
    const contentId =
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const title = {
      number: 1,
      durationSeconds: 60,
      chapters: 1,
      audioStreams: [{ id: 128 }, { id: 128 }],
      subtitles: [],
    };

    expect(
      decodeDvdTitleMap({ schemaVersion: 2, contentId, titles: [title] }),
    ).toBeNull();
    expect(
      decodeDvdTitleMap({
        schemaVersion: 2,
        contentId,
        titles: [{
          ...title,
          audioStreams: [],
          subtitles: [{ id: 32 }, { id: 32 }],
        }],
      }),
    ).toBeNull();
  });

  it("decodes only bounded legacy archived title evidence", () => {
    expect(decodeArchivedDvdTitles({
      legacySchemaVersion: 1,
      titles: [{
        number: " 1 ",
        seconds: " 5400 ",
        chapters: " 8 ",
        audio_streams: " 2 ",
        subtitles: " 1 ",
      }],
    })).toEqual([{
      number: 1,
      durationSeconds: 5_400,
      chapters: 8,
      audioStreams: [{ id: 0 }, { id: 1 }],
      subtitles: [{ id: 0 }],
    }]);
    expect(decodeArchivedDvdTitles({
      legacySchemaVersion: 2,
      titles: [{ number: 1 }, { number: 1 }],
    })).toBeNull();
    expect(decodeArchivedDvdTitles({
      legacySchemaVersion: 2,
      titles: Array.from(
        { length: MAX_DVD_TITLES + 1 },
        (_, index) => ({ number: index + 1 }),
      ),
    })).toBeNull();
    expect(decodeArchivedDvdTitles({
      legacySchemaVersion: 2,
      titles: [{ number: 1, chapters: MAX_DVD_SCAN_INTEGER + 1 }],
    })).toBeNull();
  });
});
