export function parseRequiredText(
  value: unknown,
  name: string,
  invalidInput: (message: string) => Error,
  maximum = 128,
): string {
  if (
    typeof value !== "string" || value.trim() === "" ||
    value.length > maximum
  ) {
    throw invalidInput(`${name} must be a non-empty string.`);
  }
  return value.trim();
}
