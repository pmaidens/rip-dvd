import { describe, expect, it } from "vitest";

import {
  archiveBoundaryEvidenceFromRecord,
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

  it("reconstructs a versioned record while preserving historical nulls", () => {
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
    expect(archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: null,
      boundaryReportedSizeBytes: null,
      boundaryPublishedSizeBytes: null,
      boundaryExcludedSectorCount: null,
    })).toBeNull();
  });

  it("rejects a partial persisted record", () => {
    expect(() => archiveBoundaryEvidenceFromRecord({
      boundaryPolicyVersion: "dvd-archive-boundary-v1",
      boundaryReportedSizeBytes: 8_192,
      boundaryPublishedSizeBytes: null,
      boundaryExcludedSectorCount: 0,
    })).toThrow(DomainInvariantError);
  });
});
