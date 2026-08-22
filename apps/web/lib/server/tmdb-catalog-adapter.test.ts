import { describe, expect, it, vi } from "vitest";

import {
  createTmdbCatalogLookup,
  tmdbCredentialFromEnvironment,
} from "./tmdb-catalog-adapter";

describe("TMDB Catalog adapter", () => {
  it("prefers a read token while retaining v3 API-key support", () => {
    expect(tmdbCredentialFromEnvironment({
      TMDB_API_KEY: " key ",
      TMDB_API_TOKEN: " token ",
    })).toEqual({ kind: "bearer_token", bearerToken: "token" });
    expect(tmdbCredentialFromEnvironment({
      TMDB_API_KEY: " key ",
    })).toEqual({ kind: "api_key", apiKey: "key" });
    expect(tmdbCredentialFromEnvironment({})).toBeNull();
  });

  it("normalizes movie and TV search results", async () => {
    const requests: Array<[string | URL, RequestInit | undefined]> = [];
    const fetcher = vi.fn(async (
      input: string | URL,
      init?: RequestInit,
    ) => {
      requests.push([input, init]);
      return Response.json({
      results: [
        {
          id: 1,
          media_type: "movie",
          title: "Movie Match",
          release_date: "1999-08-06",
        },
        {
          id: 2,
          media_type: "tv",
          name: "Show Match",
          first_air_date: "2005-03-26",
        },
        { id: 3, media_type: "person", name: "Not Catalog Content" },
      ],
      });
    });
    const adapter = createTmdbCatalogLookup(
      { kind: "bearer_token", bearerToken: "secret" },
      fetcher,
    );

    await expect(adapter.search("A label")).resolves.toEqual([
      { id: 1, kind: "movie", title: "Movie Match", year: 1999 },
      { id: 2, kind: "tv_show", title: "Show Match", year: 2005 },
    ]);
    const [url, init] = requests[0]!;
    expect(String(url)).toContain("/3/search/multi?");
    expect(String(url)).toContain("query=A+label");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("returns numbered season and episode metadata", async () => {
    const fetcher = vi.fn(async (input: string | URL) =>
      String(input).includes("/season/2")
        ? Response.json({
          season_number: 2,
          name: "Season 2",
          episodes: [
            { episode_number: 1, name: "Arrival", runtime: 42 },
            { episode_number: 2, name: "Departure", runtime: null },
          ],
        })
        : Response.json({
          seasons: [
            { season_number: 0, episode_count: 4 },
            { season_number: 2, episode_count: 10 },
          ],
        }));
    const adapter = createTmdbCatalogLookup(
      { kind: "api_key", apiKey: "key" },
      fetcher,
    );

    await expect(adapter.getTvDetails(20)).resolves.toEqual({
      seasons: [
        { seasonNumber: 0 },
        { seasonNumber: 2 },
      ],
    });
    await expect(adapter.getTvSeason(20, 2)).resolves.toEqual({
      seasonNumber: 2,
      title: "Season 2",
      episodes: [
        { episodeNumber: 1, title: "Arrival", runtimeMinutes: 42 },
        { episodeNumber: 2, title: "Departure", runtimeMinutes: null },
      ],
    });
    expect(String(fetcher.mock.calls[0]![0])).toContain("api_key=key");
  });

  it("rejects a season with a malformed middle episode", async () => {
    const fetcher = vi.fn(async () => Response.json({
      season_number: 1,
      name: "Season 1",
      episodes: [
        { episode_number: 1, name: "First", runtime: 42 },
        { episode_number: 2, name: "", runtime: 42 },
        { episode_number: 3, name: "Third", runtime: 42 },
      ],
    }));
    const adapter = createTmdbCatalogLookup(
      { kind: "api_key", apiKey: "key" },
      fetcher,
    );

    await expect(adapter.getTvSeason(20, 1)).rejects.toThrow(
      "invalid season episode details",
    );
  });

  it("rejects a season whose episode sequence has a gap", async () => {
    const fetcher = vi.fn(async () => Response.json({
      season_number: 1,
      name: "Season 1",
      episodes: [
        { episode_number: 1, name: "First", runtime: 42 },
        { episode_number: 3, name: "Third", runtime: 42 },
      ],
    }));
    const adapter = createTmdbCatalogLookup(
      { kind: "api_key", apiKey: "key" },
      fetcher,
    );

    await expect(adapter.getTvSeason(20, 1)).rejects.toThrow(
      "complete ordered sequence",
    );
  });
});
