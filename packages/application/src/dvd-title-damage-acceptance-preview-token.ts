const TOKEN_PATTERN =
  /^dvd-title-damage-acceptance-preview:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createDvdTitleDamageAcceptancePreviewToken(): string {
  return `dvd-title-damage-acceptance-preview:${crypto.randomUUID()}`;
}

export function isDvdTitleDamageAcceptancePreviewToken(
  value: unknown,
): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}
