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
import { dispatchNotifications } from "@rip-dvd/application";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDvdDiscVerificationResultDigest,
  dvdRecoveryWriteAuthority,
  DVD_RECOVERY_PASS_CLAIM_LEASE_MS,
  type ArchiveRecoveryAttemptId,
  type DvdDiscVerificationDiagnostic,
  type NotificationPayload,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { seedDvdDiscVerificationFixture } from "../../../../../operator-cli/src/dvd-disc-verification.test-support.js";
import { notificationWorkflow } from "../../../../../operator-cli/src/notification-workflow.test-support.js";
import { createOperatorWorkflowFixture } from "../../../../../operator-cli/src/operator-workflow.test-support.js";
import {
  commitDvdRecoveryBatch,
  DvdRecoveryBatchFault,
  type DvdRecoveryAtomicWriter,
} from "../../../../../archive-worker/src/dvd-recovery-batch.js";
import {
  pollDvdDiscVerification,
  type DvdRecoverySourceReader,
  type DvdVerificationSourceReader,
} from "../../../../../archive-worker/src/dvd-disc-verifier.js";
import {
  pollDvdRecoveryPass,
  runDvdRecoveryWorker,
} from "../../../../../archive-worker/src/dvd-recovery-worker.js";
import {
  DvdRecoveryReconciliationFault,
  reconcileDvdRecoveryCheckpoint,
} from "../../../../../archive-worker/src/dvd-recovery-reconciliation.js";
import { createOperationsResponse } from "../../operations/route.js";
import { handleNotifications } from "../../notifications/route.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];

const immediateDeviceInactivity = {
  async withDeviceInactive(
    _devicePath: string,
    mutation: () => void | Promise<void>,
  ) {
    await mutation();
  },
};

function syntheticDeviceIdentity(devicePath: string) {
  return { devicePath, deviceId: "2049", inode: "7" };
}

async function completeMismatchAndConfirm(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  seeded: Awaited<ReturnType<typeof seedDvdDiscVerificationFixture>>,
) {
  const current = fixture.openAccess();
  const checkpoint = current.catalog.findDvdArchiveEvidenceHeader(
    seeded.archive.id,
  )!;
  current.close();
  const submitted = await fixture.run([
    "archive-recovery",
    "verify-disc",
    seeded.recoveryId,
    "--key",
    "00000000-0000-4000-8000-000000000446",
    "--disc-inspection-id",
    seeded.inspection.id,
    "--checkpoint-revision",
    String(checkpoint.currentManifestRevision),
    "--checkpoint-digest",
    checkpoint.currentManifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const access = fixture.openAccess();
  try {
    const claim = access.dvdDiscVerifications.claimNext(
      "synthetic-recovery-worker",
    )!;
    const sample = seeded.sampleManifest.samples[0]!;
    const findings = [{
      ...sample,
      outcome: "mismatch" as const,
      referenceDigest: sample.digest,
      observedDigest: "f".repeat(64),
      diagnostic: null,
    }];
    access.dvdDiscVerifications.appendFinding(claim, findings[0]!);
    const verification = access.dvdDiscVerifications.complete(claim, {
      findings,
      budgetExhausted: false,
      interrupted: false,
      insertionChanged: false,
      checkpointChanged: false,
    });
    return access.dvdDiscConfirmations.record({
      mutationKey: "00000000-0000-4000-8000-000000000447",
      archiveRecoveryId: seeded.recoveryId,
      originalDiscArchiveId: seeded.archive.id,
      archiveRecoveryAttemptId: seeded.attemptId,
      discInspectionId: seeded.inspection.id,
      detectedDiscId: seeded.verificationDisc.id,
      mediaGeneration: "synthetic-verification-generation",
      verificationId: verification.id,
      verificationWorkerExecutionId: "synthetic-recovery-worker",
      verificationOutcome: "mismatch",
      verificationResultDigest: createDvdDiscVerificationResultDigest(
        verification,
      ),
      checkpointRevision: checkpoint.currentManifestRevision,
      checkpointDigest: checkpoint.currentManifestDigest,
      acknowledgeMixedSource: true,
    });
  } finally {
    access.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fixtures.splice(0).forEach((fixture) => fixture.dispose());
});

async function subscribeRecoveryBrowsers(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  names: string[] = [],
) {
  const workflow = await notificationWorkflow(fixture);
  for (const name of names) await workflow.register(name);
}

it("notifies every subscribed browser once after later Recovery completes, with shared CLI and HTTP detail", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await subscribeRecoveryBrowsers(fixture);
  await completeVerification(fixture, seeded);
  const input = pollInput(fixture, immediateReader(() => ({
    outcome: "readable", bytes: Buffer.alloc(2_048, 0x6a),
  })).reader);
  try {
    const initialJobs = input.access.archiveJobs.listForArchive(seeded.archive.id);
    const initialRequest = initialJobs[0]!.archiveRequestId;
    expect(initialJobs[0]!.status).toBe("completed");
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    const cli = await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId]);
    expect(cli).toMatchObject({ exitCode: 0, result: { item: { status: "completed" } } });
    expect(await createOperationsResponse(input.access, new Request(
      `https://operator.example/api/operations?kind=archive-recoveries&id=${seeded.recoveryId}`,
    ), fixture.originalsLibraryPath).json()).toEqual(cli.result);
    const deliveries = await fixture.run(["notifications", "deliveries"]);
    expect(deliveries.result).toMatchObject({ deliveries: [
      { status: "queued" }, { status: "queued" },
    ] });
    expect(await (await handleNotifications(new Request(
      "https://operator.example/api/notifications?action=deliveries",
    ), () => input.access)).json()).toEqual(deliveries.result);
    await subscribeRecoveryBrowsers(fixture, ["future"]);
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(input.access, async (_recipient, payload) => {
      sent.push(payload);
    })).toEqual({ accepted: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      label: "EXAMPLE_FILM_2020",
      body: "Archive Recovery completed. All remaining source recovered.",
      destination: `/notifications/target?kind=original-disc-archives&id=${seeded.archive.id}`,
    });
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]!.tag).toMatch(/^rip-dvd-[a-f0-9]{32}$/);
    expect(input.access.archiveJobs.listForArchive(seeded.archive.id)).toEqual(initialJobs);
    expect((await fixture.run(["inspect", "archive-requests", initialRequest])).result)
      .toMatchObject({ item: { status: "fulfilled" } });
  } finally {
    input.access.close();
  }
});

it.each([false, true])("queues a committed Recovery attention outcome, storage pause=%s, without changing the saved job", async (storageFault) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await subscribeRecoveryBrowsers(fixture);
  await completeVerification(fixture, seeded);
  const input = pollInput(fixture, immediateReader(() => ({
    outcome: "unreadable", diagnostic: transportError,
  })).reader);
  try {
    const savedJobs = input.access.archiveJobs.listForArchive(seeded.archive.id);
    if (storageFault) {
      const database = new DatabaseSync(fixture.databasePath);
      database.prepare("UPDATE detected_discs SET volume_label = NULL WHERE id = ?")
        .run(seeded.archive.detectedDiscId);
      database.close();
    }
    const run = storageFault ? {
      ...input,
      reader: immediateReader(() => ({
        outcome: "readable", bytes: Buffer.alloc(2_048, 0x6a),
      })).reader,
      async commit() {
        throw new DvdRecoveryBatchFault("IMAGE_WRITE_FAILED", {
          storageFault: true, retainRecoveryWork: true,
        });
      },
    } : input;
    expect(await pollDvdRecoveryPass(run)).toBe(true);
    expect(await pollDvdRecoveryPass(run)).toBe(false);
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: storageFault
        ? { status: "paused", pauseReason: "storage_fault", faultCode: null }
        : { status: "faulted", faultCode: "SOURCE_TRANSPORT_ERROR" } });
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(input.access, async (_recipient, payload) => {
      sent.push(payload);
      if (storageFault) throw new Error("Synthetic sender rejection");
    })).toEqual(storageFault ? { accepted: 0, failed: 2 } : { accepted: 2, failed: 0 });
    expect(sent[0]).toMatchObject({
      body: "Archive Recovery needs attention. Inspect the recovery for details.",
      label: storageFault ? "Unlabelled disc" : "EXAMPLE_FILM_2020",
      destination: `/notifications/target?kind=original-disc-archives&id=${seeded.archive.id}`,
    });
    expect(sent[1]).toEqual(sent[0]);
    expect(input.access.archiveJobs.listForArchive(seeded.archive.id)).toEqual(savedJobs);
  } finally {
    input.access.close();
  }
});

it("rolls back Recovery settlement with its notification and reconciles completion once after restart", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await subscribeRecoveryBrowsers(fixture);
  await completeVerification(fixture, seeded);
  const input = pollInput(fixture, immediateReader(() => ({
    outcome: "readable", bytes: Buffer.alloc(2_048, 0x6b),
  })).reader);
  const sqlite = new DatabaseSync(fixture.databasePath);
  try {
    sqlite.exec("CREATE TRIGGER synthetic_recovery_notification_rollback BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT, 'Synthetic rollback'); END");
    await expect(pollDvdRecoveryPass(input)).rejects.toThrow();
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "running" } });
    sqlite.exec("DROP TRIGGER synthetic_recovery_notification_rollback");
    const restarted = fixture.openAccess();
    try {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        await reconcileDvdRecoveryCheckpoint({
          access: restarted,
          originalsLibraryPath: fixture.originalsLibraryPath,
          originalDiscArchiveId: seeded.archive.id,
          atomicWriter: syntheticAtomicWriter,
        });
      }
      expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
        .toMatchObject({ item: { status: "completed" } });
      const sent: NotificationPayload[] = [];
      expect(await dispatchNotifications(restarted, async (_recipient, payload) => {
        sent.push(payload);
      })).toEqual({ accepted: 2, failed: 0 });
      expect(sent[0]!.body).toBe("Archive Recovery completed. All remaining source recovered.");
      expect(sent[1]).toEqual(sent[0]);
    } finally {
      restarted.close();
    }
  } finally {
    sqlite.close();
    input.access.close();
  }
});

it("rolls back a committed fault when its recipient snapshot cannot persist", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await subscribeRecoveryBrowsers(fixture);
  const authority = await completeVerification(fixture, seeded);
  const access = fixture.openAccess();
  const sqlite = new DatabaseSync(fixture.databasePath);
  try {
    const claim = access.archiveRecoveryWork.claim(
      access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
      "synthetic-fault-transaction-worker",
    );
    access.archiveRecoveryWork.bindVerification(claim, authority);
    const fault = () => access.archiveRecoveryWork.markFault({
      claim, faultCode: "SOURCE_TRANSPORT_ERROR", retainWork: false, storageFault: false,
    });
    sqlite.exec("CREATE TRIGGER synthetic_recovery_fault_rollback BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT, 'Synthetic rollback'); END");
    expect(fault).toThrow();
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "running", faultCode: null } });
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    sqlite.exec("DROP TRIGGER synthetic_recovery_fault_rollback");
    fault();
    expect(fault).toThrow();
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [{ status: "queued" }, { status: "queued" }] });
  } finally {
    sqlite.close();
    access.close();
  }
});

