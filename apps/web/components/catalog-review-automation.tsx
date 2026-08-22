"use client";

import { useEffect, useState } from "react";

import type {
  AutomaticCatalogProposal,
  AutomaticCatalogSuggestion,
} from "../lib/catalog-automation";
import type { CatalogReviewReplacementEncodeInput } from "../lib/catalog-review-command";
import type {
  CatalogReviewDto,
} from "./catalog-review-model";

type SuggestionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; suggestion: AutomaticCatalogSuggestion }
  | { status: "error" };

type CatalogSuggestionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestAutomaticCatalogSuggestion(
  archiveId: string,
  fetcher: CatalogSuggestionFetch = fetch,
): Promise<AutomaticCatalogSuggestion> {
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}/suggestion`,
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
  const pristine = review.reviewOutcome === "needs_review" &&
    review.coverage.discSelectionCount === 0;
  const configured = review.automaticCataloging?.configured ?? false;

  useEffect(() => {
    if (!pristine || !configured) {
      setState({ status: "idle" });
      return;
    }
    let isRequestActive = true;
    setState({ status: "loading" });
    void requestAutomaticCatalogSuggestion(review.archive.id)
      .then((suggestion) => {
        if (isRequestActive) setState({ status: "loaded", suggestion });
      })
      .catch(() => {
        if (isRequestActive) setState({ status: "error" });
      });
    return () => {
      isRequestActive = false;
    };
  }, [configured, pristine, review.archive.id, review]);

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
  if (suggestion.status === "needs_review") {
    return (
      <section className="catalog-automation">
        <p className="section-eyebrow">Automatic cataloging</p>
        <h3>I could not make a safe automatic choice</h3>
        <p>{suggestion.message}</p>
        <p>
          I searched for "{suggestion.hints.query}". The manual tools below are
          still available for this disc.
        </p>
        {suggestion.matches && suggestion.matches.length > 0 ? (
          <div className="catalog-automation-alternatives">
            <h4>Possible matches</h4>
            <ul>
              {suggestion.matches.map((match) => (
                <li key={`${match.kind}:${match.id}`}>
                  <strong>{match.title}{formatYear(match.year)}</strong>
                  <span>{match.kind === "movie" ? "Movie" : "TV series"}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <TmdbAttribution />
      </section>
    );
  }
  const { proposal } = suggestion;
  return (
    <section className="catalog-automation is-proposed" aria-labelledby="catalog-proposal-title">
      <p className="section-eyebrow">Automatic catalog proposal</p>
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
