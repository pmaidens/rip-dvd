interface CatalogReviewPaginationProps {
  ariaLabel: string;
  itemLabel: string;
  page: {
    offset: number;
    limit: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  isSaving: boolean;
  onPage(offset: number): void;
}

export function CatalogReviewPagination({
  ariaLabel,
  itemLabel,
  page,
  isSaving,
  onPage,
}: CatalogReviewPaginationProps) {
  if (!page.hasPrevious && !page.hasNext) {
    return null;
  }

  return (
    <div className="profile-actions" aria-label={ariaLabel}>
      <button
        type="button"
        disabled={isSaving || !page.hasPrevious}
        onClick={() => onPage(Math.max(0, page.offset - page.limit))}
      >
        Previous {itemLabel}
      </button>
      <button
        type="button"
        disabled={isSaving || !page.hasNext}
        onClick={() => onPage(page.offset + page.limit)}
      >
        Next {itemLabel}
      </button>
    </div>
  );
}
