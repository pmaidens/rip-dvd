"use client";

import type { CompletedCatalogReviewOutcome } from "@rip-dvd/data-access";

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
  CreateEpisodicMappingProposalInput,
  CreateMappingProposalInput,
  DiscSelectionKind,
  EpisodicMappingProposal,
  MappingProposal,
  SaveMediaItemInput,
  UpdateDiscSelectionInput,
} from "./catalog-review-model";
import type { CatalogReviewReplacementEncodeInput } from "../lib/catalog-review-command";
import { useCatalogReviewState } from "./catalog-review-state";

interface CatalogReviewViewProps {
  state: CatalogReviewLoadState;
  editingMediaItemId: string | null;
  isSaving: boolean;
  requestError: string | null;
  mutationNotice?: string | null;
  mappingProposalError: string | null;
  selectionKind: DiscSelectionKind;
  activeMappingProposal: MappingProposal | null;
  activeEpisodicMappingProposal?: EpisodicMappingProposal | null;
  archiveOnlySelected: boolean;
  onClose(): void;
  onRetry(): void;
  onEditMediaItem(id: string): void;
  onCancelEdit(): void;
  onDiscSelectionsPage(offset: number): void;
  onCorrectionHistoryPage(offset: number): void;
  onCorrectionEncodeHistoryPage(offset: number): void;
  onCorrectionRetainedOutputHistoryPage(offset: number): void;
  onReplacementJobsPage?(offset: number): void;
  onReplacementProfilesPage?(offset: number): void;
  onSelectionKindChange(kind: DiscSelectionKind): void;
  onArchiveOnlyChange(selected: boolean): void;
  onStartMappingProposal(proposal: MappingProposal): void;
  onCancelMappingProposal(): void;
  onCreateMappingProposal(input: CreateMappingProposalInput): void;
  onStartEpisodicMappingProposal?(proposal: EpisodicMappingProposal): void;
  onCancelEpisodicMappingProposal?(): void;
  onCreateEpisodicMappingProposal?(
    input: CreateEpisodicMappingProposalInput,
  ): void;
  onSaveMediaItem(input: SaveMediaItemInput): void;
  onDeleteMediaItem(id: string): void;
  onCreateDiscSelection(input: CreateDiscSelectionInput): void;
  onUpdateDiscSelection(id: string, changes: UpdateDiscSelectionInput): void;
  onDeleteDiscSelection(id: string): void;
  onCompleteReview(
    outcome: CompletedCatalogReviewOutcome,
    replacements: CatalogReviewReplacementEncodeInput[],
  ): void;
}

