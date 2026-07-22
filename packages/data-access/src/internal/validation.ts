import { DomainInvariantError } from "../errors.js";

export function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new DomainInvariantError(`${name} must not be empty`);
  }
  return normalized;
}

export function requirePositiveSafeInteger(
  value: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainInvariantError(`${name} must be a positive safe integer`);
  }
  return value;
}
