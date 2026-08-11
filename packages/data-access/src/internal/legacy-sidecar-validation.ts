export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function legacyInteger(
  value: unknown,
  defaultValue?: number,
): number | null {
  if (value === undefined && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) ? Number(value) : null;
}

export function positiveInteger(value: unknown): number | null {
  const integer = legacyInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}

export function optionalYear(value: unknown): number | null {
  const year = positiveInteger(value);
  return year !== null && year >= 1800 && year <= 9999 ? year : null;
}

export function recordedDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  const integer = legacyInteger(value);
  return integer !== null && integer >= 0 ? integer : null;
}
