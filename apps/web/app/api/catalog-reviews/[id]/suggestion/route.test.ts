import { describe, expect, it, vi } from "vitest";

import type {
  CatalogMetadataCandidate,
  CatalogMetadataLookup,
} from "../../../../../lib/catalog-automation";
import { useDataAccessFixture } from "../../../../../test/data-access-fixture";
import { createCatalogSuggestionRoute } from "./route";

const dataAccessFixture = useDataAccessFixture();

function createArchive(
  access: ReturnType<typeof dataAccessFixture.create>,
  label: string,
  durations = [5_400],
) {
  const drive = access.catalog.upsertOpticalDrive({
    devicePath: "/dev/catalog-automation",
    isPresent: true,
  });
  const contentId = `sha256:${"9".repeat(64)}`;
  const disc = access.catalog.registerDetectedDisc({
    opticalDriveId: drive.id,
    discKind: "dvd",
    fingerprint: contentId,
    volumeLabel: label,
    scanData: {
      schemaVersion: 2,
      contentId,
      titles: durations.map((durationSeconds, index) => ({
        number: index + 1,
        durationSeconds,
        chapters: 16,
        audioStreams: [],
        subtitles: [],
      })),
    },
  });
  access.catalog.updateDetectedDiscStatus(disc.id, "scanned");
  access.catalog.updateDetectedDiscStatus(disc.id, "approved");
  return access.catalog.createOriginalDiscArchive({
    detectedDiscId: disc.id,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: `/media/originals/${label}.iso`,
    fingerprint: contentId,
  });
}

function exampleTvLookup(): CatalogMetadataLookup {
  return {
    search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
      id: 99,
      kind: "tv_show",
      title: "Example Show",
      year: 2020,
    }]),
    getTvDetails: vi.fn(async () => ({ seasons: [] })),
    getTvSeason: vi.fn(async () => ({
      seasonNumber: 1,
      title: "Season 1",
      episodes: [
        { episodeNumber: 1, title: "First", runtimeMinutes: 42 },
        { episodeNumber: 2, title: "Second", runtimeMinutes: 42 },
      ],
    })),
  };
}

