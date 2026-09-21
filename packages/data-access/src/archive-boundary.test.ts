import { describe, expect, it } from "vitest";

import {
  archiveBoundaryEvidenceFromRecord,
  createCorrectedDvdArchiveBoundaryEvidence,
  createNormalDvdArchiveBoundaryEvidence,
  DVD_ARCHIVE_BOUNDARY_POLICY_VERSION,
} from "./archive-boundary.js";
import { DomainInvariantError } from "./errors.js";

describe("DVD archive-boundary evidence", () => {
  it("records independent endpoint proof for a normal full-size archive", () => {
    expect(createNormalDvdArchiveBoundaryEvidence({
      reportedSizeBytes: 8_192,
      endpointProof: {
        proofVersion: "dvd-normal-endpoint-proof-v1",
        confirmationCount: 2,
        firstExcludedLba: 4,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x72,
          senseKey: 0x05,
          asc: 0x21,
          ascq: 0,
        },
      },
    })).toEqual({
      policyVersion: "dvd-archive-boundary-v2",
      reportedSizeBytes: 8_192,
      publishedSizeBytes: 8_192,
      excludedSectorCount: 0,
      endpointProof: {
        proofVersion: "dvd-normal-endpoint-proof-v1",
        confirmationCount: 2,
        firstExcludedLba: 4,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2",
          scsiStatus: 2,
          hostStatus: 0,
          driverStatus: 8,
          senseResponseCode: 0x72,
          senseKey: 0x05,
          asc: 0x21,
          ascq: 0,
        },
      },
    });
    expect(DVD_ARCHIVE_BOUNDARY_POLICY_VERSION).toBe(
      "dvd-archive-boundary-v2",
    );
  });

  it.each([
    ["zero size", { reportedSizeBytes: 0 }],
    ["unaligned size", { reportedSizeBytes: 8_191 }],
    ["wrong first excluded LBA", {
      endpointProof: { firstExcludedLba: 3 },
    }],
    ["one confirmation", { endpointProof: { confirmationCount: 1 } }],
    ["non-out-of-range response", {
      endpointProof: { outOfRangeEvidence: { asc: 0x20 } },
    }],
  ])("rejects normal evidence with %s", (_reason, override) => {
    const endpointProof = {
      proofVersion: "dvd-normal-endpoint-proof-v1",
      confirmationCount: 2,
      firstExcludedLba: 4,
      ...(override as { endpointProof?: Record<string, unknown> }).endpointProof,
      outOfRangeEvidence: {
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode: 0x70,
        senseKey: 0x05,
        asc: 0x21,
        ascq: 0,
        ...(override as {
          endpointProof?: { outOfRangeEvidence?: Record<string, unknown> };
        }).endpointProof?.outOfRangeEvidence,
      },
    };
    expect(() => createNormalDvdArchiveBoundaryEvidence({
      reportedSizeBytes: 8_192,
      ...override,
      endpointProof,
    } as never)).toThrow(DomainInvariantError);
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

  it.each([
    ["a non-positive size", 0, 0],
    ["different reported and published sizes", 8_192, 4_096],
  ])(
    "rejects legacy normal records with %s",
    (_reason, reportedSizeBytes, publishedSizeBytes) => {
      expect(() => archiveBoundaryEvidenceFromRecord({
        boundaryPolicyVersion: "dvd-archive-boundary-v1",
        boundaryReportedSizeBytes: reportedSizeBytes,
        boundaryPublishedSizeBytes: publishedSizeBytes,
        boundaryExcludedSectorCount: 0,
      })).toThrow(DomainInvariantError);
    },
  );

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

  it("reconstructs normal endpoint proof", () => {
    expect(archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: "dvd-archive-boundary-v2",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: 8_192,
      boundaryExcludedSectorCount: 0,
      boundaryFirstExcludedLba: 4,
      boundaryMaximumReferencedLba: null,
      boundaryReadFailureClassifierVersion: "scsi-read-classifier-v2",
      boundaryReadFailureScsiStatus: 2,
      boundaryReadFailureHostStatus: 0,
      boundaryReadFailureDriverStatus: 8,
      boundaryReadFailureSenseResponseCode: 0x70,
      boundaryReadFailureSenseKey: 0x05,
      boundaryReadFailureAsc: 0x21,
      boundaryReadFailureAscq: 0,
    })).toMatchObject({
      policyVersion: "dvd-archive-boundary-v2",
      excludedSectorCount: 0,
      endpointProof: {
        proofVersion: "dvd-normal-endpoint-proof-v1",
        confirmationCount: 2,
        firstExcludedLba: 4,
        outOfRangeEvidence: {
          classifierVersion: "scsi-read-classifier-v2",
          asc: 0x21,
        },
      },
    });
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
