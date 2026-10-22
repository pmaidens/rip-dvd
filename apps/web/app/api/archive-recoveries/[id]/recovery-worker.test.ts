import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DvdDiscVerificationDiagnostic,
  DvdRecoveryWriteAuthority,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { seedDvdDiscVerificationFixture } from "../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import type { DvdRecoveryAtomicWriter } from "../../../../../archive-worker/src/dvd-recovery-batch.js";
import type { DvdRecoverySourceReader } from "../../../../../archive-worker/src/dvd-disc-verifier.js";
import { pollDvdRecoveryPass } from "../../../../../archive-worker/src/dvd-recovery-worker.js";
import type { reconcileDvdRecoveryCheckpoint } from "../../../../../archive-worker/src/dvd-recovery-reconciliation.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

afterEach(() => {
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

const syntheticAtomicWriter: DvdRecoveryAtomicWriter = {
  inspect() {
    return {
      contract: "linux-rwf-atomic-v1",
      unitBytes: 4_096,
      memoryAlignmentBytes: 4_096,
    };
  },
  write({ imagePath, startByte, bytes, unitBytes }) {
    const descriptor = openSync(imagePath, "r+");
    try {
      const bytesWritten = writeSync(
        descriptor,
        bytes,
        0,
        bytes.length,
        startByte,
      );
      fsyncSync(descriptor);
      return { bytesWritten, unitBytes };
    } finally {
      closeSync(descriptor);
    }
  },
  restoreVersion({ imagePath, mtimeNs }) {
    const current = lstatSync(imagePath, { bigint: true });
    utimesSync(
      imagePath,
      Number(current.atimeNs) / 1_000_000_000,
      Number(BigInt(mtimeNs)) / 1_000_000_000,
    );
    return {
      mtimeNs: lstatSync(imagePath, { bigint: true }).mtimeNs.toString(),
    };
  },
};

const mediumError: DvdDiscVerificationDiagnostic = {
  category: "medium_error",
  classifierVersion: "scsi-read-classifier-v2",
  scsiStatus: 2,
  hostStatus: 0,
  driverStatus: 8,
  senseResponseCode: 0x70,
  senseKey: 3,
  asc: 0x11,
  ascq: 0,
  informationLba: null,
};

const transportError: DvdDiscVerificationDiagnostic = {
  ...mediumError,
  category: "transport_error",
  senseKey: null,
  asc: null,
  ascq: null,
};

async function completeVerification(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  seeded: Awaited<ReturnType<typeof seedDvdDiscVerificationFixture>>,
): Promise<DvdRecoveryWriteAuthority> {
  const result = await fixture.run([
    "archive-recovery",
    "verify-disc",
    seeded.recoveryId,
    "--key",
    "00000000-0000-4000-8000-000000000450",
    "--disc-inspection-id",
    seeded.inspection.id,
    "--checkpoint-revision",
    "1",
    "--checkpoint-digest",
    seeded.manifest.manifestDigest,
  ]);
  expect(result.exitCode).toBe(0);
  const access = fixture.openAccess();
  try {
    const claim = access.dvdDiscVerifications.claimNext(
      "synthetic-verification-worker",
    )!;
    const findings = seeded.sampleManifest.samples.map((sample) => ({
      ...sample,
      outcome: "match" as const,
      referenceDigest: sample.digest,
      observedDigest: sample.digest,
      diagnostic: null,
    }));
    for (const finding of findings) {
      access.dvdDiscVerifications.appendFinding(claim, finding);
    }
    const verification = access.dvdDiscVerifications.complete(claim, {
      findings,
      budgetExhausted: false,
      interrupted: false,
      insertionChanged: false,
      checkpointChanged: false,
    });
    return {
      verificationId: verification.id,
      archiveRecoveryId: verification.archiveRecoveryId,
      originalDiscArchiveId: verification.originalDiscArchiveId,
      discInspectionId: verification.discInspectionId,
      detectedDiscId: verification.detectedDiscId,
      mediaGeneration: verification.mediaGeneration,
      verificationWorkerExecutionId: verification.workerExecutionId!,
      checkpointRevision: verification.checkpointRevision,
      checkpointDigest: verification.checkpointDigest,
    };
  } finally {
    access.close();
  }
}

function immediateReader(
  read: (startLba: number) =>
    | { outcome: "readable"; bytes: Buffer }
    | { outcome: "unreadable"; diagnostic: DvdDiscVerificationDiagnostic },
) {
  const start = vi.fn((input:
    Parameters<DvdRecoverySourceReader["start"]>[0]) => ({
      result: Promise.resolve(read(input.startLba)),
      closed: Promise.resolve(),
      cancel: vi.fn(),
    }));
  return { reader: { start }, start };
}

function pollInput(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  reader: DvdRecoverySourceReader,
) {
  return {
    access: fixture.openAccess(),
    atomicWriter: syntheticAtomicWriter,
    deviceInactivity: {
      async withDeviceInactive(
        _devicePath: string,
        mutation: () => void | Promise<void>,
      ) {
        await mutation();
      },
    },
    mediaGenerationObserver: {
      async observe() {
        return "synthetic-verification-generation";
      },
    },
    originalsLibraryPath: fixture.originalsLibraryPath,
    reader,
    workerExecutionId: "synthetic-recovery-worker",
  };
}

it("narrows a skipped region sector by sector and preserves recovered positions", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 3,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const before = readFileSync(seeded.archive.archivePath);
  const source = immediateReader((startLba) => startLba === 101
    ? { outcome: "unreadable", diagnostic: mediumError }
    : { outcome: "readable", bytes: Buffer.alloc(2_048, startLba) });
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(
      source.start.mock.calls.map(([read]) => read.startLba),
      JSON.stringify(
        input.access.catalog.findArchiveRecoveryById(seeded.recoveryId),
      ),
    )
      .toEqual([100, 101, 102]);
    expect(source.start.mock.calls.every(([read]) =>
      read.timeoutMs === undefined
    )).toBe(true);
    const checkpoint = await input.access.readDvdCheckpoint(
      seeded.archive.id,
      (await import("@rip-dvd/worker-runtime")).defaultArchiveImageOwnership,
    );
    expect(checkpoint?.unrecoveredSourceRanges).toEqual([{
      startLba: 101,
      sectorCount: 1,
      classification: "individually_failed",
    }]);
    const after = readFileSync(seeded.archive.archivePath);
    expect(after.subarray(100 * 2_048, 101 * 2_048))
      .toEqual(Buffer.alloc(2_048, 100));
    expect(after.subarray(101 * 2_048, 102 * 2_048))
      .toEqual(before.subarray(101 * 2_048, 102 * 2_048));
    expect(after.subarray(102 * 2_048, 103 * 2_048))
      .toEqual(Buffer.alloc(2_048, 102));
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible", work: null });
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible", faultCode: null, work: null });
  } finally {
    input.access.close();
  }
}, 20_000);