it("records a later Stop fault separately after rediscovery changes the label and another browser subscribes", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await subscribeRecoveryBrowsers(fixture);
  const authority = await completeVerification(fixture, seeded);
  const access = fixture.openAccess();
  try {
    const claim = access.archiveRecoveryWork.claim(
      access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
      "synthetic-distinct-fault-worker",
    );
    access.archiveRecoveryWork.bindVerification(claim, authority);
    access.archiveRecoveryWork.markFault({
      claim, faultCode: "IMAGE_WRITE_FAILED", retainWork: false, storageFault: true,
    });
    const sent: NotificationPayload[] = [];
    const sender = async (_recipient: unknown, payload: NotificationPayload) => { sent.push(payload); };
    expect(await dispatchNotifications(access, sender)).toEqual({ accepted: 2, failed: 0 });
    await subscribeRecoveryBrowsers(fixture, ["future"]);
    const disc = access.catalog.listDetectedDiscs(undefined, { ids: [seeded.archive.detectedDiscId] })[0]!;
    access.catalog.registerDetectedDisc({
      opticalDriveId: disc.opticalDriveId, discKind: disc.discKind,
      fingerprint: disc.fingerprint, volumeLabel: "Synthetic rediscovered disc",
    });
    const stop = access.archiveRecoveryWork.requestStop({
      mutationKey: "synthetic-distinct-fault-stop",
      archiveRecoveryId: seeded.recoveryId, attemptId: seeded.attemptId,
    });
    access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: seeded.recoveryId, attemptId: seeded.attemptId,
      stopOperationId: stop.stopOperationId!, faultCode: "CONSISTENCY_FAULT",
    });
    expect(await dispatchNotifications(access, sender)).toEqual({ accepted: 3, failed: 0 });
    expect(sent[2]).toMatchObject({
      label: "Synthetic rediscovered disc",
      body: "Archive Recovery needs attention. Inspect the recovery for details.",
    });
    expect(sent[2]!.tag).not.toBe(sent[0]!.tag);
    expect(sent[3]).toEqual(sent[2]);
    expect(sent[4]).toEqual(sent[2]);
  } finally {
    access.close();
  }
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
  return completeQueuedVerification(fixture, seeded);
}

function completeQueuedVerification(
  fixture: ReturnType<typeof createOperatorWorkflowFixture>,
  seeded: Awaited<ReturnType<typeof seedDvdDiscVerificationFixture>>,
) {
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

function rewriteStopReceiptAsLegacy(databasePath: string, mutationKey: string) {
  const database = new DatabaseSync(databasePath);
  const stored = database.prepare(
    "SELECT outcome FROM mutation_invocations WHERE key = ?",
  ).get(mutationKey) as { outcome: string };
  const legacy = JSON.parse(stored.outcome) as {
    pauseReason?: unknown;
    passHistory?: unknown;
    work: Record<string, unknown> | null;
  };
  delete legacy.pauseReason;
  delete legacy.passHistory;
  if (legacy.work !== null) {
    delete legacy.work.passNumber;
    delete legacy.work.passDirection;
    delete legacy.work.passStartedAt;
    delete legacy.work.passInitialUnrecoveredSectorCount;
    delete legacy.work.passRecoveredSectorCount;
  }
  database.prepare(
    "UPDATE mutation_invocations SET outcome = ? WHERE key = ?",
  ).run(JSON.stringify(legacy), mutationKey);
  database.close();
}

type SyntheticSourceReadResult =
  | { outcome: "readable"; bytes: Buffer }
  | { outcome: "unreadable"; diagnostic: DvdDiscVerificationDiagnostic };

function immediateSourceReader<
  Request extends { devicePath: string; startLba: number },
>(
  read: (startLba: number) => SyntheticSourceReadResult,
) {
  const start = vi.fn((input: Request) => ({
    result: Promise.resolve(read(input.startLba)),
    closed: Promise.resolve(),
    cancel: vi.fn(),
    deviceIdentity: syntheticDeviceIdentity(input.devicePath),
    ready: Promise.resolve(),
    authorize: vi.fn(),
  }));
  return { reader: { start }, start };
}

function immediateReader(
  read: (startLba: number) => SyntheticSourceReadResult,
) {
  return immediateSourceReader<
    Parameters<DvdRecoverySourceReader["start"]>[0]
  >(read);
}

function immediateVerificationReader(
  read: (startLba: number) => SyntheticSourceReadResult,
) {
  return immediateSourceReader<
    Parameters<DvdVerificationSourceReader["start"]>[0]
  >(read);
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
      async withDeviceIdentityInactive(
        _identity: ReturnType<typeof syntheticDeviceIdentity>,
        mutation: () => void | Promise<void>,
      ) {
        await mutation();
      },
    },
    mediaGenerationObserver: {
      async observe(_devicePath: string, _signal: AbortSignal) {
        return "synthetic-verification-generation";
      },
    },
    originalsLibraryPath: fixture.originalsLibraryPath,
    reader,
    workerExecutionId: "synthetic-recovery-worker",
  };
}

it("applies and records an explicit Resume speed before verification reads", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  const resumed = await fixture.run([
    "archive-recovery", "resume", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000623",
    "--attempt-id", seeded.attemptId,
    "--checkpoint-revision", String(seeded.pointer.currentManifestRevision),
    "--checkpoint-digest", seeded.pointer.currentManifestDigest,
    "--speed-mode", "low",
  ]);
  expect(resumed.exitCode).toBe(0);
  const speedController = {
    apply: vi.fn(async () => ({
      attemptedSpeeds: [4],
      selectedSpeed: 4,
      observedSpeed: 16,
      outcome: "ignored" as const,
    })),
  };
  const source = immediateVerificationReader((startLba) => {
    const index = startLba / 64;
    const bytes = Buffer.alloc(32 * 2_048, index);
    bytes[bytes.length - 1] = index + 1;
    return { outcome: "readable", bytes };
  });
  const access = fixture.openAccess();
  const withDeviceInactive = vi.fn(async (
    _devicePath: string,
    mutation: () => void | Promise<void>,
  ) => {
    expect(speedController.apply).not.toHaveBeenCalled();
    await mutation();
  });
  try {
    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: { withDeviceInactive },
      reader: source.reader,
      workerExecutionId: "synthetic-resume-speed-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
    })).toBe(true);
    expect(withDeviceInactive).toHaveBeenCalledWith(
      seeded.verificationDrive.devicePath,
      expect.any(Function),
    );
    expect(speedController.apply).toHaveBeenCalledOnce();
    expect(speedController.apply.mock.invocationCallOrder[0])
      .toBeLessThan(source.start.mock.invocationCallOrder[0]!);
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        speedMode: "low",
        speedRequestResult: {
          attemptId: expect.any(String),
          discInspectionId: seeded.inspection.id,
          mode: "low",
          attemptedSpeeds: [4],
          selectedSpeed: 4,
          observedSpeed: 16,
          outcome: "ignored",
        },
      });
    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: immediateDeviceInactivity,
      reader: source.reader,
      workerExecutionId: "synthetic-resume-speed-verifier-restart",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
    })).toBe(false);
    expect(speedController.apply).toHaveBeenCalledOnce();
  } finally {
    access.close();
  }
});

it("does not apply Resume speed after the insertion changes under drive exclusion", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  expect((await fixture.run([
    "archive-recovery", "resume", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000625",
    "--attempt-id", seeded.attemptId,
    "--checkpoint-revision", String(seeded.pointer.currentManifestRevision),
    "--checkpoint-digest", seeded.pointer.currentManifestDigest,
    "--speed-mode", "low",
  ])).exitCode).toBe(0);
  const speedController = {
    apply: vi.fn(async () => ({
      attemptedSpeeds: [4],
      selectedSpeed: 4,
      observedSpeed: 4,
      outcome: "accepted" as const,
    })),
  };
  const source = immediateVerificationReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(32 * 2_048),
  }));
  const access = fixture.openAccess();
  const withDeviceInactive = vi.fn(async (
    _devicePath: string,
    mutation: () => void | Promise<void>,
  ) => {
    access.discInspections.clearCurrent({
      opticalDriveId: seeded.verificationDrive.id,
    });
    await mutation();
  });
  try {
    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: { withDeviceInactive },
      reader: source.reader,
      workerExecutionId: "synthetic-stale-resume-speed-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
    })).toBe(true);
    expect(withDeviceInactive).toHaveBeenCalledOnce();
    expect(speedController.apply).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ speedRequestResult: null });
  } finally {
    access.close();
  }
});

it("retries Resume verification after speed selection is cancelled", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  expect((await fixture.run([
    "archive-recovery", "resume", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000624",
    "--attempt-id", seeded.attemptId,
    "--checkpoint-revision", String(seeded.pointer.currentManifestRevision),
    "--checkpoint-digest", seeded.pointer.currentManifestDigest,
    "--speed-mode", "low",
  ])).exitCode).toBe(0);

  const shutdown = new AbortController();
  let cancelFirstRequest = true;
  const speedController = {
    apply: vi.fn(async (input: { signal: AbortSignal }) => {
      if (cancelFirstRequest) {
        cancelFirstRequest = false;
        shutdown.abort();
        input.signal.throwIfAborted();
      }
      return {
        attemptedSpeeds: [4],
        selectedSpeed: 4,
        observedSpeed: 4,
        outcome: "accepted" as const,
      };
    }),
  };
  const source = immediateVerificationReader((startLba) => {
    const index = startLba / 64;
    const bytes = Buffer.alloc(32 * 2_048, index);
    bytes[bytes.length - 1] = index + 1;
    return { outcome: "readable", bytes };
  });
  const access = fixture.openAccess();
  try {
    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: immediateDeviceInactivity,
      reader: source.reader,
      workerExecutionId: "synthetic-cancelled-speed-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
      signal: shutdown.signal,
    })).toBe(true);
    const retry = access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )!;
    expect(retry).toMatchObject({
      status: "queued",
      discInspectionId: seeded.inspection.id,
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "eligible",
        speedRequestResult: null,
        work: { status: "requested", verificationId: retry.id },
      });

    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: immediateDeviceInactivity,
      reader: source.reader,
      workerExecutionId: "synthetic-restarted-speed-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
    })).toBe(true);
    expect(speedController.apply).toHaveBeenCalledTimes(2);
    expect(source.start).toHaveBeenCalled();
    expect(access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )).toMatchObject({ status: "completed", outcome: "match" });
  } finally {
    access.close();
  }
});

