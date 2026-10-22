import { expect, it } from "vitest";

import {
  createDvdSourceSampleDigest,
  createDvdSourceSampleManifestDigest,
  dvdDiscVerificationOutcome,
  dvdSourceSampleCandidates,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
  DVD_SOURCE_SAMPLE_SECTOR_COUNT,
  DVD_SOURCE_VERIFICATION_MAX_BYTES,
  DVD_SOURCE_VERIFICATION_POLICY_VERSION,
  hasSuitableDvdSourceSampleContent,
  validateDvdSourceSampleManifest,
  type DvdDiscVerificationSampleFinding,
} from "./dvd-disc-verification.js";

it("selects deterministic 32-sector windows near sixteen equal-band midpoints", () => {
  const extent = 16_000;
  const first = Array.from({ length: DVD_SOURCE_SAMPLE_BAND_COUNT },
    (_, bandIndex) => dvdSourceSampleCandidates({
      acceptedEndLbaExclusive: extent,
      bandIndex,
      unrecoveredSourceRanges: [],
    })[0]!);

  expect(new Set(first).size).toBe(16);
  for (const [bandIndex, startLba] of first.entries()) {
    const midpoint = startLba + DVD_SOURCE_SAMPLE_SECTOR_COUNT / 2;
    expect(midpoint).toBeGreaterThanOrEqual(extent * bandIndex / 16);
    expect(midpoint).toBeLessThan(extent * (bandIndex + 1) / 16);
  }
  expect(
    DVD_SOURCE_SAMPLE_BAND_COUNT * DVD_SOURCE_SAMPLE_BYTE_COUNT,
  ).toBe(DVD_SOURCE_VERIFICATION_MAX_BYTES);
});

it("never selects a reference window crossing unresolved source sectors", () => {
  const candidates = dvdSourceSampleCandidates({
    acceptedEndLbaExclusive: 16_000,
    bandIndex: 4,
    unrecoveredSourceRanges: [{
      startLba: 4_484,
      sectorCount: 64,
      classification: "skipped_untested",
    }],
  });
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.every((startLba) =>
    startLba + DVD_SOURCE_SAMPLE_SECTOR_COUNT <= 4_484 ||
    startLba >= 4_548)).toBe(true);
});

it("rejects uniform filler and binds valid references to their provenance", () => {
  const uniform = Buffer.alloc(DVD_SOURCE_SAMPLE_BYTE_COUNT, 7);
  const suitable = Buffer.from(uniform);
  suitable[suitable.length - 1] = 8;
  expect(hasSuitableDvdSourceSampleContent(uniform)).toBe(false);
  expect(hasSuitableDvdSourceSampleContent(suitable)).toBe(true);
  const payload = {
    policyVersion: DVD_SOURCE_VERIFICATION_POLICY_VERSION,
    byteRepresentation: DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
    sourceMetadataFingerprint: "synthetic-source",
    acceptedEndLbaExclusive: 16_000,
    checkpointRevision: 3,
    checkpointDigest: "a".repeat(64),
    samples: [{
      bandIndex: 0,
      startLba: 484,
      sectorCount: DVD_SOURCE_SAMPLE_SECTOR_COUNT,
      digest: createDvdSourceSampleDigest(suitable),
    }],
  } as const;
  const manifest = {
    ...payload,
    manifestDigest: createDvdSourceSampleManifestDigest(payload),
  };
  expect(validateDvdSourceSampleManifest(manifest)).toEqual(manifest);
  expect(() => validateDvdSourceSampleManifest({
    ...manifest,
    checkpointRevision: 4,
  })).toThrow("does not match its contents");
});

it("lets known mismatch evidence outrank unreadable transport evidence", () => {
  const findings: DvdDiscVerificationSampleFinding[] = [
    {
      bandIndex: 0,
      startLba: 0,
      sectorCount: 32,
      outcome: "mismatch",
      referenceDigest: "a".repeat(64),
      observedDigest: "b".repeat(64),
      diagnostic: null,
    },
    {
      bandIndex: 1,
      startLba: 1_000,
      sectorCount: 32,
      outcome: "unreadable",
      referenceDigest: "c".repeat(64),
      observedDigest: null,
      diagnostic: {
        category: "transport_error",
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 0,
        hostStatus: 7,
        driverStatus: 0,
        senseResponseCode: null,
        senseKey: null,
        asc: null,
        ascq: null,
        informationLba: null,
      },
    },
  ];
  expect(dvdDiscVerificationOutcome({
    metadataMatches: true,
    coverageComplete: false,
    budgetExhausted: false,
    insertionChanged: false,
    checkpointChanged: false,
    findings,
  })).toEqual({
    outcome: "mismatch",
    reasons: [
      "DISC_SAMPLE_MISMATCH",
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_SAMPLE_UNREADABLE",
    ],
  });
});
