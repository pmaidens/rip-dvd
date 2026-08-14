// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import titleSuggestionPolicy from "../../../fixtures/title-suggestion-policy.json";

import {
  CatalogReviewEvidence,
  formatVolumeLabel,
  titleSuggestion,
} from "./catalog-review-evidence";

const evidenceCoverage = {
  discSelectionCount: 2,
  mediaItemsWithSelections: 2,
  mappedTitles: 0,
  partiallyMappedTitles: 1,
  unmappedTitles: 1,
  mainFeatureSelections: 0,
  titles: [
    {
      titleNumber: 1,
      status: "partially_mapped" as const,
      hasOverlap: true,
    },
    {
      titleNumber: 2,
      status: "unmapped" as const,
      hasOverlap: false,
    },
  ],
};

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
  it("renders the overlap warning for exact-overlap coverage", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="CONCERT_DISC"
        coverage={{
          discSelectionCount: 2,
          mediaItemsWithSelections: 2,
          mappedTitles: 1,
          partiallyMappedTitles: 0,
          unmappedTitles: 0,
          mainFeatureSelections: 0,
          titles: [{
            titleNumber: 1,
            status: "mapped",
            hasOverlap: true,
          }],
        }}
        titles={[{
          number: 1,
          durationSeconds: 3_600,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }]}
      />,
    );

    expect(html).toContain("Overlapping Disc Selections");
    expect(html).toContain("counted once and remain valid");
    expect(html).toContain("Mapped");
  });

  it("renders the overlap warning for duplicate main-feature selections", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="TWO_MAIN_FEATURES"
        coverage={{
          ...evidenceCoverage,
          discSelectionCount: 2,
          mainFeatureSelections: 2,
        }}
        titles={[]}
      />,
    );

    expect(html).toContain("Overlapping Disc Selections");
    expect(html).toContain("main-feature sources");
  });

  it("renders archived evidence and non-authoritative suggestions accessibly", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="FEATURE_DISC_2_2005_SPECIAL_EDITION"
        coverage={evidenceCoverage}
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
            durationSeconds: 90,
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
    expect(html).toContain("Very short or menu candidate");
    expect(html).toContain("Audio: None");
    expect(html).toContain("Subtitles: None");
    expect(html).toContain("Partially mapped");
    expect(html).toContain("Overlapping Disc Selections");
    expect(html).toContain("counted once and remain valid");
    expect(html).toContain("1 very-short unmapped title");
    expect(html).not.toContain('<details open=""');
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Technical stream details</summary>");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
  });

  it("keeps exact-title Assisted Mapping actions and the editable Mapping Proposal beside its evidence", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="FEATURE_DISC_2_2005_SPECIAL_EDITION"
        coverage={evidenceCoverage}
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
    expect(html).toContain("Map to existing Media Item");
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

  it("groups an episodic proposal after its selected title evidence", () => {
    const titles = [8, 3, 5].map((number) => ({
      number,
      durationSeconds: 2_400,
      chapters: 8,
      audioStreams: [],
      subtitles: [],
    }));
    const html = renderToStaticMarkup(
      <CatalogReviewEvidence
        volumeLabel="EXAMPLE_SHOW_DISC_2"
        coverage={{
          discSelectionCount: 0,
          mediaItemsWithSelections: 0,
          mappedTitles: 0,
          partiallyMappedTitles: 0,
          unmappedTitles: 3,
          mainFeatureSelections: 0,
          titles: titles.map(({ number }) => ({
            titleNumber: number,
            status: "unmapped" as const,
            hasOverlap: false,
          })),
        }}
        titles={titles}
        activeEpisodicMappingProposal={{
          episodes: [3, 8].map((titleNumber, index) => ({
            titleNumber,
            title: `Episode ${index + 4}`,
            episodeNumber: index + 4,
          })),
        }}
        onStartEpisodicMappingProposal={() => undefined}
        onCancelEpisodicMappingProposal={() => undefined}
        onCreateEpisodicMappingProposal={() => undefined}
      />,
    );
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const workspace = rendered.querySelector(".catalog-episodic-workspace");

    expect(workspace).not.toBeNull();
    expect([...workspace!.querySelectorAll(".catalog-title-evidence h4")]
      .map((heading) => heading.textContent)).toEqual(["Title 3", "Title 8"]);
    expect(workspace!.querySelector(
      ".catalog-episodic-mapping-proposal",
    )).not.toBeNull();
    expect(workspace!.textContent).not.toContain("Title 5");
    expect(html.indexOf("Title 3")).toBeLessThan(
      html.indexOf("Episodic Mapping Proposal"),
    );
  });

  it.each([
    ["partially mapped", "partially_mapped" as const, true],
    ["already mapped", "mapped" as const, false],
  ])("does not automatically propose sources for a %s title", async (
    _label,
    status,
    hasOverlap,
  ) => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onStartMappingProposal = vi.fn();

    await act(async () => {
      root.render(
        <CatalogReviewEvidence
          volumeLabel="PARTIAL_DISC"
          coverage={{
            ...evidenceCoverage,
            mappedTitles: status === "mapped" ? 1 : 0,
            partiallyMappedTitles: status === "partially_mapped" ? 1 : 0,
            titles: [{ titleNumber: 1, status, hasOverlap }],
          }}
          titles={[{
            number: 1,
            durationSeconds: 3_600,
            chapters: 12,
            audioStreams: [],
            subtitles: [],
          }]}
          onStartMappingProposal={onStartMappingProposal}
        />,
      );
    });
    const assistedActions = [...container.querySelectorAll<HTMLButtonElement>(
      ".catalog-title-actions button",
    )];
    expect(assistedActions).toHaveLength(6);
    expect(assistedActions.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain(
      "Use manual Disc Selection controls for intentional overlaps",
    );
    for (const button of assistedActions) {
      await act(async () => button.click());
    }
    expect(onStartMappingProposal).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });

  it("filters the evidence cards while keeping very-short unmapped titles expandable", async () => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const titles = [
      {
        number: 1,
        durationSeconds: 3_600,
        chapters: 12,
        audioStreams: [],
        subtitles: [],
      },
      {
        number: 2,
        durationSeconds: 90,
        chapters: 1,
        audioStreams: [],
        subtitles: [],
      },
    ];

    await act(async () => {
      root.render(
        <CatalogReviewEvidence
          volumeLabel="FILTER_DISC"
          coverage={evidenceCoverage}
          titles={titles}
        />,
      );
    });
    const collapsedTitles = container.querySelector<HTMLDetailsElement>(
      ".catalog-coverage-collapsed",
    );
    expect(collapsedTitles?.open).toBe(false);
    expect(collapsedTitles?.textContent).toContain("Title 2");
    expect(collapsedTitles?.textContent).not.toContain("Title 1");

    const unmappedFilter = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Unmapped",
    );
    if (!unmappedFilter) {
      throw new Error("Expected the Unmapped filter");
    }
    await act(async () => unmappedFilter.click());

    const visibleCards = [...container.querySelectorAll(
      ".catalog-title-evidence",
    )].map((element) => element.textContent);
    expect(visibleCards).toHaveLength(1);
    expect(visibleCards[0]).toContain("Title 2");
    expect(container.textContent).not.toContain("Title 1");
    expect(unmappedFilter.getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps an active very-short Mapping Proposal visible across coverage filters", async () => {
    (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CatalogReviewEvidence
          volumeLabel="FILTER_DISC"
          coverage={evidenceCoverage}
          titles={[{
            number: 2,
            durationSeconds: 90,
            chapters: 1,
            audioStreams: [],
            subtitles: [],
          }]}
          activeMappingProposal={{
            action: "chapters",
            sourceIdentity: {
              kind: "dvd_chapters",
              titleNumber: 2,
              chapterStart: 1,
              chapterEnd: 1,
            },
          }}
          onStartMappingProposal={() => undefined}
        />,
      );
    });
    const mappedFilter = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Mapped",
    );
    if (!mappedFilter) {
      throw new Error("Expected the Mapped filter");
    }
    await act(async () => mappedFilter.click());

    const activeTitle = container.querySelector(
      ".catalog-title-evidence-active",
    );
    expect(activeTitle?.textContent).toContain("Title 2");
    expect(activeTitle?.textContent).toContain("Mapping Proposal");
    expect(activeTitle?.querySelector('[name="titleNumber"]')?.getAttribute(
      "value",
    )).toBe("2");
    expect(activeTitle?.querySelector('[name="chapterStart"]')).not.toBeNull();
    expect(activeTitle?.querySelector('[name="chapterEnd"]')).not.toBeNull();
    expect(activeTitle?.querySelector('[name="label"]')).not.toBeNull();
    expect(activeTitle?.closest(".catalog-coverage-collapsed")).toBeNull();
    expect(mappedFilter.getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.unmount());
    container.remove();
  });
});
