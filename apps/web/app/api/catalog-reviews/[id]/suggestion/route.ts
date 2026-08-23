import {
  decodeArchivedDvdTitles,
  normalizeMediaItemSearchTitle,
  type DataAccess,
  type MediaItem,
  type OriginalDiscArchiveId,
  type TmdbIdentity,
} from "@rip-dvd/data-access";

import {
  suggestCatalog,
  type AutomaticCatalogSuggestion,
  type CatalogMetadataLookup,
  type CatalogMetadataSelection,
} from "../../../../../lib/catalog-automation";
import { getDataAccess } from "../../../../../lib/data-access";
import {
  createTmdbCatalogLookup,
  tmdbCredentialFromEnvironment,
} from "../../../../../lib/server/tmdb-catalog-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const CATALOG_PAGE_SIZE = 100;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function defaultLookup(): CatalogMetadataLookup | null {
  const credential = tmdbCredentialFromEnvironment();
  return credential === null ? null : createTmdbCatalogLookup(credential);
}

function metadataSelectionFromParameters(
  parameters: URLSearchParams,
): CatalogMetadataSelection | undefined | null {
  if ([...parameters.keys()].length === 0) return undefined;
  if (
    [...parameters.keys()].some((key) =>
      key !== "tmdbId" && key !== "mediaType"
    ) ||
    parameters.getAll("tmdbId").length !== 1 ||
    parameters.getAll("mediaType").length !== 1
  ) {
    return null;
  }
  const tmdbIdText = parameters.get("tmdbId") ?? "";
  const mediaType = parameters.get("mediaType");
  const tmdbId = Number(tmdbIdText);
  return /^(?:[1-9]\d*)$/.test(tmdbIdText) &&
      Number.isSafeInteger(tmdbId) &&
      (mediaType === "movie" || mediaType === "tv_show")
    ? { id: tmdbId, kind: mediaType }
    : null;
}

function isCompatibleCatalogMatch(
  item: MediaItem,
  kind: MediaItem["kind"],
  title: string,
  year: number | null,
): boolean {
  return item.kind === kind &&
    normalizeMediaItemSearchTitle(item.title) ===
      normalizeMediaItemSearchTitle(title) &&
    year !== null && item.year === year;
}

function allCatalogPages(
  loadPage: (offset: number) => MediaItem[],
): MediaItem[] {
  const items: MediaItem[] = [];
  for (let offset = 0;; offset += CATALOG_PAGE_SIZE) {
    const page = loadPage(offset);
    items.push(...page);
    if (page.length < CATALOG_PAGE_SIZE) return items;
  }
}

function findCompatibleCatalogItems(
  access: DataAccess,
  kind: MediaItem["kind"],
  title: string,
  year: number | null,
): MediaItem[] {
  return allCatalogPages((offset) =>
    access.catalog.searchMediaItems({
      query: title,
      limit: CATALOG_PAGE_SIZE,
      offset,
    })
  )
    .filter((item) =>
      isCompatibleCatalogMatch(item, kind, title, year)
    );
}

function conflictingCatalogIdentity(
  access: DataAccess,
  item: MediaItem,
  proposed: TmdbIdentity,
): boolean {
  const current = access.catalog.findTmdbIdentityByMediaItemId(item.id);
  return current !== null &&
    (current.mediaType !== proposed.mediaType ||
      current.tmdbId !== proposed.tmdbId);
}

function ambiguousLocalCatalogMatch(
  suggestion: Extract<AutomaticCatalogSuggestion, { status: "ready" }>,
  description: string,
): AutomaticCatalogSuggestion {
  return {
    status: "needs_review",
    hints: suggestion.hints,
    reason: "ambiguous_catalog_match",
    message:
      `More than one local ${description} matches this disc. Choose the intended catalog item manually.`,
  };
}

function catalogIdentityConflict(
  suggestion: Extract<AutomaticCatalogSuggestion, { status: "ready" }>,
): AutomaticCatalogSuggestion {
  return {
    status: "needs_review",
    hints: suggestion.hints,
    reason: "catalog_identity_conflict",
    message:
      "The matching local catalog item identifies different TMDB content. Choose the intended item manually.",
  };
}

