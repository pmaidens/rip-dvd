interface CatalogReviewCompletionProps {
  isSaving: boolean;
  selectionCount: number;
  reviewStatus: "needs_review" | "reviewed";
  onComplete(): void;
}

export function CatalogReviewCompletion({
  isSaving,
  selectionCount,
  reviewStatus,
  onComplete,
}: CatalogReviewCompletionProps) {
  return (
    <div className="catalog-complete">
      <p>Completing review removes this archive from the dashboard queue.</p>
      <button
        type="button"
        onClick={onComplete}
        disabled={
          isSaving || selectionCount === 0 || reviewStatus === "reviewed"
        }
      >
        Complete review
      </button>
    </div>
  );
}
