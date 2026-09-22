import { readFileSync } from "node:fs";

export interface StructuredInputIO {
  readStdin?(): string;
  readFile?(path: string): string;
}

export class StructuredInputError extends Error {
  constructor(readonly code: "INVALID_ARGUMENTS" | "INVALID_INPUT", message: string) {
    super(message);
  }
}

export function readStructuredObject(
  options: ReadonlyMap<string, string>,
  io: StructuredInputIO,
): unknown | undefined {
  const forms = ["--json", "--stdin", "--file"].filter((name) => options.has(name));
  if (forms.length > 1) {
    throw new StructuredInputError("INVALID_ARGUMENTS", "Choose one structured input form.");
  }
  if (forms.length === 0) return undefined;
  let text: string;
  try {
    text = options.get("--json") ?? (options.has("--stdin")
      ? (io.readStdin ?? (() => readFileSync(0, "utf8")))()
      : (io.readFile ?? ((path) => readFileSync(path, "utf8")))(options.get("--file")!));
  } catch {
    throw new StructuredInputError("INVALID_INPUT", "Structured input could not be read.");
  }
  if (text.length > 1_000_000) {
    throw new StructuredInputError("INVALID_ARGUMENTS", "Structured input is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StructuredInputError("INVALID_ARGUMENTS", "Structured input is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StructuredInputError("INVALID_ARGUMENTS", "Structured input must be a JSON object.");
  }
  return value;
}
