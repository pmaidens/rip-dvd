import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import titleSuggestionPolicy from "../../../fixtures/title-suggestion-policy.json";

import {
  CatalogReviewEvidence,
  formatVolumeLabel,
  titleSuggestion,
} from "./catalog-review-evidence";

describe("Catalog Review Title Suggestions", () => {
  it.each(titleSuggestionPolicy.cases)(
    "labels $durationSeconds seconds conservatively",
    ({ durationSeconds, suggestion }) => {
      expect(titleSuggestion(durationSeconds)).toBe(suggestion);
    },
  );
});

describe("Catalog Review volume-label formatting", () => {
  it.each([
    [
      "DOCTOR_WHO.S01_DISC_2_2005_SPECIAL_EDITION",
      "Doctor Who S01 Disc 2 2005 Special Edition",
    ],
    [
      "the_lord.of_the_rings_disc_2",
      "The Lord of the Rings Disc 2",
    ],
    ["Doctor_WHO.S01_DISC_2", "Doctor WHO S01 DISC 2"],
    ["  FEATURE___DISC...2   ", "Feature Disc 2"],
    ["", ""],
  ])("formats %j without inferring semantics", (volumeLabel, formatted) => {
    expect(formatVolumeLabel(volumeLabel)).toBe(formatted);
  });
});

describe("CatalogReviewEvidence", () => {
  it("renders archived evidence and non-authoritative suggestions accessibly", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="FEATURE_DISC_2_2005_SPECIAL_EDITION"
        titles={[
          {
            number: 1,
            durationSeconds: 3_600,
            chapters: 12,
            audioStreams: [
              {
                id: 128,
                language: "English",
                format: "AC3",
                channels: 6,
              },
              {
                id: 129,
                languageCode: "fr",
                format: "DTS",
                channels: 2,
              },
              { id: 130, language: "English", format: "AC3", channels: 2 },
            ],
            subtitles: [
              { id: 32, language: "English", content: "Normal" },
              { id: 33, languageCode: "es", content: "Closed Captions" },
            ],
          },
          {
            number: 2,
            durationSeconds: 1_199,
            chapters: 1,
            audioStreams: [],
            subtitles: [],
          },
        ]}
      />,
    );

    expect(html).toContain("Archived Scan Evidence");
    expect(html).toContain(
      "read-only disc structure captured during scanning",
    );
    expect(html).toContain("Original volume label");
    expect(html).toContain("FEATURE_DISC_2_2005_SPECIAL_EDITION");
    expect(html).toContain("Formatted label suggestion");
    expect(html).toContain("Feature Disc 2 2005 Special Edition");
    expect(html).toContain("Title Suggestions use duration only");
    expect(html).toContain(
      "do not identify content, select a source, or create a Disc Selection",
    );
    expect(html).toContain("Title 1");
    expect(html).toContain("1h 0m 0s");
    expect(html).toContain("12 chapters");
    expect(html).toContain("Audio: English, fr");
    expect(html).toContain("Subtitles: English, es");
    expect(html).toContain("Feature-length candidate");
    expect(html).toContain("Longest title");
    expect(html).toContain("Technical stream details");
    expect(html).toContain("Audio stream 0x80");
    expect(html).toContain("English · AC3 · 6 channels");
    expect(html).toContain("Subtitle stream 0x20");
    expect(html).toContain("English · Normal");
    expect(html).toContain("Short or extra candidate");
    expect(html).toContain("Audio: None");
    expect(html).toContain("Subtitles: None");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Technical stream details</summary>");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
  });

  it("keeps exact-title Assisted Mapping actions and the editable Mapping Proposal beside its evidence", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="FEATURE_DISC_2_2005_SPECIAL_EDITION"
        titles={[{
          number: 2,
          durationSeconds: 1_200,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }]}
        mediaItems={[{
          id: "movie-1",
          parentId: null,
          kind: "movie",
          title: "Existing Movie",
          year: null,
          seasonNumber: null,
          episodeNumber: null,
        }]}
        activeMappingProposal={{
          action: "chapters",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 2,
            chapterStart: 1,
            chapterEnd: 8,
          },
        }}
        isSaving={false}
        onStartMappingProposal={() => undefined}
        onCancelMappingProposal={() => undefined}
        onCreateMappingProposal={() => undefined}
      />,
    );

    expect(html).toContain("Map DVD main feature");
    expect(html).toContain("Map as movie");
    expect(html).toContain("Map as bonus feature");
    expect(html).toContain("Map as trailer");
    expect(html).toContain("Map chapters");
    expect(html).toContain("Map as other");
    expect(html).toContain("Mapping Proposal");
    expect(html.indexOf("Title 2")).toBeLessThan(
      html.indexOf("Mapping Proposal"),
    );
    expect(html).toContain('name="title"');
    expect(html).toContain(
      'value="Feature Disc 2 2005 Special Edition"',
    );
    expect(html).toContain('name="kind"');
    expect(html).toContain('name="parentId"');
    expect(html).toMatch(/name="titleNumber" value="2"/);
    expect(html).toContain('readOnly=""');
    expect(html).toContain('name="chapterStart"');
    expect(html).toContain('name="chapterEnd"');
    expect(html).toContain('name="label"');
    expect(html).toContain("Create Media Item and Disc Selection");
  });
});
