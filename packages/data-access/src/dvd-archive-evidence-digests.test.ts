import { describe, expect, it } from "vitest";

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
  it("uses stable domain-separated canonical encodings", () => {
    const boundaryEvidenceDigest = createDvdArchiveBoundaryEvidenceDigest({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0,
    });
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
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
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
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryEvidenceDigest,
      unrecoveredSourceRanges,
    });

    expect(boundaryEvidenceDigest).toBe(
      "6f995d225efe15ffa7555b68fc63ce70b7da3002914f7020c51af38f80ad705b",
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
        "17d746d786d1aea2ac1d376b92280331d66f97978f3d895cb91b32d72687fdb1",
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
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryEvidenceDigest:
        "6f995d225efe15ffa7555b68fc63ce70b7da3002914f7020c51af38f80ad705b",
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
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0,
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
