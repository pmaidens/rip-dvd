import { describe, expect, it } from "vitest";

import {
  decodeDvdTitleMap,
  MAX_DVD_AUDIO_STREAMS_PER_TITLE,
  MAX_DVD_TITLES,
} from "./dvd-scan.js";

describe("versioned DVD title-map contract", () => {
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
});
