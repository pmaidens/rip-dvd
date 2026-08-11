"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import type { DvdTitle } from "@rip-dvd/data-access/dvd-scan";

import type {
  CatalogReviewCommand,
  CatalogReviewDiscSelectionInput,
} from "../lib/catalog-review-command";
import { displayTerm } from "../lib/display-term";

const mediaItemKinds = [
  "movie",
  "tv_show",
  "season",
  "episode",
  "trailer",
  "bonus_feature",
  "other",
] as const;

type MediaItemKind = (typeof mediaItemKinds)[number];
type DiscSelectionKind = "main_feature" | "dvd_title" | "dvd_chapters";

export interface CatalogReviewMediaItem {
  id: string;
  parentId: string | null;
  kind: MediaItemKind;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface CatalogReviewDiscSelection {
  id: string;
  mediaItemId: string;
  sourceKey: string;
  kind: DiscSelectionKind;
  titleNumber: number | null;
  chapterStart: number | null;
  chapterEnd: number | null;
  label: string | null;
}

export interface CatalogReviewDto {
  archive: {
    id: string;
    discLabel: string;
    discKind: string;
    archiveFormat: string;
    archivedAt: string;
    catalogReviewedAt: string | null;
  };
  reviewStatus: "needs_review" | "reviewed";
  rawScan: { titles: DvdTitle[] };
  mediaItems: CatalogReviewMediaItem[];
  mediaItemsPage: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasNext: boolean;
    itemIds: string[];
  };
  discSelections: CatalogReviewDiscSelection[];
  discSelectionsPage: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export type CatalogReviewLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; review: CatalogReviewDto };

interface SaveMediaItemInput {
  id?: string;
  parentId?: string | null;
  kind: MediaItemKind;
  title: string;
  year?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

type CreateSelectionInput = CatalogReviewDiscSelectionInput & {
  replacesDiscSelectionId?: string;
};

interface CatalogReviewViewProps {
  state: CatalogReviewLoadState;
  editingMediaItemId: string | null;
  isSaving: boolean;
  requestError: string | null;
  onClose(): void;
  onRetry(): void;
  onEditMediaItem(id: string): void;
  onCancelEdit(): void;
  onMediaItemsPage(offset: number): void;
  onDiscSelectionsPage(offset: number): void;
  onSaveMediaItem(input: SaveMediaItemInput): void;
  onCreateDiscSelection(input: CreateSelectionInput): void;
  onDeleteDiscSelection(id: string): void;
  onCompleteReview(): void;
}

function integerFormValue(form: FormData, name: string): number | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : Number(value);
}

