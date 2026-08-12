import type { DiscInspectionReasonCode } from "@rip-dvd/data-access";

import { optionalBoundedText } from "./bounded-text.js";

export interface ClassifiedDiscInspectionError {
  diagnostic?: string;
  kind: "abort" | "fail" | "retry";
  reasonCode: DiscInspectionReasonCode;
}

export class DiscInspectionError extends Error {
  override readonly name = "DiscInspectionError";

  constructor(
    readonly kind: ClassifiedDiscInspectionError["kind"],
    readonly reasonCode: DiscInspectionReasonCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function classifyDiscInspectionError(error: unknown): ClassifiedDiscInspectionError {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : undefined;
  const diagnostic = optionalBoundedText(message, 500);
  const structured = error instanceof DiscInspectionError ? error : undefined;
  return {
    kind: structured?.kind ?? "retry",
    reasonCode: structured?.reasonCode ?? "unknown",
    ...(diagnostic ? { diagnostic } : {}),
  };
}
