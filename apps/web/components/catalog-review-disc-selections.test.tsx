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
        correctionHistory={[]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
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
        onCorrectionHistoryPage={() => undefined}
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

  it("offers supersession for a running dependency without direct mutation actions", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-1",
          mediaItemId: "movie-1",
          sourceIdentity: { kind: "main_feature" },
          label: null,
          actionAvailability: {
            state: "locked_provenance",
            availableActions: ["correct"],
            reason:
              "Encode Job job-1 is running; correcting by supersession will request cancellation and preserve its provenance",
            relatedEncodeJob: { id: "job-1", status: "running" },
          },
        }]}
        page={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        correctionHistory={[]}
        correctionHistoryPage={{
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
        onCorrectionHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Locked provenance");
    expect(html).toContain("Encode Job job-1 is running");
    expect(html).toContain("Correct by supersession");
    expect(html).toContain("Correction note");
    expect(html).toContain("will request cancellation");
    expect(html).not.toContain("Repair unsafe legacy Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
  });

  it("shows every superseded source and human correction note", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewDiscSelections
        discSelections={[{
          id: "selection-corrected",
          mediaItemId: "movie-corrected",
          sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
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
          hasNext: false,
        }}
        correctionHistory={[
          {
            supersededDiscSelection: {
              id: "selection-mistaken",
              mediaItemId: "movie-mistaken",
              sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
              label: "Theatrical cut",
            },
            replacementDiscSelection: {
              id: "selection-intermediate",
              mediaItemId: "movie-intermediate",
              sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
              label: null,
            },
            reason: "The director's cut is title 2.",
            correctedAt: "2026-08-12T18:00:00.000Z",
            encodeHistory: [
              {
                id: "encode-original",
                status: "completed",
                predecessorEncodeJobId: null,
                replacementEncodeJobId: "encode-corrected",
                retainedOutput: null,
              },
              {
                id: "encode-corrected",
                status: "completed",
                predecessorEncodeJobId: "encode-original",
                replacementEncodeJobId: null,
                retainedOutput: {
                  state: "retained",
                  cleanupEligible: true,
                },
              },
            ],
          },
          {
            supersededDiscSelection: {
              id: "selection-intermediate",
              mediaItemId: "movie-intermediate",
              sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
              label: null,
            },
            replacementDiscSelection: {
              id: "selection-corrected",
              mediaItemId: "movie-corrected",
              sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
              label: null,
            },
            reason: "The restored edition is title 3.",
            correctedAt: "2026-08-12T19:00:00.000Z",
            encodeHistory: [],
          },
        ]}
        correctionHistoryPage={{
          offset: 0,
          limit: 100,
          hasPrevious: false,
          hasNext: false,
        }}
        mediaItems={[
          {
            id: "movie-corrected",
            parentId: null,
            kind: "movie",
            title: "Correct Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "movie-intermediate",
            parentId: null,
            kind: "movie",
            title: "Intermediate Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
          {
            id: "movie-mistaken",
            parentId: null,
            kind: "movie",
            title: "Mistaken Movie",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
        ]}
        rawTitles={[]}
        selectionKind="main_feature"
        isSaving={false}
        onPage={() => undefined}
        onCorrectionHistoryPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onCreate={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(html).toContain("Disc Selection Correction History");
    expect(html).toContain(
      "Mistaken Movie · Title 1 → Intermediate Movie · Title 2",
    );
    expect(html).toContain(
      "Intermediate Movie · Title 2 → Correct Movie · Title 3",
    );
    expect(html).toContain("The director&#x27;s cut is title 2.");
    expect(html).toContain("The restored edition is title 3.");
    expect(html).toContain("Encode Job encode-original · Completed");
    expect(html).toContain("Superseded by encode-corrected");
    expect(html).toContain("Encode Job encode-corrected · Completed");
    expect(html).toContain("Replaces encode-original");
    expect(html).toContain("Prior output retained · Cleanup eligible");
    expect(html).toContain("Correct Movie");
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
        correctionHistory={[]}
        correctionHistoryPage={{
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
        onCorrectionHistoryPage={() => undefined}
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
        correctionHistory={[]}
        correctionHistoryPage={{
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
        onCorrectionHistoryPage={() => undefined}
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
