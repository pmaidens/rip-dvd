import { expect, it } from "vitest";

import { createDvdDiscVerificationResultDigest } from "./dvd-disc-confirmation.js";
import type { DvdDiscVerification } from "./types.js";

function completedVerification(): DvdDiscVerification {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "verification-1" as DvdDiscVerification["id"],
    archiveRecoveryId: "recovery-1" as DvdDiscVerification["archiveRecoveryId"],
    archiveRecoveryAttemptId:
      "attempt-1" as DvdDiscVerification["archiveRecoveryAttemptId"],
    attemptOrdinal: 1,
    originalDiscArchiveId:
      "archive-1" as DvdDiscVerification["originalDiscArchiveId"],
    discInspectionId:
      "inspection-1" as DvdDiscVerification["discInspectionId"],
    detectedDiscId: "disc-1" as DvdDiscVerification["detectedDiscId"],
    mediaGeneration: "generation-1",
    sourceMetadataFingerprint: "source-fingerprint",
    observedMetadataFingerprint: "observed-fingerprint",
    checkpointRevision: 3,
    checkpointDigest: "a".repeat(64),
    status: "completed",
    outcome: "mismatch",
    reasons: ["DISC_METADATA_MISMATCH"],
    findings: [],
    budgetExhausted: false,
    workerExecutionId: "worker-1",
    claimToken: null,
    claimedAt: timestamp,
    admittedDevicePath: null,
    admittedDeviceId: null,
    admittedDeviceInode: null,
    startedAt: timestamp,
    completedAt: timestamp,
    failureCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

it("binds both metadata fingerprints into the verification result digest", () => {
  const verification = completedVerification();
  const digest = createDvdDiscVerificationResultDigest(verification);

  expect(createDvdDiscVerificationResultDigest({
    ...verification,
    sourceMetadataFingerprint: "changed-source-fingerprint",
  })).not.toBe(digest);
  expect(createDvdDiscVerificationResultDigest({
    ...verification,
    observedMetadataFingerprint: "changed-observed-fingerprint",
  })).not.toBe(digest);
});
