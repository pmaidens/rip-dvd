"use client";

import React, { useState } from "react";

import { displayTerm } from "../lib/display-term";
import { integerFormValue } from "./catalog-review-form";
import { requestMediaItemSearch } from "./catalog-review-media-item-search";
import type {
  CreateEpisodicMappingProposalInput,
  EpisodicMappingProposal,
  MediaItemKind,
  MediaItemSearchDto,
} from "./catalog-review-model";

function ExistingHierarchySearch({
  kind,
  label,
  initialQuery,
  isSaving,
  selectedId,
  onSelect,
}: {
  kind: Extract<MediaItemKind, "tv_show" | "season">;
  label: string;
  initialQuery: string;
  isSaving: boolean;
  selectedId: string | null;
  onSelect(id: string | null): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<MediaItemSearchDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function search(offset = 0) {
    if (query.trim() === "") {
      setError(`Enter a ${label} title to search.`);
      return;
    }
    setIsSearching(true);
    setError(null);
    onSelect(null);
    try {
      setResult(await requestMediaItemSearch(query.trim(), offset));
    } catch {
      setResult(null);
      setError(`${label} search is unavailable.`);
    } finally {
      setIsSearching(false);
    }
  }

  const matches = result?.results.filter(
    ({ mediaItem }) => mediaItem.kind === kind,
  ) ?? [];
  return (
    <div className="catalog-episodic-existing-search">
      <div className="catalog-media-item-search-controls">
        <label>
          Search {label}s by title
          <input
            name={`${kind}Search`}
            maxLength={256}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={isSaving || isSearching}
          onClick={() => void search()}
        >
          {isSearching ? "Searching…" : `Search ${label}s`}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <>
          {matches.length === 0 ? (
            <p className="catalog-empty">No {label}s matched.</p>
          ) : (
            <ul className="catalog-media-item-search-results">
              {matches.map(({ mediaItem, ancestors }) => (
                <li key={mediaItem.id}>
                  <label>
                    <input
                      type="radio"
                      name={`${kind}ExistingId`}
                      checked={selectedId === mediaItem.id}
                      onChange={() => onSelect(mediaItem.id)}
                    />
                    <span>
                      <strong>{[
                        ...ancestors.map((item) => item.title),
                        mediaItem.title,
                      ].join(" › ")}</strong>
                      <span>{displayTerm(mediaItem.kind)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="catalog-media-item-search-pages">
            <button
              type="button"
              disabled={!result.page.hasPrevious || isSearching}
              onClick={() => void search(Math.max(
                0,
                result.page.offset - result.page.limit,
              ))}
            >
              Previous search results
            </button>
            <button
              type="button"
              disabled={!result.page.hasNext || isSearching}
              onClick={() => void search(
                result.page.offset + result.page.limit,
              )}
            >
              Next search results
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function CatalogReviewEpisodicMappingProposal({
  proposal,
  proposedTitle,
  isSaving,
  error,
  onCancel,
  onCreate,
}: {
  proposal: EpisodicMappingProposal;
  proposedTitle: string;
  isSaving: boolean;
  error: string | null;
  onCancel(): void;
  onCreate(input: CreateEpisodicMappingProposalInput): void;
}) {
  const [tvShowChoice, setTvShowChoice] = useState<
    "create_new" | "use_existing"
  >("create_new");
  const [seasonChoice, setSeasonChoice] = useState<
    "create_new" | "use_existing"
  >("create_new");
  const [selectedTvShowId, setSelectedTvShowId] = useState<string | null>(null);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const visibleError = clientError ?? error;
  const errorId = "episodic-mapping-proposal-error";

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (tvShowChoice === "use_existing" && selectedTvShowId === null) {
      setClientError("Select an existing TV Show before saving.");
      return;
    }
    if (seasonChoice === "use_existing" && selectedSeasonId === null) {
      setClientError("Select an existing Season before saving.");
      return;
    }
    setClientError(null);
    onCreate({
      tvShow: tvShowChoice === "create_new"
        ? {
            choice: "create_new",
            title: String(form.get("tvShowTitle") ?? "").trim(),
            year: integerFormValue(form, "tvShowYear") ?? null,
          }
        : { choice: "use_existing", mediaItemId: selectedTvShowId! },
      season: seasonChoice === "create_new"
        ? {
            choice: "create_new",
            title: String(form.get("seasonTitle") ?? "").trim(),
            seasonNumber: integerFormValue(form, "seasonNumber") ?? 0,
          }
        : { choice: "use_existing", mediaItemId: selectedSeasonId! },
      episodes: proposal.episodes.map((episode) => {
        const label = String(
          form.get(`episodeLabel-${episode.titleNumber}`) ?? "",
        ).trim();
        return {
          titleNumber: episode.titleNumber,
          title: String(
            form.get(`episodeTitle-${episode.titleNumber}`) ?? "",
          ).trim(),
          episodeNumber: integerFormValue(
            form,
            `episodeNumber-${episode.titleNumber}`,
          ) ?? 0,
          ...(label === "" ? {} : { label }),
        };
      }),
    });
  }

  return (
    <section
      className="catalog-mapping-proposal catalog-episodic-mapping-proposal"
      aria-labelledby="active-episodic-mapping-proposal"
    >
      <div className="profile-form-heading">
        <div>
          <p className="section-eyebrow">Assisted Mapping</p>
          <h4 id="active-episodic-mapping-proposal">
            Episodic Mapping Proposal
          </h4>
        </div>
        <button type="button" onClick={onCancel} disabled={isSaving}>
          Cancel proposal
        </button>
      </div>
      <p className="catalog-help">
        Review the TV Show, numbered Season, Episodes, and whole-title Disc
        Selections. The complete batch commits together or none of it does.
      </p>
      {visibleError ? (
        <div
          className="catalog-mapping-proposal-error section-error"
          id={errorId}
          role="alert"
        >
          {visibleError}
        </div>
      ) : null}
      <form
        className="catalog-form"
        aria-describedby={visibleError ? errorId : undefined}
        onSubmit={submit}
      >
        <fieldset>
          <legend>TV Show</legend>
          <div className="catalog-mapping-target-choices">
            <label>
              <input
                type="radio"
                name="tvShowChoice"
                checked={tvShowChoice === "create_new"}
                onChange={() => {
                  setTvShowChoice("create_new");
                  setSeasonChoice("create_new");
                }}
              />
              Create new TV Show
            </label>
            <label>
              <input
                type="radio"
                name="tvShowChoice"
                checked={tvShowChoice === "use_existing"}
                onChange={() => setTvShowChoice("use_existing")}
              />
              Use existing TV Show
            </label>
          </div>
          {tvShowChoice === "create_new" ? (
            <div className="catalog-fields">
              <label>
                TV Show title
                <input
                  name="tvShowTitle"
                  required
                  maxLength={256}
                  defaultValue={proposedTitle}
                />
              </label>
              <label>
                Year
                <input name="tvShowYear" type="number" min="1800" max="9999" />
              </label>
            </div>
          ) : (
            <ExistingHierarchySearch
              kind="tv_show"
              label="TV Show"
              initialQuery={proposedTitle}
              isSaving={isSaving}
              selectedId={selectedTvShowId}
              onSelect={setSelectedTvShowId}
            />
          )}
        </fieldset>
        <fieldset>
          <legend>Season</legend>
          <div className="catalog-mapping-target-choices">
            <label>
              <input
                type="radio"
                name="seasonChoice"
                checked={seasonChoice === "create_new"}
                onChange={() => setSeasonChoice("create_new")}
              />
              Create new Season
            </label>
            <label>
              <input
                type="radio"
                name="seasonChoice"
                checked={seasonChoice === "use_existing"}
                disabled={tvShowChoice !== "use_existing"}
                onChange={() => setSeasonChoice("use_existing")}
              />
              Use existing Season
            </label>
          </div>
          {seasonChoice === "create_new" ? (
            <div className="catalog-fields">
              <label>
                Season title
                <input
                  name="seasonTitle"
                  required
                  maxLength={256}
                  defaultValue={`${proposedTitle} Season 1`}
                />
              </label>
              <label>
                Season number
                <input
                  name="seasonNumber"
                  type="number"
                  min="0"
                  required
                  defaultValue="1"
                />
              </label>
            </div>
          ) : (
            <ExistingHierarchySearch
              kind="season"
              label="Season"
              initialQuery={proposedTitle}
              isSaving={isSaving}
              selectedId={selectedSeasonId}
              onSelect={setSelectedSeasonId}
            />
          )}
        </fieldset>
        <fieldset>
          <legend>Episodes and Disc Selections</legend>
          <ol className="catalog-episodic-episodes">
            {proposal.episodes.map((episode) => (
              <li
                key={episode.titleNumber}
                className="catalog-episodic-episode"
              >
                <strong>DVD Title {episode.titleNumber}</strong>
                <div className="catalog-fields">
                  <label>
                    Episode name
                    <input
                      name={`episodeTitle-${episode.titleNumber}`}
                      required
                      maxLength={256}
                      defaultValue={episode.title}
                    />
                  </label>
                  <label>
                    Episode number
                    <input
                      name={`episodeNumber-${episode.titleNumber}`}
                      type="number"
                      min="1"
                      required
                      defaultValue={episode.episodeNumber}
                    />
                  </label>
                  <label>
                    Disc Selection source
                    <input value={`Whole DVD Title ${episode.titleNumber}`} readOnly />
                  </label>
                  <label>
                    Disc Selection label
                    <input
                      name={`episodeLabel-${episode.titleNumber}`}
                      maxLength={256}
                      placeholder="Optional"
                      defaultValue={episode.label ?? ""}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ol>
        </fieldset>
        <button type="submit" disabled={isSaving}>
          Create episodic hierarchy and Disc Selections
        </button>
      </form>
    </section>
  );
}
