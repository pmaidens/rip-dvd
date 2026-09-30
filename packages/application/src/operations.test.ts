import {
  type ArchiveJobId,
  DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT,
  type ConsistentReadAccess,
  type DetectedDisc,
  type DetectedDiscId,
  type DvdArchiveEvidenceHeader,
  type OpticalDriveId,
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

function syntheticDisc(): DetectedDisc {
  const timestamp = new Date(1);
  return {
    id: "synthetic-disc" as DetectedDiscId,
    opticalDriveId: "synthetic-drive" as OpticalDriveId,
    discKind: "dvd",
    fingerprint: "synthetic-disc-fingerprint",
    volumeLabel: "SYNTHETIC_DISC",
    status: "archived",
    scanData: {},
    detectedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function syntheticEvidenceHeader(
  originalDiscArchiveId: OriginalDiscArchiveId,
): DvdArchiveEvidenceHeader {
  const timestamp = new Date(1);
  return {
    originalDiscArchiveId,
    sourceArchiveJobId:
      `synthetic-job-${originalDiscArchiveId}` as ArchiveJobId,
    evidenceFormat: "dvd-recovery-evidence-v1",
    boundaryEvidenceDigest: "a".repeat(64),
    sectorSizeBytes: 2_048,
    acceptedEndLbaExclusive: 2,
    currentManifestId: `synthetic-manifest-${originalDiscArchiveId}`,
    currentManifestRevision: 1,
    currentManifestDigest: "b".repeat(64),
    unrecoveredSourceRanges: [{
      startLba: 1,
      sectorCount: 1,
      classification: "skipped_untested",
    }],
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

  it("chunks evidence reads for a detected disc with more than 1,000 archives", () => {
    const disc = syntheticDisc();
    const archives = Array.from(
      { length: DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT + 1 },
      (_, index) => ({
        ...syntheticArchive(index),
        detectedDiscId: disc.id,
      }),
    );
    const findDvdArchiveEvidenceHeaders = vi.fn(
      (ids: readonly OriginalDiscArchiveId[]) => {
        expect(ids.length).toBeLessThanOrEqual(
          DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT,
        );
        return new Map(ids.map((archiveId) => [
          archiveId,
          syntheticEvidenceHeader(archiveId),
        ]));
      },
    );
    const snapshot = {
      catalog: {
        listDetectedDiscs: vi.fn(() => [disc]),
        listOriginalDiscArchives: vi.fn(() => archives),
        findDvdArchiveEvidenceHeaders,
      },
      archiveRequests: {
        listForDetectedDisc: vi.fn(() => []),
        listRelevantForDetectedDiscs: vi.fn(() => []),
      },
      discInspections: { list: vi.fn(() => []) },
      archiveJobs: { list: vi.fn(() => []) },
    } as unknown as ConsistentReadAccess;
    const access = {
      readConsistentSnapshot<T>(
        read: (consistent: ConsistentReadAccess) => T,
      ): T {
        return read(snapshot);
      },
    };

    const result = inspectOperations(access, "detected-discs", {
      id: disc.id,
    });

    const visibleArchives = (result.item as {
      archives: readonly {
        id: OriginalDiscArchiveId;
        integrity: string;
        badSectorCount: number | null;
      }[];
    }).archives;
    expect(visibleArchives).toHaveLength(archives.length);
    expect(visibleArchives.at(-1)).toMatchObject({
      id: archives.at(-1)!.id,
      integrity: "incomplete_read",
      badSectorCount: 1,
    });
    expect(findDvdArchiveEvidenceHeaders).toHaveBeenCalledTimes(2);
    expect(findDvdArchiveEvidenceHeaders.mock.calls[0]?.[0]).toEqual(
      archives.slice(0, DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT).map(
        (archive) => archive.id,
      ),
    );
    expect(findDvdArchiveEvidenceHeaders.mock.calls[1]?.[0]).toEqual([
      archives[DVD_ARCHIVE_EVIDENCE_HEADER_BATCH_LIMIT]!.id,
    ]);
  });
});