function reuseExistingCatalogItems(
  access: DataAccess,
  suggestion: AutomaticCatalogSuggestion,
): AutomaticCatalogSuggestion {
  if (suggestion.status !== "ready") return suggestion;
  const proposal = suggestion.proposal;
  if (proposal.kind === "movie") {
    const identified = access.catalog.findMediaItemByTmdbIdentity({
      mediaType: "movie",
      tmdbId: proposal.tmdbId,
    });
    const compatible = identified === null
      ? findCompatibleCatalogItems(
        access,
        "movie",
        proposal.title,
        proposal.year,
      )
      : [];
    if (compatible.length > 1) {
      return ambiguousLocalCatalogMatch(suggestion, "Movie");
    }
    const existing = identified ?? compatible[0] ?? null;
    if (
      existing !== null &&
      conflictingCatalogIdentity(access, existing, {
        mediaType: "movie",
        tmdbId: proposal.tmdbId,
      })
    ) {
      return catalogIdentityConflict(suggestion);
    }
    return existing === null
      ? suggestion
      : {
        ...suggestion,
        proposal: {
          ...proposal,
          input: {
            ...proposal.input,
            target: {
              choice: "use_existing",
              mediaItemId: existing.id,
              tmdbIdentity: {
                mediaType: "movie",
                tmdbId: proposal.tmdbId,
              },
            },
          },
        },
      };
  }
  const identifiedShow = access.catalog.findMediaItemByTmdbIdentity({
    mediaType: "tv_show",
    tmdbId: proposal.tmdbId,
  });
  const compatibleShows = identifiedShow === null
    ? findCompatibleCatalogItems(
      access,
      "tv_show",
      proposal.title,
      proposal.year,
    )
    : [];
  if (compatibleShows.length > 1) {
    return ambiguousLocalCatalogMatch(suggestion, "TV Show");
  }
  const show = identifiedShow ?? compatibleShows[0] ?? null;
  if (show === null) return suggestion;
  if (conflictingCatalogIdentity(access, show, {
    mediaType: "tv_show",
    tmdbId: proposal.tmdbId,
  })) {
    return catalogIdentityConflict(suggestion);
  }
  const showChildren = allCatalogPages((offset) =>
    access.catalog.listMediaItems({
      parentId: show.id,
      limit: CATALOG_PAGE_SIZE,
      offset,
    })
  );
  const matchingSeasons = showChildren.filter((item) =>
    item.kind === "season" && item.seasonNumber === proposal.seasonNumber
  );
  if (matchingSeasons.length > 1) {
    return ambiguousLocalCatalogMatch(suggestion, "Season");
  }
  const season = matchingSeasons[0] ?? null;
  const existingEpisodes = season === null
    ? []
    : allCatalogPages((offset) =>
      access.catalog.listMediaItems({
        parentId: season.id,
        limit: CATALOG_PAGE_SIZE,
        offset,
      })
    );
  const matchingEpisodes = proposal.input.episodes.map((episode) =>
    existingEpisodes.filter((item) =>
      item.kind === "episode" &&
      item.episodeNumber === episode.episodeNumber
    )
  );
  if (matchingEpisodes.some((matches) => matches.length > 1)) {
    return ambiguousLocalCatalogMatch(suggestion, "Episode");
  }
  return {
    ...suggestion,
    proposal: {
      ...proposal,
      input: {
        ...proposal.input,
        tvShow: {
          choice: "use_existing",
          mediaItemId: show.id,
          tmdbIdentity: {
            mediaType: "tv_show",
            tmdbId: proposal.tmdbId,
          },
        },
        season: season === null
          ? proposal.input.season
          : { choice: "use_existing", mediaItemId: season.id },
        episodes: proposal.input.episodes.map((episode, index) => {
          const existing = matchingEpisodes[index]?.[0];
          return existing === undefined
            ? episode
            : { ...episode, existingMediaItemId: existing.id };
        }),
      },
    },
  };
}

export async function createCatalogSuggestionRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getLookup: () => CatalogMetadataLookup | null = defaultLookup,
): Promise<Response> {
  if (request.method !== "GET") {
    return response({ error: "Method not allowed" }, 405);
  }
  const parameters = new URL(request.url).searchParams;
  const metadataSelection = metadataSelectionFromParameters(parameters);
  if (
    metadataSelection === null ||
    id.trim().length === 0 || id.length > 256
  ) {
    return response({ error: "Invalid Catalog suggestion request" }, 400);
  }
  try {
    const access = getAccess();
    const archiveId = id as OriginalDiscArchiveId;
    const evidence = access.readConsistentSnapshot((snapshot) => {
      const archive = snapshot.catalog.listOriginalDiscArchives({
        ids: [archiveId],
      })[0];
      if (!archive) return null;
      const disc = snapshot.catalog.listDetectedDiscs(undefined, {
        ids: [archive.detectedDiscId],
      })[0];
      if (!disc) return null;
      return {
        discLabel: disc.volumeLabel ?? "",
        titles: decodeArchivedDvdTitles(disc.scanData) ?? [],
      };
    });
    if (evidence === null) {
      return response({ error: "Original Disc Archive not found" }, 404);
    }
    const suggestion = await suggestCatalog(
      evidence.discLabel,
      evidence.titles,
      getLookup(),
      metadataSelection,
    );
    return response(reuseExistingCatalogItems(access, suggestion));
  } catch {
    return response({
      status: "needs_review",
      reason: "metadata_unavailable",
      message:
        "Automatic cataloging is unavailable. The archived disc is safe, and the manual tools still work.",
    }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createCatalogSuggestionRoute(request, id);
}
