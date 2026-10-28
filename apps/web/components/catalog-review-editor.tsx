"use client";

import type { CompletedCatalogReviewOutcome } from "@rip-dvd/data-access";
import { useRef, useState, type KeyboardEvent } from "react";

import { archiveIntegrityLabel } from "../lib/archive-integrity";
import type { AutomaticCatalogProposal } from "../lib/catalog-automation";
import { formatVolumeLabel } from "../lib/catalog-label";
import { ArchiveIntegrityDescription } from "./archive-integrity-description";
import { ArchiveBoundaryDescription } from "./archive-boundary-description";
import { displayTerm } from "../lib/display-term";
import { CatalogReviewCompletion } from "./catalog-review-completion";
import { CatalogReviewAutomation } from "./catalog-review-automation";
import { CatalogReviewDiscSelections } from "./catalog-review-disc-selections";
import { CatalogReviewEvidence } from "./catalog-review-evidence";
import { CatalogReviewMediaItems } from "./catalog-review-media-items";
import { CatalogReviewRearchiveProposal } from "./catalog-review-rearchive-proposal";
import { CatalogReviewTitleIdentity } from "./catalog-review-title-identity";
import { CatalogReviewTitleDamageEvidence } from "./catalog-review-title-damage";
import { DamagePreviewReview } from "./damage-preview-review";
import {
  CatalogReviewDamageDecisionStatus,
  CatalogReviewMappingStatus,
  CatalogReviewRecoveryStep,
} from "./catalog-review-workflow";
import type {
  CatalogReviewLoadState,
  CatalogReviewRearchiveProposal as CatalogReviewRearchiveProposalDto,
  CreateDiscSelectionInput,
  CreateEpisodicMappingProposalInput,
  CreateMappingProposalInput,
  DiscSelectionKind,
  EpisodicMappingProposal,
  MappingProposal,
  SaveMediaItemInput,
  SaveRearchiveMappingProposalInput,
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
  activeMappingProposalRevision?: string | null;
  activeEpisodicMappingProposal?: EpisodicMappingProposal | null;
  activeEpisodicMappingProposalRevision?: string | null;
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
  onUseRefreshedMappingProposalEvidence?(): void;
  onCreateMappingProposal(input: CreateMappingProposalInput): void;
  onStartEpisodicMappingProposal?(proposal: EpisodicMappingProposal): void;
  onCancelEpisodicMappingProposal?(): void;
  onUseRefreshedEpisodicMappingProposalEvidence?(): void;
  onCreateEpisodicMappingProposal?(
    input: CreateEpisodicMappingProposalInput,
  ): void;
  onAcceptAutomaticCatalogProposal?(proposal: AutomaticCatalogProposal): void;
  onPreviewRearchiveMappingProposal?(
    input: SaveRearchiveMappingProposalInput,
  ): Promise<CatalogReviewRearchiveProposalDto>;
  onSaveRearchiveMappingProposal?(input: SaveRearchiveMappingProposalInput): void;
  onAcceptRearchive?(
    replacements: CatalogReviewReplacementEncodeInput[],
  ): void;
  onSaveMediaItem(input: SaveMediaItemInput): void;
  onDeleteMediaItem(id: string): void;
  onCreateDiscSelection(
    input: CreateDiscSelectionInput,
    catalogRevision: string,
    onCommitted: () => void,
  ): void;
  onUpdateDiscSelection(
    id: string,
    changes: UpdateDiscSelectionInput,
    catalogRevision: string,
    onCommitted: () => void,
  ): void;
  onDeleteDiscSelection(id: string): void;
  onCompleteReview(
    outcome: CompletedCatalogReviewOutcome,
    replacements: CatalogReviewReplacementEncodeInput[],
  ): void;
  onEvidenceChoice?(choice: "archive_only" | "reopen"): void;
}

export function catalogReviewSelectionTitles(
  review: Pick<
    Extract<CatalogReviewLoadState, { status: "loaded" }>["review"],
    "rawScan" | "titleIdentity" | "reviewWorkflow"
  >,
) {
  return review.titleIdentity?.available
    ? review.titleIdentity.items
      .filter(({ presentAtCurrentCheckpoint, observation }) =>
        presentAtCurrentCheckpoint && observation.angleNumber === 1
      )
      .map(({ observation }) => ({
        number: observation.displayTitleNumber,
        chapters: observation.chapterCount,
      }))
    : review.reviewWorkflow === undefined
    ? review.rawScan.titles
    : [];
}

