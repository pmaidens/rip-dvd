import { describe, expect, it } from "vitest";

import {
  createIncompleteReadArchiveIntegrityEvidence,
  createWatchableSalvageArchiveIntegrityEvidence,
  withAuthoritativeDvdArchiveIntegrity,
} from "./archive-integrity.js";
import type {
  DvdArchiveEvidenceHeader,
  OriginalDiscArchive,
} from "./types.js";

describe("Archive Integrity evidence", () => {
  it("pairs the authoritative integrity projection with its manifest revision", () => {
    const archive: OriginalDiscArchive = {
      id: "archive-1" as OriginalDiscArchive["id"],
      detectedDiscId: "disc-1" as OriginalDiscArchive["detectedDiscId"],
      rearchiveSourceArchiveId: null,
      discKind: "dvd",
      archiveFormat: "iso",
      archivePath: "/synthetic/archive.iso",
      fingerprint: "synthetic-fingerprint",
      sizeBytes: 4096,
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 4096,
      boundaryPublishedSizeBytes: 4096,
      boundaryExcludedSectorCount: 0,
      boundaryFirstExcludedLba: null,
      boundaryMaximumReferencedLba: null,
      boundaryReadFailureClassifierVersion: null,
      boundaryReadFailureScsiStatus: null,
      boundaryReadFailureHostStatus: null,
      boundaryReadFailureDriverStatus: null,
      boundaryReadFailureSenseResponseCode: null,
      boundaryReadFailureSenseKey: null,
      boundaryReadFailureAsc: null,
      boundaryReadFailureAscq: null,
      integrity: "incomplete_read",
      integrityEvidenceRevision: 1,
      integrityPolicyVersion: "dvd-recovery-evidence-v1",
      badSectorCount: 2,
      badAreaCount: 1,
      badSectorRanges: [{ startLba: 0, sectorCount: 2 }],
      badSectorCountsByTitle: null,
      archivedAt: new Date(1),
      catalogReviewedAt: null,
      catalogReviewOutcome: "needs_review",
      verificationStatus: null,
      verificationMessage: null,
      verifiedAt: null,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    };
    const header: DvdArchiveEvidenceHeader = {
      originalDiscArchiveId: archive.id,
      sourceArchiveJobId: "job-1" as DvdArchiveEvidenceHeader[
        "sourceArchiveJobId"
      ],
      evidenceFormat: "dvd-recovery-evidence-v1",
      boundaryEvidenceDigest: "a".repeat(64),
      sectorSizeBytes: 2048,
      acceptedEndLbaExclusive: 2,
      currentManifestId: "manifest-2",
      currentManifestRevision: 2,
      currentManifestDigest: "b".repeat(64),
      unrecoveredSourceRanges: [
        { startLba: 0, sectorCount: 1, classification: "skipped_untested" },
        { startLba: 1, sectorCount: 1, classification: "individually_failed" },
      ],
      createdAt: new Date(1),
      updatedAt: new Date(2),
    };

    expect(withAuthoritativeDvdArchiveIntegrity(archive, header)).toMatchObject({
      integrity: "incomplete_read",
      integrityEvidenceRevision: 2,
      badSectorCount: 2,
      badAreaCount: 2,
    });
  });

  it("creates a compatible projection for versioned incomplete-read evidence", () => {
    expect(createIncompleteReadArchiveIntegrityEvidence([
      { startLba: 12, sectorCount: 4 },
      { startLba: 20, sectorCount: 2 },
    ])).toEqual({
      integrity: "incomplete_read",
      policyVersion: "dvd-recovery-evidence-v1",
      badSectorCount: 6,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 12, sectorCount: 4 },
        { startLba: 20, sectorCount: 2 },
      ],
    });
  });

  it("preserves adjacent half-open incomplete-read ranges", () => {
    expect(createIncompleteReadArchiveIntegrityEvidence([
      { startLba: 0, sectorCount: 1 },
      { startLba: 1, sectorCount: 1 },
    ])).toMatchObject({
      badSectorCount: 2,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 0, sectorCount: 1 },
        { startLba: 1, sectorCount: 1 },
      ],
    });
  });

  it.each([
    { ranges: [] },
    { ranges: [{ startLba: -1, sectorCount: 1 }] },
    { ranges: [{ startLba: 1, sectorCount: 0 }] },
    { ranges: [
      { startLba: 2, sectorCount: 2 },
      { startLba: 3, sectorCount: 1 },
    ] },
  ])("rejects invalid incomplete-read ranges", ({ ranges }) => {
    expect(() => createIncompleteReadArchiveIntegrityEvidence(ranges))
      .toThrow();
  });

  it("normalizes bounded isolated-sector evidence for watchable salvage", () => {
    expect(createWatchableSalvageArchiveIntegrityEvidence(
      " dvd-watchable-salvage-v2 ",
      [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
      [
        { titleNumber: 2, badSectorCount: 1 },
        { titleNumber: 5, badSectorCount: 2 },
      ],
    )).toEqual({
      integrity: "watchable_salvage",
      policyVersion: "dvd-watchable-salvage-v2",
      badSectorCount: 2,
      badAreaCount: 2,
      badSectorRanges: [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
      badSectorCountsByTitle: [
        { titleNumber: 2, badSectorCount: 1 },
        { titleNumber: 5, badSectorCount: 2 },
      ],
    });
  });

  it.each([
    ["policy bound", [{ startLba: 1, sectorCount: 2 }]],
    ["normalized shape", [
      { startLba: 1, sectorCount: 1 },
      { startLba: 2, sectorCount: 1 },
    ]],
    ["policy count bound", Array.from({ length: 33 }, (_, index) => ({
      startLba: index * 2,
      sectorCount: 1,
    }))],
  ] as const)("rejects evidence outside the watchability %s", (
    _description,
    ranges,
  ) => {
    expect(() => createWatchableSalvageArchiveIntegrityEvidence(
      "dvd-unused-space-v1",
      ranges,
      [],
    )).toThrow();
  });

  it.each([
    ["per-title policy bound", [{ titleNumber: 1, badSectorCount: 17 }]],
    ["ascending title order", [
      { titleNumber: 2, badSectorCount: 1 },
      { titleNumber: 1, badSectorCount: 1 },
    ]],
    ["positive title number", [{ titleNumber: 0, badSectorCount: 1 }]],
    ["disc evidence consistency", [{ titleNumber: 1, badSectorCount: 3 }]],
  ] as const)("rejects invalid %s evidence", (_description, titleCounts) => {
    expect(() => createWatchableSalvageArchiveIntegrityEvidence(
      "dvd-watchable-salvage-v2",
      [
        { startLba: 12, sectorCount: 1 },
        { startLba: 20, sectorCount: 1 },
      ],
      titleCounts,
    )).toThrow();
  });
});