it("retries Resume verification after transient drive contention", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries SET
    status = 'paused', pause_reason = 'no_progress', updated_at = updated_at + 1
    WHERE id = ?`).run(seeded.recoveryId);
  database.close();
  expect((await fixture.run([
    "archive-recovery", "resume", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000626",
    "--attempt-id", seeded.attemptId,
    "--checkpoint-revision", String(seeded.pointer.currentManifestRevision),
    "--checkpoint-digest", seeded.pointer.currentManifestDigest,
    "--speed-mode", "low",
  ])).exitCode).toBe(0);

  const speedController = {
    apply: vi.fn(async () => ({
      attemptedSpeeds: [4],
      selectedSpeed: 4,
      observedSpeed: 4,
      outcome: "accepted" as const,
    })),
  };
  const source = immediateVerificationReader((startLba) => {
    const index = startLba / 64;
    const bytes = Buffer.alloc(32 * 2_048, index);
    bytes[bytes.length - 1] = index + 1;
    return { outcome: "readable", bytes };
  });
  const access = fixture.openAccess();
  try {
    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: {
        async withDeviceInactive() {
          throw new Error("DVD archive device is still active");
        },
      },
      reader: source.reader,
      workerExecutionId: "synthetic-contended-speed-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
    })).toBe(true);
    const retry = access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )!;
    expect(retry).toMatchObject({
      status: "queued",
      discInspectionId: seeded.inspection.id,
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "eligible",
        speedRequestResult: null,
        work: { status: "requested", verificationId: retry.id },
      });

    expect(await pollDvdDiscVerification({
      access,
      deviceInactivity: immediateDeviceInactivity,
      reader: source.reader,
      workerExecutionId: "synthetic-uncontended-speed-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
      speedController,
    })).toBe(true);
    expect(speedController.apply).toHaveBeenCalledOnce();
    expect(source.start).toHaveBeenCalled();
    expect(access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )).toMatchObject({ status: "completed", outcome: "match" });
  } finally {
    access.close();
  }
});

it("continues a productive pass in reverse and pauses after no progress", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 3,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  await subscribeRecoveryBrowsers(fixture);
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
      .toMatchObject({
        status: "eligible",
        pauseReason: null,
        passHistory: [{
          passNumber: 1,
          direction: "forward",
          initialUnrecoveredSectorCount: 3,
          recoveredSectorCount: 2,
          remainingSectorCount: 1,
          lastCursorLba: 102,
          outcome: "productive",
        }],
        work: {
          status: "requested",
          verificationId: null,
          passNumber: 2,
          passDirection: "reverse",
          passStartedAt: null,
          passStartedManifestRevision: null,
          passInitialUnrecoveredSectorCount: null,
          passRecoveredSectorCount: 0,
          passObservationCount: null,
          passPositiveIntervalCount: null,
          passMinimumIntervalMs: null,
          passMaximumIntervalMs: null,
          passLastObservedAt: null,
          passCursorLba: null,
        },
      });
    const nextVerification = input.access.dvdDiscVerifications
      .findLatestForRecovery(seeded.recoveryId);
    expect(nextVerification).toMatchObject({
      attemptOrdinal: 2,
      status: "queued",
      checkpointRevision: checkpoint?.revision,
      checkpointDigest: checkpoint?.manifestDigest,
    });
    const queuedCli = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    const queuedWeb = await createOperationsResponse(
      input.access,
      new Request(
        `http://localhost/api/operations?kind=archive-recoveries&id=${seeded.recoveryId}`,
      ),
    );
    expect(queuedCli.exitCode).toBe(0);
    expect(queuedCli.result).toEqual(await queuedWeb.json());
    expect(queuedCli.result).toMatchObject({
      item: { status: "running", recoveryStatus: "eligible" },
    });
    const queuedWait = await fixture.run([
      "wait",
      "archive-recoveries",
      seeded.recoveryId,
      "--timeout-ms",
      "0",
    ]);
    expect(queuedWait.result).toMatchObject({
      outcome: "timeout",
      current: { status: "running", recoveryStatus: "eligible" },
    });
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    expect(source.start.mock.calls.map(([read]) => read.startLba))
      .toEqual([100, 101, 102]);
    completeQueuedVerification(fixture, seeded);

    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    expect(source.start.mock.calls.map(([read]) => read.startLba))
      .toEqual([100, 101, 102, 101]);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "no_progress",
        faultCode: null,
        passHistory: [
          expect.objectContaining({
            passNumber: 1,
            direction: "forward",
            outcome: "productive",
          }),
          expect.objectContaining({
            passNumber: 2,
            direction: "reverse",
            initialUnrecoveredSectorCount: 1,
            recoveredSectorCount: 0,
            remainingSectorCount: 1,
            lastCursorLba: 101,
            outcome: "no_progress",
          }),
        ],
        work: {
          status: "requested",
          passNumber: 2,
          passDirection: "reverse",
          passCursorLba: 101,
          passObservationCount: 1,
          passPositiveIntervalCount: 1,
          passLastObservedAt: expect.any(Date),
        },
      });
  } finally {
    input.access.close();
  }
}, 20_000);

it("retries an interrupted between-pass verification after restart", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 200,
    sectorCount: 3,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const firstPassSource = immediateReader((startLba) => startLba === 201
    ? { outcome: "unreadable", diagnostic: mediumError }
    : { outcome: "readable", bytes: Buffer.alloc(2_048, startLba) });
  const firstRun = pollInput(fixture, firstPassSource.reader);
  expect(await pollDvdRecoveryPass(firstRun)).toBe(true);
  const interrupted = firstRun.access.dvdDiscVerifications.claimNext(
    "synthetic-interrupted-continuation-verifier",
  );
  if (interrupted === null) {
    throw new Error("Expected between-pass verification claim");
  }
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE dvd_disc_verifications SET claimed_at = 0
    WHERE id = ?`).run(interrupted.id);
  database.close();
  firstRun.access.close();

  const restarted = fixture.openAccess();
  expect(restarted.dvdDiscVerifications.recoverExpiredClaims()).toBe(1);
  expect(restarted.dvdDiscVerifications.listForRecoveryAttempt(
    seeded.recoveryId,
    seeded.attemptId,
  )).toMatchObject([
    { attemptOrdinal: 1, status: "completed", outcome: "match" },
    {
      attemptOrdinal: 2,
      status: "completed",
      outcome: "inconclusive",
      reasons: expect.arrayContaining(["DISC_VERIFICATION_INTERRUPTED"]),
    },
    { attemptOrdinal: 3, status: "queued", outcome: null },
  ]);
  expect(restarted.catalog.findArchiveRecoveryById(seeded.recoveryId))
    .toMatchObject({
      status: "eligible",
      faultCode: null,
      work: { status: "requested", passNumber: 2 },
    });
  restarted.close();

  completeQueuedVerification(fixture, seeded);
  const resumedSource = immediateReader(() => ({
    outcome: "unreadable",
    diagnostic: mediumError,
  }));
  const resumed = pollInput(fixture, resumedSource.reader);
  try {
    expect(await pollDvdRecoveryPass(resumed)).toBe(true);
    expect(resumed.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "no_progress",
        work: { passNumber: 2, passDirection: "reverse" },
      });
  } finally {
    resumed.access.close();
  }
}, 20_000);

it("faults a continuation when its source is removed between passes", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 210,
    sectorCount: 3,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  await subscribeRecoveryBrowsers(fixture);
  const firstPassSource = immediateReader((startLba) => startLba === 211
    ? { outcome: "unreadable", diagnostic: mediumError }
    : { outcome: "readable", bytes: Buffer.alloc(2_048, startLba) });
  const input = pollInput(fixture, firstPassSource.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    const verificationSource = immediateVerificationReader(() => ({
      outcome: "readable",
      bytes: Buffer.alloc(2_048),
    }));
    expect(await pollDvdDiscVerification({
      access: input.access,
      deviceInactivity: immediateDeviceInactivity,
      reader: verificationSource.reader,
      workerExecutionId: "synthetic-removed-continuation-verifier",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-removed-generation";
        },
      },
    })).toBe(true);
    expect(verificationSource.start).not.toHaveBeenCalled();
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [{ status: "queued" }, { status: "queued" }] });
    expect(input.access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )).toMatchObject({
      status: "completed",
      outcome: "inconclusive",
      reasons: expect.arrayContaining(["DISC_INSERTION_CHANGED"]),
    });
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "DISC_VERIFICATION_STALE",
        work: { status: "requested", passNumber: 2 },
      });
    const inspected = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    expect(inspected.result).toMatchObject({
      item: {
        status: "faulted",
        recoveryStatus: "faulted",
        faultCode: "DISC_VERIFICATION_STALE",
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
      current: {
        status: "faulted",
        faultCode: "DISC_VERIFICATION_STALE",
      },
    });
  } finally {
    input.access.close();
  }
}, 20_000);

it("keeps a no-progress pause durable and exposes it identically", async () => {
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
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "no_progress",
        passHistory: [expect.objectContaining({
          passNumber: 1,
          direction: "forward",
          outcome: "no_progress",
        })],
      });
  } finally {
    input.access.close();
  }

  const restarted = pollInput(fixture, source.reader);
  restarted.workerExecutionId = "synthetic-no-progress-restart-worker";
  try {
    expect(await pollDvdRecoveryPass(restarted)).toBe(false);
    expect(source.start).toHaveBeenCalledOnce();
    const inspectionTime = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inspectionTime);
    const cli = await fixture.run([
      "inspect",
      "archive-recoveries",
      seeded.recoveryId,
    ]);
    const web = await createOperationsResponse(
      restarted.access,
      new Request(
        `http://localhost/api/operations?kind=archive-recoveries&id=${seeded.recoveryId}`,
      ),
    );
    const webResult = await web.json();
    vi.useRealTimers();
    expect(cli.exitCode).toBe(0);
    expect(cli.result).toEqual(webResult);
    expect(cli.result).toMatchObject({
      item: {
        status: "paused",
        recoveryStatus: "paused",
        pauseReason: "no_progress",
        availableActions: expect.arrayContaining([
          expect.objectContaining({ name: "stop", eligible: true }),
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
      current: { status: "paused", pauseReason: "no_progress" },
    });
    const stop = await fixture.run([
      "archive-recovery",
      "stop",
      seeded.recoveryId,
      "--key",
      "00000000-0000-4000-8000-000000000460",
      "--attempt-id",
      seeded.attemptId,
    ]);
    expect(stop).toMatchObject({
      exitCode: 0,
      result: {
        archiveRecovery: { status: "stopping", pauseReason: null },
      },
    });
    expect(await pollDvdRecoveryPass(restarted)).toBe(true);
    expect(restarted.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    restarted.access.close();
  }
}, 20_000);

it("keeps an unstarted legacy Stop receipt unstarted", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 175,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const mutationKey = "00000000-0000-4000-8000-000000000466";
  const access = fixture.openAccess();
  const original = access.archiveRecoveryWork.requestStop({
    mutationKey,
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  access.close();
  rewriteStopReceiptAsLegacy(fixture.databasePath, mutationKey);

  const restarted = fixture.openAccess();
  try {
    expect(restarted.archiveRecoveryWork.requestStop({
      mutationKey,
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    })).toEqual(original);
  } finally {
    restarted.close();
  }
});

it("normalizes progressed pass state in a legacy Stop receipt", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 175,
    sectorCount: 3,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const mutationKey = "00000000-0000-4000-8000-000000000467";
  const access = fixture.openAccess();
  expect(access.archiveRecoveryWork.claimNextVerifiedCandidate(
    "synthetic-legacy-stop-worker",
  )).not.toBeNull();
  const progressDatabase = new DatabaseSync(fixture.databasePath);
  progressDatabase.prepare(`UPDATE archive_recovery_work
    SET pass_cursor_lba = 175
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  progressDatabase.close();
  const original = access.archiveRecoveryWork.requestStop({
    mutationKey,
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  access.close();
  rewriteStopReceiptAsLegacy(fixture.databasePath, mutationKey);

  const restarted = fixture.openAccess();
  try {
    expect(restarted.archiveRecoveryWork.requestStop({
      mutationKey,
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    })).toEqual(original);
  } finally {
    restarted.close();
  }
});

it("retains only the latest sixteen completed pass summaries", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 176,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const setupAccess = fixture.openAccess();
  setupAccess.archiveRecoveryWork.request(seeded.recoveryId);
  setupAccess.close();
  const priorHistory = Array.from({ length: 16 }, (_, index) => ({
    passNumber: index + 1,
    direction: index % 2 === 0 ? "forward" : "reverse",
    initialUnrecoveredSectorCount: 1,
    recoveredSectorCount: 1,
    remainingSectorCount: 1,
    lastCursorLba: 176,
    startedAtMs: index * 2,
    completedAtMs: index * 2 + 1,
    elapsedMs: 1,
    outcome: "productive",
  }));
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recoveries
    SET pass_history = ?
    WHERE id = ?`).run(JSON.stringify(priorHistory), seeded.recoveryId);
  database.prepare(`UPDATE archive_recovery_work
    SET pass_number = 17
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  database.close();
  const source = immediateReader(() => ({
    outcome: "unreadable",
    diagnostic: mediumError,
  }));
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    const recovery = input.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    );
    expect(recovery).toMatchObject({
      status: "paused",
      pauseReason: "no_progress",
    });
    expect(recovery?.passHistory).toHaveLength(16);
    expect(recovery?.passHistory.at(0)?.passNumber).toBe(2);
    expect(recovery?.passHistory.at(-1)).toMatchObject({
      passNumber: 17,
      direction: "forward",
      recoveredSectorCount: 0,
      outcome: "no_progress",
    });
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
  await subscribeRecoveryBrowsers(fixture);
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
    expect(input.access.dvdRecoveryReconciliations.fail(
      reconciliation, "CONSISTENCY_FAULT",
    )).toBeNull();
    const detail = await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId]);
    expect(detail.result).toMatchObject({ item: {
      reconciliation: { status: "failed", failureCode: "CONSISTENCY_FAULT" },
    } });
    expect(await createOperationsResponse(input.access, new Request(
      `https://operator.example/api/operations?kind=archive-recoveries&id=${seeded.recoveryId}`,
    ), fixture.originalsLibraryPath).json()).toEqual(detail.result);
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [{ status: "queued" }, { status: "queued" }] });
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible", work: null });
  } finally {
    input.access.close();
  }
});

