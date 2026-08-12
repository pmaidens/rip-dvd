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
  discSelectionOffset = 0,
}: {
  archiveId: string;
  discLabel: string;
  discSelectionOffset?: number;
}): CatalogReviewDto {
  const mediaItemId = `${archiveId}-item-${discSelectionOffset}`;
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
      catalogReviewOutcome: "needs_review",
    },
    reviewOutcome: "needs_review",
    rawScan: { titles: [] },
    coverage: {
      discSelectionCount: 1,
      mediaItemsWithSelections: 1,
      mappedTitles: 0,
      partiallyMappedTitles: 0,
      unmappedTitles: 0,
      mainFeatureSelections: 0,
      titles: [],
    },
    mediaItems: [{
      id: mediaItemId,
      parentId: null,
      kind: "movie",
      title: `${discLabel} item`,
      year: null,
      seasonNumber: null,
      episodeNumber: null,
    }],
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
      "/api/catalog-reviews/archive-a?selectionOffset=0",
      "/api/catalog-reviews/archive-b?selectionOffset=0",
    ]);

    await resolveRequest(
      requests[1]!,
      catalogReview({ archiveId: "archive-b", discLabel: "CURRENT_ARCHIVE" }),
    );
    expect(container.textContent).toContain("Catalog Current Archive");

    await resolveRequest(
      requests[0]!,
      catalogReview({ archiveId: "archive-a", discLabel: "STALE_ARCHIVE" }),
    );
    expect(container.textContent).toContain("Catalog Current Archive");
    expect(container.textContent).not.toContain("STALE_ARCHIVE");
  });

  it("keeps the current rendered Disc Selection page", async () => {
    const requests = stubDeferredCatalogReviewRequests();

    await act(async () => renderCatalogReviewEditor("archive-a"));
    await resolveRequest(
      requests[0]!,
      catalogReview({ archiveId: "archive-a", discLabel: "FIRST_PAGE" }),
    );

    const nextDiscSelectionsPage = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Next Disc Selections");
    if (!nextDiscSelectionsPage) {
      throw new Error("Expected the next Disc Selections page control");
    }
    await act(async () => nextDiscSelectionsPage.click());
    expect(requests.slice(1).map(({ url }) => url)).toEqual([
      "/api/catalog-reviews/archive-a?selectionOffset=100",
    ]);

    await resolveRequest(
      requests[1]!,
      catalogReview({
        archiveId: "archive-a",
        discLabel: "CURRENT_PAGE",
        discSelectionOffset: 100,
      }),
    );
    expect(container.textContent).toContain("CURRENT_PAGE item");
    expect(container.textContent).toContain("Title 2");
  });

  it("keeps a failed Mapping Proposal editable and refreshes the exact-source mapping after success", async () => {
    const initialReview = catalogReview({
      archiveId: "archive-a",
      discLabel: "MAPPING_PROPOSAL_DISC_2",
    });
    initialReview.rawScan.titles = [{
      number: 3,
      durationSeconds: 600,
      chapters: 4,
      audioStreams: [],
      subtitles: [],
    }];
    initialReview.mediaItems = [];
    initialReview.discSelections = [];
    const refreshedReview: CatalogReviewDto = {
      ...initialReview,
      catalogRevision: "2026-08-11T06:00:01.000Z",
      mediaItems: [{
        id: "created-movie",
        parentId: null,
        kind: "movie",
        title: "Corrected Proposal Title",
        year: null,
        seasonNumber: null,
        episodeNumber: null,
      }],
      discSelections: [{
        id: "created-selection",
        mediaItemId: "created-movie",
        sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
        label: null,
        actionAvailability: {
          state: "editable",
          availableActions: ["correct", "edit_label", "remove"],
          reason: null,
          relatedEncodeJob: null,
        },
      }],
    };
    const postedCommands: unknown[] = [];
    let mutationAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        mutationAttempts += 1;
        postedCommands.push(JSON.parse(String(init.body)) as unknown);
        return mutationAttempts === 1
          ? Response.json({ error: "Correct the proposed title" }, {
              status: 409,
            })
          : Response.json({}, { status: 201 });
      }
      return Response.json(
        mutationAttempts === 0 ? initialReview : refreshedReview,
      );
    }));

    await act(async () => renderCatalogReviewEditor("archive-a"));
    const mapMovie = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Map as movie",
    );
    if (!mapMovie) {
      throw new Error("Expected a title-row movie mapping action");
    }
    await act(async () => mapMovie.click());
    const proposal = container.querySelector(".catalog-mapping-proposal");
    const titleInput = proposal?.querySelector<HTMLInputElement>(
      'input[name="title"]',
    );
    const submit = [...(proposal?.querySelectorAll("button") ?? [])].find(
      (button) =>
        button.textContent === "Create Media Item and Disc Selection",
    );
    if (!titleInput || !submit) {
      throw new Error("Expected an editable Mapping Proposal");
    }
    titleInput.value = "Corrected Proposal Title";

    await act(async () => submit.click());
    expect(container.textContent).toContain("Correct the proposed title");
    expect(container.textContent).toContain("Mapping Proposal");
    expect(container.querySelector(
      '.catalog-mapping-proposal [role="alert"]',
    )?.textContent).toContain("Correct the proposed title");
    expect(container.querySelector(
      '.catalog-editor > [role="alert"]',
    )).toBeNull();
    expect(container.querySelector<HTMLInputElement>(
      '.catalog-mapping-proposal input[name="title"]',
    )?.value).toBe("Corrected Proposal Title");

    await act(async () => submit.click());
    expect(container.querySelector(".catalog-mapping-proposal")).toBeNull();
    expect(container.textContent).toContain("Corrected Proposal Title");
    expect(container.textContent).toContain("Title 3");
    expect(postedCommands).toEqual([
      {
        action: "create_mapping_proposal",
        catalogRevision: initialReview.catalogRevision,
        target: {
          choice: "create_new",
          mediaItem: {
            parentId: null,
            kind: "movie",
            title: "Corrected Proposal Title",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
        },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
        },
      },
      {
        action: "create_mapping_proposal",
        catalogRevision: initialReview.catalogRevision,
        target: {
          choice: "create_new",
          mediaItem: {
            parentId: null,
            kind: "movie",
            title: "Corrected Proposal Title",
            year: null,
            seasonNumber: null,
            episodeNumber: null,
          },
        },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 3 },
        },
      },
    ]);
  });

  it("orders selected titles into an editable episodic proposal and preserves it across validation errors", async () => {
    const initialReview = catalogReview({
      archiveId: "archive-a",
      discLabel: "EXAMPLE_SHOW_DISC_2",
    });
    initialReview.rawScan.titles = [8, 3, 5].map((number) => ({
      number,
      durationSeconds: 2_400,
      chapters: 8,
      audioStreams: [],
      subtitles: [],
    }));
    initialReview.coverage = {
      discSelectionCount: 0,
      mediaItemsWithSelections: 0,
      mappedTitles: 0,
      partiallyMappedTitles: 0,
      unmappedTitles: 3,
      mainFeatureSelections: 0,
      titles: [8, 3, 5].map((titleNumber) => ({
        titleNumber,
        status: "unmapped" as const,
        hasOverlap: false,
      })),
    };
    initialReview.mediaItems = [];
    initialReview.discSelections = [];
    const refreshedReview: CatalogReviewDto = {
      ...initialReview,
      catalogRevision: "2026-08-11T06:00:01.000Z",
      coverage: {
        ...initialReview.coverage,
        discSelectionCount: 3,
        mediaItemsWithSelections: 3,
        mappedTitles: 3,
        unmappedTitles: 0,
        titles: initialReview.coverage.titles.map((title) => ({
          ...title,
          status: "mapped",
        })),
      },
    };
    const postedCommands: unknown[] = [];
    let mutationAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        mutationAttempts += 1;
        postedCommands.push(JSON.parse(String(init.body)) as unknown);
        return mutationAttempts === 1
          ? Response.json({ error: "Episode 12 already exists" }, {
              status: 409,
            })
          : Response.json({}, { status: 201 });
      }
      return Response.json(
        mutationAttempts === 0 ? initialReview : refreshedReview,
      );
    }));

    await act(async () => renderCatalogReviewEditor("archive-a"));
    const selectTitle = (titleNumber: number) => container.querySelector<
      HTMLInputElement
    >(`input[name="episodicTitleNumbers"][value="${titleNumber}"]`);
    for (const titleNumber of [8, 3, 5]) {
      const checkbox = selectTitle(titleNumber);
      if (!checkbox) {
        throw new Error(`Expected episodic selection for Title ${titleNumber}`);
      }
      await act(async () => checkbox.click());
    }
    const startingEpisode = container.querySelector<HTMLInputElement>(
      'input[name="episodicStartingEpisodeNumber"]',
    );
    const startProposal = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create episodic proposal",
    );
    if (!startingEpisode || !startProposal) {
      throw new Error("Expected episodic proposal controls");
    }
    startingEpisode.value = "0";
    await act(async () => startProposal.click());
    expect(container.querySelector(
      ".catalog-episodic-selection [role=\"alert\"]",
    )?.textContent).toContain("positive whole number");
    expect(container.querySelector(
      ".catalog-episodic-mapping-proposal",
    )).toBeNull();
    await act(async () => {
      startingEpisode.value = "4";
      startingEpisode.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => startProposal.click());

    const proposal = container.querySelector(
      ".catalog-episodic-mapping-proposal",
    );
    const episodeRows = [...(proposal?.querySelectorAll(
      ".catalog-episodic-episode",
    ) ?? [])];
    expect(episodeRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("DVD Title 3"),
      expect.stringContaining("DVD Title 5"),
      expect.stringContaining("DVD Title 8"),
    ]);
    expect(episodeRows.map((row) => row.querySelector<HTMLInputElement>(
      'input[name^="episodeNumber-"]',
    )?.value)).toEqual(["4", "5", "6"]);

    const showTitle = proposal?.querySelector<HTMLInputElement>(
      'input[name="tvShowTitle"]',
    );
    const seasonTitle = proposal?.querySelector<HTMLInputElement>(
      'input[name="seasonTitle"]',
    );
    const editedEpisodeTitle = proposal?.querySelector<HTMLInputElement>(
      'input[name="episodeTitle-5"]',
    );
    const editedEpisodeNumber = proposal?.querySelector<HTMLInputElement>(
      'input[name="episodeNumber-5"]',
    );
    const editedSelectionLabel = proposal?.querySelector<HTMLInputElement>(
      'input[name="episodeLabel-5"]',
    );
    const submit = [...(proposal?.querySelectorAll("button") ?? [])].find(
      (button) =>
        button.textContent === "Create episodic hierarchy and Disc Selections",
    );
    if (
      !showTitle || !seasonTitle || !editedEpisodeTitle ||
      !editedEpisodeNumber || !editedSelectionLabel || !submit
    ) {
      throw new Error("Expected editable episodic Mapping Proposal fields");
    }
    showTitle.value = "Edited Show";
    seasonTitle.value = "Edited Season";
    editedEpisodeTitle.value = "A Different Fifth Episode";
    editedEpisodeNumber.value = "12";
    editedSelectionLabel.value = "Broadcast cut";

    await act(async () => submit.click());
    expect(proposal?.querySelector('[role="alert"]')?.textContent).toContain(
      "Episode 12 already exists",
    );
    expect(container.querySelector<HTMLInputElement>(
      'input[name="episodeTitle-5"]',
    )?.value).toBe("A Different Fifth Episode");
    expect(container.querySelector<HTMLInputElement>(
      'input[name="episodeNumber-5"]',
    )?.value).toBe("12");

    await act(async () => submit.click());
    expect(container.querySelector(
      ".catalog-episodic-mapping-proposal",
    )).toBeNull();
    expect(container.textContent).toContain("0 selected titles");
    expect(postedCommands).toEqual(Array(2).fill({
      action: "create_episodic_mapping_proposal",
      catalogRevision: initialReview.catalogRevision,
      tvShow: {
        choice: "create_new",
        title: "Edited Show",
        year: null,
      },
      season: {
        choice: "create_new",
        title: "Edited Season",
        seasonNumber: 1,
      },
      episodes: [
        { titleNumber: 3, title: "Episode 4", episodeNumber: 4 },
        {
          titleNumber: 5,
          title: "A Different Fifth Episode",
          episodeNumber: 12,
          label: "Broadcast cut",
        },
        { titleNumber: 8, title: "Episode 6", episodeNumber: 6 },
      ],
    }));
  });

  it("explicitly reuses a searched TV Show and its Season in an episodic proposal", async () => {
    const review = catalogReview({
      archiveId: "archive-a",
      discLabel: "SEARCHED_SHOW_DISC",
    });
    review.rawScan.titles = [{
      number: 2,
      durationSeconds: 2_400,
      chapters: 8,
      audioStreams: [],
      subtitles: [],
    }];
    review.coverage = {
      discSelectionCount: 0,
      mediaItemsWithSelections: 0,
      mappedTitles: 0,
      partiallyMappedTitles: 0,
      unmappedTitles: 1,
      mainFeatureSelections: 0,
      titles: [{
        titleNumber: 2,
        status: "unmapped",
        hasOverlap: false,
      }],
    };
    review.mediaItems = [];
    review.discSelections = [];
    const postedCommands: unknown[] = [];
    let searchCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        postedCommands.push(JSON.parse(String(init.body)) as unknown);
        return Response.json({}, { status: 201 });
      }
      if (String(input).startsWith("/api/media-items?")) {
        searchCount += 1;
        return Response.json({
          results: searchCount === 1
            ? [{
                mediaItem: {
                  id: "existing-show",
                  parentId: null,
                  kind: "tv_show",
                  title: "Searched Show",
                  year: 2004,
                  seasonNumber: null,
                  episodeNumber: null,
                },
                ancestors: [],
                suggestion: "normalized",
              }]
            : [{
                mediaItem: {
                  id: "existing-season",
                  parentId: "existing-show",
                  kind: "season",
                  title: "Searched Show Season 2",
                  year: null,
                  seasonNumber: 2,
                  episodeNumber: null,
                },
                ancestors: [{
                  id: "existing-show",
                  parentId: null,
                  kind: "tv_show",
                  title: "Searched Show",
                  year: 2004,
                  seasonNumber: null,
                  episodeNumber: null,
                }],
                suggestion: null,
              }],
          page: {
            offset: 0,
            limit: 20,
            hasPrevious: false,
            hasNext: false,
          },
        });
      }
      return Response.json(review);
    }));

    await act(async () => renderCatalogReviewEditor("archive-a"));
    const titleChoice = container.querySelector<HTMLInputElement>(
      'input[name="episodicTitleNumbers"]',
    );
    if (!titleChoice) {
      throw new Error("Expected an episodic title choice");
    }
    await act(async () => titleChoice.click());
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create episodic proposal",
    );
    if (!start) {
      throw new Error("Expected Create episodic proposal");
    }
    await act(async () => start.click());

    const showChoices = container.querySelectorAll<HTMLInputElement>(
      'input[name="tvShowChoice"]',
    );
    await act(async () => showChoices[1]?.click());
    const searchShows = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Search TV Shows",
    );
    if (!searchShows) {
      throw new Error("Expected TV Show search");
    }
    await act(async () => searchShows.click());
    const showResult = container.querySelector<HTMLInputElement>(
      'input[name="tv_showExistingId"]',
    );
    if (!showResult) {
      throw new Error("Expected the existing TV Show result");
    }
    await act(async () => showResult.click());

    const seasonChoices = container.querySelectorAll<HTMLInputElement>(
      'input[name="seasonChoice"]',
    );
    expect(seasonChoices[1]?.disabled).toBe(false);
    await act(async () => seasonChoices[1]?.click());
    const searchSeasons = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Search Seasons",
    );
    if (!searchSeasons) {
      throw new Error("Expected Season search");
    }
    await act(async () => searchSeasons.click());
    const seasonResult = container.querySelector<HTMLInputElement>(
      'input[name="seasonExistingId"]',
    );
    if (!seasonResult) {
      throw new Error("Expected the existing Season result");
    }
    await act(async () => seasonResult.click());

    const submit = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent === "Create episodic hierarchy and Disc Selections",
    );
    if (!submit) {
      throw new Error("Expected episodic proposal submission");
    }
    await act(async () => submit.click());

    expect(postedCommands).toEqual([{
      action: "create_episodic_mapping_proposal",
      catalogRevision: review.catalogRevision,
      tvShow: { choice: "use_existing", mediaItemId: "existing-show" },
      season: { choice: "use_existing", mediaItemId: "existing-season" },
      episodes: [{
        titleNumber: 2,
        title: "Episode 1",
        episodeNumber: 1,
      }],
    }]);
  });

  it("resets the proposal defaults when selecting another action for the same title", async () => {
    const review = catalogReview({
      archiveId: "archive-a",
      discLabel: "ACTION_SWITCH_DISC",
    });
    review.rawScan.titles = [{
      number: 3,
      durationSeconds: 600,
      chapters: 4,
      audioStreams: [],
      subtitles: [],
    }];
    review.mediaItems = [];
    review.discSelections = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(review)));

    await act(async () => renderCatalogReviewEditor("archive-a"));
    const action = (label: string) => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label);
    const movieAction = action("Map as movie");
    if (!movieAction) {
      throw new Error("Expected movie mapping action");
    }
    await act(async () => movieAction.click());
    const movieTitle = container.querySelector<HTMLInputElement>(
      '.catalog-mapping-proposal input[name="title"]',
    );
    const movieKind = container.querySelector<HTMLSelectElement>(
      '.catalog-mapping-proposal select[name="kind"]',
    );
    if (!movieTitle || !movieKind) {
      throw new Error("Expected movie Mapping Proposal fields");
    }
    movieTitle.value = "Unsaved movie edits";
    expect(movieKind.value).toBe("movie");

    const trailerAction = action("Map as trailer");
    if (!trailerAction) {
      throw new Error("Expected trailer mapping action");
    }
    await act(async () => trailerAction.click());
    expect(container.querySelector<HTMLSelectElement>(
      '.catalog-mapping-proposal select[name="kind"]',
    )?.value).toBe("trailer");
    expect(container.querySelector<HTMLInputElement>(
      '.catalog-mapping-proposal input[name="title"]',
    )?.value).toBe("Action Switch Disc");
  });

  it("requires an explicit existing Media Item selection after bounded search", async () => {
    const review = catalogReview({
      archiveId: "archive-a",
      discLabel: "EXISTING_MOVIE",
    });
    review.rawScan.titles = [{
      number: 1,
      durationSeconds: 5_400,
      chapters: 12,
      audioStreams: [],
      subtitles: [],
    }];
    review.mediaItems = [];
    review.discSelections = [];
    const postedCommands: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.startsWith("/api/media-items?")) {
        return Response.json({
          results: [{
            mediaItem: {
              id: "existing-movie",
              parentId: "existing-season",
              kind: "episode",
              title: "Existing Movie",
              year: null,
              seasonNumber: null,
              episodeNumber: 4,
            },
            ancestors: [{
              id: "existing-show",
              parentId: null,
              kind: "tv_show",
              title: "Existing Show",
              year: null,
              seasonNumber: null,
              episodeNumber: null,
            }, {
              id: "existing-season",
              parentId: "existing-show",
              kind: "season",
              title: "Season 2",
              year: null,
              seasonNumber: 2,
              episodeNumber: null,
            }],
            suggestion: "exact",
          }],
          page: {
            offset: 0,
            limit: 20,
            hasPrevious: false,
            hasNext: false,
          },
        });
      }
      if (init?.method === "POST") {
        postedCommands.push(JSON.parse(String(init.body)) as unknown);
        return Response.json({}, { status: 201 });
      }
      return Response.json(review);
    }));

    await act(async () => renderCatalogReviewEditor("archive-a"));
    const mapMovie = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Map as movie",
    );
    if (!mapMovie) {
      throw new Error("Expected a title-row movie mapping action");
    }
    await act(async () => mapMovie.click());

    expect(container.textContent).toContain("Create new Media Item");
    expect(container.textContent).toContain("Use existing Media Item");
    const useExisting = container.querySelector<HTMLInputElement>(
      'input[name="mappingTargetChoice"][value="use_existing"]',
    );
    if (!useExisting) {
      throw new Error("Expected the existing Media Item choice");
    }
    await act(async () => useExisting.click());

    const search = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Search full catalog",
    );
    if (!search) {
      throw new Error("Expected the full-catalog search action");
    }
    await act(async () => search.click());

    expect(container.textContent).toContain(
      "Existing Show › Season 2 › Existing Movie",
    );
    expect(container.textContent).toContain("Exact title suggestion");
    const existingResult = container.querySelector<HTMLInputElement>(
      'input[name="existingMediaItemId"][value="existing-movie"]',
    );
    expect(existingResult?.checked).toBe(false);
    if (!existingResult) {
      throw new Error("Expected an unselected catalog result");
    }
    await act(async () => existingResult.click());

    const submit = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent ===
          "Use existing Media Item and create Disc Selection",
    );
    if (!submit) {
      throw new Error("Expected the explicit reuse submit action");
    }
    await act(async () => submit.click());

    expect(postedCommands).toEqual([{
      action: "create_mapping_proposal",
      catalogRevision: review.catalogRevision,
      target: {
        choice: "use_existing",
        mediaItemId: "existing-movie",
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    }]);
  });

  it("posts Archive-only completion only after the inline choice is selected", async () => {
    const review = catalogReview({
      archiveId: "archive-a",
      discLabel: "ARCHIVE_ONLY_DISC",
    });
    review.coverage = {
      discSelectionCount: 0,
      mediaItemsWithSelections: 0,
      mappedTitles: 0,
      partiallyMappedTitles: 0,
      unmappedTitles: 0,
      mainFeatureSelections: 0,
      titles: [],
    };
    review.discSelections = [];
    const postedCommands: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (init?.method === "POST") {
        postedCommands.push(JSON.parse(String(init.body)) as unknown);
        return Response.json({});
      }
      return Response.json(review);
    }));
    const onCompleted = vi.fn();

    await act(async () => {
      root.render(
        <CatalogReviewEditor
          archiveId="archive-a"
          onClose={() => undefined}
          onCompleted={onCompleted}
        />,
      );
    });
    const archiveOnly = container.querySelector<HTMLInputElement>(
      '.catalog-complete-action input[type="checkbox"]',
    );
    const complete = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Complete review",
    );
    if (!archiveOnly || !complete) {
      throw new Error("Expected inline Archive-only completion controls");
    }
    expect(complete.disabled).toBe(true);

    await act(async () => archiveOnly.click());
    expect(archiveOnly.checked).toBe(true);
    expect(complete.disabled).toBe(false);
    await act(async () => complete.click());

    expect(postedCommands).toEqual([{
      action: "complete_review",
      catalogRevision: review.catalogRevision,
      outcome: "archive_only",
    }]);
    expect(onCompleted).toHaveBeenCalledOnce();
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
      create_episodic_mapping_proposal: {
        action: "create_episodic_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        tvShow: { choice: "create_new", title: "Example Show" },
        season: {
          choice: "create_new",
          title: "Example Show Season 1",
          seasonNumber: 1,
        },
        episodes: [{
          titleNumber: 1,
          title: "Episode 1",
          episodeNumber: 1,
        }],
      },
      create_mapping_proposal: {
        action: "create_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        target: {
          choice: "create_new",
          mediaItem: { kind: "movie", title: "Proposed Movie" },
        },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      },
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
        outcome: "reviewed_with_selections",
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

  it("shows archived DVD evidence separately from editable hierarchy and reviewed mappings", () => {
    const html = renderToStaticMarkup(
      <CatalogReviewView
        state={{
          status: "loaded",
          review: {
            catalogRevision: "2026-08-03T18:00:00.000Z",
            archive: {
              id: "archive-1",
              discLabel: "EPISODE_DISC_2_2005",
              discKind: "dvd",
              archiveFormat: "iso",
              archivedAt: "2026-08-03T18:00:00.000Z",
              catalogReviewedAt: null,
              catalogReviewOutcome: "needs_review",
            },
            reviewOutcome: "needs_review",
            rawScan: {
              titles: [{
                number: 1,
                durationSeconds: 2_400,
                chapters: 8,
                audioStreams: [{
                  id: 128,
                  language: "English",
                  format: "AC3",
                  channels: 6,
                }],
                subtitles: [{
                  id: 32,
                  language: "English",
                  content: "Normal",
                }],
              },
              {
                number: 2,
                durationSeconds: 3_600,
                chapters: 12,
                audioStreams: [],
                subtitles: [],
              }],
            },
            coverage: {
              discSelectionCount: 1,
              mediaItemsWithSelections: 1,
              mappedTitles: 0,
              partiallyMappedTitles: 1,
              unmappedTitles: 1,
              mainFeatureSelections: 0,
              titles: [
                {
                  titleNumber: 1,
                  status: "partially_mapped",
                  hasOverlap: false,
                },
                {
                  titleNumber: 2,
                  status: "unmapped",
                  hasOverlap: false,
                },
              ],
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
        mappingProposalError={null}
        selectionKind="main_feature"
        activeMappingProposal={null}
        archiveOnlySelected={false}
        onClose={() => undefined}
        onRetry={() => undefined}
        onEditMediaItem={() => undefined}
        onCancelEdit={() => undefined}
        onDiscSelectionsPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onArchiveOnlyChange={() => undefined}
        onStartMappingProposal={() => undefined}
        onCancelMappingProposal={() => undefined}
        onCreateMappingProposal={() => undefined}
        onSaveMediaItem={() => undefined}
        onCreateDiscSelection={() => undefined}
        onDeleteDiscSelection={() => undefined}
        onCompleteReview={() => undefined}
      />,
    );

    expect(html).toContain("Catalog Episode Disc 2 2005");
    expect(html).toContain(
      "Disc Selection selection-1 cannot be deleted because Encode Job history must be preserved",
    );
    expect(html).toContain("Archived Scan Evidence");
    expect(html).toContain("Original volume label");
    expect(html).toContain("EPISODE_DISC_2_2005");
    expect(html).toContain("Title 1");
    expect(html).toContain("40m 0s");
    expect(html).toContain("8 chapters");
    expect(html).toContain("Audio: English");
    expect(html).toContain("Subtitles: English");
    expect(html).toContain("Episode or long-extra candidate");
    expect(html).toContain("Title 2");
    expect(html).toContain("Feature-length candidate");
    expect(html).toContain("Longest title");
    expect(html).toContain("Audio stream 0x80");
    expect(html).toContain("Subtitle stream 0x20");
    expect(html).toContain("Media Item hierarchy");
    expect(html).toContain("Chapter Show");
    expect(html).toContain("Parent context");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(3);
    expect(html).toContain("Season 1");
    expect(html).toContain("Episode One");
    expect(html).toContain("Reviewed Disc Selections");
    expect(html).toContain("Title 1, chapters 1–4");
    expect(html).not.toContain("Next Media Items");
    expect(html).toContain("Add Disc Selection");
    expect(html).toContain('name="replacesDiscSelectionId"');
    expect(html).toContain("Locked provenance");
    expect(html).toContain("Encode Job job-1 is completed");
    expect(html).not.toContain("Repair an existing Disc Selection");
    expect(html).not.toContain("Remove Disc Selection");
    expect(html).toContain("Next Disc Selections");
    expect(html).toContain("Complete review");
    expect(selectOptionValues(html, "selectionKind")).toEqual(
      DISC_SELECTION_KINDS,
    );
  });

  it("preserves full mapped hierarchy and ancestor context while editing", () => {
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
              catalogReviewOutcome: "needs_review",
            },
            reviewOutcome: "needs_review",
            rawScan: { titles: [] },
            coverage: {
              discSelectionCount: 1,
              mediaItemsWithSelections: 1,
              mappedTitles: 0,
              partiallyMappedTitles: 0,
              unmappedTitles: 0,
              mainFeatureSelections: 0,
              titles: [],
            },
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
            ],
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
        mappingProposalError={null}
        selectionKind="main_feature"
        activeMappingProposal={null}
        archiveOnlySelected={false}
        onClose={() => undefined}
        onRetry={() => undefined}
        onEditMediaItem={() => undefined}
        onCancelEdit={() => undefined}
        onDiscSelectionsPage={() => undefined}
        onSelectionKindChange={() => undefined}
        onArchiveOnlyChange={() => undefined}
        onStartMappingProposal={() => undefined}
        onCancelMappingProposal={() => undefined}
        onCreateMappingProposal={() => undefined}
        onSaveMediaItem={() => undefined}
        onCreateDiscSelection={() => undefined}
        onDeleteDiscSelection={() => undefined}
        onCompleteReview={() => undefined}
      />,
    );

    expect(html).toContain("Parent context");
    expect(html).toContain('value="season-1" selected="">— Parent Season');
    expect(html).toContain("Mapped Episode");
    expect(html).not.toContain("Unknown Media Item");
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(3);
  });
});
