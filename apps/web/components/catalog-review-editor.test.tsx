import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CATALOG_REVIEW_COMMAND_ACTIONS,
  type CatalogReviewCommand,
} from "../lib/catalog-review-command";

import {
  DISC_SELECTION_KINDS,
  MEDIA_ITEM_KINDS,
} from "@rip-dvd/data-access/catalog-kinds";

import {
  CatalogReviewView,
  mutateCatalogReview,
} from "./catalog-review-editor";

function selectOptionValues(html: string, name: string): string[] {
  const select = html.match(
    new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`),
  )?.[1];
  if (select === undefined) {
    throw new Error(`Expected select named ${name}`);
  }
  return [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map(
    ([, value]) => value,
  );
}

describe("CatalogReviewView", () => {
  it("posts every shared catalog review command variant", async () => {
    expectTypeOf(mutateCatalogReview).parameter(1)
      .toEqualTypeOf<CatalogReviewCommand>();
    const commands = {
      create_media_item: {
        action: "create_media_item",
        mediaItem: { kind: "movie", title: "Example Movie" },
      },
      update_media_item: {
        action: "update_media_item",
        mediaItemId: "media-item-1",
        changes: { title: "Updated Movie" },
      },
      create_disc_selection: {
        action: "create_disc_selection",
        selection: {
          mediaItemId: "media-item-1",
          kind: "main_feature",
        },
      },
      repair_disc_selection: {
        action: "repair_disc_selection",
        discSelectionId: "selection-1",
        selection: {
          mediaItemId: "media-item-1",
          kind: "dvd_title",
          titleNumber: 1,
        },
      },
      delete_disc_selection: {
        action: "delete_disc_selection",
        discSelectionId: "selection-1",
      },
      complete_review: { action: "complete_review" },
    } satisfies Record<CatalogReviewCommand["action"], CatalogReviewCommand>;
    const postedBodies: unknown[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(JSON.parse(String(init?.body)) as unknown);
      return Response.json({});
    };

    for (const action of CATALOG_REVIEW_COMMAND_ACTIONS) {
      await mutateCatalogReview("archive-1", commands[action], fetcher);
    }

    expect(postedBodies).toEqual(CATALOG_REVIEW_COMMAND_ACTIONS.map(
      (action) => commands[action],
    ));
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
        requestError={
          "Disc Selection selection-1 cannot be deleted because Encode Job history must be preserved"
        }
        selectionKind="main_feature"
        onClose={() => undefined}
        onRetry={() => undefined}
        onEditMediaItem={() => undefined}
        onCancelEdit={() => undefined}
        onMediaItemsPage={() => undefined}
        onDiscSelectionsPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onSaveMediaItem={() => undefined}
        onCreateDiscSelection={() => undefined}
        onDeleteDiscSelection={() => undefined}
        onCompleteReview={() => undefined}
      />,
    );

    expect(html).toContain("Catalog EPISODE_DISC");
    expect(html).toContain(
      "Disc Selection selection-1 cannot be deleted because Encode Job history must be preserved",
    );
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
    expect(html).toContain("Repair an existing Disc Selection");
    expect(html).toContain('name="replacesDiscSelectionId"');
    expect(html).toContain("Remove Disc Selection");
    expect(html).toContain("Next Disc Selections");
    expect(html).toContain("Complete review");
    expect(selectOptionValues(html, "kind")).toEqual(MEDIA_ITEM_KINDS);
    expect(selectOptionValues(html, "selectionKind")).toEqual(
      DISC_SELECTION_KINDS,
    );
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
        requestError={null}
        selectionKind="main_feature"
        onClose={() => undefined}
        onRetry={() => undefined}
        onEditMediaItem={() => undefined}
        onCancelEdit={() => undefined}
        onMediaItemsPage={() => undefined}
        onDiscSelectionsPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onSaveMediaItem={() => undefined}
        onCreateDiscSelection={() => undefined}
        onDeleteDiscSelection={() => undefined}
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