it("does not start a source read when Stop commits during insertion observation", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048),
  }));
  const input = pollInput(fixture, source.reader);
  let finishObservation!: (generation: string) => void;
  const observation = new Promise<string>((resolve) => {
    finishObservation = resolve;
  });
  const observe = vi.fn(() => observation);
  input.mediaGenerationObserver.observe = observe;
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    const polling = pollDvdRecoveryPass({ ...input, reconcile });
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000453",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    finishObservation("synthetic-verification-generation");

    await polling;
    expect(source.start).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    input.access.close();
  }
});

it("finishes a fully recovered pass without rewriting the successful Archive Job", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 150,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x5a),
  }));
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "completed", work: null });
    expect(input.access.archiveJobs.listForArchive(seeded.archive.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "completed" }),
      ]));
  } finally {
    input.access.close();
  }
});

it("keeps Stop durable until a blocked source command is reaped", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 200,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  let closeRead!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeRead = resolve;
  });
  const cancel = vi.fn();
  const start = vi.fn(() => ({
    result: new Promise<never>(() => {}),
    closed,
    cancel,
  }));
  const input = pollInput(fixture, { start });
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    const polling = pollDvdRecoveryPass({
      ...input,
      reconcile,
      stopPollIntervalMs: 1,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000451",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopping" });
    expect(reconcile).not.toHaveBeenCalled();
    closeRead();
    await polling;
    expect(start).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    const inspected = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    expect(inspected.result).toMatchObject({
      item: {
        status: "stopped",
        recoveryStatus: "stopped",
        availableActions: expect.arrayContaining([
          expect.objectContaining({
            name: "stop",
            eligible: false,
            reason: "Archive Recovery is already stopped.",
          }),
        ]),
      },
    });
    const waited = await fixture.run([
      "wait",
      "archive-recoveries",
      seeded.recoveryId,
      "--timeout-ms",
      "0",
    ]);
    expect(waited.result).toMatchObject({
      outcome: "settled",
      current: { status: "stopped" },
    });
  } finally {
    input.access.close();
  }
}, 20_000);

