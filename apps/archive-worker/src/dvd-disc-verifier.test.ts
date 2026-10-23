import { expect, it, vi } from "vitest";
import {
  createDvdSourceSampleDigest,
  createDvdSourceSampleManifestDigest,
  DVD_SOURCE_SAMPLE_BAND_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_COUNT,
  DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION,
  DVD_SOURCE_SAMPLE_SECTOR_COUNT,
  DVD_DISC_VERIFICATION_POLICY_VERSION,
  type DvdDiscVerificationDiagnostic,
  type DvdSourceSampleManifest,
  type DvdSourceSampleReference,
} from "@rip-dvd/data-access";

import {
  createNodeDvdRecoverySourceReader,
  parseDvdVerificationReadFailureProtocol,
  verifyInsertedDvdAgainstSamples,
  type DvdSourceRead,
  type DvdVerificationSourceReader,
} from "./dvd-disc-verifier.js";
import type {
  BoundedRawCommandProcessCompletion,
  StartNodeAuthorizedBoundedCommandProcessOptions,
} from "./bounded-child-process.js";

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
const deviceIdentity = {
  devicePath: "/dev/synthetic-disc",
  deviceId: "1",
  inode: "2",
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
    policyVersion: DVD_DISC_VERIFICATION_POLICY_VERSION,
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
  read: (index: number) => DvdSourceRead,
) {
  const run = vi.fn(({ startLba }:
    Parameters<DvdVerificationSourceReader["start"]>[0]) => ({
      result: Promise.resolve(read(startLba / 64)),
      closed: Promise.resolve(),
      cancel: vi.fn(),
      deviceIdentity,
      ready: Promise.resolve(),
      authorize: vi.fn(),
    }));
  return { reader: { start: run }, run };
}

it("binds a recovery helper read to the inherited device descriptor", async () => {
  let launched: StartNodeAuthorizedBoundedCommandProcessOptions | undefined;
  const bytes = Buffer.alloc(2_048, 0x4f);
  const startProcess = vi.fn((
    options: StartNodeAuthorizedBoundedCommandProcessOptions,
  ) => {
    launched = options;
    let resolveResult!: (value: {
      exitCode: number;
      signal: null;
      stderr: Buffer;
      stdout: Buffer;
    }) => void;
    return {
      result: new Promise<BoundedRawCommandProcessCompletion>((resolve) => {
        resolveResult = resolve;
      }),
      closed: Promise.resolve(),
      cancel: vi.fn(),
      ready: Promise.resolve(),
      authorize: vi.fn(() => resolveResult({
        exitCode: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: bytes,
      })),
    };
  });
  const active = createNodeDvdRecoverySourceReader({ startProcess }).start({
    devicePath: "/dev/null",
    startLba: 0,
    sectorCount: 1,
    acceptedEndLbaExclusive: 1,
  });

  expect(launched?.arguments_.slice(5, 9)).toEqual([
    "/proc/self/fd/3",
    "rip-dvd-dvdcss-reader",
    "recover-sector-v1",
    "/proc/self/fd/3",
  ]);
  expect(launched?.extraFileDescriptors).toEqual([expect.any(Number)]);
  expect(launched).toMatchObject({
    authorizationPayload: "1",
    authorizationReadyMessage: "rip-dvd-source-read-authorization-ready\n",
  });
  await active.ready;
  active.authorize();
  await expect(active.result).resolves.toEqual({ outcome: "readable", bytes });
});

it("matches all sixteen bounded raw-sector samples", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(),
    sourceMetadataFingerprint: metadataFingerprint,
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
    manifest: manifest(), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
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
    manifest: manifest(15), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0, now: () => 1, insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: ["DISC_SAMPLE_COVERAGE_INCOMPLETE"],
  });
});

it("keeps a metadata mismatch visible when the sample manifest is missing", async () => {
  const source = reader(() => {
    throw new Error("no source read expected");
  });
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: null,
    sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: `dvdmeta-sha256:${"b".repeat(64)}`,
    devicePath: "/dev/synthetic-disc",
    reader: source.reader,
    startedAtMs: 0,
    now: () => 1,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "mismatch",
    reasons: [
      "DISC_METADATA_MISMATCH",
      "DISC_SAMPLE_MANIFEST_UNAVAILABLE",
    ],
  });
  expect(source.run).not.toHaveBeenCalled();
});