describe("Catalog automatic suggestion API", () => {
  it("builds a proposal from the selected TMDB search result", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "THE_THING");
    const lookup: CatalogMetadataLookup = {
      search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [
        { id: 1, kind: "movie", title: "The Thing", year: 1982 },
        { id: 2, kind: "movie", title: "The Thing", year: 2011 },
      ]),
      getTvDetails: vi.fn(async () => ({ seasons: [] })),
      getTvSeason: vi.fn(async () => {
        throw new Error("Unexpected TV season lookup");
      }),
    };

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion?tmdbId=2&mediaType=movie`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "ready",
      proposal: { kind: "movie", tmdbId: 2, year: 2011 },
    });
  });

  it("rejects incomplete TMDB selection parameters", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "THE_THING");
    const getLookup = vi.fn(exampleTvLookup);

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion?tmdbId=2`,
      ),
      archive.id,
      () => access,
      getLookup,
    );

    expect(result.status).toBe(400);
    expect(getLookup).not.toHaveBeenCalled();
  });

  it("reuses a TMDB-identified local movie even when its title was edited", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "THE_IRON_GIANT_1999_DISC_1");
    const existing = access.catalog.createMediaItem({
      kind: "movie",
      title: "Iron Giant, The",
      year: 1999,
      tmdbIdentity: { mediaType: "movie", tmdbId: 10_350 },
    });
    const lookup: CatalogMetadataLookup = {
      search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
        id: 10_350,
        kind: "movie",
        title: "The Iron Giant",
        year: 1999,
      }]),
      getTvDetails: vi.fn(async () => ({ seasons: [] })),
      getTvSeason: vi.fn(async () => {
        throw new Error("Unexpected TV season lookup");
      }),
    };

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    await expect(result.json()).resolves.toMatchObject({
      status: "ready",
      proposal: {
        kind: "movie",
        input: {
          target: {
            choice: "use_existing",
            mediaItemId: existing.id,
          },
          discSelection: { sourceIdentity: { kind: "main_feature" } },
        },
      },
    });
  });

  it("does not assign a dated TMDB identity to a yearless title match", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "DUNE_2021");
    const existing = access.catalog.createMediaItem({
      kind: "movie",
      title: "Dune",
    });
    const lookup: CatalogMetadataLookup = {
      search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
        id: 438_631,
        kind: "movie",
        title: "Dune",
        year: 2021,
      }]),
      getTvDetails: vi.fn(async () => ({ seasons: [] })),
      getTvSeason: vi.fn(async () => {
        throw new Error("Unexpected TV season lookup");
      }),
    };

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "ready",
      proposal: {
        kind: "movie",
        input: { target: { choice: "create_new" } },
      },
    });
    expect(access.catalog.findMediaItemByTmdbIdentity({
      mediaType: "movie",
      tmdbId: 438_631,
    })).toBeNull();
    expect(access.catalog.listMediaItems({ ids: [existing.id] })).toEqual([
      existing,
    ]);
  });

  it("requires manual review when duplicate local movies match", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "DUNE_2021");
    for (const title of ["Dune", "DUNE"]) {
      access.catalog.createMediaItem({ kind: "movie", title, year: 2021 });
    }
    const lookup: CatalogMetadataLookup = {
      search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
        id: 438_631,
        kind: "movie",
        title: "Dune",
        year: 2021,
      }]),
      getTvDetails: vi.fn(async () => ({ seasons: [] })),
      getTvSeason: vi.fn(async () => {
        throw new Error("Unexpected TV season lookup");
      }),
    };

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "needs_review",
      reason: "ambiguous_catalog_match",
    });
  });

  it("requires manual review when a title match has another TMDB identity", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "DUNE_2021");
    access.catalog.createMediaItem({
      kind: "movie",
      title: "Dune",
      year: 2021,
      tmdbIdentity: { mediaType: "movie", tmdbId: 841 },
    });
    const lookup: CatalogMetadataLookup = {
      search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
        id: 438_631,
        kind: "movie",
        title: "Dune",
        year: 2021,
      }]),
      getTvDetails: vi.fn(async () => ({ seasons: [] })),
      getTvSeason: vi.fn(async () => {
        throw new Error("Unexpected TV season lookup");
      }),
    };

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "needs_review",
      reason: "catalog_identity_conflict",
    });
  });

  it("reuses a TMDB show and its numbered season and episodes", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(
      access,
      "EXAMPLE_SHOW_S01_DISC_1",
      [2_520, 2_500],
    );
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "My Example Show",
      year: 2020,
      tmdbIdentity: { mediaType: "tv_show", tmdbId: 99 },
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Series One",
      seasonNumber: 1,
    });
    const episodes = [1, 2].map((episodeNumber) =>
      access.catalog.createMediaItem({
        parentId: season.id,
        kind: "episode",
        title: `Local title ${episodeNumber}`,
        episodeNumber,
      })
    );
    const lookup = exampleTvLookup();

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          tvShow: { choice: "use_existing", mediaItemId: show.id },
          season: { choice: "use_existing", mediaItemId: season.id },
          episodes: [
            { episodeNumber: 1, existingMediaItemId: episodes[0]!.id },
            { episodeNumber: 2, existingMediaItemId: episodes[1]!.id },
          ],
        },
      },
    });
  });

  it("requires manual review when a show has duplicate numbered seasons", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(
      access,
      "EXAMPLE_SHOW_S01_DISC_1",
      [2_520, 2_500],
    );
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Example Show",
      year: 2020,
      tmdbIdentity: { mediaType: "tv_show", tmdbId: 99 },
    });
    for (const title of ["Season One", "Series One"]) {
      access.catalog.createMediaItem({
        parentId: show.id,
        kind: "season",
        title,
        seasonNumber: 1,
      });
    }

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      exampleTvLookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "needs_review",
      reason: "ambiguous_catalog_match",
    });
  });

  it("requires manual review when a season has duplicate numbered episodes", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(
      access,
      "EXAMPLE_SHOW_S01_DISC_1",
      [2_520, 2_500],
    );
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Example Show",
      year: 2020,
      tmdbIdentity: { mediaType: "tv_show", tmdbId: 99 },
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Season 1",
      seasonNumber: 1,
    });
    for (const title of ["First", "Alternate First"]) {
      access.catalog.createMediaItem({
        parentId: season.id,
        kind: "episode",
        title,
        episodeNumber: 1,
      });
    }

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      exampleTvLookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "needs_review",
      reason: "ambiguous_catalog_match",
    });
  });

  it("reuses an existing episode after the first catalog page", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(
      access,
      "LONG_SHOW_SPECIALS_DISC_21_OF_21_2020",
      [2_520, 2_500],
    );
    const show = access.catalog.createMediaItem({
      kind: "tv_show",
      title: "Long Show",
      year: 2020,
      tmdbIdentity: { mediaType: "tv_show", tmdbId: 101 },
    });
    const season = access.catalog.createMediaItem({
      parentId: show.id,
      kind: "season",
      title: "Specials",
      seasonNumber: 0,
    });
    const existingEpisodes = Array.from({ length: 101 }, (_, index) =>
      access.catalog.createMediaItem({
        parentId: season.id,
        kind: "episode",
        title: `Special ${index + 1}`,
        episodeNumber: index + 1,
      })
    );
    const lookup: CatalogMetadataLookup = {
      search: vi.fn(async (): Promise<CatalogMetadataCandidate[]> => [{
        id: 101,
        kind: "tv_show",
        title: "Long Show",
        year: 2020,
      }]),
      getTvDetails: vi.fn(async () => ({ seasons: [] })),
      getTvSeason: vi.fn(async () => ({
        seasonNumber: 0,
        title: "Specials",
        episodes: Array.from({ length: 102 }, (_, index) => ({
          episodeNumber: index + 1,
          title: `Special ${index + 1}`,
          runtimeMinutes: 42,
        })),
      })),
    };

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => lookup,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "ready",
      proposal: {
        kind: "tv_show",
        input: {
          episodes: [
            {
              episodeNumber: 101,
              existingMediaItemId: existingEpisodes[100]!.id,
            },
            { episodeNumber: 102 },
          ],
        },
      },
    });
  });

  it("keeps manual review available without TMDB credentials", async () => {
    const access = dataAccessFixture.create();
    const archive = createArchive(access, "UNCONFIGURED_DISC");

    const result = await createCatalogSuggestionRoute(
      new Request(
        `http://localhost:3000/api/catalog-reviews/${archive.id}/suggestion`,
      ),
      archive.id,
      () => access,
      () => null,
    );

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "needs_review",
      reason: "metadata_not_configured",
    });
  });
});