it("finishes a durable Stop after a worker restart without another read", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 900,
    sectorCount: 1,
    classification: "skipped_untested",
  }], "/dev/synthetic-recovery-drive");
  const authority = await completeVerification(fixture, seeded);
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  const withDeviceInactive = vi.fn(async (
    _devicePath: string,
    mutation: () => void | Promise<void>,
  ) => {
    await mutation();
  });
  input.deviceInactivity.withDeviceInactive = withDeviceInactive;
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    const requested = input.access.archiveRecoveryWork.request(
      seeded.recoveryId,
    );
    const claim = input.access.archiveRecoveryWork.claim(
      requested.archiveRecoveryId,
      "interrupted-recovery-worker",
    );
    input.access.archiveRecoveryWork.bindVerification(claim, authority);
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000452",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(source.start).not.toHaveBeenCalled();
    expect(withDeviceInactive).toHaveBeenCalledWith(
      seeded.verificationDrive.devicePath,
      expect.any(Function),
    );
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    input.access.close();
  }
});

it("rejects source-read admission after Stop commits", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const authority = await completeVerification(fixture, seeded);
  const access = fixture.openAccess();
  const start = vi.fn();
  try {
    const claim = access.archiveRecoveryWork.claim(
      access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
      "synthetic-stopped-recovery-worker",
    );
    access.archiveRecoveryWork.bindVerification(claim, authority);
    access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000455",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(() => access.archiveRecoveryWork.admitSourceRead(claim, start))
      .toThrow();
    expect(start).not.toHaveBeenCalled();
  } finally {
    access.close();
  }
});

it("records a synchronous source-start failure as a read fault", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const start = vi.fn(() => {
    throw new Error("Synthetic source vanished before process start");
  });
  const input = pollInput(fixture, { start });
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "SOURCE_READ_FAILED",
      });
  } finally {
    input.access.close();
  }
});

it("keeps a transport fault out of source evidence and preserves the Archive Job", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "unreadable",
    diagnostic: transportError,
  }));
  const input = pollInput(fixture, source.reader);
  try {
    const headerBefore = input.access.catalog.findDvdArchiveEvidenceHeader(
      seeded.archive.id,
    );
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    const recovery = input.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    );
    expect(recovery).toMatchObject({
      status: "faulted",
      faultCode: "SOURCE_TRANSPORT_ERROR",
      work: null,
    });
    expect(input.access.catalog.findDvdArchiveEvidenceHeader(seeded.archive.id))
      .toEqual(headerBefore);
    expect(input.access.archiveJobs.listForArchive(seeded.archive.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "completed" }),
      ]));
  } finally {
    input.access.close();
  }
});

it.each([
  "WRITER_NOT_QUIESCENT",
  "CONSISTENCY_FAULT",
] as const)("retains the recovery reservation for ownership fault %s", async (
  faultCode,
) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x5a),
  }));
  const input = pollInput(fixture, source.reader);
  const withWriter = vi.fn(async () => {
    throw new ArchiveImageOwnershipError(faultCode);
  });
  const archiveImageOwnership: ArchiveImageOwnership = {
    ...defaultArchiveImageOwnership,
    withWriter,
  };
  try {
    expect(await pollDvdRecoveryPass({
      ...input,
      archiveImageOwnership,
    })).toBe(true);
    expect(withWriter).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode,
        work: expect.objectContaining({ status: "claimed" }),
      });
  } finally {
    input.access.close();
  }
});

it("preserves a Stop that wins the race with fault recording", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const authority = await completeVerification(fixture, seeded);
  const access = fixture.openAccess();
  try {
    const claim = access.archiveRecoveryWork.claim(
      access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
      "synthetic-racing-recovery-worker",
    );
    access.archiveRecoveryWork.bindVerification(claim, authority);
    access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000454",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    access.archiveRecoveryWork.markFault({
      claim,
      faultCode: "SOURCE_TRANSPORT_ERROR",
      retainWork: false,
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "stopping",
        faultCode: null,
        work: expect.objectContaining({
          claimToken: claim.claimToken,
          status: "claimed",
        }),
      });
  } finally {
    access.close();
  }
});

it("records a changed insertion separately without starting a source read", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048),
  }));
  const input = pollInput(fixture, source.reader);
  input.mediaGenerationObserver.observe = async () =>
    "changed-media-generation";
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "SOURCE_CHANGED",
        work: null,
      });
  } finally {
    input.access.close();
  }
});
