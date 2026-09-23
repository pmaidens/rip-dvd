const REARCHIVE_ACCEPTANCE_PREVIEW_TOKEN_PATTERN =
  /^rearchive-acceptance-preview:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createRearchiveAcceptancePreviewToken(): string {
  return `rearchive-acceptance-preview:${crypto.randomUUID()}`;
}

export function isRearchiveAcceptancePreviewToken(
  value: unknown,
): value is string {
  return typeof value === "string" &&
    REARCHIVE_ACCEPTANCE_PREVIEW_TOKEN_PATTERN.test(value);
}
