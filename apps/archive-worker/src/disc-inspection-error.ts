import type { DiscInspectionReasonCode } from "@rip-dvd/data-access";

import { optionalBoundedText } from "./bounded-text.js";

export interface ClassifiedDiscInspectionError {
  diagnostic?: string;
  kind: "abort" | "fail" | "retry";
  reasonCode: DiscInspectionReasonCode;
}

export function classifyDiscInspectionError(error: unknown): ClassifiedDiscInspectionError {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = optionalBoundedText(message, 500);
  const result = (
    kind: ClassifiedDiscInspectionError["kind"],
    reasonCode: DiscInspectionReasonCode,
  ): ClassifiedDiscInspectionError => ({
    kind,
    reasonCode,
    ...(diagnostic ? { diagnostic } : {}),
  });
  if (/medium changed|media changed/i.test(message)) {
    return result("abort", "media_changed");
  }
  if (/no medium|medium not present/i.test(message)) {
    return result("abort", "no_medium");
  }
  if (/identity changed|device instance changed/i.test(message)) {
    return result("abort", "drive_identity_changed");
  }
  if (/invalid DVD title map|invalid DVD size|invalid content identity|invalid metadata/i.test(message)) {
    return result("fail", /content|size/i.test(message) ? "invalid_content" : "invalid_metadata");
  }
  if (/not enabled|unavailable|not present/i.test(message)) {
    return result("retry", "drive_unavailable");
  }
  if (/not ready/i.test(message)) {
    return result("retry", "drive_not_ready");
  }
  if (/lsdvd|metadata/i.test(message)) {
    return result("retry", "metadata_read_failed");
  }
  if (/blockdev|content size/i.test(message)) {
    return result("retry", "content_size_failed");
  }
  if (/hash|content read|dvdcss/i.test(message)) {
    return result("retry", "content_read_failed");
  }
  return result("retry", "unknown");
}
