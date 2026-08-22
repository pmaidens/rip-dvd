import { describe, expect, it, vi } from "vitest";

import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";

import {
  catalogDiscHints,
  suggestCatalog,
  type CatalogMetadataCandidate,
  type CatalogMetadataLookup,
  type CatalogMetadataSeason,
} from "./catalog-automation";

function title(number: number, durationSeconds: number): DvdTitle {
  return {
    number,
    durationSeconds,
    chapters: 8,
    audioStreams: [],
    subtitles: [],
  };
}

function lookup(overrides: Partial<CatalogMetadataLookup>): CatalogMetadataLookup {
  return {
    search: vi.fn(async () => []),
    getTvDetails: vi.fn(async () => ({ seasons: [] })),
    getTvSeason: vi.fn(async () => {
      throw new Error("Unexpected season lookup");
    }),
    ...overrides,
  };
}

function season(
  count: number,
  runtimeMinutes = 42,
): CatalogMetadataSeason {
  return {
    seasonNumber: 1,
    title: "Season 1",
    episodes: Array.from({ length: count }, (_, index) => ({
      episodeNumber: index + 1,
      title: `Story ${index + 1}`,
      runtimeMinutes,
    })),
  };
}

describe("automatic Catalog proposals", () => {
  it("extracts search and TV ordering hints from a DVD label", () => {
    expect(catalogDiscHints(
      "DOCTOR_WHO.S01_DISC_2_OF_3_2005_SPECIAL_EDITION",
      [title(1, 2_520), title(2, 2_500), title(3, 80)],
    )).toEqual({
      query: "Doctor Who",
      formattedLabel: "Doctor Who S01 Disc 2 of 3 2005 Special Edition",
      year: 2005,
      seasonNumber: 1,
      discNumber: 2,
      discCount: 3,
      likelyKind: "tv_show",
    });
  });

  it.each(["VOL", "VOLUME", "SIDE"])(
    "parses %s numbering as disc-order evidence",
    (alias) => {
      expect(catalogDiscHints(
        `EXAMPLE_SHOW_S01_${alias}_1_OF_2_2020`,
        [title(1, 1_320), title(2, 1_320)],
      )).toMatchObject({
        query: "Example Show",
        year: 2020,
        seasonNumber: 1,
        discNumber: 1,
        discCount: 2,
      });
    },
  );

  it("parses compact season/disc markers and bracketed years", () => {
    expect(catalogDiscHints(
      "EXAMPLE_SHOW_S01D02_OF_03_2020",
      [title(1, 1_320), title(2, 1_320)],
    )).toMatchObject({
      query: "Example Show",
      year: 2020,
      seasonNumber: 1,
      discNumber: 2,
      discCount: 3,
    });
    expect(catalogDiscHints("DUNE_(2021)_DISC_1", [title(1, 9_300)]))
      .toMatchObject({ query: "Dune", year: 2021, discNumber: 1 });
  });

  it("uses a bracketed year to disambiguate a remake", async () => {
    const suggestion = await suggestCatalog(
      "DUNE_(2021)_DISC_1",
      [title(1, 9_300)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
          { id: 841, kind: "movie", title: "Dune", year: 1984 },
          { id: 438_631, kind: "movie", title: "Dune", year: 2021 },
        ]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      hints: { query: "Dune", year: 2021 },
      proposal: { kind: "movie", tmdbId: 438_631 },
    });
  });

  it("preserves numeric movie titles instead of treating them as years", () => {
    expect(catalogDiscHints("1917", [title(1, 7_140)])).toMatchObject({
      query: "1917",
      year: null,
    });
    expect(catalogDiscHints(
      "2001_A_SPACE_ODYSSEY_DISC_1",
      [title(1, 8_940)],
    )).toMatchObject({
      query: "2001 a Space Odyssey",
      year: null,
      discNumber: 1,
    });
  });

  it("automatically identifies a movie whose title starts with a year", async () => {
    await expect(suggestCatalog(
      "2001_A_SPACE_ODYSSEY_DISC_1",
      [title(1, 8_940)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 62,
          kind: "movie",
          title: "2001: A Space Odyssey",
          year: 1968,
        }]),
      }),
    )).resolves.toMatchObject({
      status: "ready",
      hints: { query: "2001 a Space Odyssey", year: null },
      proposal: { kind: "movie", tmdbId: 62, year: 1968 },
    });
  });

  it("proposes a TMDB movie with HandBrake main-feature selection", async () => {
    const suggestion = await suggestCatalog(
      "THE_IRON_GIANT_1999_DISC_1",
      [title(1, 5_160), title(2, 600), title(3, 75)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 10_350,
          kind: "movie",
          title: "The Iron Giant",
          year: 1999,
        }]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "movie",
        title: "The Iron Giant",
        year: 1999,
        confidence: "high",
        input: {
          target: {
            choice: "create_new",
            mediaItem: {
              kind: "movie",
              title: "The Iron Giant",
              year: 1999,
            },
          },
          discSelection: { sourceIdentity: { kind: "main_feature" } },
        },
      },
    });
  });

  it("keeps a dominant movie feature ahead of clustered short extras", async () => {
    await expect(suggestCatalog(
      "THE_IRON_GIANT_1999_DISC_1",
      [title(1, 5_400), title(2, 1_200), title(3, 1_230)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 10_350,
          kind: "movie",
          title: "The Iron Giant",
          year: 1999,
        }]),
      }),
    )).resolves.toMatchObject({
      status: "ready",
      hints: { likelyKind: "movie" },
      proposal: { kind: "movie", tmdbId: 10_350 },
    });
  });

  it("does not accept an exact title when the label year conflicts", async () => {
    await expect(suggestCatalog(
      "DUNE_2021",
      [title(1, 9_300)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 841,
          kind: "movie",
          title: "Dune",
          year: 1984,
        }]),
      }),
    )).resolves.toMatchObject({
      status: "needs_review",
      reason: "metadata_match_uncertain",
    });
  });

  it("does not accept a movie when the DVD structure looks episodic", async () => {
    await expect(suggestCatalog(
      "EXAMPLE_2020",
      [title(1, 2_520), title(2, 2_500)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 1,
          kind: "movie",
          title: "Example",
          year: 2020,
        }]),
      }),
    )).resolves.toMatchObject({
      status: "needs_review",
      reason: "metadata_match_uncertain",
    });
  });

  it("declines to choose between same-name remakes without a year hint", async () => {
    const suggestion = await suggestCatalog(
      "THE_THING",
      [title(1, 6_540)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
          { id: 1, kind: "movie", title: "The Thing", year: 1982 },
          { id: 2, kind: "movie", title: "The Thing", year: 2011 },
        ]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      matches: [
        { id: 1, title: "The Thing", year: 1982 },
        { id: 2, title: "The Thing", year: 2011 },
      ],
    });
  });

  it("keeps same-name remakes ambiguous regardless of search rank", async () => {
    const suggestion = await suggestCatalog(
      "THE_THING",
      [title(1, 6_540)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
          { id: 1, kind: "movie", title: "The Thing", year: 1982 },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: 100 + index,
            kind: "movie" as const,
            title: `Unrelated ${index + 1}`,
            year: 2000 + index,
          })),
          { id: 2, kind: "movie", title: "The Thing", year: 2011 },
        ]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      matches: [
        { id: 1, title: "The Thing", year: 1982 },
        { id: 2, title: "The Thing", year: 2011 },
      ],
    });
  });

  it("keeps exact title-and-year duplicates ambiguous regardless of rank", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_2020",
      [title(1, 5_400)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
          { id: 1, kind: "movie", title: "Example", year: 2020 },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: 100 + index,
            kind: "movie" as const,
            title: `Unrelated ${index + 1}`,
            year: 2000 + index,
          })),
          { id: 2, kind: "movie", title: "Example", year: 2020 },
        ]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      matches: [
        { id: 1, title: "Example", year: 2020 },
        { id: 2, title: "Example", year: 2020 },
      ],
    });
  });

  it("keeps equal-title and equal-year media types ambiguous without structural evidence", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_2020",
      [title(1, 600)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
          { id: 1, kind: "movie", title: "Example", year: 2020 },
          { id: 2, kind: "tv_show", title: "Example", year: 2020 },
        ]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      matches: [
        { id: 1, kind: "movie", title: "Example", year: 2020 },
        { id: 2, kind: "tv_show", title: "Example", year: 2020 },
      ],
    });
  });

  it("returns close partial-title matches as ambiguous candidates", async () => {
    const suggestion = await suggestCatalog(
      "OFFICE_2005",
      [title(1, 5_400)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
          { id: 1, kind: "movie", title: "The Office", year: 2005 },
          { id: 2, kind: "movie", title: "Office Space", year: 2005 },
        ]),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "ambiguous_metadata_match",
      matches: [
        { id: 1, title: "The Office" },
        { id: 2, title: "Office Space" },
      ],
    });
  });

  it("maps a numbered TV disc to TMDB episodes using DVD order", async () => {
    const getTvSeason = vi.fn(async () => season(6));
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_2_OF_2_2020",
      [
        title(1, 2_510),
        title(2, 2_520),
        title(3, 2_500),
        title(4, 8_000),
        title(5, 90),
      ],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason,
      }),
    );

    expect(getTvSeason).toHaveBeenCalledWith(99, 1);
    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        title: "Example Show",
        seasonNumber: 1,
        unselectedTitleCount: 2,
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 4, title: "Story 4" },
            { titleNumber: 2, episodeNumber: 5, title: "Story 5" },
            { titleNumber: 3, episodeNumber: 6, title: "Story 6" },
          ],
        },
      },
    });
  });

  it("uses volume numbering to align a TV episode batch", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_VOL_1_OF_2_2020",
      [title(1, 2_510), title(2, 2_520)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(4)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 1 },
            { titleNumber: 2, episodeNumber: 2 },
          ],
        },
      },
    });
  });

  it("uses TMDB runtimes to map clustered long-form TV episodes", async () => {
    const suggestion = await suggestCatalog(
      "LONG_SHOW_S01_DISC_1_2020",
      [title(1, 4_800), title(2, 4_830)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 101,
          kind: "tv_show",
          title: "Long Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(2, 80)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      hints: { likelyKind: "tv_show" },
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 1 },
            { titleNumber: 2, episodeNumber: 2 },
          ],
        },
      },
    });
  });

  it("maps an earlier disc in an equal-sized multi-disc season", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_OF_2_2020",
      Array.from({ length: 4 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 1 },
            { titleNumber: 2, episodeNumber: 2 },
            { titleNumber: 3, episodeNumber: 3 },
            { titleNumber: 4, episodeNumber: 4 },
          ],
        },
      },
    });
  });

  it("maps the first disc in an uneven 4/4/2 season", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_OF_3_2020",
      Array.from({ length: 4 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(10, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 1 },
            { titleNumber: 2, episodeNumber: 2 },
            { titleNumber: 3, episodeNumber: 3 },
            { titleNumber: 4, episodeNumber: 4 },
          ],
        },
      },
    });
  });

  it("does not infer a middle-disc offset from its own title count", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_2_OF_3_2020",
      Array.from({ length: 4 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(10, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("keeps a divisible middle disc manual without preceding-disc evidence", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_2_OF_3_2020",
      Array.from({ length: 4 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(12, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("maps an exact six-episode disc without an arbitrary batch ceiling", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_OF_2_2020",
      Array.from({ length: 6 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(12, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
      },
    });
    if (suggestion.status !== "ready" || suggestion.proposal.kind !== "tv_show") {
      throw new Error("Expected an exact six-episode proposal");
    }
    expect(suggestion.proposal.input.episodes).toHaveLength(6);
    expect(suggestion.proposal.input.episodes[0]).toMatchObject({
      titleNumber: 1,
      episodeNumber: 1,
    });
    expect(suggestion.proposal.input.episodes[5]).toMatchObject({
      titleNumber: 6,
      episodeNumber: 6,
    });
  });

  it("does not turn an episode-length extra into another episode", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_2_2020",
      Array.from({ length: 5 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("rejects an episode-length extra on the first disc", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_2020",
      Array.from({ length: 5 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("does not infer a partial first-disc batch from title count alone", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_2020",
      Array.from({ length: 4 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("rejects a numbered batch enlarged by a same-runtime extra", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_OF_2_2020",
      Array.from({ length: 4 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(6, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("aligns variable-length episodes against their individual runtimes", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_OF_2_2020",
      [title(1, 1_320), title(2, 1_320), title(3, 2_640)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => ({
          seasonNumber: 1,
          title: "Season 1",
          episodes: [22, 22, 44, 22, 22, 22].map(
            (runtimeMinutes, index) => ({
              episodeNumber: index + 1,
              title: `Story ${index + 1}`,
              runtimeMinutes,
            }),
          ),
        })),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 1 },
            { titleNumber: 2, episodeNumber: 2 },
            { titleNumber: 3, episodeNumber: 3 },
          ],
        },
      },
    });
  });

  it("rejects a same-runtime extra when the disc does not complete an equal partition", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_2_2020",
      Array.from({ length: 5 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(12, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("maps an uneven final disc from the remaining episode window", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_3_OF_3_2020",
      [title(1, 1_320), title(2, 1_320)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(10, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            { titleNumber: 1, episodeNumber: 9 },
            { titleNumber: 2, episodeNumber: 10 },
          ],
        },
      },
    });
  });

  it("rejects a nonstandard final-disc split without sibling evidence", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_3_OF_3_2020",
      [title(1, 1_320), title(2, 1_320)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(12, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("rejects a later uneven disc when earlier batch sizes are unknown", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_3_2020",
      [title(1, 1_320), title(2, 1_320), title(3, 1_320)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(10, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("does not assume a short Disc 2 is the final disc", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_2_2020",
      [title(1, 1_320), title(2, 1_320)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => season(6, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("uses the only numbered season when the label omits it", async () => {
    const suggestion = await suggestCatalog(
      "ONE_SEASON_SHOW",
      Array.from({ length: 8 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 7,
          kind: "tv_show",
          title: "One Season Show",
          year: 2024,
        }]),
        getTvDetails: vi.fn(async () => ({
          seasons: [
            { seasonNumber: 0 },
            { seasonNumber: 1 },
          ],
        })),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: { kind: "tv_show", seasonNumber: 1 },
    });
  });

  it("rejects metadata for a different season than requested", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_2020",
      [title(1, 1_320), title(2, 1_320)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => ({
          ...season(2, 22),
          seasonNumber: 2,
        })),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "metadata_unavailable",
    });
  });

  it("recognizes a complete single-disc season labeled Disc 1", async () => {
    const suggestion = await suggestCatalog(
      "ONE_SEASON_SHOW_S01_DISC_1",
      Array.from({ length: 8 }, (_, index) => title(index + 1, 1_320)),
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 7,
          kind: "tv_show",
          title: "One Season Show",
          year: 2024,
        }]),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        seasonNumber: 1,
      },
    });
    if (suggestion.status !== "ready" || suggestion.proposal.kind !== "tv_show") {
      throw new Error("Expected a complete TV season proposal");
    }
    expect(suggestion.proposal.input.episodes).toHaveLength(8);
  });

  it("does not guess an episode window without a disc number", async () => {
    const suggestion = await suggestCatalog(
      "ONE_SEASON_SHOW",
      [title(1, 1_320), title(2, 1_310)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 7,
          kind: "tv_show",
          title: "One Season Show",
          year: 2024,
        }]),
        getTvDetails: vi.fn(async () => ({
          seasons: [{ seasonNumber: 1 }],
        })),
        getTvSeason: vi.fn(async () => season(8, 22)),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("requires TMDB runtime evidence before mapping episodes", async () => {
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_S01_DISC_1_2020",
      [title(1, 1_320), title(2, 2_700)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason: vi.fn(async () => ({
          seasonNumber: 1,
          title: "Season 1",
          episodes: [
            { episodeNumber: 1, title: "First", runtimeMinutes: null },
            { episodeNumber: 2, title: "Second", runtimeMinutes: null },
          ],
        })),
      }),
    );

    expect(suggestion).toMatchObject({
      status: "needs_review",
      reason: "episode_order_uncertain",
    });
  });

  it("recognizes a Specials disc as season zero", async () => {
    const getTvSeason = vi.fn(async () => ({
      seasonNumber: 0,
      title: "Specials",
      episodes: [
        { episodeNumber: 1, title: "First Special", runtimeMinutes: 45 },
        { episodeNumber: 2, title: "Second Special", runtimeMinutes: 45 },
      ],
    }));
    const suggestion = await suggestCatalog(
      "EXAMPLE_SHOW_SPECIALS_DISC_1",
      [title(1, 2_700), title(2, 2_680)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 99,
          kind: "tv_show",
          title: "Example Show",
          year: 2020,
        }]),
        getTvSeason,
      }),
    );

    expect(getTvSeason).toHaveBeenCalledWith(99, 0);
    expect(suggestion).toMatchObject({
      status: "ready",
      hints: { query: "Example Show", seasonNumber: 0 },
      proposal: { kind: "tv_show", seasonNumber: 0 },
    });
  });

  it("keeps manual review available when TMDB is not configured", async () => {
    await expect(suggestCatalog(
      "UNKNOWN_DISC",
      [title(1, 5_400)],
      null,
    )).resolves.toMatchObject({
      status: "needs_review",
      reason: "metadata_not_configured",
    });
  });

  it("does not search TMDB when the disc has no volume label", async () => {
    const search = vi.fn(async () => []);

    await expect(suggestCatalog(
      "",
      [title(1, 5_400)],
      lookup({ search }),
    )).resolves.toMatchObject({
      status: "needs_review",
      reason: "disc_label_missing",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps a partial title match in manual review", async () => {
    await expect(suggestCatalog(
      "THE_IRON_GIANT_COLLECTION",
      [title(1, 5_400)],
      lookup({
        search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
          id: 10_350,
          kind: "movie",
          title: "The Iron Giant",
          year: 1999,
        }]),
      }),
    )).resolves.toMatchObject({
      status: "needs_review",
      reason: "metadata_match_uncertain",
      matches: [{ id: 10_350, title: "The Iron Giant" }],
    });
  });

  it("keeps manual review available when TMDB fails", async () => {
    await expect(suggestCatalog(
      "THE_IRON_GIANT_1999",
      [title(1, 5_400)],
      lookup({
        search: vi.fn(async () => {
          throw new Error("TMDB unavailable");
        }),
      }),
    )).resolves.toMatchObject({
      status: "needs_review",
      reason: "metadata_unavailable",
    });
  });
});