it("recovers from an explicitly confirmed mismatch and records its source authorization", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const before = readFileSync(seeded.archive.archivePath);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x44),
  }));
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).toHaveBeenCalledTimes(1);
    const checkpoint = await input.access.readDvdCheckpoint(
      seeded.archive.id,
      defaultArchiveImageOwnership,
    );
    expect(checkpoint).toMatchObject({
      recoveryRead: {
        verificationId: confirmation.verificationId,
        discConfirmationId: confirmation.id,
        startLba: 100,
        outcome: "recovered",
      },
    });
    expect(input.access.catalog.listOriginalDiscArchives({
      ids: [seeded.archive.id],
    })[0]).toMatchObject({ integrity: "clean_read" });
    const inspection = await fixture.run([
      "archive-recovery",
      "preview-disc-confirmation",
      seeded.recoveryId,
    ]);
    expect(inspection.result).toMatchObject({
      provenance: {
        imageUsesConfirmedSource: true,
        confirmations: [{
          confirmation: { id: confirmation.id },
          recoveredSectorCount: 1,
          failedReadCount: 0,
          firstRecoveredLba: 100,
          lastRecoveredLba: 100,
          recoveredRanges: [{ startLba: 100, sectorCount: 1 }],
        }],
      },
    });
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "completed", work: null });
    const after = readFileSync(seeded.archive.archivePath);
    expect(after.subarray(0, 100 * 2_048))
      .toEqual(before.subarray(0, 100 * 2_048));
    expect(after.subarray(101 * 2_048))
      .toEqual(before.subarray(101 * 2_048));
  } finally {
    input.access.close();
  }
}, 15_000);

it("expires confirmation before a restarted worker can read the source", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x44),
  }));
  const input = pollInput(fixture, source.reader);
  input.workerExecutionId = "synthetic-restarted-recovery-worker";
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.dvdDiscConfirmations.find(confirmation.id))
      .toMatchObject({
        expiredAt: expect.any(Date),
        expiryReason: "WORKER_EXECUTION_CHANGED",
      });
  } finally {
    input.access.close();
  }
});

it("expires confirmation when a restarted recovery worker starts", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x44),
  }));
  const input = pollInput(fixture, source.reader);
  const stopped = new AbortController();
  stopped.abort();
  try {
    await runDvdRecoveryWorker({
      ...input,
      intervalMs: 1,
      log: vi.fn(),
      signal: stopped.signal,
      workerExecutionId: "synthetic-restarted-recovery-worker",
    });
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.dvdDiscConfirmations.find(confirmation.id))
      .toMatchObject({
        expiredAt: expect.any(Date),
        expiryReason: "WORKER_EXECUTION_CHANGED",
      });
  } finally {
    input.access.close();
  }
});

it("keeps confirmation authority until a live writer reaches takeover", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const access = fixture.openAccess();
  try {
    const claimed = access.archiveRecoveryWork.claimNextVerifiedCandidate(
      "synthetic-recovery-worker",
    );
    expect(claimed?.confirmation?.id).toBe(confirmation.id);
    expect(access.dvdDiscConfirmations.expireForWorkerExecution(
      "synthetic-restarted-recovery-worker",
    )).toBe(0);
    expect(access.dvdDiscConfirmations.find(confirmation.id)?.expiredAt)
      .toBeNull();

    const sqlite = new DatabaseSync(fixture.databasePath);
    sqlite.prepare(`
      UPDATE archive_recovery_work
      SET claimed_at = 0
      WHERE archive_recovery_id = ?
    `).run(seeded.recoveryId);
    sqlite.close();
    expect(access.dvdDiscConfirmations.expireForWorkerExecution(
      "synthetic-restarted-recovery-worker",
    )).toBe(1);
    expect(access.dvdDiscConfirmations.find(confirmation.id)).toMatchObject({
      expiredAt: expect.any(Date),
      expiryReason: "WORKER_EXECUTION_CHANGED",
    });
  } finally {
    access.close();
  }
});

it("expires confirmation after source removal without starting a read", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x44),
  }));
  const input = pollInput(fixture, source.reader);
  input.access.discInspections.clearCurrent({
    opticalDriveId: seeded.verificationDrive.id,
  });
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.dvdDiscConfirmations.find(confirmation.id))
      .toMatchObject({
        expiredAt: expect.any(Date),
        expiryReason: "DISC_INSERTION_CHANGED",
      });
  } finally {
    input.access.close();
  }
});

it("expires confirmation when the observed source generation changes", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x44),
  }));
  const input = pollInput(fixture, source.reader);
  input.mediaGenerationObserver.observe = async () =>
    "synthetic-changed-source-generation";
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.dvdDiscConfirmations.find(confirmation.id))
      .toMatchObject({
        expiredAt: expect.any(Date),
        expiryReason: "DISC_SOURCE_CHANGED",
      });
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

it("expires confirmation when insertion changes at the batch authority gate", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 100,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const confirmation = await completeMismatchAndConfirm(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x44),
  }));
  const baseInput = pollInput(fixture, source.reader);
  const input = {
    ...baseInput,
    commit: async (
      options: Parameters<typeof commitDvdRecoveryBatch>[0],
    ) => {
      baseInput.access.discInspections.clearCurrent({
        opticalDriveId: seeded.verificationDrive.id,
      });
      return commitDvdRecoveryBatch(options);
    },
  };
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).toHaveBeenCalledOnce();
    expect(source.start.mock.results[0]?.value.authorize)
      .toHaveBeenCalledOnce();
    expect(input.access.dvdDiscConfirmations.find(confirmation.id))
      .toMatchObject({
        expiredAt: expect.any(Date),
        expiryReason: "DISC_INSERTION_CHANGED",
      });
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "DISC_VERIFICATION_STALE",
        work: null,
      });
  } finally {
    input.access.close();
  }
});

it("does not authorize a source read when Stop commits during insertion observation", async () => {
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
    expect(source.start).toHaveBeenCalledOnce();
    expect(source.start.mock.results[0]?.value.authorize)
      .not.toHaveBeenCalled();
    expect(source.start.mock.results[0]?.value.cancel).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    input.access.close();
  }
});

it("follows a serial-proven drive renumber between admitted sector reads", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const originalDevicePath = "/dev/synthetic-recovery-before-renumber";
  const renumberedDevicePath = "/dev/synthetic-recovery-after-renumber";
  const serialNumber = "synthetic-recovery-renumber-serial";
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 180,
    sectorCount: 2,
    classification: "skipped_untested",
  }], originalDevicePath);
  const setupAccess = fixture.openAccess();
  try {
    expect(setupAccess.catalog.upsertOpticalDrive({
      devicePath: originalDevicePath,
      serialNumber,
      isEnabled: true,
      isPresent: true,
    }).id).toBe(seeded.verificationDrive.id);
  } finally {
    setupAccess.close();
  }
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x64),
  }));
  const input = pollInput(fixture, source.reader);
  let committedSectors = 0;
  const commit = vi.fn(async (
    batch: Parameters<typeof commitDvdRecoveryBatch>[0],
  ) => {
    const result = await commitDvdRecoveryBatch(batch);
    committedSectors += 1;
    if (committedSectors === 1) {
      const renumbered = input.access.catalog.reconcileOpticalDrives([{
        devicePath: renumberedDevicePath,
        serialNumber,
        isConfiguredDevice: false,
      }]).find((drive) => drive.serialNumber === serialNumber);
      expect(renumbered?.id).toBe(seeded.verificationDrive.id);
    }
    return result;
  });
  try {
    expect(await pollDvdRecoveryPass({ ...input, commit })).toBe(true);
    expect(source.start.mock.calls.map(([read]) => read.devicePath)).toEqual([
      originalDevicePath,
      renumberedDevicePath,
    ]);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "completed", work: null });
  } finally {
    input.access.close();
  }
});

