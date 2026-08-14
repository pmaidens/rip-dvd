import { describe, expect, it } from "vitest";

import { createDvdMetadataFingerprint } from "./dvd-metadata-fingerprint.js";

describe("DVD metadata fingerprint", () => {
  const title = {
    number: 1,
    durationSeconds: 60,
    chapters: 1,
    audioStreams: [{ id: 128, language: "English" }],
    subtitles: [{ id: 32, language: "English" }],
  };

  it("is deterministic across title and stream ordering", () => {
    const input = {
      sizeBytes: 4_700_000_000,
      titles: [
        { ...title, number: 2 },
        {
          ...title,
          audioStreams: [{ id: 129 }, { id: 128 }],
          subtitles: [{ id: 33 }, { id: 32 }],
        },
      ],
      volumeLabel: " SAMPLE_DISC ",
    };

    expect(createDvdMetadataFingerprint(input)).toBe(
      createDvdMetadataFingerprint({
        ...input,
        titles: [
          {
            ...input.titles[1]!,
            audioStreams: [...input.titles[1]!.audioStreams].reverse(),
            subtitles: [...input.titles[1]!.subtitles].reverse(),
          },
          input.titles[0]!,
        ],
      }),
    );
    expect(createDvdMetadataFingerprint(input)).toMatch(
      /^dvdmeta-sha256:[0-9a-f]{64}$/,
    );
  });

  it("changes when identifying metadata or the declared size changes", () => {
    const base = createDvdMetadataFingerprint({
      sizeBytes: 1_024,
      titles: [title],
      volumeLabel: "DISC_A",
    });

    expect(createDvdMetadataFingerprint({
      sizeBytes: 2_048,
      titles: [title],
      volumeLabel: "DISC_A",
    })).not.toBe(base);
    expect(createDvdMetadataFingerprint({
      sizeBytes: 1_024,
      titles: [title],
      volumeLabel: "DISC_B",
    })).not.toBe(base);
  });
});
