"use client";

import { displayTerm } from "../lib/display-term";
import { CatalogReviewCompletion } from "./catalog-review-completion";
import { CatalogReviewDiscSelections } from "./catalog-review-disc-selections";
import { CatalogReviewMediaItems } from "./catalog-review-media-items";
import type {
  CatalogReviewLoadState,
  CreateDiscSelectionInput,
  DiscSelectionKind,
  SaveMediaItemInput,
} from "./catalog-review-model";
import { useCatalogReviewState } from "./catalog-review-state";

interface CatalogReviewViewProps {
  state: CatalogReviewLoadState;
  editingMediaItemId: string | null;
  isSaving: boolean;
  requestError: string | null;
  selectionKind: DiscSelectionKind;
  onClose(): void;
  onRetry(): void;
  onEditMediaItem(id: string): void;
  onCancelEdit(): void;
  onMediaItemsPage(offset: number): void;
  onDiscSelectionsPage(offset: number): void;
  onSelectionKindChange(kind: DiscSelectionKind): void;
  onSaveMediaItem(input: SaveMediaItemInput): void;
  onCreateDiscSelection(input: CreateDiscSelectionInput): void;
  onDeleteDiscSelection(id: string): void;
  onCompleteReview(): void;
}

export function CatalogReviewView({
  state,
  editingMediaItemId,
  isSaving,
  requestError,
  selectionKind,
  onClose,
  onRetry,
  onEditMediaItem,
  onCancelEdit,
  onMediaItemsPage,
  onDiscSelectionsPage,
  onSelectionKindChange,
  onSaveMediaItem,
  onCreateDiscSelection,
  onDeleteDiscSelection,
  onCompleteReview,
}: CatalogReviewViewProps) {
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
  return (
    <section className="catalog-editor" aria-labelledby="catalog-editor-title">
      <header className="catalog-editor-header">
        <div>
          <p className="section-eyebrow">Archived disc review</p>
          <h2 id="catalog-editor-title">Catalog {review.archive.discLabel}</h2>
          <p>
            {displayTerm(review.archive.discKind)} · {
              review.archive.archiveFormat.toUpperCase()
            }
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
            <p className="catalog-empty">
              No reviewable DVD titles were recorded.
            </p>
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

        <CatalogReviewMediaItems
          mediaItems={review.mediaItems}
          page={review.mediaItemsPage}
          editingMediaItemId={editingMediaItemId}
          isSaving={isSaving}
          onEdit={onEditMediaItem}
          onCancelEdit={onCancelEdit}
          onPage={onMediaItemsPage}
          onSave={onSaveMediaItem}
        />

        <section
          className="catalog-pane catalog-selections"
          aria-labelledby="reviewed-selections"
        >
          <CatalogReviewDiscSelections
            discSelections={review.discSelections}
            page={review.discSelectionsPage}
            mediaItems={review.mediaItems}
            rawTitles={review.rawScan.titles}
            selectionKind={selectionKind}
            isSaving={isSaving}
            onPage={onDiscSelectionsPage}
            onSelectionKindChange={onSelectionKindChange}
            onCreate={onCreateDiscSelection}
            onDelete={onDeleteDiscSelection}
          />
          <CatalogReviewCompletion
            isSaving={isSaving}
            selectionCount={review.discSelections.length}
            reviewStatus={review.reviewStatus}
            onComplete={onCompleteReview}
          />
        </section>
      </div>
    </section>
  );
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
  const review = useCatalogReviewState({ archiveId, onCompleted });

  return (
    <CatalogReviewView
      state={review.state}
      editingMediaItemId={review.editingMediaItemId}
      isSaving={review.isSaving}
      requestError={review.requestError}
      selectionKind={review.selectionKind}
      onClose={onClose}
      onRetry={review.retry}
      onEditMediaItem={review.editMediaItem}
      onCancelEdit={review.cancelEdit}
      onMediaItemsPage={review.changeMediaItemOffset}
      onDiscSelectionsPage={review.changeDiscSelectionOffset}
      onSelectionKindChange={review.changeSelectionKind}
      onSaveMediaItem={review.saveMediaItem}
      onCreateDiscSelection={review.createDiscSelection}
      onDeleteDiscSelection={review.deleteDiscSelection}
      onCompleteReview={review.completeReview}
    />
  );
}

export type {
  CatalogReviewDiscSelection,
  CatalogReviewDto,
  CatalogReviewLoadState,
  CatalogReviewMediaItem,
} from "./catalog-review-model";
export {
  createCatalogReviewRequestScope,
  mutateCatalogReview,
  requestCatalogReview,
} from "./catalog-review-state";
