"use client";

import { useEffect, useRef, useState } from "react";

import type {
  AutomaticCatalogProposal,
  AutomaticCatalogSuggestion,
  CatalogMetadataCandidate,
  CatalogMetadataSelection,
} from "../lib/catalog-automation";
import type { CatalogReviewReplacementEncodeInput } from "../lib/catalog-review-command";
import type {
  CatalogReviewDto,
} from "./catalog-review-model";

type SuggestionState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded";
      suggestion: AutomaticCatalogSuggestion;
      matches: CatalogMetadataCandidate[];
      selectedMatch: CatalogMetadataCandidate | null;
      isSelecting: boolean;
      selectionError: boolean;
    }
  | { status: "error" };

type CatalogSuggestionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestAutomaticCatalogSuggestion(
  archiveId: string,
  fetcher: CatalogSuggestionFetch = fetch,
  metadataSelection?: CatalogMetadataSelection,
): Promise<AutomaticCatalogSuggestion> {
  const parameters = metadataSelection === undefined
    ? ""
    : `?${new URLSearchParams({
      tmdbId: String(metadataSelection.id),
      mediaType: metadataSelection.kind,
    }).toString()}`;
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}/suggestion${parameters}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("Automatic catalog suggestion request failed");
  }
  return response.json() as Promise<AutomaticCatalogSuggestion>;
}

function TmdbAttribution() {
  return (
    <div className="catalog-tmdb-attribution">
      <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
        <img
          src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
          alt="TMDB"
        />
      </a>
      <span>
        This product uses the TMDB API but is not endorsed or certified by
        TMDB.
      </span>
    </div>
  );
}

function formatYear(year: number | null): string {
  return year === null ? "" : ` (${year})`;
}

function matchKey(match: CatalogMetadataSelection): string {
  return `${match.kind}:${match.id}`;
}

