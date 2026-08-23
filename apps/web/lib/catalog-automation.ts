import { normalizeMediaItemSearchTitle } from "@rip-dvd/data-access";
import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";

import type {
  CatalogReviewEpisodicSeasonTarget,
  CatalogReviewEpisodicTvShowTarget,
  CatalogReviewMappingTarget,
  CatalogReviewProposedDiscSelectionInput,
} from "./catalog-review-command";
import { formatVolumeLabel } from "./catalog-label";

const COMBINED_SEASON_DISC_MARKER =
  /(?:^|\s)s0*(?<season>\d{1,3})d0*(?<disc>\d{1,3})(?:\s*(?:of|\/)\s*0*(?<count>\d{1,3}))?(?=\s|$)/i;
const SEASON_MARKER =
  /(?:^|\s)s(?:eason)?\s*0*(?<season>\d{1,3})(?=\s|$)/i;
const DISC_MARKER =
  /(?:^|\s)(?:d|disc|disk|dvd|vol|volume|side)\s*0*(?<disc>\d{1,3})(?:\s*(?:of|\/)\s*0*(?<count>\d{1,3}))?(?=\s|$)/i;

export interface CatalogMetadataCandidate {
  id: number;
  kind: "movie" | "tv_show";
  title: string;
  year: number | null;
}

export type CatalogMetadataSelection = Pick<
  CatalogMetadataCandidate,
  "id" | "kind"
>;

export interface CatalogMetadataTvDetails {
  seasons: Array<{
    seasonNumber: number;
  }>;
}

export interface CatalogMetadataSeason {
  seasonNumber: number;
  title: string;
  episodes: Array<{
    episodeNumber: number;
    title: string;
    runtimeMinutes: number | null;
  }>;
}

export interface CatalogMetadataLookup {
  search(query: string): Promise<CatalogMetadataCandidate[]>;
  getTvDetails(id: number): Promise<CatalogMetadataTvDetails>;
  getTvSeason(id: number, seasonNumber: number): Promise<CatalogMetadataSeason>;
}

export interface CatalogDiscHints {
  query: string;
  formattedLabel: string;
  year: number | null;
  seasonNumber: number | null;
  discNumber: number | null;
  discCount: number | null;
  likelyKind: "movie" | "tv_show" | "unknown";
}

export type AutomaticCatalogProposal =
  | {
      kind: "movie";
      title: string;
      year: number | null;
      tmdbId: number;
      confidence: "high";
      explanation: string;
      scannedTitleCount: number;
      input: {
        target: CatalogReviewMappingTarget;
        discSelection: CatalogReviewProposedDiscSelectionInput;
      };
    }
  | {
      kind: "tv_show";
      title: string;
      year: number | null;
      tmdbId: number;
      seasonNumber: number;
      confidence: "high";
      explanation: string;
      unselectedTitleCount: number;
      input: {
        tvShow: CatalogReviewEpisodicTvShowTarget;
        season: CatalogReviewEpisodicSeasonTarget;
        episodes: Array<{
          titleNumber: number;
          title: string;
          episodeNumber: number;
        }>;
      };
    };

export type AutomaticCatalogSuggestion =
  | {
      status: "ready";
      hints: CatalogDiscHints;
      proposal: AutomaticCatalogProposal;
    }
  | {
      status: "needs_review";
      hints: CatalogDiscHints;
      reason:
        | "disc_label_missing"
        | "metadata_not_configured"
        | "metadata_unavailable"
        | "no_metadata_match"
        | "ambiguous_metadata_match"
        | "ambiguous_catalog_match"
        | "catalog_identity_conflict"
        | "metadata_match_uncertain"
        | "season_unknown"
        | "episode_order_uncertain";
      message: string;
      matches?: CatalogMetadataCandidate[];
    };

