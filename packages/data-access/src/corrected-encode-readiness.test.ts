import { describe, expect, it } from "vitest";

import type {
  EncodeJobClaimToken,
  EncodeJobCleanupClaimToken,
} from "./types.js";
import { isEncodeJobSafelyTerminal } from "./corrected-encode-readiness.js";

const safelyTerminal = {
  status: "completed",
  partialCleanupOutputPath: null,
  partialCleanupClaimToken: null,
  partialCleanupLeaseToken: null,
  publicationPending: false,
  publicationCompletionPending: false,
} as const;

describe("Encode Job safe terminal state", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "accepts %s without cleanup or publication fences",
    (status) => {
      expect(isEncodeJobSafelyTerminal({ ...safelyTerminal, status })).toBe(
        true,
      );
    },
  );

  it.each([
    "queued",
    "running",
    "cancellation_requested",
  ] as const)("rejects active status %s", (status) => {
    expect(isEncodeJobSafelyTerminal({ ...safelyTerminal, status })).toBe(
      false,
    );
  });

  it.each([
    { partialCleanupOutputPath: "/media/movies/partial.mkv" },
    {
      partialCleanupClaimToken:
        "cleanup-claim" as EncodeJobClaimToken,
    },
    {
      partialCleanupLeaseToken:
        "cleanup-lease" as EncodeJobCleanupClaimToken,
    },
    { publicationPending: true },
    { publicationCompletionPending: true },
  ])("rejects terminal work while a fence remains: $0", (fence) => {
    expect(isEncodeJobSafelyTerminal({ ...safelyTerminal, ...fence })).toBe(
      false,
    );
  });
});
