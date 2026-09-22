const CATALOG_REVIEW_COMPLETION_PREVIEW_TOKEN_PATTERN =
  /^catalog-review-completion-preview:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createCatalogReviewCompletionPreviewToken(): string {
  return `catalog-review-completion-preview:${crypto.randomUUID()}`;
}

export function isCatalogReviewCompletionPreviewToken(
  value: unknown,
): value is string {
  return typeof value === "string" &&
    CATALOG_REVIEW_COMPLETION_PREVIEW_TOKEN_PATTERN.test(value);
}
