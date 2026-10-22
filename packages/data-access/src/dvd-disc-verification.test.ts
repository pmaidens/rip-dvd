import { expect, it } from "vitest";

import {
  assertDvdSourceSampleManifestProjection,
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
  validateDvdDiscVerificationFindings,
  validateDvdSourceSampleManifest,
  type DvdDiscVerificationSampleFinding,
  type DvdSourceSampleManifest,
} from "./dvd-disc-verification.js";

function sourceManifest(): DvdSourceSampleManifest {
  const bytes = Buffer.alloc(DVD_SOURCE_SAMPLE_BYTE_COUNT);
  bytes[bytes.length - 1] = 1;
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
      digest: createDvdSourceSampleDigest(bytes),
    }],
  } as const;
  return {
    ...payload,
    manifestDigest: createDvdSourceSampleManifestDigest(payload),
  };
}

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

it("rejects a source sample whose advertised band does not contain it", () => {
  const manifest = sourceManifest();
  const payload = {
    ...manifest,
    samples: [{ ...manifest.samples[0]!, startLba: 2_000 }],
  };
  const { manifestDigest: _manifestDigest, ...unsigned } = payload;
  expect(() => validateDvdSourceSampleManifest({
    ...payload,
    manifestDigest: createDvdSourceSampleManifestDigest(unsigned),
  })).toThrow("source sample reference is invalid");
});

it("rejects a valid but different source-sample database projection", () => {
  const published = sourceManifest();
  const changedPayload = {
    ...published,
    samples: [{
      ...published.samples[0]!,
      digest: "b".repeat(64),
    }],
  };
  const { manifestDigest: _manifestDigest, ...unsigned } = changedPayload;
  const projected = {
    ...changedPayload,
    manifestDigest: createDvdSourceSampleManifestDigest(unsigned),
  };

  expect(() => assertDvdSourceSampleManifestProjection(
    published,
    projected,
  )).toThrow("conflicts with publication evidence");
});

it("requires every durable finding to bind to the next manifest reference", () => {
  const manifest = sourceManifest();
  expect(() => validateDvdDiscVerificationFindings(manifest, [{
    ...manifest.samples[0]!,
    startLba: manifest.samples[0]!.startLba + 1,
    outcome: "match",
    referenceDigest: manifest.samples[0]!.digest,
    observedDigest: manifest.samples[0]!.digest,
    diagnostic: null,
  }])).toThrow("does not match its source reference");
});

it.each([0x71, 0x73])(
  "accepts deferred sense response %#x as durable unknown evidence",
  (senseResponseCode) => {
    const manifest = sourceManifest();
    expect(() => validateDvdDiscVerificationFindings(manifest, [{
      ...manifest.samples[0]!,
      outcome: "unreadable",
      referenceDigest: manifest.samples[0]!.digest,
      observedDigest: null,
      diagnostic: {
        category: "unknown",
        classifierVersion: "scsi-read-classifier-v2",
        scsiStatus: 2,
        hostStatus: 0,
        driverStatus: 8,
        senseResponseCode,
        senseKey: 3,
        asc: 0x11,
        ascq: 0,
        informationLba: manifest.samples[0]!.startLba,
      },
    }])).not.toThrow();
  },
);

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
    manifestUnavailable: false,
    coverageComplete: false,
    budgetExhausted: false,
    interrupted: false,
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