function markerNumber(
  match: RegExpExecArray | null,
  name: "season" | "disc" | "count",
): number | null {
  const value = Number(match?.groups?.[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function consumeMarker(label: string, pattern: RegExp) {
  const match = pattern.exec(label);
  return {
    match,
    remainder: match === null ? label : label.replace(pattern, " "),
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : ordered[middle] ?? 0;
}

function likelyDiscKind(titles: readonly DvdTitle[]): CatalogDiscHints["likelyKind"] {
  const longEpisodeTitles = titles.filter(({ durationSeconds }) =>
    durationSeconds >= 70 * 60 && durationSeconds <= 90 * 60
  );
  if (longEpisodeTitles.length >= 2) {
    const durations = longEpisodeTitles.map(({ durationSeconds }) =>
      durationSeconds
    );
    const middle = median(durations);
    if (durations.filter((duration) =>
      Math.abs(duration - middle) <= Math.max(8 * 60, middle * 0.2)
    ).length >= 2) {
      return "tv_show";
    }
  }
  const longestFeatureSeconds = Math.max(
    0,
    ...titles.map(({ durationSeconds }) =>
      durationSeconds >= 70 * 60 ? durationSeconds : 0
    ),
  );
  const otherProgramSeconds = titles
    .map(({ durationSeconds }) => durationSeconds)
    .filter((durationSeconds) =>
      durationSeconds >= 12 * 60 && durationSeconds < 70 * 60
    )
    .reduce((total, durationSeconds) => total + durationSeconds, 0);
  if (
    longestFeatureSeconds > 0 &&
    longestFeatureSeconds >= otherProgramSeconds * 1.5
  ) {
    return "movie";
  }
  const episodeLengthTitles = titles.filter(({ durationSeconds }) =>
    durationSeconds >= 12 * 60 && durationSeconds <= 75 * 60
  );
  if (episodeLengthTitles.length >= 2) {
    const durations = episodeLengthTitles.map(({ durationSeconds }) =>
      durationSeconds
    );
    const middle = median(durations);
    const clustered = durations.filter((duration) =>
      Math.abs(duration - middle) <= Math.max(8 * 60, middle * 0.35)
    );
    if (clustered.length >= 2) {
      return "tv_show";
    }
  }
  if (titles.some(({ durationSeconds }) => durationSeconds >= 70 * 60)) {
    return "movie";
  }
  return "unknown";
}

export function catalogDiscHints(
  discLabel: string,
  titles: readonly DvdTitle[],
): CatalogDiscHints {
  const formattedLabel = formatVolumeLabel(discLabel);
  const combined = consumeMarker(formattedLabel, COMBINED_SEASON_DISC_MARKER);
  const season = consumeMarker(combined.remainder, SEASON_MARKER);
  const disc = consumeMarker(season.remainder, DISC_MARKER);
  const seasonNumber = markerNumber(combined.match, "season") ??
    markerNumber(season.match, "season") ??
    (/\bspecials?\b/i.test(formattedLabel) ? 0 : null);
  const discNumber = markerNumber(combined.match, "disc") ??
    markerNumber(disc.match, "disc");
  const discCount = markerNumber(combined.match, "count") ??
    markerNumber(disc.match, "count");
  const titleAndYear = disc.remainder
    .replace(/(?:^|\s)(?:special|collector'?s?)\s+edition(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)specials?(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const trailingYear = /(?:^|\s)(?:((?:19|20)\d{2})|\(((?:19|20)\d{2})\)|\[((?:19|20)\d{2})\])$/i
    .exec(titleAndYear);
  const titleWithoutYear = trailingYear === null
    ? titleAndYear
    : titleAndYear.slice(0, trailingYear.index).trim();
  const yearText = trailingYear?.slice(1).find((value) => value !== undefined);
  const year = yearText !== undefined && titleWithoutYear !== ""
    ? Number(yearText)
    : null;
  const query = year === null ? titleAndYear : titleWithoutYear;
  return {
    query: query || formattedLabel,
    formattedLabel,
    year,
    seasonNumber,
    discNumber,
    discCount,
    likelyKind: likelyDiscKind(titles),
  };
}

function candidateScore(
  candidate: CatalogMetadataCandidate,
  hints: CatalogDiscHints,
  rank: number,
): number {
  const query = normalizeMediaItemSearchTitle(hints.query);
  const title = normalizeMediaItemSearchTitle(candidate.title);
  let score = Math.max(0, 10 - rank);
  if (title === query) {
    score += 60;
  } else if (title.includes(query) || query.includes(title)) {
    score += 25;
  }
  if (hints.year !== null && candidate.year === hints.year) {
    score += 25;
  } else if (
    hints.year !== null &&
    candidate.year !== null &&
    Math.abs(candidate.year - hints.year) === 1
  ) {
    score += 8;
  }
  if (hints.likelyKind === candidate.kind) {
    score += 20;
  } else if (hints.likelyKind !== "unknown") {
    score -= 15;
  }
  return score;
}

function chooseCandidate(
  candidates: readonly CatalogMetadataCandidate[],
  hints: CatalogDiscHints,
):
  | { candidate: CatalogMetadataCandidate; confidence: "high" | "medium" }
  | { ambiguous: CatalogMetadataCandidate[] }
  | null {
  const ranked = candidates
    .map((candidate, rank) => ({
      candidate,
      score: candidateScore(candidate, hints, rank),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score < 35) {
    return null;
  }
  const exactTitle = normalizeMediaItemSearchTitle(best.candidate.title) ===
    normalizeMediaItemSearchTitle(hints.query);
  const exactYear = hints.year !== null && best.candidate.year === hints.year;
  const structurallyCompatibleExactTitles = ranked.filter(({ candidate }) =>
    normalizeMediaItemSearchTitle(candidate.title) ===
      normalizeMediaItemSearchTitle(hints.query) &&
    (hints.likelyKind === "unknown" || candidate.kind === hints.likelyKind)
  );
  const indistinguishableExactTitles = structurallyCompatibleExactTitles
    .filter(({ candidate }) =>
      hints.year === null || candidate.year === hints.year
    );
  if (
    indistinguishableExactTitles.length > 1
  ) {
    return {
      ambiguous: indistinguishableExactTitles
        .slice(0, 3)
        .map(({ candidate }) => candidate),
    };
  }
  const closeCandidates = ranked.filter(({ score }) =>
    score >= 35 && best.score - score < 8
  );
  if (closeCandidates.length > 1) {
    return {
      ambiguous: closeCandidates
        .slice(0, 3)
        .map(({ candidate }) => candidate),
    };
  }
  return {
    candidate: best.candidate,
    confidence: exactTitle && hints.likelyKind !== "unknown" &&
        hints.likelyKind === best.candidate.kind &&
        (exactYear ||
          hints.year === null)
      ? "high"
      : "medium",
  };
}

function movieProposal(
  match: CatalogMetadataCandidate,
  titles: readonly DvdTitle[],
): AutomaticCatalogProposal {
  const hasFeatureLengthTitle = titles.some(
    ({ durationSeconds }) => durationSeconds >= 70 * 60,
  );
  return {
    kind: "movie",
    title: match.title,
    year: match.year,
    tmdbId: match.id,
    confidence: "high",
    explanation: hasFeatureLengthTitle
      ? "The disc label matches a movie, and the scan contains a feature-length title. HandBrake will resolve the DVD main feature during encoding."
      : "The disc label matches a movie. HandBrake will inspect the DVD and resolve its main feature during encoding.",
    scannedTitleCount: titles.length,
    input: {
      target: {
        choice: "create_new",
        mediaItem: {
          kind: "movie",
          title: match.title,
          ...(match.year === null ? {} : { year: match.year }),
          tmdbIdentity: { mediaType: "movie", tmdbId: match.id },
        },
      },
      discSelection: { sourceIdentity: { kind: "main_feature" } },
    },
  };
}

function matchesEpisodeRuntime(
  durationSeconds: number,
  runtimeMinutes: number | null,
): boolean {
  if (runtimeMinutes === null || runtimeMinutes <= 0) return false;
  const expectedSeconds = runtimeMinutes * 60;
  return Math.abs(durationSeconds - expectedSeconds) <=
    Math.max(10 * 60, expectedSeconds * 0.4);
}

function episodeCandidateTitles(
  titles: readonly DvdTitle[],
  season: CatalogMetadataSeason,
): DvdTitle[] {
  const episodeRuntimes = season.episodes
    .map(({ runtimeMinutes }) => runtimeMinutes)
    .filter((runtime): runtime is number => runtime !== null && runtime > 0);
  if (episodeRuntimes.length === 0) return [];
  return [...titles]
    .filter(({ durationSeconds }) => {
      if (durationSeconds < 12 * 60 || durationSeconds > 90 * 60) {
        return false;
      }
      return episodeRuntimes.some((runtimeMinutes) =>
        matchesEpisodeRuntime(durationSeconds, runtimeMinutes)
      );
    })
    .sort((left, right) => left.number - right.number);
}

function episodeWindow(
  titles: readonly DvdTitle[],
  season: CatalogMetadataSeason,
  expectedStart: number,
): CatalogMetadataSeason["episodes"] {
  const count = Math.min(titles.length, season.episodes.length);
  if (count === 0) return [];
  let best: CatalogMetadataSeason["episodes"] = [];
  let bestStart = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let start = 0; start <= season.episodes.length - count; start += 1) {
    const window = season.episodes.slice(start, start + count);
    if (window.some((episode, index) =>
      !matchesEpisodeRuntime(
        titles[index]?.durationSeconds ?? 0,
        episode.runtimeMinutes,
      )
    )) continue;
    const runtimeDifference = window.reduce((total, episode, index) => {
      const runtimeMinutes = episode.runtimeMinutes;
      if (runtimeMinutes === null) return Number.POSITIVE_INFINITY;
      return total + Math.abs(
        (titles[index]?.durationSeconds ?? 0) - runtimeMinutes * 60,
      );
    }, 0);
    const discOrderPenalty = Math.abs(start - expectedStart) * 60;
    const score = runtimeDifference + discOrderPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = window;
      bestStart = start;
    }
  }
  return bestStart === expectedStart ? best : [];
}

function episodePartitionStart(
  candidateTitleCount: number,
  seasonEpisodeCount: number,
  discNumber: number | null,
  discCount: number | null,
): number | null {
  if (candidateTitleCount === 0) return null;
  if (
    candidateTitleCount === seasonEpisodeCount &&
    (discNumber === null || discNumber === 1)
  ) {
    return 0;
  }
  if (discNumber === null || discNumber < 1) return null;

  if (
    discCount !== null &&
    discCount >= discNumber &&
    discCount > 1 &&
    (discNumber === 1 || discNumber === discCount)
  ) {
    const fullDiscEpisodeCount = Math.ceil(seasonEpisodeCount / discCount);
    const expectedStart = (discNumber - 1) * fullDiscEpisodeCount;
    const expectedEpisodeCount = Math.min(
      fullDiscEpisodeCount,
      seasonEpisodeCount - expectedStart,
    );
    if (
      expectedEpisodeCount > 0 &&
      candidateTitleCount === expectedEpisodeCount
    ) {
      return expectedStart;
    }
  }

  return null;
}

function tvProposal(
  match: CatalogMetadataCandidate,
  hints: CatalogDiscHints,
  season: CatalogMetadataSeason,
  titles: readonly DvdTitle[],
): AutomaticCatalogProposal | null {
  const candidateTitles = episodeCandidateTitles(titles, season);
  const partitionStart = episodePartitionStart(
    candidateTitles.length,
    season.episodes.length,
    hints.discNumber,
    hints.discCount,
  );
  if (partitionStart === null) return null;
  const episodes = episodeWindow(candidateTitles, season, partitionStart);
  if (candidateTitles.length < 2 || episodes.length !== candidateTitles.length) {
    return null;
  }
  const mappings = episodes.map((episode, index) => ({
    titleNumber: candidateTitles[index]!.number,
    title: episode.title || `Episode ${episode.episodeNumber}`,
    episodeNumber: episode.episodeNumber,
  }));
  return {
    kind: "tv_show",
    title: match.title,
    year: match.year,
    tmdbId: match.id,
    seasonNumber: season.seasonNumber,
    confidence: "high",
    explanation:
      "The disc has a cluster of episode-length titles. The proposed episode order follows the DVD title order and checks each duration against TMDB.",
    unselectedTitleCount: Math.max(0, titles.length - mappings.length),
    input: {
      tvShow: {
        choice: "create_new",
        title: match.title,
        ...(match.year === null ? {} : { year: match.year }),
        tmdbIdentity: { mediaType: "tv_show", tmdbId: match.id },
      },
      season: {
        choice: "create_new",
        title: season.title || `${match.title} Season ${season.seasonNumber}`,
        seasonNumber: season.seasonNumber,
      },
      episodes: mappings,
    },
  };
}

function needsReview(
  hints: CatalogDiscHints,
  reason: Extract<AutomaticCatalogSuggestion, { status: "needs_review" }>['reason'],
  message: string,
  matches?: CatalogMetadataCandidate[],
): AutomaticCatalogSuggestion {
  return {
    status: "needs_review",
    hints,
    reason,
    message,
    ...(matches === undefined ? {} : { matches }),
  };
}

export async function suggestCatalog(
  discLabel: string,
  titles: readonly DvdTitle[],
  lookup: CatalogMetadataLookup | null,
  metadataSelection?: CatalogMetadataSelection,
): Promise<AutomaticCatalogSuggestion> {
  const hints = catalogDiscHints(discLabel, titles);
  if (hints.formattedLabel === "") {
    return needsReview(
      hints,
      "disc_label_missing",
      "The disc has no volume label, so there is not enough evidence to search TMDB safely.",
    );
  }
  if (lookup === null) {
    return needsReview(
      hints,
      "metadata_not_configured",
      "TMDB is not configured, so the program cannot identify this title automatically.",
    );
  }
  let candidates: CatalogMetadataCandidate[];
  try {
    candidates = await lookup.search(hints.query);
  } catch {
    return needsReview(
      hints,
      "metadata_unavailable",
      "TMDB could not be reached. The archived disc is safe, and you can retry later.",
    );
  }
  const operatorSelectedCandidate = metadataSelection === undefined
    ? undefined
    : candidates.find((candidate) =>
      candidate.id === metadataSelection.id &&
      candidate.kind === metadataSelection.kind
    );
  if (metadataSelection !== undefined && operatorSelectedCandidate === undefined) {
    return needsReview(
      hints,
      "no_metadata_match",
      "The selected TMDB match is no longer in the search results. Choose another match or retry the search.",
    );
  }
  const selected = operatorSelectedCandidate === undefined
    ? chooseCandidate(candidates, hints)
    : { candidate: operatorSelectedCandidate, confidence: "high" as const };
  if (selected === null) {
    return needsReview(
      hints,
      "no_metadata_match",
      `TMDB did not return a convincing match for "${hints.query}".`,
    );
  }
  if (selected !== null && "ambiguous" in selected) {
    return needsReview(
      hints,
      "ambiguous_metadata_match",
      `TMDB returned more than one plausible match for "${hints.query}".`,
      selected.ambiguous,
    );
  }
  const { candidate, confidence } = selected;
  if (confidence === "medium") {
    return needsReview(
      hints,
      "metadata_match_uncertain",
      `TMDB returned a possible match for "${hints.query}", but the label did not match closely enough to finish automatically.`,
      [candidate],
    );
  }
  if (candidate.kind === "movie") {
    return { status: "ready", hints, proposal: movieProposal(candidate, titles) };
  }

  let seasonNumber = hints.seasonNumber;
  if (seasonNumber === null) {
    try {
      const details = await lookup.getTvDetails(candidate.id);
      const numberedSeasons = details.seasons.filter(({ seasonNumber }) =>
        seasonNumber > 0
      );
      if (numberedSeasons.length === 1) {
        seasonNumber = numberedSeasons[0]!.seasonNumber;
      }
    } catch {
      return needsReview(
        hints,
        "metadata_unavailable",
        "TMDB matched the TV show, but its season list could not be loaded.",
      );
    }
  }
  if (seasonNumber === null) {
    return needsReview(
      hints,
      "season_unknown",
      `TMDB matched ${candidate.title}, but the disc label does not identify a season.`,
    );
  }
  let season: CatalogMetadataSeason;
  try {
    season = await lookup.getTvSeason(candidate.id, seasonNumber);
    if (season.seasonNumber !== seasonNumber) {
      throw new Error("Metadata season number does not match the request");
    }
  } catch {
    return needsReview(
      hints,
      "metadata_unavailable",
      `TMDB matched ${candidate.title}, but Season ${seasonNumber} could not be loaded.`,
    );
  }
  const proposal = tvProposal(candidate, hints, season, titles);
  return proposal === null
    ? needsReview(
      hints,
      "episode_order_uncertain",
      `TMDB matched ${candidate.title} Season ${seasonNumber}, but the DVD titles do not line up cleanly with its episode runtimes.`,
    )
    : { status: "ready", hints, proposal };
}