it("rejects an unauthorized read when the drive path changes before admission", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const originalDevicePath = "/dev/synthetic-observed-recovery-drive";
  const renumberedDevicePath = "/dev/synthetic-renumbered-recovery-drive";
  const serialNumber = "synthetic-observed-renumber-serial";
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    originalDevicePath,
  );
  const setupAccess = fixture.openAccess();
  try {
    expect(setupAccess.catalog.upsertOpticalDrive({
      devicePath: originalDevicePath,
      serialNumber,
      isEnabled: true,
      isPresent: true,
    }).id).toBe(seeded.verificationDrive.id);
  } finally {
    setupAccess.close();
  }
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x65),
  }));
  const input = pollInput(fixture, source.reader);
  input.mediaGenerationObserver.observe = async (devicePath) => {
    expect(devicePath).toBe(originalDevicePath);
    return "synthetic-verification-generation";
  };
  const admitSourceRead = input.access.archiveRecoveryWork.admitSourceRead
    .bind(input.access.archiveRecoveryWork);
  vi.spyOn(input.access.archiveRecoveryWork, "admitSourceRead")
    .mockImplementation((claim, expectedDevicePath, identity) => {
      const renumbered = input.access.catalog.reconcileOpticalDrives([{
        devicePath: renumberedDevicePath,
        serialNumber,
        isConfiguredDevice: false,
      }]).find((drive) => drive.serialNumber === serialNumber);
      expect(renumbered?.id).toBe(seeded.verificationDrive.id);
      return admitSourceRead(claim, expectedDevicePath, identity);
    });
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).toHaveBeenCalledOnce();
    expect(source.start.mock.results[0]?.value.authorize)
      .not.toHaveBeenCalled();
    expect(source.start.mock.results[0]?.value.cancel).toHaveBeenCalledOnce();
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

it("keeps Stop pending while a rejected recovery admission claim is live", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 149,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  let rejectRead!: (reason?: unknown) => void;
  const result = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const observeResult = vi.spyOn(result, "catch");
  let closeRead!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeRead = resolve;
  });
  const cancel = vi.fn(() => {
    expect(observeResult).toHaveBeenCalledOnce();
    rejectRead(new Error("Synthetic cancelled recovery read"));
  });
  const authorize = vi.fn();
  const start = vi.fn((request:
    Parameters<DvdRecoverySourceReader["start"]>[0]) => ({
      result,
      closed,
      cancel,
      deviceIdentity: syntheticDeviceIdentity(request.devicePath),
      ready: Promise.resolve(),
      authorize,
    }));
  const input = pollInput(fixture, { start });
  vi.spyOn(input.access.archiveRecoveryWork, "admitSourceRead")
    .mockImplementation(() => {
      throw new Error("Synthetic recovery admission commit failure");
    });
  const stopInput = pollInput(
    fixture,
    immediateReader(() => {
      throw new Error("Stop must not start another recovery read");
    }).reader,
  );
  try {
    const polling = pollDvdRecoveryPass(input);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(authorize).not.toHaveBeenCalled();
    const stopAccess = fixture.openAccess();
    const stopOperationId = (() => {
      try {
        return stopAccess.archiveRecoveryWork.requestStop({
          mutationKey: "00000000-0000-4000-8000-000000000489",
          archiveRecoveryId: seeded.recoveryId,
          attemptId: seeded.attemptId,
        }).stopOperationId;
      } finally {
        stopAccess.close();
      }
    })();
    const stopping = stopInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    );
    expect(stopping).toMatchObject({
      status: "stopping",
      work: { status: "claimed", claimedAt: expect.any(Date) },
    });
    expect(Date.now() - stopping!.work!.claimedAt!.getTime())
      .toBeLessThan(DVD_RECOVERY_PASS_CLAIM_LEASE_MS);
    expect(stopInput.access.archiveRecoveryWork.prepareStop({
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
      stopOperationId,
    })).toBe(false);
    expect(await pollDvdRecoveryPass(stopInput)).toBe(false);
    expect(stopInput.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopping" });

    closeRead();
    await expect(polling).resolves.toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", faultCode: null });
  } finally {
    stopInput.access.close();
    input.access.close();
  }
});

it("allows Stop after rolled-back recovery admission expires without authorizing", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 149,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const input = pollInput(fixture, immediateReader(() => {
    throw new Error("Stop must not start another recovery read");
  }).reader);
  const candidate = input.access.archiveRecoveryWork
    .claimNextVerifiedCandidate("synthetic-crashed-admission-worker");
  if (candidate === null) throw new Error("Expected recovery claim");
  const authorize = vi.fn();
  const cancel = vi.fn();
  const start = vi.fn(() => ({
    result: new Promise<never>(() => {}),
    closed: new Promise<void>(() => {}),
    cancel,
    deviceIdentity: {
      ...syntheticDeviceIdentity(seeded.verificationDrive.devicePath),
      deviceId: "invalid",
    },
    ready: Promise.resolve(),
    authorize,
  }));
  const preparedRead = start();
  await preparedRead.ready;
  expect(() => input.access.archiveRecoveryWork.admitSourceRead(
    candidate.claim,
    seeded.verificationDrive.devicePath,
    preparedRead.deviceIdentity,
  )).toThrow("DVD Recovery source device identity is invalid");
  expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
    .toMatchObject({
      work: {
        admittedDevicePath: null,
        admittedDeviceId: null,
        admittedDeviceInode: null,
      },
    });
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE archive_recovery_work
    SET claimed_at = 0
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  database.close();
  input.access.archiveRecoveryWork.requestStop({
    mutationKey: "00000000-0000-4000-8000-000000000496",
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
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

it("notifies only after an active checkpoint batch settles the last source and releases ownership", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  await notificationWorkflow(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({ outcome: "readable", bytes: Buffer.alloc(2_048, 0x6a) }));
  const input = pollInput(fixture, source.reader);
  let releaseBatch!: () => void;
  const batchBlocked = new Promise<void>((resolve) => { releaseBatch = resolve; });
  let batchEntered!: () => void;
  const entered = new Promise<void>((resolve) => { batchEntered = resolve; });
  const commit: typeof commitDvdRecoveryBatch = (options) => commitDvdRecoveryBatch({
    ...options,
    async fault(point) {
      if (point === "after:image_sync") {
        batchEntered();
        await batchBlocked;
      }
    },
  });
  const polling = pollDvdRecoveryPass({ ...input, commit });
  try {
    await Promise.race([entered, polling.then(() => {
      throw new Error("Recovery ended before the controlled batch boundary");
    })]);
    expect((await fixture.run(["archive-recovery", "stop", seeded.recoveryId,
      "--key", "synthetic-stop-active-batch", "--attempt-id", seeded.attemptId])).exitCode).toBe(0);
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "stopping", checkpoint: { currentManifestRevision: 1 } } });
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    expect(await pollDvdRecoveryPass({ ...input, workerExecutionId: "synthetic-competing-stop-worker" })).toBe(false);
    expect((await fixture.run(["notifications", "deliveries"])).result).toMatchObject({ deliveries: [] });
    releaseBatch();
    expect(await polling).toBe(true);
    expect((await fixture.run(["inspect", "archive-recoveries", seeded.recoveryId])).result)
      .toMatchObject({ item: { status: "stopped", checkpoint: { currentManifestRevision: 2 },
        progress: { unresolvedSectorCount: 0 } } });
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(input.access, async (_recipient, payload) => { sent.push(payload); }))
      .toEqual({ accepted: 2, failed: 0 });
    expect(sent).toEqual([expect.objectContaining({
      body: "Archive Recovery stopped. No source remains unrecovered.",
    }), expect.any(Object)]);
    expect(sent[1]).toEqual(sent[0]);
  } finally {
    releaseBatch();
    await polling;
    input.access.close();
  }
}, 20_000);

it("keeps Stop durable until a blocked source command is reaped", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  await notificationWorkflow(fixture);
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
  const start = vi.fn((read: Parameters<DvdRecoverySourceReader["start"]>[0]) => ({
    result: new Promise<never>(() => {}),
    closed,
    cancel,
    deviceIdentity: syntheticDeviceIdentity(read.devicePath),
    ready: Promise.resolve(),
    authorize: vi.fn(),
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
    expect((await fixture.run([
      "archive-recovery", "stop", seeded.recoveryId,
      "--key", "synthetic-blocked-stop", "--attempt-id", seeded.attemptId,
    ])).exitCode).toBe(0);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopping" });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    closeRead();
    await polling;
    expect(start).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [
        { status: "queued" }, { status: "queued" },
      ] });
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

it("stops against the admitted inode after the drive path is reused", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const originalDevicePath = "/dev/synthetic-stop-before-renumber";
  const replacementDevicePath = "/dev/synthetic-stop-after-renumber";
  const serialNumber = "synthetic-stop-renumber-serial";
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 208,
    sectorCount: 1,
    classification: "skipped_untested",
  }], originalDevicePath);
  const setupAccess = fixture.openAccess();
  try {
    setupAccess.catalog.upsertOpticalDrive({
      devicePath: originalDevicePath,
      serialNumber,
      isEnabled: true,
      isPresent: true,
    });
  } finally {
    setupAccess.close();
  }
  await completeVerification(fixture, seeded);
  let closeRead!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeRead = resolve;
  });
  const cancel = vi.fn();
  const admittedIdentity = syntheticDeviceIdentity(originalDevicePath);
  const source = {
    start: vi.fn(() => ({
      result: new Promise<never>(() => {}),
      closed,
      cancel,
      deviceIdentity: admittedIdentity,
      ready: Promise.resolve(),
      authorize: vi.fn(),
    })),
  };
  const input = pollInput(fixture, source);
  const withDeviceIdentityInactive = vi.fn(async (
    _identity: ReturnType<typeof syntheticDeviceIdentity>,
    mutation: () => void | Promise<void>,
  ) => mutation());
  input.deviceInactivity.withDeviceIdentityInactive =
    withDeviceIdentityInactive;
  try {
    const polling = pollDvdRecoveryPass({
      ...input,
      stopPollIntervalMs: 1,
    });
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce());
    input.access.catalog.reconcileOpticalDrives([{
      devicePath: replacementDevicePath,
      serialNumber,
      isConfiguredDevice: false,
    }]);
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000492",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    closeRead();
    await expect(polling).resolves.toBe(true);
    expect(withDeviceIdentityInactive).toHaveBeenCalledWith(
      admittedIdentity,
      expect.any(Function),
    );
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    input.access.close();
  }
}, 20_000);

it("releases a quiesced read on shutdown so a restarted worker can resume", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 201,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  await subscribeRecoveryBrowsers(fixture);
  let closeRead!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeRead = resolve;
  });
  const cancel = vi.fn(() => closeRead());
  const firstSource = {
    start: vi.fn((read: Parameters<DvdRecoverySourceReader["start"]>[0]) => ({
      result: new Promise<never>(() => {}),
      closed,
      cancel,
      deviceIdentity: syntheticDeviceIdentity(read.devicePath),
      ready: Promise.resolve(),
      authorize: vi.fn(),
    })),
  };
  const controller = new AbortController();
  const firstInput = pollInput(fixture, firstSource);
  try {
    const polling = pollDvdRecoveryPass({
      ...firstInput,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(firstSource.start).toHaveBeenCalledOnce());
    controller.abort(new Error("Synthetic recovery worker shutdown"));

    await expect(polling).rejects.toThrow("SOURCE_READ_FAILED");
    expect(cancel).toHaveBeenCalledOnce();
    expect((await fixture.run(["notifications", "deliveries"])).result)
      .toMatchObject({ deliveries: [] });
    expect(firstInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({
      status: "eligible",
      work: {
        status: "requested",
        claimToken: null,
        verificationId: expect.any(String),
      },
    });
  } finally {
    firstInput.access.close();
  }

  const restartedSource = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x64),
  }));
  const restartedInput = pollInput(fixture, restartedSource.reader);
  restartedInput.workerExecutionId = "synthetic-restarted-recovery-worker";
  try {
    expect(await pollDvdRecoveryPass(restartedInput)).toBe(true);
    expect(restartedSource.start).toHaveBeenCalledOnce();
    expect(restartedInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({ status: "completed", work: null });
  } finally {
    restartedInput.access.close();
  }
}, 20_000);

