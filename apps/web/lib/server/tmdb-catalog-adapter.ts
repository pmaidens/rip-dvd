import type {
  CatalogMetadataCandidate,
  CatalogMetadataLookup,
  CatalogMetadataSeason,
  CatalogMetadataTvDetails,
} from "../catalog-automation";

type CatalogMetadataFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type TmdbCredential =
  | { kind: "api_key"; apiKey: string }
  | { kind: "bearer_token"; bearerToken: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function yearFromDate(value: unknown): number | null {
  const text = textValue(value);
  if (!text) return null;
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(text);
  const year = Number(match?.[1]);
  return Number.isSafeInteger(year) && year >= 1800 && year <= 9999
    ? year
    : null;
}

function candidate(value: unknown): CatalogMetadataCandidate | null {
  const item = record(value);
  const id = integer(item?.id);
  const mediaType = item?.media_type;
  if (!item || id === null || id < 1) return null;
  if (mediaType === "movie") {
    const title = textValue(item.title) ?? textValue(item.original_title);
    return title === null
      ? null
      : {
        id,
        kind: "movie",
        title,
        year: yearFromDate(item.release_date),
      };
  }
  if (mediaType === "tv") {
    const title = textValue(item.name) ?? textValue(item.original_name);
    return title === null
      ? null
      : {
        id,
        kind: "tv_show",
        title,
        year: yearFromDate(item.first_air_date),
      };
  }
  return null;
}

function tvDetails(value: unknown): CatalogMetadataTvDetails {
  const result = record(value);
  if (!result || !Array.isArray(result.seasons)) {
    throw new Error("TMDB returned invalid TV details");
  }
  const seasons = result.seasons.map((value) => {
    const season = record(value);
    const seasonNumber = integer(season?.season_number);
    if (seasonNumber === null || seasonNumber < 0) {
      throw new Error("TMDB returned invalid TV details");
    }
    return { seasonNumber };
  });
  if (new Set(seasons.map(({ seasonNumber }) => seasonNumber)).size !==
    seasons.length) {
    throw new Error("TMDB returned duplicate TV seasons");
  }
  return { seasons };
}

function seasonDetails(value: unknown): CatalogMetadataSeason {
  const result = record(value);
  const seasonNumber = integer(result?.season_number);
  const title = textValue(result?.name);
  if (
    !result || seasonNumber === null || seasonNumber < 0 ||
    title === null || !Array.isArray(result.episodes)
  ) {
    throw new Error("TMDB returned invalid season details");
  }
  const episodes = result.episodes.map((value) => {
    const episode = record(value);
    const episodeNumber = integer(episode?.episode_number);
    const episodeTitle = textValue(episode?.name);
    const runtime = episode?.runtime === null
      ? null
      : integer(episode?.runtime);
    if (
      episodeNumber === null || episodeNumber < 1 ||
        episodeTitle === null ||
        (episode?.runtime !== null && runtime === null) ||
        (runtime !== null && runtime < 1)
    ) {
      throw new Error("TMDB returned invalid season episode details");
    }
    return {
      episodeNumber,
      title: episodeTitle,
      runtimeMinutes: runtime,
    };
  });
  if (
    episodes.length === 0 ||
    episodes.some(({ episodeNumber }, index) => episodeNumber !== index + 1)
  ) {
    throw new Error("TMDB season episodes are not a complete ordered sequence");
  }
  return { seasonNumber, title, episodes };
}

export function tmdbCredentialFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TmdbCredential | null {
  const bearerToken = environment.TMDB_API_TOKEN?.trim();
  const apiKey = environment.TMDB_API_KEY?.trim();
  return bearerToken
    ? { kind: "bearer_token", bearerToken }
    : apiKey
    ? { kind: "api_key", apiKey }
    : null;
}

export function createTmdbCatalogLookup(
  credential: TmdbCredential,
  fetcher: CatalogMetadataFetch = fetch,
): CatalogMetadataLookup {
  async function request(path: string, parameters?: Record<string, string>) {
    const url = new URL(path, "https://api.themoviedb.org/3/");
    url.searchParams.set("language", "en-US");
    for (const [name, value] of Object.entries(parameters ?? {})) {
      url.searchParams.set(name, value);
    }
    if (credential.kind === "api_key") {
      url.searchParams.set("api_key", credential.apiKey);
    }
    const response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        ...(credential.kind === "bearer_token"
          ? { Authorization: `Bearer ${credential.bearerToken}` }
          : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`TMDB request failed with status ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }

  return {
    async search(query) {
      const result = record(await request("search/multi", {
        query,
        include_adult: "false",
        page: "1",
      }));
      if (!result || !Array.isArray(result.results)) {
        throw new Error("TMDB returned invalid search results");
      }
      return result.results.slice(0, 20).flatMap((value) => {
        const parsed = candidate(value);
        return parsed === null ? [] : [parsed];
      });
    },
    async getTvDetails(id) {
      return tvDetails(await request(`tv/${id}`));
    },
    async getTvSeason(id, seasonNumber) {
      return seasonDetails(await request(`tv/${id}/season/${seasonNumber}`));
    },
  };
}
