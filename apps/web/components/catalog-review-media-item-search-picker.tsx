"use client";

import { useEffect, useState } from "react";

import { displayTerm } from "../lib/display-term";
import { requestMediaItemSearch } from "./catalog-review-media-item-search";
import type {
  MediaItemSearchDto,
  MediaItemSearchResult,
} from "./catalog-review-model";

export function CatalogReviewMediaItemSearchPicker({
  initialQuery,
  selectedMediaItemId,
  inputName = "existingMediaItemId",
  isSaving,
  onSelect,
}: {
  initialQuery: string;
  selectedMediaItemId: string | null;
  inputName?: string;
  isSaving: boolean;
  onSelect(result: MediaItemSearchResult): void;
}) {
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [searchResult, setSearchResult] = useState<MediaItemSearchDto | null>(
    null,
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    setSearchQuery(initialQuery);
    setSearchResult(null);
    setSearchError(null);
  }, [initialQuery]);

  async function searchMediaItems(offset = 0) {
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchError("Enter a Media Item title to search.");
      return;
    }
    setIsSearching(true);
    setSearchError(null);
    try {
      setSearchResult(await requestMediaItemSearch(query, offset));
    } catch {
      setSearchResult(null);
      setSearchError("Media Item search is unavailable.");
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <div className="catalog-media-item-search-picker">
      <div className="catalog-media-item-search-controls">
        <label>
          Search by title
          <input
            name="mediaItemSearch"
            maxLength={256}
            value={searchQuery}
            disabled={isSaving}
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
                      name={inputName}
                      value={result.mediaItem.id}
                      checked={selectedMediaItemId === result.mediaItem.id}
                      disabled={isSaving}
                      onChange={() => onSelect(result)}
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
              disabled={
                isSaving || !searchResult.page.hasPrevious || isSearching
              }
              onClick={() => void searchMediaItems(Math.max(
                0,
                searchResult.page.offset - searchResult.page.limit,
              ))}
            >
              Previous search results
            </button>
            <button
              type="button"
              disabled={isSaving || !searchResult.page.hasNext || isSearching}
              onClick={() => void searchMediaItems(
                searchResult.page.offset + searchResult.page.limit,
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
