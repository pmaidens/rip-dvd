import {
  type ConsistentReadAccess,
  type DetectedDiscId,
  type OriginalDiscArchive,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { describe, expect, it, vi } from "vitest";

import { inspectOperations } from "./operations.js";

function syntheticArchive(index: number): OriginalDiscArchive {
  const timestamp = new Date(index + 1);
  return {
    id: `synthetic-archive-${index}` as OriginalDiscArchiveId,
    detectedDiscId: `synthetic-disc-${index}` as DetectedDiscId,
    rearchiveSourceArchiveId: null,
    discKind: "dvd",
    archiveFormat: "iso",
    archivePath: `/media/originals/synthetic-${index}.iso`,
    fingerprint: `synthetic-fingerprint-${index}`,
    sizeBytes: null,
    boundaryPolicyVersion: null,
    boundaryReportedSizeBytes: null,
    boundaryPublishedSizeBytes: null,
    boundaryExcludedSectorCount: null,
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
    integrity: "unknown",
    integrityEvidenceRevision: null,
    integrityPolicyVersion: null,
    badSectorCount: null,
    badAreaCount: null,
    badSectorRanges: null,
    badSectorCountsByTitle: null,
    archivedAt: timestamp,
    catalogReviewedAt: null,
    catalogReviewOutcome: "needs_review",
    verificationStatus: null,
    verificationMessage: null,
    verifiedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("inspectOperations", () => {
  it("reads evidence headers once for a bounded 100-archive snapshot", () => {
    const archives = Array.from({ length: 100 }, (_, index) =>
      syntheticArchive(index)
    );
    const findDvdArchiveEvidenceHeaders = vi.fn(() => new Map());
    const findDvdArchiveEvidenceHeader = vi.fn(() => {
      throw new Error("single evidence read should not be used");
    });
    const snapshot = {
      catalog: {
        listOriginalDiscArchives: vi.fn(() => archives),
        findDvdArchiveEvidenceHeader,
        findDvdArchiveEvidenceHeaders,
      },
    } as unknown as ConsistentReadAccess;
    const access = {
      readConsistentSnapshot<T>(
        read: (consistent: ConsistentReadAccess) => T,
      ): T {
        return read(snapshot);
      },
    };

    const result = inspectOperations(access, "original-disc-archives", {
      limit: 100,
    });

    expect(result.items).toHaveLength(100);
    expect(findDvdArchiveEvidenceHeaders).toHaveBeenCalledTimes(1);
    expect(findDvdArchiveEvidenceHeaders).toHaveBeenCalledWith(
      archives.map((archive) => archive.id),
    );
    expect(findDvdArchiveEvidenceHeader).not.toHaveBeenCalled();
  });
});
