import { describe, expect, it } from "vitest";

import { calculateCatalogReviewCoverage } from "./catalog-review-coverage";

describe("Catalog Review Coverage", () => {
  it("reports whole, unioned partial, overlapping, unmapped, and main-feature coverage", () => {
    const coverage = calculateCatalogReviewCoverage(
      [
        {
          number: 1,
          durationSeconds: 5_400,
          chapters: 12,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 2,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 3,
          durationSeconds: 1_800,
          chapters: 6,
          audioStreams: [],
          subtitles: [],
        },
        {
          number: 4,
          durationSeconds: 90,
          chapters: 1,
          audioStreams: [],
          subtitles: [],
        },
      ],
      [
        {
          mediaItemId: "movie",
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
        {
          mediaItemId: "episode-a",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 2,
            chapterStart: 1,
            chapterEnd: 3,
          },
        },
        {
          mediaItemId: "episode-b",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 2,
            chapterStart: 3,
            chapterEnd: 5,
          },
        },
        {
          mediaItemId: "episode-a",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 3,
            chapterStart: 1,
            chapterEnd: 3,
          },
        },
        {
          mediaItemId: "episode-b",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 3,
            chapterStart: 4,
            chapterEnd: 6,
          },
        },
        {
          mediaItemId: "movie",
          sourceIdentity: { kind: "main_feature" },
        },
      ],
    );

    expect(coverage).toEqual({
      discSelectionCount: 6,
      mediaItemsWithSelections: 3,
      mappedTitles: 2,
      partiallyMappedTitles: 1,
      unmappedTitles: 1,
      mainFeatureSelections: 1,
      titles: [
        {
          titleNumber: 1,
          status: "mapped",
          hasOverlap: false,
        },
        {
          titleNumber: 2,
          status: "partially_mapped",
          hasOverlap: true,
        },
        {
          titleNumber: 3,
          status: "mapped",
          hasOverlap: false,
        },
        {
          titleNumber: 4,
          status: "unmapped",
          hasOverlap: false,
        },
      ],
    });
  });

  it("warns when a whole-title selection overlaps an excerpt without double-counting", () => {
    const coverage = calculateCatalogReviewCoverage(
      [{
        number: 7,
        durationSeconds: 4_200,
        chapters: 10,
        audioStreams: [],
        subtitles: [],
      }],
      [
        {
          mediaItemId: "concert",
          sourceIdentity: { kind: "dvd_title", titleNumber: 7 },
        },
        {
          mediaItemId: "song",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 7,
            chapterStart: 3,
            chapterEnd: 4,
          },
        },
      ],
    );

    expect(coverage.mappedTitles).toBe(1);
    expect(coverage.partiallyMappedTitles).toBe(0);
    expect(coverage.titles[0]).toMatchObject({
      status: "mapped",
      hasOverlap: true,
    });
  });
});
