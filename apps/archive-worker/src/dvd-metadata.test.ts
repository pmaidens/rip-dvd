import { describe, expect, it } from "vitest";

import {
  decodeLsdvdMetadata,
  decodeLsdvdNavigationMetadata,
} from "./dvd-metadata.js";

describe("lsdvd metadata decoder", () => {
  it("decodes a reviewable title map with Bookworm stream labels", () => {
    const output = [
      "Disc Title: LANGUAGE_DISC",
      "Title: 01, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 1, Subpictures: 1",
      "  Audio: 1, Language:  - Not Specified, Format: ac3, Frequency: 48000, Quantization: drc, Channels: 2, AP: 0, Content: Normal, Stream id: 0x80",
      "  Subtitle: 1, Language: lv - Latvian, Lettish, Content: Normal, Stream id: 0x20,",
    ].join("\n");

    expect(decodeLsdvdMetadata(output)).toEqual({
      volumeLabel: "LANGUAGE_DISC",
      titles: [
        {
          number: 1,
          durationSeconds: 600,
          chapters: 2,
          audioStreams: [
            {
              id: 128,
              language: "Not Specified",
              format: "ac3",
              channels: 2,
            },
          ],
          subtitles: [
            {
              id: 32,
              languageCode: "lv",
              language: "Latvian, Lettish",
              content: "Normal",
            },
          ],
        },
      ],
    });
  });

  it("associates each title with its title set in the shared decoder", () => {
    const output = [
      "Disc Title: SHARED_VTS_DISC",
      "Title: 1, Length: 00:10:00.000 Chapters: 2, Cells: 2, Audio streams: 0, Subpictures: 0",
      "  VTS: 01, TTN: 01, FPS: 29.97, Format: NTSC, Aspect ratio: 4/3, Width: 720, Height: 480, DF: Letterbox",
      "Title: 2, Length: 00:05:00.000 Chapters: 1, Cells: 1, Audio streams: 0, Subpictures: 0",
      "  VTS: 01, TTN: 02, FPS: 29.97, Format: NTSC, Aspect ratio: 4/3, Width: 720, Height: 480, DF: Letterbox",
    ].join("\n");

    const decoded = decodeLsdvdNavigationMetadata(output);

    expect([...decoded.titleSetsByTitleNumber]).toEqual([[1, 1], [2, 1]]);
    expect(decoded.titles.map((title) => title.number)).toEqual([1, 2]);
  });
});
