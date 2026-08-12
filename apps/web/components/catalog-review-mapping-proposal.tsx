"use client";

import React, { useState } from "react";

import { displayTerm } from "../lib/display-term";
import { integerFormValue } from "./catalog-review-form";
import { orderMediaItemHierarchy } from "./catalog-review-hierarchy";
import { requestMediaItemSearch } from "./catalog-review-media-item-search";
import {
  mediaItemKinds,
  type CatalogReviewMediaItem,
  type CreateMappingProposalInput,
  type MappingProposal,
  type MediaItemSearchDto,
  type MediaItemKind,
} from "./catalog-review-model";

const actionMediaItemKinds = {
  movie: "movie",
  bonus_feature: "bonus_feature",
  trailer: "trailer",
  chapters: "other",
  other: "other",
  main_feature: "movie",
} satisfies Record<MappingProposal["action"], MediaItemKind>;

function sourceDescription(proposal: MappingProposal): string {
  const source = proposal.sourceIdentity;
  if (source.kind === "main_feature") {
    return "DVD main feature";
  }
  if (source.kind === "dvd_title") {
    return `exact whole Title ${source.titleNumber}`;
  }
  return `Title ${source.titleNumber} chapter range`;
}

export function CatalogReviewMappingProposal({
  proposal,
  proposedTitle,
  mediaItems,
  isSaving,
  error,
  onCancel,
  onCreate,
}: {
  proposal: MappingProposal;
  proposedTitle: string;
  mediaItems: CatalogReviewMediaItem[];
  isSaving: boolean;
  error: string | null;
  onCancel(): void;
  onCreate(input: CreateMappingProposalInput): void;
}) {
  const hierarchy = orderMediaItemHierarchy(mediaItems);
  const source = proposal.sourceIdentity;
  const [targetChoice, setTargetChoice] = useState<
    "create_new" | "use_existing"
  >("create_new");
  const [searchQuery, setSearchQuery] = useState(proposedTitle);
  const [searchResult, setSearchResult] = useState<MediaItemSearchDto | null>(
    null,
  );
  const [selectedMediaItemId, setSelectedMediaItemId] = useState<string | null>(
    null,
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function searchMediaItems(offset = 0) {
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchError("Enter a Media Item title to search.");
      return;
    }
    setIsSearching(true);
    setSearchError(null);
    setSelectedMediaItemId(null);
    try {
      setSearchResult(await requestMediaItemSearch(query, offset));
    } catch {
      setSearchResult(null);
      setSearchError("Media Item search is unavailable.");
    } finally {
      setIsSearching(false);
    }
  }

  function createProposal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") ?? "").trim();
    const sourceIdentity = source.kind === "dvd_chapters"
      ? {
          kind: source.kind,
          titleNumber: source.titleNumber,
          chapterStart: integerFormValue(form, "chapterStart") ?? 0,
          chapterEnd: integerFormValue(form, "chapterEnd") ?? 0,
        } as const
      : source;
    if (targetChoice === "use_existing" && selectedMediaItemId === null) {
      setSearchError("Select an existing Media Item before saving.");
      return;
    }
    const parentId = String(form.get("parentId") ?? "").trim();
    onCreate({
      target: targetChoice === "create_new"
        ? {
          choice: "create_new",
          mediaItem: {
            parentId: parentId === "" ? null : parentId,
            kind: String(form.get("kind")) as MediaItemKind,
            title: String(form.get("title") ?? "").trim(),
            year: integerFormValue(form, "year") ?? null,
            seasonNumber: integerFormValue(form, "seasonNumber") ?? null,
            episodeNumber: integerFormValue(form, "episodeNumber") ?? null,
          },
        }
        : {
          choice: "use_existing",
          mediaItemId: selectedMediaItemId!,
        },
      discSelection: {
        sourceIdentity,
        ...(label ? { label } : {}),
      },
    });
  }

  return (
    <section
      className="catalog-mapping-proposal"
      aria-labelledby="active-mapping-proposal"
    >
      <div className="profile-form-heading">
        <div>
          <p className="section-eyebrow">Assisted Mapping</p>
          <h4 id="active-mapping-proposal">Mapping Proposal</h4>
        </div>
        <button type="button" onClick={onCancel} disabled={isSaving}>
          Cancel proposal
        </button>
      </div>
      <p className="catalog-help">
        Review the proposed Media Item and Disc Selection for {sourceDescription(
          proposal,
        )}. Nothing is created until you submit both together.
      </p>
      {error ? (
        <div
          className="catalog-mapping-proposal-error section-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <form className="catalog-form" onSubmit={createProposal}>
        <fieldset>
          <legend>Media Item choice</legend>
          <div className="catalog-mapping-target-choices">
            <label>
              <input
                type="radio"
                name="mappingTargetChoice"
                value="create_new"
                checked={targetChoice === "create_new"}
                onChange={() => setTargetChoice("create_new")}
              />
              Create new Media Item
            </label>
            <label>
              <input
                type="radio"
                name="mappingTargetChoice"
                value="use_existing"
                checked={targetChoice === "use_existing"}
                onChange={() => setTargetChoice("use_existing")}
              />
              Use existing Media Item
            </label>
          </div>
        </fieldset>
        {targetChoice === "create_new" ? (
          <fieldset key="create-new-media-item">
            <legend>Create new Media Item</legend>
            <div className="catalog-fields">
              <label>
                Title
                <input
                  name="title"
                  required
                  maxLength={256}
                  defaultValue={proposedTitle}
                />
              </label>
              <label>
                Kind
                <select
                  name="kind"
                  defaultValue={actionMediaItemKinds[proposal.action]}
                >
                  {mediaItemKinds.map((kind) => (
                    <option key={kind} value={kind}>{displayTerm(kind)}</option>
                  ))}
                </select>
              </label>
              <label>
                Parent
                <select name="parentId" defaultValue="">
                  <option value="">No parent</option>
                  {hierarchy.map(({ item, depth }) => (
                    <option key={item.id} value={item.id}>
                      {`${"— ".repeat(depth)}${item.title}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Year
                <input name="year" type="number" min="1800" max="9999" />
              </label>
              <label>
                Season number
                <input name="seasonNumber" type="number" min="0" />
              </label>
              <label>
                Episode number
                <input name="episodeNumber" type="number" min="1" />
              </label>
            </div>
          </fieldset>
        ) : (
          <fieldset key="use-existing-media-item">
            <legend>Use existing Media Item</legend>
            <div className="catalog-media-item-search-controls">
              <label>
                Search by title
                <input
                  name="mediaItemSearch"
                  maxLength={256}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                disabled={isSaving || isSearching}
                onClick={() => void searchMediaItems()}
              >
                {isSearching ? "Searching…" : "Search full catalog"}
              </button>
            </div>
            {searchError ? (
              <p className="catalog-media-item-search-error" role="alert">
                {searchError}
              </p>
            ) : null}
            {searchResult ? (
              <>
                {searchResult.results.length === 0 ? (
                  <p className="catalog-empty">No Media Items matched.</p>
                ) : (
                  <ul className="catalog-media-item-search-results">
                    {searchResult.results.map((result) => (
                      <li key={result.mediaItem.id}>
                        <label>
                          <input
                            type="radio"
                            name="existingMediaItemId"
                            value={result.mediaItem.id}
                            checked={selectedMediaItemId === result.mediaItem.id}
                            onChange={() =>
                              setSelectedMediaItemId(result.mediaItem.id)}
                          />
                          <span>
                            <strong>{[
                              ...result.ancestors.map((item) => item.title),
                              result.mediaItem.title,
                            ].join(" › ")}</strong>
                            <span>{displayTerm(result.mediaItem.kind)}</span>
                            {result.suggestion ? (
                              <span className="catalog-search-suggestion">
                                {result.suggestion === "exact"
                                  ? "Exact title suggestion"
                                  : "Normalized title suggestion"}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="catalog-media-item-search-pages">
                  <button
                    type="button"
                    disabled={!searchResult.page.hasPrevious || isSearching}
                    onClick={() =>
                      void searchMediaItems(Math.max(
                        0,
                        searchResult.page.offset - searchResult.page.limit,
                      ))}
                  >
                    Previous search results
                  </button>
                  <button
                    type="button"
                    disabled={!searchResult.page.hasNext || isSearching}
                    onClick={() =>
                      void searchMediaItems(
                        searchResult.page.offset + searchResult.page.limit,
                      )}
                  >
                    Next search results
                  </button>
                </div>
              </>
            ) : null}
          </fieldset>
        )}
        <fieldset>
          <legend>Proposed Disc Selection</legend>
          <div className="catalog-fields">
            <label>
              Source
              <input value={sourceDescription(proposal)} readOnly />
            </label>
            {source.kind !== "main_feature" ? (
              <label>
                DVD title
                <input
                  name="titleNumber"
                  type="number"
                  value={source.titleNumber}
                  readOnly
                />
              </label>
            ) : null}
            {source.kind === "dvd_chapters" ? (
              <>
                <label>
                  First chapter
                  <input
                    name="chapterStart"
                    type="number"
                    min="1"
                    max={source.chapterEnd}
                    required
                    defaultValue={source.chapterStart}
                  />
                </label>
                <label>
                  Last chapter
                  <input
                    name="chapterEnd"
                    type="number"
                    min="1"
                    max={source.chapterEnd}
                    required
                    defaultValue={source.chapterEnd}
                  />
                </label>
              </>
            ) : null}
            <label>
              Label
              <input name="label" maxLength={256} placeholder="Optional" />
            </label>
          </div>
        </fieldset>
        <button type="submit" disabled={isSaving}>
          {targetChoice === "create_new"
            ? "Create Media Item and Disc Selection"
            : "Use existing Media Item and create Disc Selection"}
        </button>
      </form>
    </section>
  );
}