it("resumes the remaining sectors after shutdown follows a committed batch", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 203,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const controller = new AbortController();
  const firstSource = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x67),
  }));
  const firstInput = pollInput(fixture, firstSource.reader);
  const commit = vi.fn(async (
    batch: Parameters<typeof commitDvdRecoveryBatch>[0],
  ) => {
    const result = await commitDvdRecoveryBatch(batch);
    controller.abort(new Error("Synthetic post-commit shutdown"));
    return result;
  });
  try {
    await expect(pollDvdRecoveryPass({
      ...firstInput,
      commit,
      signal: controller.signal,
    })).rejects.toThrow("Synthetic post-commit shutdown");
    expect(firstSource.start).toHaveBeenCalledOnce();
    expect(firstSource.start.mock.calls[0]?.[0].startLba).toBe(203);
    expect(firstInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({
      status: "eligible",
      work: {
        status: "requested",
        claimToken: null,
        verificationId: expect.any(String),
      },
    });
    expect((await firstInput.access.readDvdCheckpoint(
      seeded.archive.id,
      defaultArchiveImageOwnership,
    ))?.unrecoveredSourceRanges).toEqual([{
      startLba: 204,
      sectorCount: 1,
      classification: "skipped_untested",
    }]);
  } finally {
    firstInput.access.close();
  }

  const restartedSource = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x68),
  }));
  const restartedInput = pollInput(fixture, restartedSource.reader);
  restartedInput.workerExecutionId = "synthetic-post-commit-restart-worker";
  try {
    expect(await pollDvdRecoveryPass(restartedInput)).toBe(true);
    expect(restartedSource.start).toHaveBeenCalledOnce();
    expect(restartedSource.start.mock.calls[0]?.[0].startLba).toBe(204);
    expect(restartedInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({ status: "completed", work: null });
  } finally {
    restartedInput.access.close();
  }
}, 20_000);

it("does not retry a failed sector when restart resumes the same pass", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 205,
    sectorCount: 2,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const controller = new AbortController();
  const firstSource = immediateReader(() => ({
    outcome: "unreadable",
    diagnostic: mediumError,
  }));
  const firstInput = pollInput(fixture, firstSource.reader);
  const commit = vi.fn(async (
    batch: Parameters<typeof commitDvdRecoveryBatch>[0],
  ) => {
    const result = await commitDvdRecoveryBatch(batch);
    controller.abort(new Error("Synthetic failed-sector checkpoint shutdown"));
    return result;
  });
  try {
    await expect(pollDvdRecoveryPass({
      ...firstInput,
      commit,
      signal: controller.signal,
    })).rejects.toThrow("Synthetic failed-sector checkpoint shutdown");
    expect(firstSource.start.mock.calls.map(([read]) => read.startLba))
      .toEqual([205]);
    expect(firstInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({
      status: "eligible",
      work: { status: "requested", passCursorLba: 205 },
    });
  } finally {
    firstInput.access.close();
  }

  const restartedSource = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x69),
  }));
  const restartedInput = pollInput(fixture, restartedSource.reader);
  restartedInput.workerExecutionId = "synthetic-failed-sector-restart-worker";
  try {
    expect(await pollDvdRecoveryPass(restartedInput)).toBe(true);
    expect(restartedSource.start.mock.calls.map(([read]) => read.startLba))
      .toEqual([206]);
    expect(restartedInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({
      status: "eligible",
      work: {
        status: "requested",
        passNumber: 2,
        passDirection: "reverse",
      },
    });
  } finally {
    restartedInput.access.close();
  }
}, 20_000);

it("reclaims a crashed worker claim before a restarted worker resumes", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 207,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const crashedAccess = fixture.openAccess();
  const crashed = crashedAccess.archiveRecoveryWork
    .claimNextVerifiedCandidate("synthetic-crashed-recovery-worker");
  if (crashed === null) throw new Error("Expected crashed recovery claim");
  const crashedIdentity = syntheticDeviceIdentity(
    seeded.verificationDrive.devicePath,
  );
  crashedAccess.archiveRecoveryWork.admitSourceRead(
    crashed.claim,
    seeded.verificationDrive.devicePath,
    crashedIdentity,
  );
  crashedAccess.close();
  const crashedDatabase = new DatabaseSync(fixture.databasePath);
  crashedDatabase.prepare(`UPDATE archive_recovery_work
    SET claimed_at = 0
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  crashedDatabase.close();

  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x6a),
  }));
  const input = pollInput(fixture, source.reader);
  input.workerExecutionId = "synthetic-restarted-after-crash-worker";
  const racedIdentity = { ...crashedIdentity, inode: "8" };
  const beginInterruptedTakeover = input.access.archiveRecoveryWork
    .beginInterruptedTakeover.bind(input.access.archiveRecoveryWork);
  vi.spyOn(input.access.archiveRecoveryWork, "beginInterruptedTakeover")
    .mockImplementationOnce((claim, workerId) => {
      input.access.archiveRecoveryWork.admitSourceRead(
        claim,
        seeded.verificationDrive.devicePath,
        racedIdentity,
      );
      return beginInterruptedTakeover(claim, workerId);
    })
    .mockImplementation(beginInterruptedTakeover);
  const withDeviceIdentityInactive = vi.fn(async (
    _identity: ReturnType<typeof syntheticDeviceIdentity>,
    mutation: () => void | Promise<void>,
  ) => {
    if (withDeviceIdentityInactive.mock.calls.length === 1) {
      expect(input.access.archiveRecoveryWork.renewClaim(crashed.claim))
        .toBe(false);
      expect(() => input.access.archiveRecoveryWork.admitSourceRead(
        crashed.claim,
        seeded.verificationDrive.devicePath,
        crashedIdentity,
      )).toThrow();
      throw new Error("Synthetic crashed helper remains active");
    }
    await mutation();
  });
  input.deviceInactivity.withDeviceIdentityInactive =
    withDeviceIdentityInactive;
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(withDeviceIdentityInactive).toHaveBeenCalledWith(
      racedIdentity,
      expect.any(Function),
    );
    expect(source.start).not.toHaveBeenCalled();
    const fenced = input.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    );
    expect(fenced).toMatchObject({
      status: "running",
      work: {
        status: "claimed",
        claimedBy: "synthetic-restarted-after-crash-worker",
        admittedDevicePath: racedIdentity.devicePath,
        admittedDeviceInode: racedIdentity.inode,
      },
    });
    expect(fenced?.work?.claimToken).not.toBe(crashed.claim.claimToken);

    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "eligible",
        work: {
          status: "requested",
          admittedDevicePath: null,
          admittedDeviceId: null,
          admittedDeviceInode: null,
        },
      });

    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).toHaveBeenCalledOnce();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "completed", work: null });
  } finally {
    input.access.close();
  }
}, 20_000);

it("rolls a published checkpoint forward before requeueing a crashed claim", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 208,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const authority = await completeVerification(fixture, seeded);
  const crashedAccess = fixture.openAccess();
  const crashed = crashedAccess.archiveRecoveryWork
    .claimNextVerifiedCandidate("synthetic-published-checkpoint-worker");
  if (crashed === null) throw new Error("Expected crashed recovery claim");
  let pointerPublished = false;
  await expect(commitDvdRecoveryBatch({
    access: crashedAccess,
    originalsLibraryPath: fixture.originalsLibraryPath,
    originalDiscArchiveId: seeded.archive.id,
    recoveryWorkClaim: crashed.claim,
    writeAuthority: authority,
    observation: {
      startLba: 208,
      outcome: "recovered",
      bytes: Buffer.alloc(2_048, 0x6c),
    },
    atomicWriter: syntheticAtomicWriter,
    fault(point) {
      if (point === "after:pointer") {
        pointerPublished = true;
        throw new Error("Synthetic process loss after pointer publication");
      }
    },
  })).rejects.toThrow("CONSISTENCY_FAULT");
  expect(pointerPublished).toBe(true);
  crashedAccess.close();
  const crashedDatabase = new DatabaseSync(fixture.databasePath);
  crashedDatabase.prepare(`UPDATE archive_recovery_work
    SET claimed_at = 0
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  crashedDatabase.close();

  const source = immediateReader(() => {
    throw new Error("Published recovery evidence must not be read again");
  });
  const input = pollInput(fixture, source.reader);
  input.workerExecutionId = "synthetic-published-checkpoint-restart-worker";
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "completed",
        work: null,
        passHistory: [{
          passNumber: 1,
          direction: "forward",
          initialUnrecoveredSectorCount: 1,
          recoveredSectorCount: 1,
          remainingSectorCount: 0,
          lastCursorLba: 208,
          outcome: "completed",
        }],
      });
    expect(input.access.catalog.findDvdArchiveEvidenceHeader(seeded.archive.id))
      .toMatchObject({ currentManifestRevision: 2 });
  } finally {
    input.access.close();
  }
}, 20_000);

it("does not take over a foreign claim before its lease expires", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 209,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const liveAccess = fixture.openAccess();
  const live = liveAccess.archiveRecoveryWork
    .claimNextVerifiedCandidate("synthetic-live-recovery-worker");
  if (live === null) throw new Error("Expected live recovery claim");
  expect(liveAccess.archiveRecoveryWork.renewClaim(live.claim)).toBe(true);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048),
  }));
  const input = pollInput(fixture, source.reader);
  input.workerExecutionId = "synthetic-competing-recovery-worker";
  const withDeviceIdentityInactive = vi.fn();
  input.deviceInactivity.withDeviceIdentityInactive =
    withDeviceIdentityInactive;
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(withDeviceIdentityInactive).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "running",
        work: { claimedBy: "synthetic-live-recovery-worker" },
      });
  } finally {
    liveAccess.archiveRecoveryWork.requeue(live.claim);
    liveAccess.close();
    input.access.close();
  }
});

it("reconciles an interrupted batch before restart reclaims the pass", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 202,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  await completeVerification(fixture, seeded);
  const controller = new AbortController();
  const firstSource = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x65),
  }));
  const firstInput = pollInput(fixture, firstSource.reader);
  const commit = vi.fn(async () => {
    controller.abort(new Error("Synthetic batch shutdown"));
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }) as unknown as typeof commitDvdRecoveryBatch;
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent" as const,
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    await expect(pollDvdRecoveryPass({
      ...firstInput,
      commit,
      reconcile,
      signal: controller.signal,
    })).rejects.toThrow("CONSISTENCY_FAULT");
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      originalDiscArchiveId: seeded.archive.id,
      releaseRecoveryWork: false,
    }));
    expect(firstInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({
      status: "eligible",
      work: {
        status: "requested",
        claimToken: null,
        verificationId: expect.any(String),
      },
    });
  } finally {
    firstInput.access.close();
  }

  const restartedSource = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x66),
  }));
  const restartedInput = pollInput(fixture, restartedSource.reader);
  restartedInput.workerExecutionId = "synthetic-batch-restart-worker";
  try {
    expect(await pollDvdRecoveryPass(restartedInput)).toBe(true);
    expect(restartedInput.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )).toMatchObject({ status: "completed", work: null });
  } finally {
    restartedInput.access.close();
  }
}, 20_000);

