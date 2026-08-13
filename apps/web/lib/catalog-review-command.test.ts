import { describe, expect, it } from "vitest";
import {
  MAX_DVD_TITLES,
  MEDIA_ITEM_KINDS,
} from "@rip-dvd/data-access";

import {
  CATALOG_REVIEW_COMMAND_ACTIONS,
  MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES,
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
  create_episodic_mapping_proposal: {
    action: "create_episodic_mapping_proposal",
    catalogRevision: "2026-08-11T06:00:00.000Z",
    tvShow: {
      choice: "create_new",
      title: "Example Show",
      year: 2004,
    },
    season: {
      choice: "create_new",
      title: "Example Show Season 2",
      seasonNumber: 2,
    },
    episodes: [
      {
        titleNumber: 2,
        title: "Arrival",
        episodeNumber: 7,
        label: "Disc one",
      },
      {
        titleNumber: 4,
        title: "Departure",
        episodeNumber: 9,
      },
    ],
  },
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
  delete_media_item: {
    action: "delete_media_item",
    mediaItemId: "media-item-1",
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
  correct_disc_selection: {
    action: "correct_disc_selection",
    discSelectionId: "selection-1",
    catalogRevision: "2026-08-11T06:00:00.000Z",
    correctionReason: "Mapped the theatrical cut instead of the director's cut.",
    selection: {
      mediaItemId: "media-item-2",
      sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
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
    replacementEncodes: [],
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

  it("parses the explicit Archive-only Review outcome", () => {
    const command = {
      action: "complete_review",
      catalogRevision: "2026-08-11T06:00:00.000Z",
      outcome: "archive_only",
    } as const;

    expect(parseCommand(command)).toEqual({
      ok: true,
      command: { ...command, replacementEncodes: [] },
    });
  });

  it("rejects a replacement selection beyond the atomic review limit", () => {
    const replacementEncodes = Array.from(
      { length: MAX_CATALOG_REVIEW_REPLACEMENT_ENCODES + 1 },
      (_, index) => ({
        predecessorEncodeJobId: `predecessor-${index}`,
        encodingProfileId: "profile-1",
        outputPath: `/media/replacement-${index}.mkv`,
      }),
    );

    expect(parseCommand({
      action: "complete_review",
      catalogRevision: "2026-08-11T06:00:00.000Z",
      outcome: "reviewed_with_selections",
      replacementEncodes,
    })).toEqual({
      ok: false,
      error: "Invalid corrected Encode replacement plan",
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
        action: "create_episodic_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        tvShow: { choice: "create_new", title: "Example Show" },
        season: {
          choice: "create_new",
          title: "Unnumbered Season",
        },
        episodes: [{
          titleNumber: 1,
          title: "Episode 1",
          episodeNumber: 1,
        }],
      },
      "Invalid Episodic Mapping Proposal",
    ],
    [
      {
        action: "create_episodic_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        tvShow: { choice: "use_existing", mediaItemId: "show-1" },
        season: { choice: "use_existing", mediaItemId: "season-1" },
        episodes: [
          { titleNumber: 1, title: "Episode 1", episodeNumber: 1 },
          { titleNumber: 1, title: "Episode 2", episodeNumber: 2 },
        ],
      },
      "Invalid Episodic Mapping Proposal",
    ],
    [
      {
        action: "create_episodic_mapping_proposal",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        tvShow: { choice: "use_existing", mediaItemId: "show-1" },
        season: { choice: "use_existing", mediaItemId: "season-1" },
        episodes: Array.from(
          { length: MAX_DVD_TITLES + 1 },
          (_, index) => ({
            titleNumber: index + 1,
            title: `Episode ${index + 1}`,
            episodeNumber: index + 1,
          }),
        ),
      },
      "Invalid Episodic Mapping Proposal",
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
      { action: "delete_media_item" },
      "Invalid Media Item",
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
      {
        action: "correct_disc_selection",
        discSelectionId: "selection-1",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        correctionReason: "x".repeat(1_001),
        selection: {
          mediaItemId: "media-item-2",
          sourceIdentity: { kind: "dvd_title", titleNumber: 2 },
        },
      },
      "Invalid Disc Selection Correction",
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
    [
      {
        action: "complete_review",
        catalogRevision: "2026-08-11T06:00:00.000Z",
      },
      "Invalid catalog review outcome",
    ],
    [
      {
        action: "complete_review",
        catalogRevision: "2026-08-11T06:00:00.000Z",
        outcome: "zero_selections",
      },
      "Invalid catalog review outcome",
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
