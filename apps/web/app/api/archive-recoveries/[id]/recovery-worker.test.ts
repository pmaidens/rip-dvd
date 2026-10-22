import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  dvdRecoveryWriteAuthority,
  type ArchiveRecoveryAttemptId,
  type DvdDiscVerificationDiagnostic,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { seedDvdDiscVerificationFixture } from "../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import type { DvdRecoveryAtomicWriter } from "../../../../../archive-worker/src/dvd-recovery-batch.js";
import {
  pollDvdDiscVerification,
  type DvdRecoverySourceReader,
} from "../../../../../archive-worker/src/dvd-disc-verifier.js";
import { pollDvdRecoveryPass } from "../../../../../archive-worker/src/dvd-recovery-worker.js";
import {
  DvdRecoveryReconciliationFault,
  type reconcileDvdRecoveryCheckpoint,
} from "../../../../../archive-worker/src/dvd-recovery-reconciliation.js";

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
  mutationKey = "00000000-0000-4000-8000-000000000450",
) {
  const current = fixture.openAccess();
  const checkpoint = current.catalog.findDvdArchiveEvidenceHeader(
    seeded.archive.id,
  )!;
  current.close();
  const result = await fixture.run([
    "archive-recovery",
    "verify-disc",
    seeded.recoveryId,
    "--key",
    mutationKey,
    "--disc-inspection-id",
    seeded.inspection.id,
    "--checkpoint-revision",
    String(checkpoint.currentManifestRevision),
    "--checkpoint-digest",
    checkpoint.currentManifestDigest,
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
    const authority = dvdRecoveryWriteAuthority(verification);
    if (authority === null) throw new Error("Expected DVD Recovery authority");
    return authority;
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

it("persists repeated tolerable evidence across separately verified passes", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 175,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "unreadable",
    diagnostic: mediumError,
  }));
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    await completeVerification(
      fixture,
      seeded,
      "00000000-0000-4000-8000-000000000460",
    );
    expect(await pollDvdRecoveryPass(input)).toBe(true);

    const checkpoint = await input.access.readDvdCheckpoint(
      seeded.archive.id,
      defaultArchiveImageOwnership,
    );
    expect(checkpoint).toMatchObject({
      revision: 3,
      recoveryRead: { startLba: 175, outcome: "failed" },
      unrecoveredSourceRanges: [{
        startLba: 175,
        sectorCount: 1,
        classification: "individually_failed",
      }],
    });
    expect(source.start).toHaveBeenCalledTimes(2);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible", faultCode: null, work: null });
  } finally {
    input.access.close();
  }
}, 20_000);

