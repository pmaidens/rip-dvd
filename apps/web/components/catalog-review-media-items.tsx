import React from "react";

import { displayTerm } from "../lib/display-term";
import { integerFormValue } from "./catalog-review-form";
import { orderMediaItemHierarchy } from "./catalog-review-hierarchy";
import { requestMediaItemSearch } from "./catalog-review-media-item-search";
import {
  mediaItemKinds,
  type CatalogReviewMediaItem,
  type MediaItemSearchDto,
  type MediaItemSearchResult,
  type MediaItemKind,
  type SaveMediaItemInput,
} from "./catalog-review-model";

interface CatalogReviewMediaItemsProps {
  archiveId: string;
  mediaItems: CatalogReviewMediaItem[];
  mappedMediaItemIds: readonly string[];
  editingMediaItemId: string | null;
  isSaving: boolean;
  onEdit(id: string): void;
  onCancelEdit(): void;
  onSave(input: SaveMediaItemInput): void;
  onDelete(id: string): void;
}

export function CatalogReviewMediaItemMaintenanceResult({
  result,
  isSaving,
  onEdit,
  onDelete,
}: {
  result: MediaItemSearchResult;
  isSaving: boolean;
  onEdit(item: CatalogReviewMediaItem): void;
  onDelete(id: string): void;
}) {
  const { maintenance, mediaItem } = result;
  const deletionUnavailable =
    maintenance.deletionAvailability.state === "unavailable";
  return (
    <li>
      <div>
        <strong>{[
          ...result.ancestors.map((item) => item.title),
          mediaItem.title,
        ].join(" › ")}</strong>
        <span>{displayTerm(mediaItem.kind)}</span>
        {maintenance.discSelectionReferenceCount === 0 ? (
          <span>Unused Media Item</span>
        ) : (
          <span>{`Used by ${maintenance.referencedArchiveCount} ${
            maintenance.referencedArchiveCount === 1 ? "archive" : "archives"
          }`}</span>
        )}
        {deletionUnavailable ? (
          <span>{`Deletion unavailable: ${
            maintenance.deletionAvailability.reason
          }`}</span>
        ) : null}
      </div>
      <div className="profile-actions">
        <button
          type="button"
          disabled={isSaving}
          onClick={() => onEdit(mediaItem)}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={isSaving || deletionUnavailable}
          title={maintenance.deletionAvailability.reason ?? undefined}
          onClick={() => onDelete(mediaItem.id)}
        >
          Delete Media Item
        </button>
      </div>
    </li>
  );
}

