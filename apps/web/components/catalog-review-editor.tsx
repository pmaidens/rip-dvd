"use client";

import { displayTerm } from "../lib/display-term";
import { CatalogReviewCompletion } from "./catalog-review-completion";
import { CatalogReviewDiscSelections } from "./catalog-review-disc-selections";
import {
  CatalogReviewEvidence,
  formatVolumeLabel,
} from "./catalog-review-evidence";
import { CatalogReviewMediaItems } from "./catalog-review-media-items";
import type {
  CatalogReviewLoadState,
  CreateDiscSelectionInput,
  CreateMappingProposalInput,
  DiscSelectionKind,
  MappingProposal,
  SaveMediaItemInput,
} from "./catalog-review-model";
import { useCatalogReviewState } from "./catalog-review-state";

interface CatalogReviewViewProps {
  state: CatalogReviewLoadState;
  editingMediaItemId: string | null;
  isSaving: boolean;
  requestError: string | null;
  mappingProposalError: string | null;
  selectionKind: DiscSelectionKind;
  activeMappingProposal: MappingProposal | null;
  onClose(): void;
  onRetry(): void;
  onEditMediaItem(id: string): void;
  onCancelEdit(): void;
  onDiscSelectionsPage(offset: number): void;
  onSelectionKindChange(kind: DiscSelectionKind): void;
  onStartMappingProposal(proposal: MappingProposal): void;
  onCancelMappingProposal(): void;
  onCreateMappingProposal(input: CreateMappingProposalInput): void;
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
  mappingProposalError,
  selectionKind,
  activeMappingProposal,
  onClose,
  onRetry,
  onEditMediaItem,
  onCancelEdit,
  onDiscSelectionsPage,
  onSelectionKindChange,
  onStartMappingProposal,
  onCancelMappingProposal,
  onCreateMappingProposal,
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
          <h2 id="catalog-editor-title">
            Catalog {formatVolumeLabel(review.archive.discLabel) ||
              "Unlabeled disc"}
          </h2>
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
        <CatalogReviewEvidence
          coverage={review.coverage}
          volumeLabel={review.archive.discLabel}
          titles={review.rawScan.titles}
          mediaItems={review.mediaItems}
          activeMappingProposal={activeMappingProposal}
          isSaving={isSaving}
          mappingProposalError={mappingProposalError}
          onStartMappingProposal={onStartMappingProposal}
          onCancelMappingProposal={onCancelMappingProposal}
          onCreateMappingProposal={onCreateMappingProposal}
        />

        <CatalogReviewMediaItems
          mediaItems={review.mediaItems}
          mappedMediaItemIds={review.discSelections.map(
            (selection) => selection.mediaItemId,
          )}
          editingMediaItemId={editingMediaItemId}
          isSaving={isSaving}
          onEdit={onEditMediaItem}
          onCancelEdit={onCancelEdit}
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
            coverage={review.coverage}
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
      mappingProposalError={review.mappingProposalError}
      selectionKind={review.selectionKind}
      activeMappingProposal={review.activeMappingProposal}
      onClose={onClose}
      onRetry={review.retry}
      onEditMediaItem={review.editMediaItem}
      onCancelEdit={review.cancelEdit}
      onDiscSelectionsPage={review.changeDiscSelectionOffset}
      onSelectionKindChange={review.changeSelectionKind}
      onStartMappingProposal={review.startMappingProposal}
      onCancelMappingProposal={review.cancelMappingProposal}
      onCreateMappingProposal={review.createMappingProposal}
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
  mutateCatalogReview,
  requestCatalogReview,
} from "./catalog-review-state";
