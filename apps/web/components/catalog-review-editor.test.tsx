// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import {
  CATALOG_REVIEW_COMMAND_ACTIONS,
  type CatalogReviewCommand,
} from "../lib/catalog-review-command";

import {
  DISC_SELECTION_KINDS,
  MEDIA_ITEM_KINDS,
} from "@rip-dvd/data-access/catalog-kinds";

import {
  CatalogReviewEditor,
  type CatalogReviewDto,
  CatalogReviewView,
  mutateCatalogReview,
} from "./catalog-review-editor";

interface PendingRequest {
  url: string;
  resolve(response: Response): void;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function stubDeferredCatalogReviewRequests(): PendingRequest[] {
  const requests: PendingRequest[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
    new Promise<Response>((resolve) => {
      requests.push({ url: String(input), resolve });
    })));
  return requests;
}

function catalogReview({
  archiveId,
  discLabel,
  mediaOffset = 0,
  discSelectionOffset = 0,
}: {
  archiveId: string;
  discLabel: string;
  mediaOffset?: number;
  discSelectionOffset?: number;
}): CatalogReviewDto {
  const mediaItemId = `${archiveId}-item-${mediaOffset}`;
  const titleNumber = discSelectionOffset / 100 + 1;
  return {
    catalogRevision: "2026-08-11T06:00:00.000Z",
    archive: {
      id: archiveId,
      discLabel,
      discKind: "dvd",
      archiveFormat: "iso",
      archivedAt: "2026-08-03T18:00:00.000Z",
      catalogReviewedAt: null,
    },
    reviewStatus: "needs_review",
    rawScan: { titles: [] },
    mediaItems: [{
      id: mediaItemId,
      parentId: null,
      kind: "movie",
      title: `${discLabel} item at offset ${mediaOffset}`,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
    }],
    mediaItemsPage: {
      offset: mediaOffset,
      limit: 100,
      hasPrevious: mediaOffset > 0,
      hasNext: mediaOffset === 0,
      itemIds: [mediaItemId],
    },
    discSelections: [{
      id: `${archiveId}-selection-${discSelectionOffset}`,
      mediaItemId,
      sourceIdentity: { kind: "dvd_title", titleNumber },
      label: null,
      actionAvailability: {
        state: "editable",
        availableActions: ["correct", "edit_label", "remove"],
        reason: null,
        relatedEncodeJob: null,
      },
    }],
    discSelectionsPage: {
      offset: discSelectionOffset,
      limit: 100,
      hasPrevious: discSelectionOffset > 0,
      hasNext: discSelectionOffset === 0,
    },
  };
}

async function resolveRequest(
  request: PendingRequest,
  body: CatalogReviewDto,
): Promise<void> {
  await act(async () => {
    request.resolve(Response.json(body));
  });
}

function renderCatalogReviewEditor(archiveId: string): void {
  root.render(
    <CatalogReviewEditor
      archiveId={archiveId}
      onClose={() => undefined}
      onCompleted={() => undefined}
    />,
  );
}

describe("CatalogReviewEditor", () => {
  it("keeps the current archive visible when archive requests resolve out of order", async () => {
    const requests = stubDeferredCatalogReviewRequests();

    await act(async () => renderCatalogReviewEditor("archive-a"));
    await act(async () => renderCatalogReviewEditor("archive-b"));

    expect(requests.map(({ url }) => url)).toEqual([
      "/api/catalog-reviews/archive-a?mediaOffset=0&selectionOffset=0",
      "/api/catalog-reviews/archive-b?mediaOffset=0&selectionOffset=0",
    ]);

    await resolveRequest(
      requests[1]!,
      catalogReview({ archiveId: "archive-b", discLabel: "CURRENT_ARCHIVE" }),
    );
    expect(container.textContent).toContain("Catalog CURRENT_ARCHIVE");

    await resolveRequest(
      requests[0]!,
      catalogReview({ archiveId: "archive-a", discLabel: "STALE_ARCHIVE" }),
    );
    expect(container.textContent).toContain("Catalog CURRENT_ARCHIVE");
    expect(container.textContent).not.toContain("STALE_ARCHIVE");
  });

  it("keeps the current rendered pages when page requests resolve out of order", async () => {
    const requests = stubDeferredCatalogReviewRequests();

    await act(async () => renderCatalogReviewEditor("archive-a"));
    await resolveRequest(
      requests[0]!,
      catalogReview({ archiveId: "archive-a", discLabel: "FIRST_PAGE" }),
    );

    const nextMediaItemsPage = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next Media Items",
    );
    if (!nextMediaItemsPage) {
      throw new Error("Expected the next Media Items page control");
    }
    const nextDiscSelectionsPage = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Next Disc Selections");
    if (!nextDiscSelectionsPage) {
      throw new Error("Expected the next Disc Selections page control");
    }
    await act(async () => {
      nextMediaItemsPage.click();
      await Promise.resolve();
      nextDiscSelectionsPage.click();
    });
    expect(requests.slice(1).map(({ url }) => url)).toEqual([
      "/api/catalog-reviews/archive-a?mediaOffset=100&selectionOffset=0",
      "/api/catalog-reviews/archive-a?mediaOffset=100&selectionOffset=100",
    ]);

    await resolveRequest(
      requests[2]!,
      catalogReview({
        archiveId: "archive-a",
        discLabel: "CURRENT_PAGE",
        mediaOffset: 100,
        discSelectionOffset: 100,
      }),
    );
    expect(container.textContent).toContain("CURRENT_PAGE item at offset 100");
    expect(container.textContent).toContain("Title 2");

    await resolveRequest(
      requests[1]!,
      catalogReview({
        archiveId: "archive-a",
        discLabel: "STALE_PAGE",
        mediaOffset: 100,
        discSelectionOffset: 0,
      }),
    );
    expect(container.textContent).toContain("CURRENT_PAGE item at offset 100");
    expect(container.textContent).toContain("Title 2");
    expect(container.textContent).not.toContain("STALE_PAGE");
  });
});

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
          sourceIdentity: { kind: "main_feature" },
        },
      },
      repair_disc_selection: {
        action: "repair_disc_selection",
        discSelectionId: "selection-1",
        selection: {
          mediaItemId: "media-item-1",
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      },
      delete_disc_selection: {
        action: "delete_disc_selection",
        discSelectionId: "selection-1",
      },
      complete_review: {
        action: "complete_review",
        catalogRevision: "2026-08-11T06:00:00.000Z",
      },
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
            catalogRevision: "2026-08-03T18:00:00.000Z",
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
              sourceIdentity: {
                kind: "dvd_chapters",
                titleNumber: 1,
                chapterStart: 1,
                chapterEnd: 4,
              },
              label: null,
              actionAvailability: {
                state: "locked_provenance",
                availableActions: [],
                reason:
                  "Encode Job job-1 is completed; this Disc Selection is locked provenance and cannot be changed directly",
                relatedEncodeJob: { id: "job-1", status: "completed" },
              },
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
    expect(html).toContain('name="replacesDiscSelectionId"');
    expect(html).toContain("Locked provenance");
    expect(html).toContain("Encode Job job-1 is completed");
    expect(html).not.toContain("Repair an existing Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
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
            catalogRevision: "2026-08-03T19:00:00.000Z",
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
              sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
              label: null,
              actionAvailability: {
                state: "editable",
                availableActions: ["correct", "edit_label", "remove"],
                reason: null,
                relatedEncodeJob: null,
              },
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
