import { describe, expect, it } from "vitest";

import { validateDvdArchiveBoundaryEvidence } from "./archive-boundary.js";
import {
  assertDvdArchiveBoundaryEvidenceDigest,
  assertDvdArchiveEvidenceManifestDigests,
  assertDvdArchiveRecoveryReadEvidenceDigest,
  assertDvdUnrecoveredSourceRangesDigest,
  createDvdArchiveBoundaryEvidenceDigest,
  createDvdArchiveEvidenceManifestDigests,
  createDvdArchiveRecoveryReadEvidenceDigest,
  createDvdUnrecoveredSourceRangesDigest,
} from "./dvd-archive-evidence-digests.js";

describe("DVD Archive Evidence digests", () => {
  const completeNormalBoundaryEvidence = {
    policyVersion: "dvd-archive-boundary-v2" as const,
    reportedSizeBytes: 8_192,
    publishedSizeBytes: 8_192,
    excludedSectorCount: 0 as const,
    endpointProof: {
      proofVersion: "dvd-normal-endpoint-proof-v1" as const,
      confirmationCount: 2 as const,
      firstExcludedLba: 4,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 2,
        hostStatus: 0 as const,
        driverStatus: 8,
        senseResponseCode: 0x70 as const,
        senseKey: 0x05 as const,
        asc: 0x21 as const,
        ascq: 0 as const,
      },
    },
  };

  it("keeps proofless legacy normal boundaries readable but not digestible", () => {
    const legacyEvidence = {
      policyVersion: "dvd-archive-boundary-v1" as const,
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0 as const,
    };

    expect(validateDvdArchiveBoundaryEvidence(legacyEvidence, 8_192))
      .toEqual(legacyEvidence);
    expect(() => createDvdArchiveBoundaryEvidenceDigest(legacyEvidence))
      .toThrow("requires complete Archive Boundary Evidence");
  });

  it("rejects legacy normal-boundary evidence with unequal sizes", () => {
    expect(() => createDvdArchiveBoundaryEvidenceDigest({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 4_096,
      publishedSizeBytes: 2_048,
      excludedSectorCount: 0,
    })).toThrow("Normal DVD archive-boundary evidence is invalid");
  });

  it("rejects legacy normal-boundary evidence above the DVD size ceiling", () => {
    expect(() => createDvdArchiveBoundaryEvidenceDigest({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 9_000_001_536,
      publishedSizeBytes: 9_000_001_536,
      excludedSectorCount: 0,
    })).toThrow("Normal DVD archive-boundary evidence is invalid");
  });

  it("accepts valid v2 normal-boundary evidence with endpoint proof", () => {
    expect(() => createDvdArchiveBoundaryEvidenceDigest(
      completeNormalBoundaryEvidence,
    )).not.toThrow();
  });

  it("uses stable domain-separated canonical encodings", () => {
    const boundaryEvidenceDigest = createDvdArchiveBoundaryEvidenceDigest(
      completeNormalBoundaryEvidence,
    );
    const unrecoveredSourceRanges = [
      { startLba: 1, sectorCount: 2, classification: "skipped_untested" },
      { startLba: 3, sectorCount: 1, classification: "individually_failed" },
    ] as const;
    const recoveryReadEvidenceDigest =
      createDvdArchiveRecoveryReadEvidenceDigest({
        originalDiscArchiveId: "archive-1",
        fromManifestId: "manifest-1",
        fromManifestRevision: 1,
        startLba: 1,
        sectorCount: 1,
        outcome: "failed",
      });
    const initialManifest = createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: "archive-1",
      revision: 1,
      previousManifestId: null,
      previousManifestDigest: null,
      recoveryReadId: null,
      recoveryReadEvidenceDigest: null,
      evidenceFormat: "dvd-recovery-evidence-v1",
      imageFingerprint: "dvdmeta-sha256:image",
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 4,
      boundaryPolicyVersion: "dvd-archive-boundary-v2",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryEvidenceDigest,
      unrecoveredSourceRanges: [{
        startLba: 1,
        sectorCount: 3,
        classification: "skipped_untested",
      }],
    });
    const manifest = createDvdArchiveEvidenceManifestDigests({
      originalDiscArchiveId: "archive-1",
      revision: 2,
      previousManifestId: "manifest-1",
      previousManifestDigest: initialManifest.manifestDigest,
      recoveryReadId: "read-1",
      recoveryReadEvidenceDigest,
      evidenceFormat: "dvd-recovery-evidence-v1",
      imageFingerprint: "dvdmeta-sha256:image",
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 4,
      boundaryPolicyVersion: "dvd-archive-boundary-v2",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryEvidenceDigest,
      unrecoveredSourceRanges,
    });

    expect(boundaryEvidenceDigest).toBe(
      "dccc2d82e5b8adb52b3b1621a05f4d40fbdd4a23b55d12a24e9b1458edc3290b",
    );
    expect(createDvdUnrecoveredSourceRangesDigest(unrecoveredSourceRanges))
      .toBe(
        "01a02bed29db84c80c4f9e6ab63414b777464ab22ad23bbf234d40caf2de347c",
      );
    expect(recoveryReadEvidenceDigest).toBe(
      "ed1a1dbb09179e4e88aad1a56ab01052af96d6fc21080e0d786fb6a19f1bbfac",
    );
    expect(manifest).toEqual({
      unrecoveredSourceRangesDigest:
        "01a02bed29db84c80c4f9e6ab63414b777464ab22ad23bbf234d40caf2de347c",
      manifestDigest:
        "f5849ec4415df73a1748c53aa1de6a621403c7f83aa9bcbfc398051719ff018c",
    });
  });

  it("rejects noncanonical source maps before hashing", () => {
    expect(() => createDvdUnrecoveredSourceRangesDigest([
      { startLba: 2, sectorCount: 1, classification: "skipped_untested" },
      { startLba: 1, sectorCount: 1, classification: "skipped_untested" },
    ])).toThrow("canonically normalized");
    expect(() => createDvdUnrecoveredSourceRangesDigest([
      { startLba: 1, sectorCount: 1, classification: "skipped_untested" },
      { startLba: 2, sectorCount: 1, classification: "skipped_untested" },
    ])).toThrow("canonically normalized");
  });

  it("rejects a supplied digest that does not match manifest contents", () => {
    const boundaryEvidenceDigest = createDvdArchiveBoundaryEvidenceDigest(
      completeNormalBoundaryEvidence,
    );
    const input = {
      originalDiscArchiveId: "archive-1",
      revision: 1,
      previousManifestId: null,
      previousManifestDigest: null,
      recoveryReadId: null,
      recoveryReadEvidenceDigest: null,
      evidenceFormat: "dvd-recovery-evidence-v1" as const,
      imageFingerprint: "dvdmeta-sha256:image",
      sectorSizeBytes: 2_048,
      acceptedEndLbaExclusive: 4,
      boundaryPolicyVersion: "dvd-archive-boundary-v2",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryEvidenceDigest,
      unrecoveredSourceRanges: [] as const,
    };
    const digests = createDvdArchiveEvidenceManifestDigests(input);

    expect(() => assertDvdArchiveEvidenceManifestDigests({
      ...input,
      ...digests,
      manifestDigest:
        "0000000000000000000000000000000000000000000000000000000000000000",
    })).toThrow("does not match its contents");
    expect(() => assertDvdArchiveEvidenceManifestDigests({
      ...input,
      ...digests,
      unrecoveredSourceRangesDigest:
        "0000000000000000000000000000000000000000000000000000000000000000",
    })).toThrow("does not match its contents");
    expect(() => assertDvdArchiveBoundaryEvidenceDigest({
      ...completeNormalBoundaryEvidence,
    }, "0".repeat(64))).toThrow("does not match its contents");
    expect(() => assertDvdUnrecoveredSourceRangesDigest(
      input.unrecoveredSourceRanges,
      "0".repeat(64),
    )).toThrow("does not match its contents");
    expect(() => assertDvdArchiveRecoveryReadEvidenceDigest({
      originalDiscArchiveId: "archive-1",
      fromManifestId: "manifest-1",
      fromManifestRevision: 1,
      startLba: 1,
      sectorCount: 1,
      outcome: "failed",
    }, "0".repeat(64))).toThrow("does not match its contents");
  });
});
