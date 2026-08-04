import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CatalogReviewView,
  requestCatalogReview,
} from "./catalog-review-editor";

describe("CatalogReviewView", () => {
  it("requests the edited Media Item as context while paging parent choices", async () => {
    let requestedUrl = "";
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return Response.json({});
    };

    await requestCatalogReview(
      "archive-1",
      100,
      200,
      "episode-1",
      fetcher,
    );

    expect(requestedUrl).toBe(
      "/api/catalog-reviews/archive-1?mediaOffset=100&selectionOffset=200&editingMediaItemId=episode-1",
    );
  });

  it("shows raw DVD coordinates separately from editable hierarchy and reviewed mappings", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewView
        state={{
          status: "loaded",
          review: {
            archive: {
              id: "archive-1",
              discLabel: "EPISODE_DISC",
              discKind: "dvd",
              archiveFormat: "iso",
              archivedAt: "2026-08-03T18:00:00.000Z",
              catalogReviewedAt: null,
            },
            reviewStatus: "needs_review",
            rawScan: {
              titles: [{
                number: 1,
                durationSeconds: 2_400,
                chapters: 8,
                audioStreams: [],
                subtitles: [],
              }],
            },
            mediaItems: [
              {
                id: "show-1",
                parentId: null,
                kind: "tv_show",
                title: "Chapter Show",
                year: null,
                seasonNumber: null,
                episodeNumber: null,
              },
              {
                id: "season-1",
                parentId: "show-1",
                kind: "season",
                title: "Season 1",
                year: null,
                seasonNumber: 1,
                episodeNumber: null,
              },
              {
                id: "episode-1",
                parentId: "season-1",
                kind: "episode",
                title: "Episode One",
                year: null,
                seasonNumber: null,
                episodeNumber: 1,
              },
            ],
            mediaItemsPage: {
              offset: 0,
              limit: 100,
              hasPrevious: false,
              hasNext: true,
              itemIds: ["season-1", "episode-1"],
            },
            discSelections: [{
              id: "selection-1",
              mediaItemId: "episode-1",
              sourceKey: "dvd:title:1:chapters:1-4",
              kind: "dvd_chapters",
              titleNumber: 1,
              chapterStart: 1,
              chapterEnd: 4,
              label: null,
            }],
            discSelectionsPage: {
              offset: 0,
              limit: 100,
              hasPrevious: false,
              hasNext: true,
            },
          },
        }}
        editingMediaItemId={null}
        isSaving={false}
        hasRequestError={false}
        onClose={() => undefined}
        onRetry={() => undefined}
        onEditMediaItem={() => undefined}
        onCancelEdit={() => undefined}
        onMediaItemsPage={() => undefined}
        onDiscSelectionsPage={() => undefined}
        onSaveMediaItem={() => undefined}
        onCreateDiscSelection={() => undefined}
        onCompleteReview={() => undefined}
      />,
    );

    expect(html).toContain("Catalog EPISODE_DISC");
    expect(html).toContain("Raw DVD title map");
    expect(html).toContain("Title 1");
    expect(html).toContain("8 chapters");
    expect(html).toContain("Media Item hierarchy");
    expect(html).toContain("Chapter Show");
    expect(html).toContain("Parent context");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(2);
    expect(html).toContain("Season 1");
    expect(html).toContain("Episode One");
    expect(html).toContain("Reviewed Disc Selections");
    expect(html).toContain("Title 1, chapters 1–4");
    expect(html).toContain("Create Media Item");
    expect(html).toContain("Next Media Items");
    expect(html).toContain("Add Disc Selection");
    expect(html).toContain("Next Disc Selections");
    expect(html).toContain("Complete review");
    for (const kind of [
      "movie",
      "tv_show",
      "season",
      "episode",
      "trailer",
      "bonus_feature",
      "other",
    ]) {
      expect(html).toContain(`value="${kind}"`);
    }
  });

  it("preserves full hierarchy and mapping context while reparenting across pages", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewView
        state={{
          status: "loaded",
          review: {
            archive: {
              id: "archive-1",
              discLabel: "PAGED_DISC",
              discKind: "dvd",
              archiveFormat: "iso",
              archivedAt: "2026-08-03T19:00:00.000Z",
              catalogReviewedAt: null,
            },
            reviewStatus: "needs_review",
            rawScan: { titles: [] },
            mediaItems: [
              {
                id: "parent-1",
                parentId: null,
                kind: "tv_show",
                title: "Parent Show",
                year: null,
                seasonNumber: null,
                episodeNumber: null,
              },
              {
                id: "season-1",
                parentId: "parent-1",
                kind: "season",
                title: "Parent Season",
                year: null,
                seasonNumber: 1,
                episodeNumber: null,
              },
              {
                id: "episode-1",
                parentId: "season-1",
                kind: "episode",
                title: "Mapped Episode",
                year: null,
                seasonNumber: null,
                episodeNumber: 1,
              },
              {
                id: "target-1",
                parentId: null,
                kind: "tv_show",
                title: "Different-page target",
                year: null,
                seasonNumber: null,
                episodeNumber: null,
              },
            ],
            mediaItemsPage: {
              offset: 100,
              limit: 100,
              hasPrevious: true,
              hasNext: false,
              itemIds: ["target-1"],
            },
            discSelections: [{
              id: "selection-1",
              mediaItemId: "episode-1",
              sourceKey: "dvd:title:1",
              kind: "dvd_title",
              titleNumber: 1,
              chapterStart: null,
              chapterEnd: null,
              label: null,
            }],
            discSelectionsPage: {
              offset: 0,
              limit: 100,
              hasPrevious: false,
              hasNext: false,
            },
          },
        }}
        editingMediaItemId="episode-1"
        isSaving={false}
        hasRequestError={false}
        onClose={() => undefined}
        onRetry={() => undefined}
        onEditMediaItem={() => undefined}
        onCancelEdit={() => undefined}
        onMediaItemsPage={() => undefined}
        onDiscSelectionsPage={() => undefined}
        onSaveMediaItem={() => undefined}
        onCreateDiscSelection={() => undefined}
        onCompleteReview={() => undefined}
      />,
    );

    expect(html).toContain("Parent context");
    expect(html).toContain('value="season-1" selected="">— Parent Season');
    expect(html).toContain('value="target-1">Different-page target');
    expect(html).toContain("Mapped Episode");
    expect(html).not.toContain("Unknown Media Item");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(1);
  });
});
