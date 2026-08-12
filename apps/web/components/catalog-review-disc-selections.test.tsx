import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogReviewDiscSelections } from "./catalog-review-disc-selections";

describe("CatalogReviewDiscSelections", () => {
  it("renders reviewed mappings, repair choices, and pagination", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "episode-1",
          sourceIdentity: {
            kind: "dvd_chapters",
            titleNumber: 1,
            chapterStart: 1,
            chapterEnd: 4,
          },
          label: null,
          actionAvailability: {
            state: "editable",
            availableActions: ["correct", "edit_label", "remove"],
            reason: null,
            relatedEncodeJob: null,
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: true,
        }}
        mediaItems={[{
          id: "episode-1",
          parentId: null,
          kind: "episode",
          title: "Episode One",
          year: null,
          seasonNumber: null,
          episodeNumber: 1,
        }]}
        rawTitles={[{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Episode One");
    expect(html).toContain("Title 1, chapters 1–4");
    expect(html).toContain("Editable");
    expect(html).toContain("Correct or edit label");
    expect(html).toContain("Remove Disc Selection");
    expect(html).toContain("Next Disc Selections");
  });

  it("explains a running dependency without rendering doomed mutation actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "movie-1",
          sourceIdentity: { kind: "main_feature" },
          label: null,
          actionAvailability: {
            state: "locked_provenance",
            availableActions: [],
            reason:
              "Encode Job job-1 is running; direct mutation is unavailable because its Disc Selection provenance must be preserved",
            relatedEncodeJob: { id: "job-1", status: "running" },
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[{
          id: "movie-1",
          parentId: null,
          kind: "movie",
          title: "Locked Movie",
          year: null,
          seasonNumber: null,
          episodeNumber: null,
        }]}
        rawTitles={[]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Locked provenance");
    expect(html).toContain("Encode Job job-1 is running");
    expect(html).not.toContain("Correct or edit label");
    expect(html).not.toContain("Repair unsafe legacy Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
  });

  it("marks unsafe legacy selections as Needs repair with only recovery actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[
          {
            id: "selection-1",
            mediaItemId: "movie-1",
            sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
            label: null,
            actionAvailability: {
              state: "needs_repair",
              availableActions: ["repair", "remove"],
              reason:
                "Unsafe legacy Disc Selection; repair or remove it before completing Catalog Review",
              relatedEncodeJob: null,
            },
          },
          {
            id: "selection-2",
            mediaItemId: "movie-2",
            sourceIdentity: { kind: "main_feature" },
            label: null,
            actionAvailability: {
              state: "needs_repair",
              availableActions: [],
              reason:
                "Encode Job job-2 is queued; this unsafe legacy Disc Selection needs repair, but direct mutation is unavailable while the job is active",
              relatedEncodeJob: { id: "job-2", status: "queued" },
            },
          },
        ]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[
          {
            id: "movie-1",
            parentId: null,
            kind: "movie",
            title: "Legacy Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "movie-2",
            parentId: null,
            kind: "movie",
            title: "Legacy Movie with queued work",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
        ]}
        rawTitles={[{
          number: 1,
          durationSeconds: 2_400,
          chapters: 8,
          audioStreams: [],
          subtitles: [],
        }]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Needs repair");
    expect(html).toContain("Unsafe legacy Disc Selection");
    expect(html).toContain("Encode Job job-2 is queued");
    expect(html).toContain("Repair unsafe legacy Disc Selection");
    expect(html).toContain("Remove Disc Selection");
    expect(html).not.toContain("Correct or edit label");
    expect(html.match(/Repair unsafe legacy Disc Selection/g)).toHaveLength(1);
    expect(html.match(/Remove Disc Selection/g)).toHaveLength(1);
  });

  it("explains the archive cutover fence without rendering mutation actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "movie-1",
          sourceIdentity: { kind: "main_feature" },
          label: null,
          actionAvailability: {
            state: "changes_unavailable",
            availableActions: [],
            reason:
              "Disc Selection changes are unavailable while legacy cutover repair is pending",
            relatedEncodeJob: null,
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[{
          id: "movie-1",
          parentId: null,
          kind: "movie",
          title: "Cutover Movie",
          year: null,
          seasonNumber: null,
          episodeNumber: null,
        }]}
        rawTitles={[]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Changes unavailable");
    expect(html).toContain("legacy cutover repair is pending");
    expect(html).not.toContain("Correct or edit label");
    expect(html).not.toContain("Repair unsafe legacy Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
  });
});