export function CatalogReviewView({
  state,
  editingMediaItemId,
  isSaving,
  requestError,
  mutationNotice,
  mappingProposalError,
  selectionKind,
  activeMappingProposal,
  activeEpisodicMappingProposal = null,
  archiveOnlySelected,
  onClose,
  onRetry,
  onEditMediaItem,
  onCancelEdit,
  onDiscSelectionsPage,
  onCorrectionHistoryPage,
  onCorrectionEncodeHistoryPage,
  onCorrectionRetainedOutputHistoryPage,
  onReplacementJobsPage,
  onReplacementProfilesPage,
  onSelectionKindChange,
  onArchiveOnlyChange,
  onStartMappingProposal,
  onCancelMappingProposal,
  onCreateMappingProposal,
  onStartEpisodicMappingProposal,
  onCancelEpisodicMappingProposal,
  onCreateEpisodicMappingProposal,
  onSaveMediaItem,
  onDeleteMediaItem,
  onCreateDiscSelection,
  onUpdateDiscSelection,
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
            {review.reviewOutcome === "reviewed_with_selections"
              ? "Reviewed with selections"
              : review.reviewOutcome === "archive_only"
              ? "Archive only"
              : "Needs review"}
          </span>
          <button type="button" onClick={onClose}>Close review</button>
        </div>
      </header>

      {requestError ? (
        <div className="section-message section-error" role="alert">
          {requestError}
        </div>
      ) : null}
      {mutationNotice ? (
        <div className="section-message" role="status" aria-live="polite">
          {mutationNotice}
        </div>
      ) : null}

      <div className="catalog-editor-grid">
        <CatalogReviewEvidence
          coverage={review.coverage}
          volumeLabel={review.archive.discLabel}
          titles={review.rawScan.titles}
          mediaItems={review.mediaItems}
          activeMappingProposal={activeMappingProposal}
          activeEpisodicMappingProposal={activeEpisodicMappingProposal}
          isSaving={isSaving}
          mappingProposalError={mappingProposalError}
          onStartMappingProposal={onStartMappingProposal}
          onCancelMappingProposal={onCancelMappingProposal}
          onCreateMappingProposal={onCreateMappingProposal}
          onStartEpisodicMappingProposal={onStartEpisodicMappingProposal}
          onCancelEpisodicMappingProposal={onCancelEpisodicMappingProposal}
          onCreateEpisodicMappingProposal={onCreateEpisodicMappingProposal}
        />

        <CatalogReviewMediaItems
          archiveId={review.archive.id}
          mediaItems={review.mediaItems}
          mappedMediaItemIds={review.discSelections.map(
            (selection) => selection.mediaItemId,
          )}
          editingMediaItemId={editingMediaItemId}
          isSaving={isSaving}
          onEdit={onEditMediaItem}
          onCancelEdit={onCancelEdit}
          onSave={onSaveMediaItem}
          onDelete={onDeleteMediaItem}
        />

        <section
          className="catalog-pane catalog-selections"
          aria-labelledby="reviewed-selections"
        >
          <CatalogReviewDiscSelections
            discSelections={review.discSelections}
            page={review.discSelectionsPage}
            correctionHistory={review.correctionHistory}
            correctionHistoryPage={review.correctionHistoryPage}
            correctionEncodeHistory={review.correctionEncodeHistory}
            correctionEncodeHistoryPage={review.correctionEncodeHistoryPage}
            correctionRetainedOutputHistory={
              review.correctionRetainedOutputHistory
            }
            correctionRetainedOutputHistoryPage={
              review.correctionRetainedOutputHistoryPage
            }
            mediaItems={review.mediaItems}
            rawTitles={review.rawScan.titles}
            selectionKind={selectionKind}
            isSaving={isSaving}
            onPage={onDiscSelectionsPage}
            onCorrectionHistoryPage={onCorrectionHistoryPage}
            onCorrectionEncodeHistoryPage={onCorrectionEncodeHistoryPage}
            onCorrectionRetainedOutputHistoryPage={
              onCorrectionRetainedOutputHistoryPage
            }
            onSelectionKindChange={onSelectionKindChange}
            onCreate={onCreateDiscSelection}
            onUpdate={onUpdateDiscSelection}
            onDelete={onDeleteDiscSelection}
          />
          <CatalogReviewCompletion
            isSaving={isSaving}
            coverage={review.coverage}
            reviewOutcome={review.reviewOutcome}
            archiveOnlySelected={archiveOnlySelected}
            replacementPlan={review.replacementPlan}
            onArchiveOnlyChange={onArchiveOnlyChange}
            onReplacementJobsPage={onReplacementJobsPage}
            onReplacementProfilesPage={onReplacementProfilesPage}
            onComplete={onCompleteReview}
          />
        </section>
      </div>
    </section>
  );
}

export function CatalogReviewEditor({
  archiveId,
  activityRevision,
  onClose,
  onCompleted,
}: {
  archiveId: string;
  activityRevision?: string;
  onClose(): void;
  onCompleted(): void;
}) {
  const review = useCatalogReviewState({
    archiveId,
    activityRevision,
    onCompleted,
  });

  return (
    <CatalogReviewView
      state={review.state}
      editingMediaItemId={review.editingMediaItemId}
      isSaving={review.isSaving}
      requestError={review.requestError}
      mutationNotice={review.mutationNotice}
      mappingProposalError={review.mappingProposalError}
      selectionKind={review.selectionKind}
      activeMappingProposal={review.activeMappingProposal}
      activeEpisodicMappingProposal={review.activeEpisodicMappingProposal}
      archiveOnlySelected={review.archiveOnlySelected}
      onClose={onClose}
      onRetry={review.retry}
      onEditMediaItem={review.editMediaItem}
      onCancelEdit={review.cancelEdit}
      onDiscSelectionsPage={review.changeDiscSelectionOffset}
      onCorrectionHistoryPage={review.changeCorrectionHistoryOffset}
      onCorrectionEncodeHistoryPage={
        review.changeCorrectionEncodeHistoryOffset
      }
      onCorrectionRetainedOutputHistoryPage={
        review.changeCorrectionRetainedOutputHistoryOffset
      }
      onReplacementJobsPage={review.changeReplacementOffset}
      onReplacementProfilesPage={review.changeReplacementProfileOffset}
      onSelectionKindChange={review.changeSelectionKind}
      onArchiveOnlyChange={review.changeArchiveOnlySelected}
      onStartMappingProposal={review.startMappingProposal}
      onCancelMappingProposal={review.cancelMappingProposal}
      onCreateMappingProposal={review.createMappingProposal}
      onStartEpisodicMappingProposal={review.startEpisodicMappingProposal}
      onCancelEpisodicMappingProposal={review.cancelEpisodicMappingProposal}
      onCreateEpisodicMappingProposal={review.createEpisodicMappingProposal}
      onSaveMediaItem={review.saveMediaItem}
      onDeleteMediaItem={review.deleteMediaItem}
      onCreateDiscSelection={review.createDiscSelection}
      onUpdateDiscSelection={review.updateDiscSelection}
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
