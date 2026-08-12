import React from "react";

import { displayTerm } from "../lib/display-term";
import { integerFormValue } from "./catalog-review-form";
import { orderMediaItemHierarchy } from "./catalog-review-hierarchy";
import {
  mediaItemKinds,
  type CatalogReviewMediaItem,
  type MediaItemKind,
  type SaveMediaItemInput,
} from "./catalog-review-model";

interface CatalogReviewMediaItemsProps {
  mediaItems: CatalogReviewMediaItem[];
  mappedMediaItemIds: readonly string[];
  editingMediaItemId: string | null;
  isSaving: boolean;
  onEdit(id: string): void;
  onCancelEdit(): void;
  onSave(input: SaveMediaItemInput): void;
}

export function CatalogReviewMediaItems({
  mediaItems,
  mappedMediaItemIds,
  editingMediaItemId,
  isSaving,
  onEdit,
  onCancelEdit,
  onSave,
}: CatalogReviewMediaItemsProps) {
  const hierarchy = orderMediaItemHierarchy(mediaItems);
  const mappedIds = new Set(mappedMediaItemIds);
  const editing = mediaItems.find((item) => item.id === editingMediaItemId);

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
            </li>
          ))}
        </ul>
      )}

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
              {hierarchy
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
        </form>
      ) : null}
    </section>
  );
}
