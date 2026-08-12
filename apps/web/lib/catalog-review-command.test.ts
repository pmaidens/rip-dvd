import { describe, expect, it } from "vitest";
import {
  MEDIA_ITEM_KINDS,
} from "@rip-dvd/data-access";

import {
  CATALOG_REVIEW_COMMAND_ACTIONS,
  parseCatalogReviewCommand,
  type CatalogReviewCommand,
} from "./catalog-review-command";

const domainValues = {
  mediaItemKinds: MEDIA_ITEM_KINDS,
};

function parseCommand(value: unknown) {
  return parseCatalogReviewCommand(value, domainValues);
}

const validCommands = {
  create_mapping_proposal: {
    action: "create_mapping_proposal",
    catalogRevision: "2026-08-11T06:00:00.000Z",
    target: {
      choice: "create_new",
      mediaItem: {
        parentId: null,
        kind: "bonus_feature",
        title: "Behind the Scenes",
        year: null,
        seasonNumber: null,
        episodeNumber: null,
      },
    },
    discSelection: {
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 2,
        chapterStart: 1,
        chapterEnd: 3,
      },
      label: "Featurette",
    },
  },
  create_media_item: {
    action: "create_media_item",
    mediaItem: {
      parentId: null,
      kind: "movie",
      title: "Example Movie",
      year: 2026,
      seasonNumber: null,
      episodeNumber: null,
    },
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
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      label: "Feature",
    },
  },
  repair_disc_selection: {
    action: "repair_disc_selection",
    discSelectionId: "selection-1",
    selection: {
      mediaItemId: "media-item-1",
      sourceIdentity: {
        kind: "dvd_chapters",
        titleNumber: 1,
        chapterStart: 1,
        chapterEnd: 4,
      },
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

describe("catalog review command contract", () => {
  it("parses every command variant", () => {
    expect(CATALOG_REVIEW_COMMAND_ACTIONS).toEqual(Object.keys(validCommands));

    for (const action of CATALOG_REVIEW_COMMAND_ACTIONS) {
      const command = validCommands[action];
      expect(parseCommand(command)).toEqual({
        ok: true,
        command,
      });
    }
  });

  it("parses an explicit existing Media Item target without selecting one implicitly", () => {
    expect(parseCommand({
      action: "create_mapping_proposal",
      catalogRevision: "2026-08-11T06:00:00.000Z",
      target: {
        choice: "use_existing",
        mediaItemId: "media-item-1",
      },
      discSelection: {
        sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      },
    })).toEqual({
      ok: true,
      command: {
        action: "create_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        target: {
          choice: "use_existing",
          mediaItemId: "media-item-1",
        },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      },
    });
  });

  it.each([
    [null, "Invalid catalog review mutation"],
    [[], "Invalid catalog review mutation"],
    [{}, "Invalid catalog review mutation"],
    [{ action: 1 }, "Invalid catalog review mutation"],
    [{ action: "publish_review" }, "Unknown catalog review mutation"],
    [
      { action: "create_media_item", mediaItem: { kind: "movie" } },
      "Invalid Media Item",
    ],
    [
      {
        action: "create_mapping_proposal",
        catalogRevision: "not-a-revision",
        target: {
          choice: "create_new",
          mediaItem: { kind: "movie", title: "Example" },
        },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      },
      "Invalid Mapping Proposal",
    ],
    [
      {
        action: "create_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        target: { mediaItemId: "media-item-1" },
        discSelection: {
          sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
        },
      },
      "Invalid Mapping Proposal",
    ],
    [
      {
        action: "update_media_item",
        mediaItemId: "media-item-1",
        changes: {},
      },
      "Invalid Media Item update",
    ],
    [
      {
        action: "create_disc_selection",
        selection: {
          mediaItemId: "media-item-1",
          sourceIdentity: { kind: "dvd_title" },
        },
      },
      "Invalid Disc Selection",
    ],
    [
      {
        action: "repair_disc_selection",
        selection: {
          mediaItemId: "media-item-1",
          kind: "main_feature",
        },
      },
      "Invalid Disc Selection",
    ],
    [
      { action: "delete_disc_selection" },
      "Invalid Disc Selection",
    ],
    [
      { action: "complete_review" },
      "Invalid catalog review revision",
    ],
    [
      { action: "complete_review", catalogRevision: "2026-08-11" },
      "Invalid catalog review revision",
    ],
  ])("rejects invalid body %#", (body, error) => {
    expect(parseCommand(body)).toEqual({ ok: false, error });
  });

  it("retains a validated repair target when its replacement is invalid", () => {
    expect(parseCommand({
      action: "repair_disc_selection",
      discSelectionId: "selection-1",
      selection: { sourceIdentity: { kind: "main_feature" } },
    })).toEqual({
      ok: false,
      error: "Invalid Disc Selection",
      repairDiscSelectionId: "selection-1",
    });
  });
});
