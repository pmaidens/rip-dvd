import { DomainInvariantError } from "../errors.js";

export function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new DomainInvariantError(`${name} must not be empty`);
  }
  return normalized;
}