it("requires a fresh verification after the Recovery attempt rotates", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 176,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const nextAttempt =
    "synthetic-next-recovery-attempt" as ArchiveRecoveryAttemptId;
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    attempt_id = ?, attempt_ordinal = 2, updated_at = updated_at + 1
    WHERE id = ?`).run(nextAttempt, seeded.recoveryId);
  database.close();
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x61),
  }));
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();

    await completeVerification(
      fixture,
      seeded,
      "00000000-0000-4000-8000-000000000461",
    );
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        attemptId: nextAttempt,
        status: "completed",
        faultCode: null,
        work: null,
      });
  } finally {
    input.access.close();
  }
}, 20_000);

it("leaves no claim when the latest verification cannot authorize a pass", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 177,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const submitted = await fixture.run([
    "archive-recovery",
    "verify-disc",
    seeded.recoveryId,
    "--key",
    "00000000-0000-4000-8000-000000000462",
    "--disc-inspection-id",
    seeded.inspection.id,
    "--checkpoint-revision",
    "1",
    "--checkpoint-digest",
    seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const access = fixture.openAccess();
  const later = access.dvdDiscVerifications.claimNext(
    "synthetic-stale-verification-worker",
  );
  if (later === null) throw new Error("Expected later verification");
  access.dvdDiscVerifications.fail(later);
  access.close();
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x62),
  }));

  const firstPoll = pollInput(fixture, source.reader);
  expect(await pollDvdRecoveryPass(firstPoll)).toBe(false);
  expect(firstPoll.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
    .toMatchObject({ status: "eligible", work: null });
  firstPoll.access.close();

  const restartedPoll = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(restartedPoll)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect(restartedPoll.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({ status: "eligible", work: null });
  } finally {
    restartedPoll.access.close();
  }
}, 20_000);

it("does not admit a pass while reconciliation remains unresolved", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 178,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x63),
  }));
  const input = pollInput(fixture, source.reader);
  try {
    input.access.dvdRecoveryReconciliations.submit({
      mutationKey: "00000000-0000-4000-8000-000000000463",
      archiveRecoveryId: seeded.recoveryId,
    });
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    const reconciliation = input.access.dvdRecoveryReconciliations.claimNext(
      "synthetic-blocking-reconciliation-worker",
    );
    if (reconciliation === null) {
      throw new Error("Expected reconciliation claim");
    }
    input.access.dvdRecoveryReconciliations.fail(
      reconciliation,
      "CONSISTENCY_FAULT",
    );
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible", work: null });
  } finally {
    input.access.close();
  }
});

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

it("faults an unreconcilable Stop so it cannot poison the stopping queue", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 901,
    sectorCount: 1,
    classification: "skipped_untested",
  }], "/dev/synthetic-recovery-drive");
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  const reconcile = vi.fn(async () => {
    throw new DvdRecoveryReconciliationFault("STORAGE_UNSUPPORTED");
  }) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000466",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "STORAGE_UNSUPPORTED",
        stopOperationId: null,
        stopRequestedAt: null,
        stoppedAt: null,
      });
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(source.start).not.toHaveBeenCalled();
  } finally {
    input.access.close();
  }
});

it("keeps Stop pending while archive ownership is not quiescent", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 902,
    sectorCount: 1,
    classification: "skipped_untested",
  }], "/dev/synthetic-recovery-drive");
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  const reconcile = vi.fn()
    .mockRejectedValueOnce(
      new DvdRecoveryReconciliationFault("WRITER_NOT_QUIESCENT"),
    )
    .mockResolvedValue({ outcome: "already_consistent", evidence: {} }) as
      unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    const requested = input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000468",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    const deferred = input.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    );
    expect(deferred).toMatchObject({
      status: "stopping",
      stopOperationId: requested.stopOperationId,
      stopRequestedAt: requested.stopRequestedAt,
      stoppedAt: null,
      faultCode: null,
    });
    expect(deferred!.updatedAt.getTime()).toBeGreaterThan(
      requested.updatedAt.getTime(),
    );

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "stopped",
        stopOperationId: requested.stopOperationId,
        work: null,
      });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(source.start).not.toHaveBeenCalled();
  } finally {
    input.access.close();
  }
});

it("keeps Stop pending until device inactivity can be acquired", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 903,
    sectorCount: 1,
    classification: "skipped_untested",
  }], "/dev/synthetic-recovery-drive");
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  let inactivityAttempts = 0;
  input.deviceInactivity.withDeviceInactive = async (_path, mutation) => {
    inactivityAttempts += 1;
    if (inactivityAttempts === 1) {
      throw new Error("DVD archive device is still active");
    }
    await mutation();
  };
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    const requested = input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000469",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "stopping",
        stopOperationId: requested.stopOperationId,
        stopRequestedAt: requested.stopRequestedAt,
        faultCode: null,
      });
    expect(reconcile).not.toHaveBeenCalled();

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(source.start).not.toHaveBeenCalled();
  } finally {
    input.access.close();
  }
});

it("keeps Stop pending until running disc verification settles", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    [{
      startLba: 904,
      sectorCount: 1,
      classification: "skipped_untested",
    }],
    "/dev/synthetic-recovery-drive",
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000474",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const source = immediateReader(() => {
    throw new Error("No recovery read is allowed while stopping");
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
    const verificationClaim = input.access.dvdDiscVerifications.claimNext(
      "synthetic-active-verification-worker",
    );
    if (verificationClaim === null) {
      throw new Error("Expected verification claim");
    }
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000475",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopping" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(withDeviceInactive).not.toHaveBeenCalled();

    input.access.dvdDiscVerifications.fail(verificationClaim);
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(withDeviceInactive).toHaveBeenCalledWith(
      seeded.verificationDrive.devicePath,
      expect.any(Function),
    );
    expect(source.start).not.toHaveBeenCalled();
  } finally {
    input.access.close();
  }
});

it("starts no further verification read after Stop commits", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    "/dev/synthetic-verification-stop-drive",
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000476",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  let finishRead!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const start = vi.fn(() => ({
    result: firstRead.then(() => ({
      outcome: "readable" as const,
      bytes: Buffer.alloc(32 * 2_048),
    })),
    closed: firstRead,
    cancel: vi.fn(),
  }));
  const access = fixture.openAccess();
  try {
    const polling = pollDvdDiscVerification({
      access,
      reader: { start },
      workerExecutionId: "synthetic-verification-stop-worker",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000477",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    finishRead();
    await expect(polling).resolves.toBe(true);

    expect(start).toHaveBeenCalledOnce();
    expect(access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )).toMatchObject({
      status: "failed",
      failureCode: "DISC_VERIFICATION_UNAVAILABLE",
    });
  } finally {
    access.close();
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
