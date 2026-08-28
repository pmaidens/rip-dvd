import { describe, expect, it } from "vitest";

import {
  archiveBoundaryEvidenceFromRecord,
  createCorrectedDvdArchiveBoundaryEvidence,
  createNormalDvdArchiveBoundaryEvidence,
  DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
} from "./archive-boundary.js";
import { DomainInvariantError } from "./errors.js";

describe("DVD archive-boundary evidence", () => {
  it("records the reported and published size for a normal full-size archive", () => {
    expect(createNormalDvdArchiveBoundaryEvidence(8_192)).toEqual({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0,
    });
    expect(DVD_ARCHIVE_BOUNDARY_POLICY_VERSION).toBe(
      "dvd-archive-boundary-v1",
    );
  });

  it.each([
    0,
    -1,
    9_000_000_001,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
  ])("rejects an unbounded reported size of %s", (reportedSizeBytes) => {
    expect(() =>
      createNormalDvdArchiveBoundaryEvidence(reportedSizeBytes)
    ).toThrow(DomainInvariantError);
  });

  it("records a sector-precise corrected boundary and its bounded out-of-range evidence", () => {
    expect(createCorrectedDvdArchiveBoundaryEvidence({
      reportedSizeBytes: 8 * 2_048,
      publishedSizeBytes: 6 * 2_048,
      firstExcludedLba: 6,
      maximumReferencedLba: 5,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 3,
        hostStatus: 0,
        driverStatus: 0x28,
        senseResponseCode: 0x70,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      },
    })).toEqual({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 8 * 2_048,
      publishedSizeBytes: 6 * 2_048,
      excludedSectorCount: 2,
      firstExcludedLba: 6,
      maximumReferencedLba: 5,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 3,
        hostStatus: 0,
        driverStatus: 0x28,
        senseResponseCode: 0x70,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      },
    });
  });

  it.each([
    ["unaligned published size", { publishedSizeBytes: 6 * 2_048 - 1 }],
    ["contradictory first excluded LBA", { firstExcludedLba: 5 }],
    ["referenced extent crossing the boundary", { maximumReferencedLba: 6 }],
    [
      "unbounded SCSI status",
      {
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2",
          scsiStatus: 0x103,
          hostStatus: 0,
          driverStatus: 0x28,
          senseResponseCode: 0x70,
          senseKey: 0x05,
          asc: 0x21,
          ascq: 0,
        },
      },
    ],
    [
      "unbounded driver status",
      {
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2",
          scsiStatus: 3,
          hostStatus: 0,
          driverStatus: 0x10028,
          senseResponseCode: 0x70,
          senseKey: 0x05,
          asc: 0x21,
          ascq: 0,
        },
      },
    ],
    [
      "non-out-of-range sense",
      {
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v1",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x70,
          senseKey: 0x05,
          asc: 0x20,
          ascq: 0,
        },
      },
    ],
  ] as const)("rejects corrected evidence with %s", (_reason, override) => {
    expect(() => createCorrectedDvdArchiveBoundaryEvidence({
      reportedSizeBytes: 8 * 2_048,
      publishedSizeBytes: 6 * 2_048,
      firstExcludedLba: 6,
      maximumReferencedLba: 5,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v1",
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 0x70,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
      },
      ...override,
    } as never)).toThrow(DomainInvariantError);
  });

  it("reconstructs a versioned record while preserving historical nulls", () => {
    expect(archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
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
    })).toEqual({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0,
    });
    expect(archiveBoundaryEvidenceFromRecord({
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
    })).toBeNull();
  });

  it("treats omitted corrected fields as null in older record projections", () => {
    expect(archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryExcludedSectorCount: 0,
    })).toEqual({
      policyVersion: "dvd-archive-boundary-v1",
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0,
    });
  });

  it("reconstructs corrected boundary evidence", () => {
    expect(archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8 * 2_048,
      boundaryPublishedSizeBytes: 6 * 2_048,
      boundaryExcludedSectorCount: 2,
      boundaryFirstExcludedLba: 6,
      boundaryMaximumReferencedLba: 5,
      boundaryReadFailureClassifierVersion: "scsi-read-classifier-v1",
      boundaryReadFailureScsiStatus: 2,
      boundaryReadFailureHostStatus: 0,
      boundaryReadFailureDriverStatus: 8,
      boundaryReadFailureSenseResponseCode: 0x72,
      boundaryReadFailureSenseKey: 0x05,
      boundaryReadFailureAsc: 0x21,
      boundaryReadFailureAscq: 0,
    })).toEqual(expect.objectContaining({
      excludedSectorCount: 2,
      firstExcludedLba: 6,
      maximumReferencedLba: 5,
      outOfRangeEvidence: expect.objectContaining({
        senseResponseCode: 0x72,
        asc: 0x21,
      }),
    }));
  });

  it("rejects a partial persisted record", () => {
    expect(() => archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: null,
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
    })).toThrow(DomainInvariantError);
  });
});