it("pauses a crashed claim when rollback image I/O has a storage fault", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 209,
    sectorCount: 1,
    classification: "skipped_untested",
  }]);
  const authority = await completeVerification(fixture, seeded);
  const crashedAccess = fixture.openAccess();
  const crashed = crashedAccess.archiveRecoveryWork
    .claimNextVerifiedCandidate("synthetic-storage-crash-worker");
  if (crashed === null) throw new Error("Expected crashed recovery claim");
  await expect(commitDvdRecoveryBatch({
    access: crashedAccess,
    originalsLibraryPath: fixture.originalsLibraryPath,
    originalDiscArchiveId: seeded.archive.id,
    recoveryWorkClaim: crashed.claim,
    writeAuthority: authority,
    observation: {
      startLba: 209,
      outcome: "recovered",
      bytes: Buffer.alloc(2_048, 0x6d),
    },
    atomicWriter: syntheticAtomicWriter,
    fault(point) {
      if (point === "after:write") {
        throw new Error("Synthetic process loss after image write");
      }
    },
  })).rejects.toThrow("CONSISTENCY_FAULT");
  crashedAccess.close();
  const crashedDatabase = new DatabaseSync(fixture.databasePath);
  crashedDatabase.prepare(`UPDATE archive_recovery_work
    SET claimed_at = 0
    WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
  crashedDatabase.close();

  const source = immediateReader(() => {
    throw new Error("Rollback must finish before another source read");
  });
  const input = pollInput(fixture, source.reader);
  input.workerExecutionId = "synthetic-storage-crash-restart-worker";
  input.atomicWriter = {
    ...syntheticAtomicWriter,
    write() {
      throw new Error("Synthetic rollback image I/O failure");
    },
  };
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "storage_fault",
        faultCode: null,
        work: expect.objectContaining({ status: "claimed" }),
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
    const crashedDatabase = new DatabaseSync(fixture.databasePath);
    crashedDatabase.prepare(`UPDATE archive_recovery_work
      SET claimed_at = 0
      WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
    crashedDatabase.close();

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(source.start).not.toHaveBeenCalled();
    expect(withDeviceInactive).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      releaseRecoveryWork: false,
    }));
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    input.access.close();
  }
});

it("stops an idle eligible Recovery after its source drive disappears", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 900,
    sectorCount: 1,
    classification: "skipped_untested",
  }], "/dev/synthetic-missing-stop-drive");
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  input.access.catalog.reconcileOpticalDrives([]);
  const withDeviceInactive = vi.fn(async () => {
    throw new Error("Synthetic missing device path");
  });
  input.deviceInactivity.withDeviceInactive = withDeviceInactive;
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000490",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(withDeviceInactive).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
  } finally {
    input.access.close();
  }
});

it("stops queued verification work after its drive disappears", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    "/dev/synthetic-queued-verification-drive",
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000493",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const source = immediateReader(() => {
    throw new Error("No recovery read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  input.access.catalog.reconcileOpticalDrives([]);
  const withDeviceInactive = vi.fn(async () => {
    throw new Error("A queued verification has no active device handle");
  });
  const withDeviceIdentityInactive = vi.fn(async () => {
    throw new Error("A queued verification has no admitted device identity");
  });
  input.deviceInactivity.withDeviceInactive = withDeviceInactive;
  input.deviceInactivity.withDeviceIdentityInactive =
    withDeviceIdentityInactive;
  try {
    input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000494",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass(input)).toBe(true);
    expect(withDeviceInactive).not.toHaveBeenCalled();
    expect(withDeviceIdentityInactive).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect(input.access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )).toMatchObject({ status: "failed" });
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
  await subscribeRecoveryBrowsers(fixture);
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  const reconcile = vi.fn(async () => {
    throw new DvdRecoveryReconciliationFault("STORAGE_UNSUPPORTED");
  }) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    const stop = input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000466",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "STORAGE_UNSUPPORTED",
        stopOperationId: stop.stopOperationId,
        stopRequestedAt: stop.stopRequestedAt,
        stoppedAt: null,
        work: expect.objectContaining({ status: "requested" }),
      });
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(source.start).not.toHaveBeenCalled();
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(input.access, async (_recipient, payload) => {
      sent.push(payload);
    })).toEqual({ accepted: 2, failed: 0 });
    expect(sent[0]!.body).toBe("Archive Recovery needs attention. Inspect the recovery for details.");
  } finally {
    input.access.close();
  }
});