function orderedHierarchy(items: CatalogReviewMediaItem[]) {
  const byParent = new Map<string | null, CatalogReviewMediaItem[]>();
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId)
      ? item.parentId
      : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), item]);
  }
  const ordered: Array<{ item: CatalogReviewMediaItem; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const item of byParent.get(parentId) ?? []) {
      if (visited.has(item.id)) {
        continue;
      }
      visited.add(item.id);
      ordered.push({ item, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const item of items) {
    if (!visited.has(item.id)) {
      ordered.push({ item, depth: 0 });
    }
  }
  return ordered;
}

function selectionDescription(selection: CatalogReviewDiscSelection): string {
  if (selection.kind === "main_feature") {
    return "DVD main feature";
  }
  if (selection.kind === "dvd_title") {
    return `Title ${selection.titleNumber}`;
  }
  return `Title ${selection.titleNumber}, chapters ${selection.chapterStart}–${selection.chapterEnd}`;
}

export function CatalogReviewView({
  state,
  editingMediaItemId,
  isSaving,
  requestError,
  onClose,
  onRetry,
  onEditMediaItem,
  onCancelEdit,
  onMediaItemsPage,
  onDiscSelectionsPage,
  onSaveMediaItem,
  onCreateDiscSelection,
  onDeleteDiscSelection,
  onCompleteReview,
}: CatalogReviewViewProps) {
  const [selectionKind, setSelectionKind] =
    useState<DiscSelectionKind>("main_feature");

  if (state.status === "loading") {
    return (
      <section className="catalog-editor" aria-live="polite">
        <div className="section-message">Loading catalog review…</div>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="catalog-editor">
        <div className="section-message section-error" role="status">
          <span>Catalog review is unavailable. </span>
          <button type="button" onClick={onRetry}>Try again</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    );
  }

  const { review } = state;
  const hierarchy = orderedHierarchy(review.mediaItems);
  const editableMediaItemIds = new Set(review.mediaItemsPage.itemIds);
  const itemsById = new Map(review.mediaItems.map((item) => [item.id, item]));
  const editing = review.mediaItems.find(
    (item) => item.id === editingMediaItemId,
  );

  function saveMediaItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parentId = String(form.get("parentId") ?? "").trim();
    onSaveMediaItem({
      ...(editing ? { id: editing.id } : {}),
      parentId: parentId === "" ? null : parentId,
      kind: String(form.get("kind")) as MediaItemKind,
      title: String(form.get("title") ?? "").trim(),
      year: integerFormValue(form, "year") ?? null,
      seasonNumber: integerFormValue(form, "seasonNumber") ?? null,
      episodeNumber: integerFormValue(form, "episodeNumber") ?? null,
    });
  }

  function createSelection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") ?? "").trim();
    const replacesDiscSelectionId = String(
      form.get("replacesDiscSelectionId") ?? "",
    ).trim();
    const common = {
      ...(replacesDiscSelectionId
        ? { replacesDiscSelectionId }
        : {}),
      mediaItemId: String(form.get("mediaItemId")),
      ...(label ? { label } : {}),
    };
    if (selectionKind === "main_feature") {
      onCreateDiscSelection({ ...common, kind: selectionKind });
      return;
    }
    const titleNumber = integerFormValue(form, "titleNumber");
    if (titleNumber === undefined) {
      return;
    }
    if (selectionKind === "dvd_title") {
      onCreateDiscSelection({ ...common, kind: selectionKind, titleNumber });
      return;
    }
    const chapterStart = integerFormValue(form, "chapterStart");
    const chapterEnd = integerFormValue(form, "chapterEnd");
    if (chapterStart === undefined || chapterEnd === undefined) {
      return;
    }
    onCreateDiscSelection({
      ...common,
      kind: selectionKind,
      titleNumber,
      chapterStart,
      chapterEnd,
    });
  }

  return (
    <section className="catalog-editor" aria-labelledby="catalog-editor-title">
      <header className="catalog-editor-header">
        <div>
          <p className="section-eyebrow">Archived disc review</p>
          <h2 id="catalog-editor-title">Catalog {review.archive.discLabel}</h2>
          <p>
            {displayTerm(review.archive.discKind)} · {review.archive.archiveFormat.toUpperCase()}
          </p>
        </div>
        <div className="profile-actions">
          <span className="attention-mark">
            {review.reviewStatus === "reviewed" ? "Reviewed" : "Needs review"}
          </span>
          <button type="button" onClick={onClose}>Close review</button>
        </div>
      </header>

      {requestError ? (
        <div className="section-message section-error" role="alert">
          {requestError}
        </div>
      ) : null}

      <div className="catalog-editor-grid">
        <section className="catalog-pane" aria-labelledby="raw-title-map">
          <h3 id="raw-title-map">Raw DVD title map</h3>
          <p className="catalog-help">
            Archive scan data is read-only source evidence, not reviewed catalog data.
          </p>
          {review.rawScan.titles.length === 0 ? (
            <p className="catalog-empty">No reviewable DVD titles were recorded.</p>
          ) : (
            <ol className="catalog-coordinate-list">
              {review.rawScan.titles.map((title) => (
                <li key={title.number}>
                  <strong>Title {title.number}</strong>
                  <span>{title.chapters} chapters</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="catalog-pane" aria-labelledby="media-hierarchy">
          <h3 id="media-hierarchy">Media Item hierarchy</h3>
          {hierarchy.length === 0 ? (
            <p className="catalog-empty">No Media Items exist yet.</p>
          ) : (
            <ul className="media-hierarchy-list">
              {hierarchy.map(({ item, depth }) => (
                <li key={item.id} style={{ paddingLeft: `${depth * 1.1}rem` }}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{displayTerm(item.kind)}</span>
                    {!editableMediaItemIds.has(item.id) ? (
                      <span>Parent context</span>
                    ) : null}
                  </div>
                  {editableMediaItemIds.has(item.id) ? (
                    <button
                      type="button"
                      onClick={() => onEditMediaItem(item.id)}
                      disabled={isSaving}
                    >
                      Edit
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {review.mediaItemsPage.hasPrevious ||
          review.mediaItemsPage.hasNext ? (
            <div className="profile-actions" aria-label="Media Item pages">
              <button
                type="button"
                disabled={isSaving || !review.mediaItemsPage.hasPrevious}
                onClick={() =>
                  onMediaItemsPage(
                    Math.max(
                      0,
                      review.mediaItemsPage.offset -
                        review.mediaItemsPage.limit,
                    ),
                  )}
              >
                Previous Media Items
              </button>
              <button
                type="button"
                disabled={isSaving || !review.mediaItemsPage.hasNext}
                onClick={() =>
                  onMediaItemsPage(
                    review.mediaItemsPage.offset + review.mediaItemsPage.limit,
                  )}
              >
                Next Media Items
              </button>
            </div>
          ) : null}

          <form
            className="catalog-form"
            key={editing?.id ?? "create-media-item"}
            onSubmit={saveMediaItem}
          >
            <div className="profile-form-heading">
              <h3>{editing ? `Edit ${editing.title}` : "Create Media Item"}</h3>
              {editing ? (
                <button type="button" onClick={onCancelEdit}>Cancel</button>
              ) : null}
            </div>
            <div className="catalog-fields">
              <label>
                Title
                <input name="title" required maxLength={256} defaultValue={editing?.title} />
              </label>
              <label>
                Kind
                <select name="kind" defaultValue={editing?.kind ?? "movie"}>
                  {mediaItemKinds.map((kind) => (
                    <option key={kind} value={kind}>{displayTerm(kind)}</option>
                  ))}
                </select>
              </label>
              <label>
                Parent
                <select name="parentId" defaultValue={editing?.parentId ?? ""}>
                  <option value="">No parent</option>
                  {hierarchy
                    .filter(({ item }) => item.id !== editing?.id)
                    .map(({ item, depth }) => (
                      <option key={item.id} value={item.id}>
                        {`${"— ".repeat(depth)}${item.title}`}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Year
                <input name="year" type="number" min="1800" max="9999" defaultValue={editing?.year ?? ""} />
              </label>
              <label>
                Season number
                <input name="seasonNumber" type="number" min="0" defaultValue={editing?.seasonNumber ?? ""} />
              </label>
              <label>
                Episode number
                <input name="episodeNumber" type="number" min="1" defaultValue={editing?.episodeNumber ?? ""} />
              </label>
            </div>
            <button type="submit" disabled={isSaving}>
              {editing ? "Save Media Item" : "Create Media Item"}
            </button>
          </form>
        </section>

        <section className="catalog-pane catalog-selections" aria-labelledby="reviewed-selections">
          <h3 id="reviewed-selections">Reviewed Disc Selections</h3>
          {review.discSelections.length === 0 ? (
            <p className="catalog-empty">No reviewed selections exist yet.</p>
          ) : (
            <ul className="selection-list">
              {review.discSelections.map((selection) => (
                <li key={selection.id}>
                  <strong>
                    {itemsById.get(selection.mediaItemId)?.title ?? "Unknown Media Item"}
                  </strong>
                  <span>{selectionDescription(selection)}</span>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => onDeleteDiscSelection(selection.id)}
                  >
                    Remove Disc Selection
                  </button>
                </li>
              ))}
            </ul>
          )}

          {review.discSelectionsPage.hasPrevious ||
          review.discSelectionsPage.hasNext ? (
            <div className="profile-actions" aria-label="Disc Selection pages">
              <button
                type="button"
                disabled={isSaving || !review.discSelectionsPage.hasPrevious}
                onClick={() =>
                  onDiscSelectionsPage(
                    Math.max(
                      0,
                      review.discSelectionsPage.offset -
                        review.discSelectionsPage.limit,
                    ),
                  )}
              >
                Previous Disc Selections
              </button>
              <button
                type="button"
                disabled={isSaving || !review.discSelectionsPage.hasNext}
                onClick={() =>
                  onDiscSelectionsPage(
                    review.discSelectionsPage.offset +
                      review.discSelectionsPage.limit,
                  )}
              >
                Next Disc Selections
              </button>
            </div>
          ) : null}

          <form className="catalog-form" onSubmit={createSelection}>
            <h3>Add Disc Selection</h3>
            <div className="catalog-fields">
              <label>
                Catalog action
                <select name="replacesDiscSelectionId" defaultValue="">
                  <option value="">Add a new Disc Selection</option>
                  {review.discSelections.map((selection) => (
                    <option key={selection.id} value={selection.id}>
                      Repair an existing Disc Selection: {
                        selectionDescription(selection)
                      }
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Media Item
                <select name="mediaItemId" required defaultValue="">
                  <option value="" disabled>Select a Media Item</option>
                  {hierarchy.map(({ item, depth }) => (
                    <option key={item.id} value={item.id}>
                      {`${"— ".repeat(depth)}${item.title}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Source
                <select
                  name="selectionKind"
                  value={selectionKind}
                  onChange={(event) =>
                    setSelectionKind(event.currentTarget.value as DiscSelectionKind)}
                >
                  <option value="main_feature">DVD main feature</option>
                  <option value="dvd_title">DVD title</option>
                  <option value="dvd_chapters">DVD chapter range</option>
                </select>
              </label>
              {selectionKind !== "main_feature" ? (
                <label>
                  DVD title
                  <select name="titleNumber" required defaultValue="">
                    <option value="" disabled>Select a title</option>
                    {review.rawScan.titles.map((title) => (
                      <option key={title.number} value={title.number}>
                        Title {title.number} ({title.chapters} chapters)
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {selectionKind === "dvd_chapters" ? (
                <>
                  <label>
                    First chapter
                    <input name="chapterStart" type="number" min="1" required />
                  </label>
                  <label>
                    Last chapter
                    <input name="chapterEnd" type="number" min="1" required />
                  </label>
                </>
              ) : null}
              <label>
                Label
                <input name="label" maxLength={256} placeholder="Optional" />
              </label>
            </div>
            <button
              type="submit"
              disabled={isSaving || review.mediaItems.length === 0}
            >
              Add Disc Selection
            </button>
          </form>

          <div className="catalog-complete">
            <p>
              Completing review removes this archive from the dashboard queue.
            </p>
            <button
              type="button"
              onClick={onCompleteReview}
              disabled={
                isSaving ||
                review.discSelections.length === 0 ||
                review.reviewStatus === "reviewed"
              }
            >
              Complete review
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

type CatalogReviewFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createCatalogReviewRequestScope(initialArchiveId: string) {
  let activeArchiveId: string | null = initialArchiveId;
  let currentRequest = Symbol("catalog-review-request");
  return {
    activate(archiveId: string) {
      if (activeArchiveId !== archiveId) {
        activeArchiveId = archiveId;
        currentRequest = Symbol("catalog-review-request");
      }
    },
    begin(archiveId: string): symbol | null {
      if (activeArchiveId !== archiveId) {
        return null;
      }
      currentRequest = Symbol("catalog-review-request");
      return currentRequest;
    },
    invalidate(archiveId: string) {
      if (activeArchiveId === archiveId) {
        currentRequest = Symbol("catalog-review-request");
      }
    },
    deactivate(archiveId: string) {
      if (activeArchiveId === archiveId) {
        activeArchiveId = null;
        currentRequest = Symbol("catalog-review-request");
      }
    },
    isCurrent(archiveId: string, request: symbol): boolean {
      return (
        activeArchiveId === archiveId && currentRequest === request
      );
    },
  };
}

export async function requestCatalogReview(
  archiveId: string,
  mediaItemOffset: number,
  discSelectionOffset: number,
  editingMediaItemId: string | null,
  fetcher: CatalogReviewFetch = fetch,
): Promise<CatalogReviewDto> {
  const query = new URLSearchParams({
    mediaOffset: String(mediaItemOffset),
    selectionOffset: String(discSelectionOffset),
  });
  if (editingMediaItemId !== null) {
    query.set("editingMediaItemId", editingMediaItemId);
  }
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}?${query.toString()}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("Catalog review request failed");
  }
  return response.json() as Promise<CatalogReviewDto>;
}

export async function mutateCatalogReview(
  archiveId: string,
  command: CatalogReviewCommand,
  fetcher: CatalogReviewFetch = fetch,
): Promise<void> {
  const response = await fetcher(
    `/api/catalog-reviews/${encodeURIComponent(archiveId)}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    },
  );
  if (!response.ok) {
    let message = "Catalog review mutation failed";
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error.trim() !== ""
      ) {
        message = body.error.trim().slice(0, 512);
      }
    } catch {
      // Keep the bounded generic message for non-JSON error responses.
    }
    throw new Error(message);
  }
}

export function CatalogReviewEditor({
  archiveId,
  onClose,
  onCompleted,
}: {
  archiveId: string;
  onClose(): void;
  onCompleted(): void;
}) {
  const [state, setState] = useState<CatalogReviewLoadState>({
    status: "loading",
  });
  const [editingMediaItemId, setEditingMediaItemId] = useState<string | null>(null);
  const [mediaItemOffset, setMediaItemOffset] = useState(0);
  const [discSelectionOffset, setDiscSelectionOffset] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const requestScope = useRef<
    ReturnType<typeof createCatalogReviewRequestScope> | null
  >(null);
  requestScope.current ??= createCatalogReviewRequestScope(archiveId);
  requestScope.current.activate(archiveId);

  const load = useCallback(async () => {
    const request = requestScope.current?.begin(archiveId);
    if (request === null || request === undefined) {
      return;
    }
    try {
      const review = await requestCatalogReview(
        archiveId,
        mediaItemOffset,
        discSelectionOffset,
        editingMediaItemId,
      );
      if (!requestScope.current?.isCurrent(archiveId, request)) {
        return;
      }
      setState({ status: "loaded", review });
      setRequestError(null);
    } catch {
      if (!requestScope.current?.isCurrent(archiveId, request)) {
        return;
      }
      setState({ status: "error" });
    }
  }, [
    archiveId,
    discSelectionOffset,
    editingMediaItemId,
    mediaItemOffset,
  ]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  useEffect(
    () => () => requestScope.current?.deactivate(archiveId),
    [archiveId],
  );

  async function mutate(command: CatalogReviewCommand, complete = false) {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    setRequestError(null);
    try {
      await mutateCatalogReview(archiveId, command);
      setEditingMediaItemId(null);
      if (complete) {
        onCompleted();
      } else {
        await load();
      }
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message
          : "Catalog review mutation failed",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function changeEditingMediaItem(id: string | null) {
    if (editingMediaItemId === id) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setEditingMediaItemId(id);
  }

  function changeMediaItemOffset(offset: number) {
    if (mediaItemOffset === offset) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setMediaItemOffset(offset);
  }

  function changeDiscSelectionOffset(offset: number) {
    if (discSelectionOffset === offset) {
      return;
    }
    requestScope.current?.invalidate(archiveId);
    setDiscSelectionOffset(offset);
  }

  return (
    <CatalogReviewView
      state={state}
      editingMediaItemId={editingMediaItemId}
      isSaving={isSaving}
      requestError={requestError}
      onClose={onClose}
      onRetry={() => void load()}
      onEditMediaItem={(id) => changeEditingMediaItem(id)}
      onCancelEdit={() => changeEditingMediaItem(null)}
      onMediaItemsPage={(offset) => changeMediaItemOffset(offset)}
      onDiscSelectionsPage={(offset) =>
        changeDiscSelectionOffset(offset)}
      onSaveMediaItem={(input) => {
        const { id, ...values } = input;
        void mutate(
          id
            ? { action: "update_media_item", mediaItemId: id, changes: values }
            : { action: "create_media_item", mediaItem: values },
        );
      }}
      onCreateDiscSelection={(selection) => {
        const { replacesDiscSelectionId, ...values } = selection;
        void mutate(
          replacesDiscSelectionId
            ? {
                action: "repair_disc_selection",
                discSelectionId: replacesDiscSelectionId,
                selection: values,
              }
            : { action: "create_disc_selection", selection: values },
        );
      }}
      onDeleteDiscSelection={(discSelectionId) =>
        void mutate({ action: "delete_disc_selection", discSelectionId })}
      onCompleteReview={() => void mutate({ action: "complete_review" }, true)}
    />
  );
}