function catalogReviewEvidenceTitles(
  review: Pick<
    Extract<CatalogReviewLoadState, { status: "loaded" }>["review"],
    "rawScan" | "titleIdentity" | "reviewWorkflow"
  >,
) {
  if (review.reviewWorkflow === undefined) return review.rawScan.titles;
  if (review.titleIdentity?.available !== true) return [];
  const currentTitleNumbers = new Set(
    review.titleIdentity.items
      .filter(({ presentAtCurrentCheckpoint, observation }) =>
        presentAtCurrentCheckpoint && observation.angleNumber === 1
      )
      .map(({ observation }) => observation.displayTitleNumber),
  );
  return review.rawScan.titles.filter(({ number }) =>
    currentTitleNumbers.has(number)
  );
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
  activeMappingProposalRevision = null,
  activeEpisodicMappingProposal = null,
  activeEpisodicMappingProposalRevision = null,
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
  onUseRefreshedMappingProposalEvidence = () => undefined,
  onCreateMappingProposal,
  onStartEpisodicMappingProposal,
  onCancelEpisodicMappingProposal,
  onUseRefreshedEpisodicMappingProposalEvidence = () => undefined,
  onCreateEpisodicMappingProposal,
  onAcceptAutomaticCatalogProposal = () => undefined,
  onPreviewRearchiveMappingProposal = async () => {
    throw new Error("Re-archive Mapping Proposal preview is unavailable");
  },
  onSaveRearchiveMappingProposal = () => undefined,
  onAcceptRearchive = () => undefined,
  onSaveMediaItem,
  onDeleteMediaItem,
  onCreateDiscSelection,
  onUpdateDiscSelection,
  onDeleteDiscSelection,
  onCompleteReview,
  onEvidenceChoice = () => undefined,
}: CatalogReviewViewProps) {
  const [activeStep, setActiveStep] = useState<
    "recovery" | "mapping" | "damage"
  >("mapping");
  const stepRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
  const catalogMappingAction = review.reviewWorkflow?.actions.find(
    ({ action }) => action === "catalog_mapping",
  );
  const mappingAvailable = catalogMappingAction?.available ?? true;
  const rearchiveAcceptanceAvailable = review.reviewWorkflow === undefined;
  const rearchiveAcceptanceUnavailableReason = rearchiveAcceptanceAvailable
    ? null
    : {
        code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE",
        message:
          "Re-archive Acceptance is unavailable for dvd-recovery-evidence-v1; use the separate damage decision workflow.",
      };
  const mappingProposalUsesStaleEvidence = activeMappingProposal !== null &&
    activeMappingProposalRevision !== null &&
    activeMappingProposalRevision !== review.catalogRevision;
  const episodicMappingProposalUsesStaleEvidence =
    activeEpisodicMappingProposal !== null &&
    activeEpisodicMappingProposalRevision !== null &&
    activeEpisodicMappingProposalRevision !== review.catalogRevision;
  const mappingContent = (
    <>
      {review.reviewWorkflow === undefined
        ? null
        : <CatalogReviewMappingStatus workflow={review.reviewWorkflow} />}
      {review.rearchiveProposal ? (
        <CatalogReviewRearchiveProposal
          proposal={review.rearchiveProposal}
          mediaItems={review.mediaItems}
          replacementPlan={review.replacementPlan}
          isSaving={isSaving}
          mappingAvailable={mappingAvailable}
          allowMainFeature={review.reviewWorkflow === undefined}
          acceptanceAvailable={rearchiveAcceptanceAvailable}
          acceptanceUnavailableReason={rearchiveAcceptanceUnavailableReason}
          onPreview={onPreviewRearchiveMappingProposal}
          onSave={onSaveRearchiveMappingProposal}
          onAccept={onAcceptRearchive}
          onReplacementJobsPage={onReplacementJobsPage ?? (() => undefined)}
          onReplacementProfilesPage={
            onReplacementProfilesPage ?? (() => undefined)
          }
        />
      ) : null}

      {review.rearchiveProposal || review.reviewWorkflow !== undefined
        ? null
        : (
        <CatalogReviewAutomation
          review={review}
          isSaving={isSaving}
          completionEnabled
          onAcceptProposal={onAcceptAutomaticCatalogProposal}
          onCompleteReview={onCompleteReview}
        />
      )}

      {review.rearchiveProposal ? null : <details
        className="catalog-manual-workbench"
        open={
          review.reviewOutcome !== "needs_review" ||
            review.automaticCataloging?.configured !== true
            ? true
            : undefined
        }
      >
        <summary>
          <span>Manual catalog tools</span>
          <small>Use these for ambiguous discs, extras, and corrections.</small>
        </summary>
        <div className="catalog-editor-grid">
          <CatalogReviewEvidence
            coverage={review.coverage}
            volumeLabel={review.archive.discLabel}
            titles={catalogReviewEvidenceTitles(review)}
            mediaItems={review.mediaItems}
            activeMappingProposal={activeMappingProposal}
            activeEpisodicMappingProposal={activeEpisodicMappingProposal}
            allowMainFeatureProposal={review.reviewWorkflow === undefined}
            isSaving={isSaving}
            mappingAvailable={mappingAvailable}
            mappingProposalUsesStaleEvidence={
              mappingProposalUsesStaleEvidence
            }
            episodicMappingProposalUsesStaleEvidence={
              episodicMappingProposalUsesStaleEvidence
            }
            mappingProposalError={mappingProposalError}
            onStartMappingProposal={onStartMappingProposal}
            onCancelMappingProposal={onCancelMappingProposal}
            onCreateMappingProposal={onCreateMappingProposal}
            onStartEpisodicMappingProposal={onStartEpisodicMappingProposal}
            onCancelEpisodicMappingProposal={onCancelEpisodicMappingProposal}
            onCreateEpisodicMappingProposal={onCreateEpisodicMappingProposal}
            onUseRefreshedMappingProposalEvidence={
              onUseRefreshedMappingProposalEvidence
            }
            onUseRefreshedEpisodicMappingProposalEvidence={
              onUseRefreshedEpisodicMappingProposalEvidence
            }
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
              key={review.archive.id}
              catalogRevision={review.catalogRevision}
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
              rawTitles={catalogReviewSelectionTitles(review)}
              mappingReviewSelectionIds={new Set(
                review.titleIdentity?.available
                  ? review.titleIdentity.items.flatMap((item) =>
                    item.discSelectionMappings
                      .filter(({ mappingState }) =>
                        mappingState === "needs_mapping_review"
                      )
                      .map(({ discSelectionId }) => discSelectionId)
                  )
                  : [],
              )}
              allowMainFeature={review.reviewWorkflow === undefined}
              selectionKind={selectionKind}
              isSaving={isSaving}
              mappingAvailable={mappingAvailable}
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
              actionAvailability={review.reviewActionAvailability}
              reviewOutcome={review.reviewOutcome}
              archiveOnlySelected={archiveOnlySelected}
              replacementPlan={review.replacementPlan}
              completionEnabled={review.reviewWorkflow === undefined}
              onArchiveOnlyChange={onArchiveOnlyChange}
              onReplacementJobsPage={onReplacementJobsPage}
              onReplacementProfilesPage={onReplacementProfilesPage}
              onComplete={onCompleteReview}
            />
          </section>
        </div>
      </details>}
    </>
  );
  const steps = [
    { id: "recovery" as const, label: "Recovery" },
    { id: "mapping" as const, label: "Catalog mapping" },
    { id: "damage" as const, label: "Damage decision" },
  ];
  const moveStepFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
      ? -1
      : 0;
    if (direction === 0) return;
    event.preventDefault();
    const next = (index + direction + steps.length) % steps.length;
    setActiveStep(steps[next]!.id);
    stepRefs.current[next]?.focus();
  };

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
          <p>
            Archive integrity: {archiveIntegrityLabel(review.archive.integrity)}
          </p>
          <ArchiveIntegrityDescription {...review.archive} />
          <ArchiveBoundaryDescription
            boundaryEvidence={review.archive.boundaryEvidence}
          />
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

      {review.reviewWorkflow === undefined ? (
        <>
          <CatalogReviewTitleIdentity titleIdentity={review.titleIdentity} />
          <CatalogReviewTitleDamageEvidence
            originalDiscArchiveId={review.archive.id}
            titleDamage={review.titleDamage}
          />
          {mappingContent}
        </>
      ) : (
        <>
          <div
            className="catalog-review-steps"
            role="tablist"
            aria-label="Review Steps"
          >
            {steps.map((step, index) => (
              <button
                key={step.id}
                id={`catalog-review-step-${step.id}`}
                ref={(element) => {
                  stepRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                aria-selected={activeStep === step.id}
                aria-controls={`catalog-review-panel-${step.id}`}
                tabIndex={activeStep === step.id ? 0 : -1}
                onClick={() => setActiveStep(step.id)}
                onKeyDown={(event) => moveStepFocus(event, index)}
              >
                {step.label}
              </button>
            ))}
          </div>
          <section
            id="catalog-review-panel-recovery"
            className="catalog-review-step-panel"
            role="tabpanel"
            aria-labelledby="catalog-review-step-recovery"
            hidden={activeStep !== "recovery"}
          >
            <CatalogReviewRecoveryStep workflow={review.reviewWorkflow} />
          </section>
          <section
            id="catalog-review-panel-mapping"
            className="catalog-review-step-panel"
            role="tabpanel"
            aria-labelledby="catalog-review-step-mapping"
            hidden={activeStep !== "mapping"}
          >
            <CatalogReviewTitleIdentity titleIdentity={review.titleIdentity} />
            {mappingContent}
          </section>
          <section
            id="catalog-review-panel-damage"
            className="catalog-review-step-panel catalog-review-damage-panel"
            role="tabpanel"
            aria-labelledby="catalog-review-step-damage"
            hidden={activeStep !== "damage"}
          >
            <CatalogReviewTitleDamageEvidence
              originalDiscArchiveId={review.archive.id}
              titleDamage={review.titleDamage}
            />
            <DamagePreviewReview key={`${review.archive.id}:${review.catalogRevision}:${review.titleDamage?.currentAssessmentIdentity}`} archiveId={review.archive.id} />
            <CatalogReviewDamageDecisionStatus
              workflow={review.reviewWorkflow}
              isSaving={isSaving}
              onChoice={onEvidenceChoice}
            />
          </section>
        </>
      )}
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
      activeMappingProposalRevision={review.activeMappingProposalRevision}
      activeEpisodicMappingProposal={review.activeEpisodicMappingProposal}
      activeEpisodicMappingProposalRevision={
        review.activeEpisodicMappingProposalRevision
      }
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
      onUseRefreshedMappingProposalEvidence={
        review.useRefreshedMappingProposalEvidence
      }
      onCreateMappingProposal={review.createMappingProposal}
      onStartEpisodicMappingProposal={review.startEpisodicMappingProposal}
      onCancelEpisodicMappingProposal={review.cancelEpisodicMappingProposal}
      onUseRefreshedEpisodicMappingProposalEvidence={
        review.useRefreshedEpisodicMappingProposalEvidence
      }
      onCreateEpisodicMappingProposal={review.createEpisodicMappingProposal}
      onAcceptAutomaticCatalogProposal={review.acceptAutomaticCatalogProposal}
      onPreviewRearchiveMappingProposal={
        review.previewRearchiveMappingProposal
      }
      onSaveRearchiveMappingProposal={review.saveRearchiveMappingProposal}
      onAcceptRearchive={review.acceptRearchive}
      onSaveMediaItem={review.saveMediaItem}
      onDeleteMediaItem={review.deleteMediaItem}
      onCreateDiscSelection={review.createDiscSelection}
      onUpdateDiscSelection={review.updateDiscSelection}
      onDeleteDiscSelection={review.deleteDiscSelection}
      onCompleteReview={review.completeReview}
      onEvidenceChoice={review.recordEvidenceChoice}
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
