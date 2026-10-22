import { expect, it, vi } from "vitest";
import {
  createDvdSourceSampleDigest,
  createDvdSourceSampleManifestDigest,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
  DVD_SOURCE_SAMPLE_SECTOR_COUNT,
  DVD_SOURCE_VERIFICATION_POLICY_VERSION,
  type DvdDiscVerificationDiagnostic,
  type DvdSourceSampleManifest,
  type DvdSourceSampleReference,
} from "@rip-dvd/data-access";

import {
  verifyInsertedDvdAgainstSamples,
  type DvdVerificationSourceReader,
  type DvdVerificationSourceRead,
} from "./dvd-disc-verifier.js";

const metadataFingerprint = `dvdmeta-sha256:${"a".repeat(64)}`;
const diagnostic: DvdDiscVerificationDiagnostic = {
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
};

function sampleBytes(index: number): Buffer {
  const bytes = Buffer.alloc(DVD_SOURCE_SAMPLE_BYTE_COUNT, index);
  bytes[bytes.length - 1] = index + 1;
  return bytes;
}

function manifest(count = DVD_SOURCE_SAMPLE_BAND_COUNT): DvdSourceSampleManifest {
  const samples: DvdSourceSampleReference[] = Array.from(
    { length: count }, (_, bandIndex) => ({
      bandIndex,
      startLba: bandIndex * 64,
      sectorCount: DVD_SOURCE_SAMPLE_SECTOR_COUNT,
      digest: createDvdSourceSampleDigest(sampleBytes(bandIndex)),
    }),
  );
  const payload = {
    policyVersion: DVD_SOURCE_VERIFICATION_POLICY_VERSION,
    byteRepresentation: DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
    sourceMetadataFingerprint: metadataFingerprint,
    acceptedEndLbaExclusive: 1_024,
    checkpointRevision: 1,
    checkpointDigest: "b".repeat(64),
    samples,
  } as const;
  return {
    ...payload,
    manifestDigest: createDvdSourceSampleManifestDigest(payload),
  };
}

function reader(
  read: (index: number) => DvdVerificationSourceRead,
) {
  const run = vi.fn(async ({ startLba }:
    Parameters<DvdVerificationSourceReader["read"]>[0]) =>
      read(startLba / 64));
  return { reader: { read: run }, run };
}

it("matches all sixteen bounded raw-sector samples", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(),
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc",
    reader: source.reader,
    startedAtMs: 0,
    now: () => 1,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "match",
    reasons: [],
    budgetExhausted: false,
  });
  expect(result.findings).toHaveLength(16);
  expect(source.run).toHaveBeenCalledTimes(16);
  expect(source.run.mock.calls.every(([input]) => input.sectorCount === 32))
    .toBe(true);
});

it("detects changed bytes despite equal metadata", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: index === 5 ? sampleBytes(55) : sampleBytes(index),
  }));
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0, now: () => 1, insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "mismatch",
    reasons: ["DISC_SAMPLE_MISMATCH"],
  });
  expect(result.findings[5]).toMatchObject({ outcome: "mismatch" });
});

it("keeps incomplete sampling coverage inconclusive", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(15), observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0, now: () => 1, insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: ["DISC_SAMPLE_COVERAGE_INCOMPLETE"],
  });
});

it("retains structured transport diagnostics as inconclusive evidence", async () => {
  const source = reader((index) => index === 2
    ? { outcome: "unreadable", diagnostic }
    : { outcome: "readable", bytes: sampleBytes(index) });
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0, now: () => 1, insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: ["DISC_SAMPLE_UNREADABLE"],
  });
  expect(result.findings[2]).toMatchObject({
    outcome: "unreadable",
    diagnostic: { category: "transport_error", hostStatus: 7 },
  });
});

it("starts no new source read once the sixty-second budget is exhausted", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  let clock = 0;
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0,
    now: () => {
      clock += 30_000;
      return clock;
    },
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: ["DISC_VERIFICATION_TIMEOUT"],
    budgetExhausted: true,
  });
  expect(source.run).toHaveBeenCalledTimes(1);
});

it("stops after removal and invalidates a previously readable sample", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  let checks = 0;
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0, now: () => 1,
    insertionIsCurrent: () => {
      checks += 1;
      return checks < 2;
    },
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: ["DISC_INSERTION_CHANGED"],
  });
  expect(source.run).toHaveBeenCalledTimes(1);
});

it("stops after a checkpoint change and makes the result stale", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  let checks = 0;
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0, now: () => 1,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => {
      checks += 1;
      return checks < 2;
    },
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: ["DISC_CHECKPOINT_CHANGED"],
  });
  expect(source.run).toHaveBeenCalledTimes(1);
});