it("retains structured transport diagnostics as inconclusive evidence", async () => {
  const source = reader((index) => index === 2
    ? { outcome: "unreadable", diagnostic }
    : { outcome: "readable", bytes: sampleBytes(index) });
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
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
    manifest: manifest(), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0,
    now: () => 0,
    monotonicNow: () => {
      clock += 30_000;
      return clock;
    },
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_VERIFICATION_TIMEOUT",
    ],
    budgetExhausted: true,
  });
  expect(source.run).toHaveBeenCalledTimes(1);
});

it("rechecks the deadline after asynchronous read authorization", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  let clock = 0;
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc", reader: source.reader,
    startedAtMs: 0,
    now: () => 0,
    monotonicNow: () => clock,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
    async authorizeRead() {
      clock = 60_000;
      return true;
    },
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_VERIFICATION_TIMEOUT",
    ],
    budgetExhausted: true,
  });
  expect(source.run).not.toHaveBeenCalled();
});

it("passes an integer timeout when the monotonic clock is fractional", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  const monotonicNow = vi.fn()
    .mockReturnValueOnce(0.25)
    .mockReturnValue(0.75);

  await verifyInsertedDvdAgainstSamples({
    manifest: manifest(1),
    sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc",
    reader: source.reader,
    startedAtMs: 0,
    now: () => 0,
    monotonicNow,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(source.run).toHaveBeenCalledOnce();
  expect(source.run.mock.calls[0]?.[0].timeoutMs).toBe(59_999);
});

it("does not extend the read budget when wall time moves backward", async () => {
  let wallClock = 30_000;
  let monotonicClock = 0;
  const source = reader((index) => {
    wallClock = -30_000;
    monotonicClock = 30_000;
    return {
      outcome: "readable",
      bytes: sampleBytes(index),
    };
  });
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(),
    sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc",
    reader: source.reader,
    startedAtMs: 0,
    now: () => wallClock,
    monotonicNow: () => monotonicClock,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_VERIFICATION_TIMEOUT",
    ],
    budgetExhausted: true,
  });
  expect(source.run).toHaveBeenCalledTimes(1);
});