export function CatalogReviewMediaItems({
  archiveId,
  mediaItems,
  mappedMediaItemIds,
  editingMediaItemId,
  isSaving,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: CatalogReviewMediaItemsProps) {
  const hierarchy = orderMediaItemHierarchy(mediaItems);
  const mappedIds = new Set(mappedMediaItemIds);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResult, setSearchResult] = React.useState<
    MediaItemSearchDto | null
  >(null);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [isSearching, setIsSearching] = React.useState(false);
  const searchedEditing = searchResult?.results.find(
    (result) => result.mediaItem.id === editingMediaItemId,
  );
  const editing = mediaItems.find((item) => item.id === editingMediaItemId) ??
    searchedEditing?.mediaItem;
  const editingMaintenance = editing?.maintenance ??
    searchedEditing?.maintenance;
  const parentContext = orderMediaItemHierarchy([
    ...new Map([
      ...mediaItems,
      ...(searchedEditing?.ancestors ?? []),
    ].map((item) => [item.id, item])).values(),
  ]);

  async function searchMediaItems(offset = 0) {
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchError("Enter a Media Item title to search.");
      return;
    }
    setIsSearching(true);
    setSearchError(null);
    try {
      setSearchResult(await requestMediaItemSearch(query, offset, {
        archiveId,
      }));
    } catch {
      setSearchResult(null);
      setSearchError("Media Item maintenance search is unavailable.");
    } finally {
      setIsSearching(false);
    }
  }

  function saveMediaItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parentId = String(form.get("parentId") ?? "").trim();
    onSave({
      ...(editing ? { id: editing.id } : {}),
      parentId: parentId === "" ? null : parentId,
      kind: String(form.get("kind")) as MediaItemKind,
      title: String(form.get("title") ?? "").trim(),
      year: integerFormValue(form, "year") ?? null,
      seasonNumber: integerFormValue(form, "seasonNumber") ?? null,
      episodeNumber: integerFormValue(form, "episodeNumber") ?? null,
    });
  }

  return (
    <section className="catalog-pane" aria-labelledby="media-hierarchy">
      <h3 id="media-hierarchy">Media Item hierarchy</h3>
      {hierarchy.length === 0 ? (
        <p className="catalog-empty">
          No Media Items are mapped to this archive yet.
        </p>
      ) : (
        <ul className="media-hierarchy-list">
          {hierarchy.map(({ item, depth }) => (
            <li key={item.id} style={{ paddingLeft: `${depth * 1.1}rem` }}>
              <div>
                <strong>{item.title}</strong>
                <span>{displayTerm(item.kind)}</span>
                {!mappedIds.has(item.id) ? (
                  <span>Parent context</span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onEdit(item.id)}
                disabled={isSaving}
              >
                Edit
              </button>
              {item.maintenance ? (
                <>
                  <button
                    type="button"
                    onClick={() => onDelete(item.id)}
                    disabled={
                      isSaving ||
                      item.maintenance.deletionAvailability.state ===
                        "unavailable"
                    }
                    title={
                      item.maintenance.deletionAvailability.reason ?? undefined
                    }
                  >
                    Delete Media Item
                  </button>
                  {item.maintenance.deletionAvailability.state ===
                      "unavailable" ? (
                    <span>{`Deletion unavailable: ${
                      item.maintenance.deletionAvailability.reason
                    }`}</span>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="media-item-maintenance-search">
        <h4 id="media-item-maintenance-search">Find Media Items for maintenance</h4>
        <p className="catalog-help">
          Search the full catalog, including unused Media Items.
        </p>
        <div className="catalog-media-item-search-controls">
          <label>
            Search by title
            <input
              name="mediaItemMaintenanceSearch"
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
        {searchError ? <p role="alert">{searchError}</p> : null}
        {searchResult ? (
          <>
            {searchResult.results.length === 0 ? (
              <p className="catalog-empty">No Media Items matched.</p>
            ) : (
              <ul className="catalog-media-item-search-results">
                {searchResult.results.map((result) => (
                  <CatalogReviewMediaItemMaintenanceResult
                    key={result.mediaItem.id}
                    result={result}
                    isSaving={isSaving}
                    onEdit={(item) => onEdit(item.id)}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            )}
            <div className="catalog-media-item-search-pages">
              <button
                type="button"
                disabled={!searchResult.page.hasPrevious || isSearching}
                onClick={() => void searchMediaItems(Math.max(
                  0,
                  searchResult.page.offset - searchResult.page.limit,
                ))}
              >
                Previous maintenance results
              </button>
              <button
                type="button"
                disabled={!searchResult.page.hasNext || isSearching}
                onClick={() => void searchMediaItems(
                  searchResult.page.offset + searchResult.page.limit,
                )}
              >
                Next maintenance results
              </button>
            </div>
          </>
        ) : null}
      </section>

      {editing ? (
        <form
          className="catalog-form"
          key={editing.id}
          onSubmit={saveMediaItem}
        >
        <div className="profile-form-heading">
          <h3>{`Edit ${editing.title}`}</h3>
          <button type="button" onClick={onCancelEdit}>Cancel</button>
        </div>
        {editingMaintenance && editingMaintenance.otherArchiveCount > 0 ? (
          <div className="section-message" role="status">
            {`Changes affect ${editingMaintenance.otherArchiveCount} other ${
              editingMaintenance.otherArchiveCount === 1
                ? "archive"
                : "archives"
            } that use this Media Item.`}
          </div>
        ) : null}
        <div className="catalog-fields">
          <label>
            Title
            <input
              name="title"
              required
              maxLength={256}
              defaultValue={editing.title}
            />
          </label>
          <label>
            Kind
            <select name="kind" defaultValue={editing.kind}>
              {mediaItemKinds.map((kind) => (
                <option key={kind} value={kind}>{displayTerm(kind)}</option>
              ))}
            </select>
          </label>
          <label>
            Parent
            <select name="parentId" defaultValue={editing.parentId ?? ""}>
              <option value="">No parent</option>
              {parentContext
                .filter(({ item }) => item.id !== editing.id)
                .map(({ item, depth }) => (
                  <option key={item.id} value={item.id}>
                    {`${"— ".repeat(depth)}${item.title}`}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Year
            <input
              name="year"
              type="number"
              min="1800"
              max="9999"
              defaultValue={editing.year ?? ""}
            />
          </label>
          <label>
            Season number
            <input
              name="seasonNumber"
              type="number"
              min="0"
              defaultValue={editing.seasonNumber ?? ""}
            />
          </label>
          <label>
            Episode number
            <input
              name="episodeNumber"
              type="number"
              min="1"
              defaultValue={editing.episodeNumber ?? ""}
            />
          </label>
        </div>
        <button type="submit" disabled={isSaving}>
          Save Media Item
        </button>
        {editingMaintenance ? (
          <>
            <button
              type="button"
              disabled={
                isSaving ||
                editingMaintenance.deletionAvailability.state === "unavailable"
              }
              title={editingMaintenance.deletionAvailability.reason ?? undefined}
              onClick={() => onDelete(editing.id)}
            >
              Delete Media Item
            </button>
            {editingMaintenance.deletionAvailability.state === "unavailable"
              ? (
                <p>{`Deletion unavailable: ${
                  editingMaintenance.deletionAvailability.reason
                }`}</p>
              )
              : null}
          </>
        ) : null}
        </form>
      ) : null}
    </section>
  );
}
