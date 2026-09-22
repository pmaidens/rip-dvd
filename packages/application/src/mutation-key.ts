import { randomUUID } from "node:crypto";

export class InvalidMutationKeyError extends Error {
  constructor() {
    super("A mutation key of 8 to 128 safe characters is required.");
    this.name = "InvalidMutationKeyError";
  }
}

export function parseMutationKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new InvalidMutationKeyError();
  }
  return value;
}

export function generateMutationKey(): string {
  return randomUUID();
}