it("cancels a hung read at the deadline and waits for quiescence", async () => {
  vi.useFakeTimers();
  try {
    let closeRead!: () => void;
    let quiescent = false;
    const cancel = vi.fn(() => {
      quiescent = true;
      closeRead();
    });
    const source: DvdVerificationSourceReader = {
      start: vi.fn(() => ({
        result: new Promise<DvdSourceRead>(() => {}),
        closed: new Promise<void>((resolve) => {
          closeRead = resolve;
        }),
        cancel,
        deviceIdentity,
        ready: Promise.resolve(),
        authorize: vi.fn(),
      })),
    };
    const verification = verifyInsertedDvdAgainstSamples({
      manifest: manifest(),
      sourceMetadataFingerprint: metadataFingerprint,
      observedMetadataFingerprint: metadataFingerprint,
      devicePath: "/dev/synthetic-disc",
      reader: source,
      startedAtMs: 0,
      now: () => 0,
      insertionIsCurrent: () => true,
      checkpointIsCurrent: () => true,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await verification;

    expect(cancel).toHaveBeenCalledOnce();
    expect(quiescent).toBe(true);
    expect(result).toMatchObject({
      outcome: "inconclusive",
      budgetExhausted: true,
      reasons: [
        "DISC_SAMPLE_COVERAGE_INCOMPLETE",
        "DISC_VERIFICATION_TIMEOUT",
      ],
    });
  } finally {
    vi.useRealTimers();
  }
});

it("cancels a hung read on worker shutdown and waits for quiescence", async () => {
  let closeRead!: () => void;
  let quiescent = false;
  const cancel = vi.fn(() => {
    quiescent = true;
    closeRead();
  });
  const source: DvdVerificationSourceReader = {
    start: vi.fn(() => ({
      result: new Promise<DvdSourceRead>(() => {}),
      closed: new Promise<void>((resolve) => {
        closeRead = resolve;
      }),
      cancel,
      deviceIdentity,
      ready: Promise.resolve(),
      authorize: vi.fn(),
    })),
  };
  const controller = new AbortController();
  const verification = verifyInsertedDvdAgainstSamples({
    manifest: manifest(),
    sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc",
    reader: source,
    startedAtMs: 0,
    now: () => 0,
    signal: controller.signal,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
  });
  await Promise.resolve();
  controller.abort(new Error("synthetic worker shutdown"));
  const result = await verification;

  expect(cancel).toHaveBeenCalledOnce();
  expect(quiescent).toBe(true);
  expect(result).toMatchObject({
    outcome: "inconclusive",
    interrupted: true,
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_VERIFICATION_INTERRUPTED",
    ],
  });
});

it.each([0x71, 0x73])(
  "retains deferred sense response %#x as an unknown diagnostic",
  (senseResponseCode) => {
    const parsed = parseDvdVerificationReadFailureProtocol(JSON.stringify({
      protocolVersion: 1,
      category: "unknown",
      classifierVersion: "scsi-read-classifier-v2",
      scsiStatus: 2,
      hostStatus: 0,
      driverStatus: 8,
      senseResponseCode,
      senseKey: 3,
      asc: 0x11,
      ascq: 0,
      informationLba: 64,
      requestedLba: 64,
      requestedBlockCount: 32,
      retryOrdinal: 0,
    }), {
      startLba: 64,
      sectorCount: 32,
      acceptedEndLbaExclusive: 1_024,
    });

    expect(parsed).toMatchObject({
      category: "unknown",
      senseResponseCode,
      senseKey: 3,
      asc: 0x11,
      ascq: 0,
    });
  },
);

it("stops after removal and invalidates a previously readable sample", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  let checks = 0;
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
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
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_INSERTION_CHANGED",
    ],
  });
  expect(source.run).toHaveBeenCalledTimes(1);
  expect(result.findings).toEqual([]);
});

it("discards a sample when the live media generation changes during its read", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  const insertionIsCurrent = vi.fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);

  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(),
    sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc",
    reader: source.reader,
    startedAtMs: 0,
    now: () => 1,
    insertionIsCurrent,
    checkpointIsCurrent: () => true,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_INSERTION_CHANGED",
    ],
    insertionChanged: true,
  });
  expect(source.run).toHaveBeenCalledOnce();
  expect(result.findings).toEqual([]);
});

it("stops after a checkpoint change and makes the result stale", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  let checks = 0;
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(), sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
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
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_CHECKPOINT_CHANGED",
    ],
  });
  expect(source.run).toHaveBeenCalledTimes(1);
  expect(result.findings).toEqual([]);
});

it("persists each completed finding and starts no read after interruption", async () => {
  const source = reader((index) => ({
    outcome: "readable",
    bytes: sampleBytes(index),
  }));
  const authorizeRead = vi.fn()
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  const recordFinding = vi.fn();
  const result = await verifyInsertedDvdAgainstSamples({
    manifest: manifest(),
    sourceMetadataFingerprint: metadataFingerprint,
    observedMetadataFingerprint: metadataFingerprint,
    devicePath: "/dev/synthetic-disc",
    reader: source.reader,
    startedAtMs: 0,
    now: () => 1,
    insertionIsCurrent: () => true,
    checkpointIsCurrent: () => true,
    authorizeRead,
    recordFinding,
  });

  expect(result).toMatchObject({
    outcome: "inconclusive",
    reasons: [
      "DISC_SAMPLE_COVERAGE_INCOMPLETE",
      "DISC_VERIFICATION_INTERRUPTED",
    ],
    interrupted: true,
  });
  expect(source.run).toHaveBeenCalledTimes(1);
  expect(recordFinding).toHaveBeenCalledOnce();
  expect(recordFinding).toHaveBeenCalledWith(result.findings[0]);
});
