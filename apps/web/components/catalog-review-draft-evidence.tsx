export function CatalogReviewDraftEvidenceNotice({
  usesStaleEvidence,
  mappingAvailable,
  isSaving,
  onUseRefreshedEvidence,
}: {
  usesStaleEvidence: boolean;
  mappingAvailable: boolean;
  isSaving: boolean;
  onUseRefreshedEvidence(): void;
}) {
  if (!usesStaleEvidence) return null;
  return (
    <div className="section-message" role="status">
      <span>
        Catalog evidence changed while this draft was open. Your values are
        preserved; review the refreshed evidence before continuing.
      </span>{" "}
      <button
        type="button"
        disabled={isSaving || !mappingAvailable}
        onClick={onUseRefreshedEvidence}
      >
        Use refreshed evidence
      </button>
    </div>
  );
}