it("releases a faulted Stop reservation after successful reconciliation", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const access = fixture.openAccess();
  try {
    const stop = access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000489",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
      stopOperationId: stop.stopOperationId,
      faultCode: "STORAGE_UNSUPPORTED",
    });
    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        work: expect.objectContaining({ status: "requested" }),
      });

    await expect(reconcileDvdRecoveryCheckpoint({
      access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: seeded.archive.id,
      atomicWriter: syntheticAtomicWriter,
    })).resolves.toMatchObject({ outcome: "already_consistent" });

    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "STORAGE_UNSUPPORTED",
        work: null,
      });
  } finally {
    access.close();
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
      work: expect.objectContaining({ status: "requested" }),
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

it("keeps Stop pending until admitted device inactivity can be acquired", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [{
    startLba: 903,
    sectorCount: 1,
    classification: "skipped_untested",
  }], "/dev/synthetic-recovery-drive");
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => {
    throw new Error("No source read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  let inactivityAttempts = 0;
  input.deviceInactivity.withDeviceIdentityInactive = async (
    _identity,
    mutation,
  ) => {
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
    const candidate = input.access.archiveRecoveryWork
      .claimNextVerifiedCandidate("synthetic-device-inactivity-worker");
    if (candidate === null) throw new Error("Expected recovery claim");
    input.access.archiveRecoveryWork.admitSourceRead(
      candidate.claim,
      seeded.verificationDrive.devicePath,
      syntheticDeviceIdentity(seeded.verificationDrive.devicePath),
    );
    const requested = input.access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000469",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    const crashedDatabase = new DatabaseSync(fixture.databasePath);
    crashedDatabase.prepare(`UPDATE archive_recovery_work
      SET claimed_at = 0
      WHERE archive_recovery_id = ?`).run(seeded.recoveryId);
    crashedDatabase.close();

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
  const claimNext = vi.spyOn(
    input.access.archiveRecoveryWork,
    "claimNextVerifiedCandidate",
  );
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
    expect(claimNext).toHaveBeenCalledOnce();

    input.access.dvdDiscVerifications.fail(verificationClaim);
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(withDeviceInactive).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();
  } finally {
    input.access.close();
  }
});

it("keeps Stop pending while an expired verification helper is still active", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    "/dev/synthetic-expired-verification-drive",
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000490",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const source = immediateReader(() => {
    throw new Error("No recovery read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  const verificationClaim = input.access.dvdDiscVerifications.claimNext(
    "synthetic-expired-verification-worker",
  );
  if (verificationClaim === null) {
    throw new Error("Expected verification claim");
  }
  const verificationIdentity = syntheticDeviceIdentity(
    seeded.verificationDrive.devicePath,
  );
  expect(input.access.dvdDiscVerifications.admitSourceRead(
    verificationClaim,
    verificationIdentity,
  )).toBe(true);
  input.access.archiveRecoveryWork.requestStop({
    mutationKey: "00000000-0000-4000-8000-000000000491",
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE dvd_disc_verifications
    SET claimed_at = 0
    WHERE id = ?`).run(verificationClaim.id);
  database.close();
  let inactivityAttempts = 0;
  input.deviceInactivity.withDeviceIdentityInactive = async (
    identity,
    mutation,
  ) => {
    expect(identity).toEqual(verificationIdentity);
    inactivityAttempts += 1;
    if (inactivityAttempts === 1) {
      throw new Error("Synthetic verification helper remains active");
    }
    await mutation();
  };
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopping" });
    expect(input.access.dvdDiscVerifications.find(verificationClaim.id))
      .toMatchObject({
        status: "completed",
        admittedDevicePath: verificationIdentity.devicePath,
        admittedDeviceId: verificationIdentity.deviceId,
        admittedDeviceInode: verificationIdentity.inode,
      });
    expect(reconcile).not.toHaveBeenCalled();

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(source.start).not.toHaveBeenCalled();
  } finally {
    input.access.close();
  }
});

it("quiesces every admitted verification identity for the stopped attempt", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const devicePath = "/dev/synthetic-reused-verification-drive";
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    devicePath,
  );
  const submitVerification = (key: string) => fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", key,
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect((await submitVerification(
    "00000000-0000-4000-8000-000000000493",
  )).exitCode).toBe(0);
  const source = immediateReader(() => {
    throw new Error("No recovery read is allowed while stopping");
  });
  const input = pollInput(fixture, source.reader);
  const firstClaim = input.access.dvdDiscVerifications.claimNext(
    "synthetic-first-expired-verification-worker",
  );
  if (firstClaim === null) throw new Error("Expected first verification claim");
  const firstIdentity = {
    devicePath,
    deviceId: "2049",
    inode: "17",
  };
  expect(input.access.dvdDiscVerifications.admitSourceRead(
    firstClaim,
    firstIdentity,
  )).toBe(true);
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE dvd_disc_verifications
    SET claimed_at = 0
    WHERE id = ?`).run(firstClaim.id);
  database.close();
  expect(input.access.dvdDiscVerifications.recoverExpiredClaims()).toBe(1);

  expect((await submitVerification(
    "00000000-0000-4000-8000-000000000494",
  )).exitCode).toBe(0);
  const secondClaim = input.access.dvdDiscVerifications.claimNext(
    "synthetic-second-expired-verification-worker",
  );
  if (secondClaim === null) {
    throw new Error("Expected second verification claim");
  }
  const secondIdentity = {
    devicePath,
    deviceId: "2049",
    inode: "18",
  };
  expect(input.access.dvdDiscVerifications.admitSourceRead(
    secondClaim,
    secondIdentity,
  )).toBe(true);
  input.access.archiveRecoveryWork.requestStop({
    mutationKey: "00000000-0000-4000-8000-000000000495",
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  const secondDatabase = new DatabaseSync(fixture.databasePath);
  secondDatabase.prepare(`UPDATE dvd_disc_verifications
    SET claimed_at = 0
    WHERE id = ?`).run(secondClaim.id);
  secondDatabase.close();

  let firstBlocked = true;
  let secondBlocked = true;
  const inspectedIdentities: Array<typeof firstIdentity> = [];
  input.deviceInactivity.withDeviceIdentityInactive = async (
    identity,
    mutation,
  ) => {
    inspectedIdentities.push(identity);
    if (identity.inode === firstIdentity.inode && firstBlocked) {
      firstBlocked = false;
      throw new Error("Synthetic first verification helper remains active");
    }
    if (identity.inode === secondIdentity.inode && secondBlocked) {
      secondBlocked = false;
      throw new Error("Synthetic second verification helper remains active");
    }
    await mutation();
  };
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopping" });

    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(inspectedIdentities).toEqual([
      firstIdentity,
      firstIdentity,
      secondIdentity,
      firstIdentity,
      secondIdentity,
    ]);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "stopped", work: null });
    expect(reconcile).toHaveBeenCalledOnce();
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
    deviceIdentity: syntheticDeviceIdentity(
      "/dev/synthetic-verification-stop-drive",
    ),
    ready: Promise.resolve(),
    authorize: vi.fn(),
  }));
  const access = fixture.openAccess();
  try {
    const polling = pollDvdDiscVerification({
      access,
      deviceInactivity: immediateDeviceInactivity,
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

it("quiesces a verification read when admission fails after start", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    "/dev/synthetic-verification-admission-drive",
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000488",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  let closeRead!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeRead = resolve;
  });
  let rejectRead!: (reason?: unknown) => void;
  const result = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const observeResult = vi.spyOn(result, "catch");
  const cancel = vi.fn(() => {
    expect(observeResult).toHaveBeenCalledOnce();
    rejectRead(new Error("Synthetic cancelled verification read"));
  });
  const authorize = vi.fn();
  const start = vi.fn(() => ({
    result,
    closed,
    cancel,
    deviceIdentity: syntheticDeviceIdentity(
      "/dev/synthetic-verification-admission-drive",
    ),
    ready: Promise.resolve(),
    authorize,
  }));
  const access = fixture.openAccess();
  try {
    vi.spyOn(access.dvdDiscVerifications, "admitSourceRead")
      .mockImplementation(() => {
        throw new Error("Synthetic admission commit failure");
      });
    const fail = vi.spyOn(access.dvdDiscVerifications, "fail");

    const polling = pollDvdDiscVerification({
      access,
      deviceInactivity: immediateDeviceInactivity,
      reader: { start },
      workerExecutionId: "synthetic-verification-admission-worker",
      mediaGenerationObserver: {
        async observe() {
          return "synthetic-verification-generation";
        },
      },
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(authorize).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();

    closeRead();
    await expect(polling).resolves.toBe(true);
    expect(fail).toHaveBeenCalledOnce();
    expect(access.dvdDiscVerifications.findLatestForRecovery(
      seeded.recoveryId,
    )).toMatchObject({ status: "failed" });
  } finally {
    access.close();
  }
});

it("allows Stop after rolled-back verification admission expires without authorizing", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(
    fixture,
    undefined,
    "/dev/synthetic-rolled-back-verification-drive",
  );
  const submitted = await fixture.run([
    "archive-recovery", "verify-disc", seeded.recoveryId,
    "--key", "00000000-0000-4000-8000-000000000497",
    "--disc-inspection-id", seeded.inspection.id,
    "--checkpoint-revision", "1",
    "--checkpoint-digest", seeded.manifest.manifestDigest,
  ]);
  expect(submitted.exitCode).toBe(0);
  const input = pollInput(fixture, immediateReader(() => {
    throw new Error("Stop must not start a recovery read");
  }).reader);
  const claim = input.access.dvdDiscVerifications.claimNext(
    "synthetic-crashed-verification-admission-worker",
  );
  if (claim === null) throw new Error("Expected verification claim");
  const authorize = vi.fn();
  const cancel = vi.fn();
  const start = vi.fn(() => ({
    result: new Promise<never>(() => {}),
    closed: new Promise<void>(() => {}),
    cancel,
    deviceIdentity: {
      ...syntheticDeviceIdentity(seeded.verificationDrive.devicePath),
      inode: "invalid",
    },
    ready: Promise.resolve(),
    authorize,
  }));
  const preparedRead = start();
  await preparedRead.ready;
  expect(() => input.access.dvdDiscVerifications.admitSourceRead(
    claim,
    preparedRead.deviceIdentity,
  )).toThrow("DVD Disc Verification source device identity is invalid");
  expect(input.access.dvdDiscVerifications.find(claim.id)).toMatchObject({
    status: "running",
    admittedDevicePath: null,
    admittedDeviceId: null,
    admittedDeviceInode: null,
  });
  const database = new DatabaseSync(fixture.databasePath);
  database.prepare(`UPDATE dvd_disc_verifications
    SET claimed_at = 0
    WHERE id = ?`).run(claim.id);
  database.close();
  input.access.archiveRecoveryWork.requestStop({
    mutationKey: "00000000-0000-4000-8000-000000000498",
    archiveRecoveryId: seeded.recoveryId,
    attemptId: seeded.attemptId,
  });
  const reconcile = vi.fn(async () => ({
    outcome: "already_consistent",
    evidence: {},
  })) as unknown as typeof reconcileDvdRecoveryCheckpoint;
  try {
    expect(await pollDvdRecoveryPass({ ...input, reconcile })).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
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

    expect(() => access.archiveRecoveryWork.admitSourceRead(
      claim,
      seeded.verificationDrive.devicePath,
      syntheticDeviceIdentity(seeded.verificationDrive.devicePath),
    ))
      .toThrow();
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

it("rolls forward a published checkpoint and explicitly resumes after a storage fault", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture, [
    { startLba: 900, sectorCount: 2, classification: "skipped_untested" },
  ]);
  await completeVerification(fixture, seeded);
  await subscribeRecoveryBrowsers(fixture);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x6b),
  }));
  const input = pollInput(fixture, source.reader);
  let directorySyncCount = 0;
  const commit: typeof commitDvdRecoveryBatch = (options) => {
    return commitDvdRecoveryBatch({
      ...options,
      async directorySync() {
        directorySyncCount += 1;
        if (directorySyncCount === 4) {
          throw new Error("Synthetic checkpoint directory sync failure");
        }
      },
    });
  };
  try {
    expect(await pollDvdRecoveryPass({ ...input, commit })).toBe(true);
    expect(directorySyncCount).toBe(4);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "storage_fault",
        faultCode: null,
        work: expect.objectContaining({ status: "claimed" }),
      });

    await expect(reconcileDvdRecoveryCheckpoint({
      access: input.access,
      originalsLibraryPath: fixture.originalsLibraryPath,
      originalDiscArchiveId: seeded.archive.id,
      atomicWriter: syntheticAtomicWriter,
    })).resolves.toMatchObject({
      outcome: "rolled_forward",
      evidence: { authoritativeCheckpoint: { revision: 2 } },
    });
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "paused",
        pauseReason: "storage_fault",
        work: null,
      });
    const reconciled = input.access.catalog.findArchiveRecoveryById(
      seeded.recoveryId,
    )!;
    const checkpoint = input.access.catalog.findDvdArchiveEvidenceHeader(
      seeded.archive.id,
    )!;
    expect(await fixture.run([
      "archive-recovery",
      "resume",
      reconciled.id,
      "--key",
      "00000000-0000-4000-8000-000000000501",
      "--attempt-id",
      reconciled.attemptId,
      "--checkpoint-revision",
      String(checkpoint.currentManifestRevision),
      "--checkpoint-digest",
      checkpoint.currentManifestDigest,
      "--speed-mode",
      "normal",
    ])).toMatchObject({
      exitCode: 0,
      result: {
        archiveRecovery: {
          status: "eligible",
          pauseReason: null,
          work: { status: "requested" },
        },
      },
    });
    completeQueuedVerification(fixture, seeded);
    expect(await pollDvdRecoveryPass(input)).toBe(true);
    const sent: NotificationPayload[] = [];
    expect(await dispatchNotifications(input.access, async (_recipient, payload) => {
      sent.push(payload);
    })).toEqual({ accepted: 4, failed: 0 });
    expect(new Set(sent.map(({ tag }) => tag)).size).toBe(2);
    expect(new Set(sent.map(({ body }) => body))).toEqual(new Set([
      "Archive Recovery needs attention. Inspect the recovery for details.",
      "Archive Recovery completed. All remaining source recovered.",
    ]));
  } finally {
    input.access.close();
  }
});

it.each([
  "CHECKPOINT_CAPACITY_EXHAUSTED",
  "IMAGE_SYNC_FAILED",
  "CHECKPOINT_SYNC_FAILED",
] as const)("does not relabel %s consistency failures as storage faults", async (
  faultCode,
) => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048, 0x6c),
  }));
  const input = pollInput(fixture, source.reader);
  try {
    expect(await pollDvdRecoveryPass({
      ...input,
      async commit() {
        throw new DvdRecoveryBatchFault(faultCode, {
          retainRecoveryWork: true,
        });
      },
    })).toBe(true);
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        pauseReason: null,
        faultCode,
        work: expect.objectContaining({ status: "claimed" }),
      });
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
      storageFault: false,
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

it("preserves a Stop that wins the race with pass settlement", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const authority = await completeVerification(fixture, seeded);
  const access = fixture.openAccess();
  try {
    const claim = access.archiveRecoveryWork.claim(
      access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
      "synthetic-settlement-racing-recovery-worker",
    );
    access.archiveRecoveryWork.bindVerification(claim, authority);
    access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000479",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });

    access.archiveRecoveryWork.settlePass(claim);

    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "stopping",
        work: expect.objectContaining({
          claimToken: claim.claimToken,
          status: "claimed",
        }),
      });
  } finally {
    access.close();
  }
});

it("preserves a faulted Stop claim against stale pass settlement", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  const authority = await completeVerification(fixture, seeded);
  const access = fixture.openAccess();
  try {
    const claim = access.archiveRecoveryWork.claim(
      access.archiveRecoveryWork.request(seeded.recoveryId).archiveRecoveryId,
      "synthetic-faulted-stop-racing-recovery-worker",
    );
    access.archiveRecoveryWork.bindVerification(claim, authority);
    const stop = access.archiveRecoveryWork.requestStop({
      mutationKey: "00000000-0000-4000-8000-000000000480",
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
    });
    access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: seeded.recoveryId,
      attemptId: seeded.attemptId,
      stopOperationId: stop.stopOperationId,
      faultCode: "CONSISTENCY_FAULT",
    });

    access.archiveRecoveryWork.settlePass(claim);

    expect(access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({
        status: "faulted",
        faultCode: "CONSISTENCY_FAULT",
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

it("leaves eligible Recovery work dormant on unsupported storage", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const seeded = await seedDvdDiscVerificationFixture(fixture);
  await completeVerification(fixture, seeded);
  const source = immediateReader(() => ({
    outcome: "readable",
    bytes: Buffer.alloc(2_048),
  }));
  const input = pollInput(fixture, source.reader);
  const supported = input.access.dvdRecoveryStorage.readCurrent();
  if (supported === null) throw new Error("Expected storage preflight");
  input.access.dvdRecoveryStorage.record({
    contractVersion: supported.contractVersion,
    status: "unsupported",
    reasonCode: "STORAGE_UNSUPPORTED",
    facts: {
      ...supported.facts,
      mutationProtection: {
        status: "unproven",
        contract: null,
        unitBytes: null,
        memoryAlignmentBytes: null,
      },
    },
  });
  try {
    expect(await pollDvdRecoveryPass(input)).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
    expect(input.access.catalog.findArchiveRecoveryById(seeded.recoveryId))
      .toMatchObject({ status: "eligible", faultCode: null, work: null });
  } finally {
    input.access.close();
  }
});