function MatchChoices({
  matches,
  selectedMatch,
  isSelecting,
  isSaving,
  onSelect,
}: {
  matches: readonly CatalogMetadataCandidate[];
  selectedMatch: CatalogMetadataCandidate | null;
  isSelecting: boolean;
  isSaving: boolean;
  onSelect(match: CatalogMetadataCandidate): void;
}) {
  return (
    <div
      className="catalog-automation-alternatives"
      aria-busy={isSelecting}
    >
      <h4>Choose a TMDB match</h4>
      <ul>
        {matches.map((match) => (
          <li key={matchKey(match)}>
            <button
              type="button"
              aria-pressed={
                selectedMatch !== null &&
                matchKey(selectedMatch) === matchKey(match)
              }
              disabled={isSaving}
              onClick={() => onSelect(match)}
            >
              <strong>{match.title}{formatYear(match.year)}</strong>
              <span>{match.kind === "movie" ? "Movie" : "TV series"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProposalDetails({ proposal }: { proposal: AutomaticCatalogProposal }) {
  if (proposal.kind === "movie") {
    return (
      <>
        <div className="catalog-automation-heading">
          <div>
            <span className="catalog-automation-kind">Movie</span>
            <h3>{proposal.title}{formatYear(proposal.year)}</h3>
          </div>
          <span className="catalog-automation-confidence">
            {proposal.confidence} confidence
          </span>
        </div>
        <p>{proposal.explanation}</p>
        <dl className="catalog-automation-summary">
          <div>
            <dt>Encode source</dt>
            <dd>DVD main feature</dd>
          </div>
          <div>
            <dt>Scanned DVD titles</dt>
            <dd>
              {proposal.scannedTitleCount === 0
                ? "None"
                : `${proposal.scannedTitleCount} preserved; source resolved during encoding`}
            </dd>
          </div>
        </dl>
      </>
    );
  }
  return (
    <>
      <div className="catalog-automation-heading">
        <div>
          <span className="catalog-automation-kind">TV series</span>
          <h3>
            {proposal.title}{formatYear(proposal.year)} · Season {proposal.seasonNumber}
          </h3>
        </div>
        <span className="catalog-automation-confidence">
          {proposal.confidence} confidence
        </span>
      </div>
      <p>{proposal.explanation}</p>
      <ol className="catalog-automation-episodes">
        {proposal.input.episodes.map((episode) => (
          <li key={episode.titleNumber}>
            <span>DVD title {episode.titleNumber}</span>
            <strong>
              S{String(proposal.seasonNumber).padStart(2, "0")}E{
                String(episode.episodeNumber).padStart(2, "0")
              } · {episode.title}
            </strong>
          </li>
        ))}
      </ol>
      {proposal.unselectedTitleCount > 0 ? (
        <p>
          {proposal.unselectedTitleCount} other DVD {proposal.unselectedTitleCount === 1
            ? "title stays"
            : "titles stay"} archived but unselected.
        </p>
      ) : null}
    </>
  );
}

export function CatalogReviewAutomation({
  review,
  isSaving,
  onAcceptProposal,
  onCompleteReview,
}: {
  review: CatalogReviewDto;
  isSaving: boolean;
  onAcceptProposal(proposal: AutomaticCatalogProposal): void;
  onCompleteReview(
    outcome: "reviewed_with_selections",
    replacements: CatalogReviewReplacementEncodeInput[],
  ): void;
}) {
  const [state, setState] = useState<SuggestionState>({ status: "idle" });
  const suggestionRequest = useRef(0);
  const pristine = review.reviewOutcome === "needs_review" &&
    review.coverage.discSelectionCount === 0;
  const configured = review.automaticCataloging?.configured ?? false;

  useEffect(() => {
    const request = ++suggestionRequest.current;
    if (!pristine || !configured) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    void requestAutomaticCatalogSuggestion(review.archive.id)
      .then((suggestion) => {
        if (request !== suggestionRequest.current) return;
        setState({
          status: "loaded",
          suggestion,
          matches: suggestion.status === "needs_review"
            ? suggestion.matches ?? []
            : [],
          selectedMatch: null,
          isSelecting: false,
          selectionError: false,
        });
      })
      .catch(() => {
        if (request === suggestionRequest.current) {
          setState({ status: "error" });
        }
      });
    return () => {
      if (request === suggestionRequest.current) {
        suggestionRequest.current += 1;
      }
    };
  }, [configured, pristine, review.archive.id, review]);

  function selectMatch(match: CatalogMetadataCandidate) {
    const request = ++suggestionRequest.current;
    setState((current) => current.status !== "loaded"
      ? current
      : {
        ...current,
        selectedMatch: match,
        isSelecting: true,
        selectionError: false,
      });
    void requestAutomaticCatalogSuggestion(review.archive.id, fetch, match)
      .then((suggestion) => {
        if (request !== suggestionRequest.current) return;
        setState((current) => current.status !== "loaded"
          ? current
          : {
            ...current,
            suggestion,
            selectedMatch: match,
            isSelecting: false,
            selectionError: false,
          });
      })
      .catch(() => {
        if (request !== suggestionRequest.current) return;
        setState((current) => current.status !== "loaded"
          ? current
          : {
            ...current,
            selectedMatch: match,
            isSelecting: false,
            selectionError: true,
          });
      });
  }

  if (review.reviewOutcome !== "needs_review") return null;
  if (review.coverage.discSelectionCount > 0) {
    const mappingIsComplete = review.coverage.mainFeatureSelections > 0 ||
      (review.coverage.titles.length > 0 &&
        review.coverage.partiallyMappedTitles === 0 &&
        review.coverage.unmappedTitles === 0);
    if (!mappingIsComplete) {
      return (
        <section className="catalog-automation" aria-labelledby="catalog-manual-title">
          <p className="section-eyebrow">Manual review still needed</p>
          <h3 id="catalog-manual-title">Some content is mapped, but the disc is not resolved</h3>
          <p>
            Keep using the manual tools below to identify the remaining titles,
            or finish deliberately from the Review Coverage section after you
            confirm they are menus or extras.
          </p>
        </section>
      );
    }
    const replacementCount = review.replacementPlan?.jobs.length ?? 0;
    return (
      <section className="catalog-automation is-ready" aria-labelledby="catalog-ready-title">
        <div>
          <p className="section-eyebrow">Ready to finish</p>
          <h3 id="catalog-ready-title">The catalog mapping is ready</h3>
          <p>
            {review.coverage.mediaItemsWithSelections} catalog {
              review.coverage.mediaItemsWithSelections === 1 ? "item is" : "items are"
            } mapped. Unselected menus and extras do not block completion.
          </p>
        </div>
        {replacementCount === 0 ? (
          <button
            type="button"
            disabled={isSaving}
            onClick={() => onCompleteReview("reviewed_with_selections", [])}
          >
            Finish cataloging
          </button>
        ) : (
          <p>
            Review the corrected replacement choices below before finishing.
          </p>
        )}
      </section>
    );
  }
  if (!configured) {
    return (
      <section className="catalog-automation" aria-labelledby="catalog-automatic-title">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3 id="catalog-automatic-title">TMDB needs to be connected</h3>
        <p>
          Add a TMDB key or read token to the web service. Once connected, this
          page can identify movies and TV seasons before asking you to confirm
          anything.
        </p>
      </section>
    );
  }
  if (state.status === "idle" || state.status === "loading") {
    return (
      <section className="catalog-automation" aria-live="polite">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3>Identifying this title</h3>
        <p>Comparing the disc label and title runtimes with TMDB…</p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="catalog-automation">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3>Automatic identification is unavailable</h3>
        <p>The archive is safe. Use the manual tools below or reopen this review to retry.</p>
      </section>
    );
  }
  const suggestion = state.suggestion;
  const matchChoices = state.matches.length === 0
    ? null
    : (
      <MatchChoices
        key="tmdb-match-choices"
        matches={state.matches}
        selectedMatch={state.selectedMatch}
        isSelecting={state.isSelecting}
        isSaving={isSaving}
        onSelect={selectMatch}
      />
    );
  if (state.isSelecting && state.selectedMatch !== null) {
    return (
      <section className="catalog-automation" aria-live="polite">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3>
          Checking {state.selectedMatch.title}{formatYear(state.selectedMatch.year)}
        </h3>
        <p>Building a catalog proposal from this TMDB match.</p>
        {matchChoices}
        <TmdbAttribution />
      </section>
    );
  }
  if (state.selectionError) {
    return (
      <section className="catalog-automation">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3>That TMDB match could not be checked</h3>
        <p role="alert">Choose it again to retry, or try another match.</p>
        {matchChoices}
        <TmdbAttribution />
      </section>
    );
  }
  if (suggestion.status === "needs_review") {
    if (matchChoices !== null) {
      return (
        <section className="catalog-automation">
          <p className="section-eyebrow">Automatic cataloging</p>
          <h3>
            {state.selectedMatch === null
              ? "Choose the right TMDB match"
              : "This match still needs manual review"}
          </h3>
          <p>{suggestion.message}</p>
          <p>
            {state.selectedMatch === null
              ? "Pick a match to build its catalog proposal. You can switch choices until you save."
              : "Choose another match, or use the manual tools below for this disc."}
          </p>
          {matchChoices}
          <TmdbAttribution />
        </section>
      );
    }
    return (
      <section className="catalog-automation">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3>I could not make a safe automatic choice</h3>
        <p>{suggestion.message}</p>
        <p>
          I searched for "{suggestion.hints.query}". The manual tools below are
          still available for this disc.
        </p>
        <TmdbAttribution />
      </section>
    );
  }
  const { proposal } = suggestion;
  return (
    <section className="catalog-automation is-proposed" aria-labelledby="catalog-proposal-title">
      <p className="section-eyebrow">Automatic catalog proposal</p>
      {matchChoices}
      <div id="catalog-proposal-title">
        <ProposalDetails proposal={proposal} />
      </div>
      <div className="catalog-automation-actions">
        <button
          type="button"
          disabled={isSaving}
          onClick={() => onAcceptProposal(proposal)}
        >
          {proposal.kind === "movie"
            ? "Use this and continue"
            : "Use these episodes and continue"}
        </button>
        <span>This saves the mapping and finishes the review.</span>
      </div>
      <TmdbAttribution />
    </section>
  );
}
