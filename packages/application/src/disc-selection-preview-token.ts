const DISC_SELECTION_PREVIEW_TOKEN_PATTERN =
  /^disc-selection-preview:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createDiscSelectionPreviewToken(): string {
  return `disc-selection-preview:${crypto.randomUUID()}`;
}

export function isDiscSelectionPreviewToken(value: unknown): value is string {
  return typeof value === "string" && DISC_SELECTION_PREVIEW_TOKEN_PATTERN.test(value);
}
