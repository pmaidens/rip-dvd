import {
  dvdDiscVerificationInsertionIsCurrent,
  dvdRecoveryWriteAuthority,
  type ArchiveRecovery,
  type ArchiveRecoveryFaultCode,
  type ClaimedArchiveRecoveryWork,
  type DataAccess,
  type DvdRecoveryWriteAuthority,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import type { ActiveBoundedProcess } from "./bounded-child-process.js";
import {
  createNodeDvdRecoverySourceReader,
  type DvdRecoverySourceReader,
  type DvdSourceRead,
} from "./dvd-disc-verifier.js";
import {
  commitDvdRecoveryBatch,
  DvdRecoveryBatchFault,
  type DvdRecoveryAtomicWriter,
} from "./dvd-recovery-batch.js";
import {
  DvdRecoveryReconciliationFault,
  reconcileDvdRecoveryCheckpoint,
} from "./dvd-recovery-reconciliation.js";
import { runDurableWorkPoller } from "./durable-work-poller.js";
import type { DvdCopyRunner } from "./dvd-archiver.js";
import {
  createNodeMediaGenerationObserver,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";

const DEFAULT_STOP_POLL_INTERVAL_MS = 100;

type DvdRecoveryPassFaultCode =
  | "SOURCE_CHANGED"
  | "SOURCE_OBSERVATION_FAILED"
  | "SOURCE_READ_FAILED"
  | "SOURCE_NOT_READY"
  | "SOURCE_UNIT_ATTENTION"
  | "SOURCE_HARDWARE_ERROR"
  | "SOURCE_TRANSPORT_ERROR"
  | "SOURCE_PROTECTION_ERROR"
  | "SOURCE_OUT_OF_RANGE"
  | "SOURCE_READ_UNCLASSIFIED";

export class DvdRecoveryPassFault extends Error {
  override readonly name = "DvdRecoveryPassFault";

  constructor(
    readonly code: DvdRecoveryPassFaultCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

function sourceFaultCode(
  diagnostic: Extract<
    DvdSourceRead,
    { outcome: "unreadable" }
  >["diagnostic"],
): DvdRecoveryPassFaultCode {
  switch (diagnostic.category) {
    case "not_ready":
      return "SOURCE_NOT_READY";
    case "unit_attention":
      return "SOURCE_UNIT_ATTENTION";
    case "hardware_error":
      return "SOURCE_HARDWARE_ERROR";
    case "transport_error":
      return "SOURCE_TRANSPORT_ERROR";
    case "protection_error":
      return "SOURCE_PROTECTION_ERROR";
    case "out_of_range":
      return "SOURCE_OUT_OF_RANGE";
    case "unknown":
      return "SOURCE_READ_UNCLASSIFIED";
    case "medium_error":
      throw new Error("A medium error is recoverable source evidence");
  }
}

function currentRecovery(
  access: DataAccess,
  expected: Pick<ArchiveRecovery, "id" | "attemptId">,
): ArchiveRecovery {
  const recovery = access.catalog.findArchiveRecoveryById(expected.id);
  if (recovery === null || recovery.attemptId !== expected.attemptId) {
    throw new DvdRecoveryPassFault("SOURCE_CHANGED");
  }
  return recovery;
}

async function insertionIsCurrent(input: {
  access: DataAccess;
  authority: DvdRecoveryWriteAuthority;
  mediaGenerationObserver: MediaGenerationObserver;
  signal: AbortSignal;
}): Promise<boolean> {
  const inspection = input.access.discInspections.list({
    ids: [input.authority.discInspectionId],
  })[0];
  if (!dvdDiscVerificationInsertionIsCurrent(input.authority, inspection)) {
    return false;
  }
  const drive = input.access.catalog.listOpticalDrives({
    ids: [inspection.opticalDriveId],
  })[0];
  if (drive === undefined) return false;
  try {
    return await input.mediaGenerationObserver.observe(
      drive.devicePath,
      input.signal,
    ) === input.authority.mediaGeneration &&
      dvdDiscVerificationInsertionIsCurrent(
        input.authority,
        input.access.discInspections.list({
          ids: [input.authority.discInspectionId],
        })[0],
      );
  } catch (cause) {
    if (input.signal.aborted) throw cause;
    throw new DvdRecoveryPassFault("SOURCE_OBSERVATION_FAILED", { cause });
  }
}

function devicePathForAuthority(
  access: DataAccess,
  authority: DvdRecoveryWriteAuthority,
): string {
  const inspection = access.discInspections.list({
    ids: [authority.discInspectionId],
  })[0];
  const drive = inspection === undefined
    ? undefined
    : access.catalog.listOpticalDrives({
        ids: [inspection.opticalDriveId],
      })[0];
  if (drive === undefined) {
    throw new DvdRecoveryPassFault("SOURCE_CHANGED");
  }
  return drive.devicePath;
}

async function waitForRead(input: {
  active: ActiveBoundedProcess<DvdSourceRead>;
  access: DataAccess;
  recovery: Pick<ArchiveRecovery, "id" | "attemptId">;
  signal: AbortSignal;
  stopPollIntervalMs: number;
}): Promise<
  | { outcome: "completed"; read: DvdSourceRead }
  | { outcome: "stopped" }
> {
  let interval: NodeJS.Timeout | undefined;
  let removeAbortListener = () => {};
  const stopped = new Promise<{ outcome: "stopped" }>((resolve, reject) => {
    const inspect = () => {
      try {
        const recovery = currentRecovery(input.access, input.recovery);
        if (recovery.status === "stopping") resolve({ outcome: "stopped" });
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = () => reject(input.signal.reason ?? new Error("Aborted"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      input.signal.removeEventListener("abort", onAbort);
    interval = setInterval(inspect, input.stopPollIntervalMs);
    interval.unref();
    inspect();
  });
  try {
    const result = await Promise.race([
      input.active.result.then((read) => ({
        outcome: "completed" as const,
        read,
      })),
      stopped,
    ]);
    if (result.outcome === "stopped") input.active.cancel();
    await input.active.closed;
    return result;
  } catch (cause) {
    input.active.cancel();
    await input.active.closed;
    if (cause instanceof DvdRecoveryPassFault) throw cause;
    throw new DvdRecoveryPassFault("SOURCE_READ_FAILED", { cause });
  } finally {
    clearInterval(interval);
    removeAbortListener();
  }
}

async function finalizeStop(input: {
  access: DataAccess;
  archiveImageOwnership: ArchiveImageOwnership;
  deviceInactivity: Pick<DvdCopyRunner, "withDeviceInactive">;
  originalsLibraryPath: string;
  recovery: ArchiveRecovery;
  reconcile: typeof reconcileDvdRecoveryCheckpoint;
  signal: AbortSignal;
}): Promise<void> {
  if (input.recovery.stopOperationId === null) {
    throw new Error("Archive Recovery Stop has no operation identity");
  }
  const verificationId = input.recovery.work?.verificationId;
  const verification = verificationId === null || verificationId === undefined
    ? null
    : input.access.dvdDiscVerifications.find(verificationId);
  if (
    verificationId !== null && verificationId !== undefined &&
    (verification === null ||
      verification.archiveRecoveryId !== input.recovery.id ||
      verification.archiveRecoveryAttemptId !== input.recovery.attemptId ||
      verification.originalDiscArchiveId !==
        input.recovery.originalDiscArchiveId)
  ) {
    throw new DvdRecoveryPassFault("SOURCE_CHANGED");
  }
  const inspection = verification === null
    ? undefined
    : input.access.discInspections.list({
        ids: [verification.discInspectionId],
      })[0];
  const archive = verification !== null
    ? undefined
    : input.access.catalog.listOriginalDiscArchives({
        ids: [input.recovery.originalDiscArchiveId],
      })[0];
  const source = archive === undefined
    ? undefined
    : input.access.catalog.listDetectedDiscs(undefined, {
        ids: [archive.detectedDiscId],
      })[0];
  const opticalDriveId = inspection?.opticalDriveId ?? source?.opticalDriveId;
  const drive = opticalDriveId === undefined
    ? undefined
    : input.access.catalog.listOpticalDrives({ ids: [opticalDriveId] })[0];
  if (drive === undefined) {
    throw new DvdRecoveryPassFault("SOURCE_CHANGED");
  }
  await input.deviceInactivity.withDeviceInactive(drive.devicePath, async () => {
    await input.reconcile({
      access: input.access,
      originalsLibraryPath: input.originalsLibraryPath,
      originalDiscArchiveId: input.recovery.originalDiscArchiveId,
      archiveImageOwnership: input.archiveImageOwnership,
      signal: input.signal,
    });
    input.access.archiveRecoveryWork.completeStop({
      archiveRecoveryId: input.recovery.id,
      attemptId: input.recovery.attemptId,
      stopOperationId: input.recovery.stopOperationId!,
    });
  });
}

function stopFaultCode(error: unknown): ArchiveRecoveryFaultCode {
  return error instanceof DvdRecoveryPassFault ||
      error instanceof DvdRecoveryReconciliationFault
    ? error.code
    : "CONSISTENCY_FAULT";
}

async function finalizeStopSafely(input: Parameters<typeof finalizeStop>[0]) {
  try {
    await finalizeStop(input);
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (input.recovery.stopOperationId === null) throw error;
    input.access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: input.recovery.id,
      attemptId: input.recovery.attemptId,
      stopOperationId: input.recovery.stopOperationId,
      faultCode: stopFaultCode(error),
    });
  }
}

export async function pollDvdRecoveryPass(input: {
  access: DataAccess;
  atomicWriter?: DvdRecoveryAtomicWriter;
  archiveImageOwnership?: ArchiveImageOwnership;
  deviceInactivity: Pick<DvdCopyRunner, "withDeviceInactive">;
  mediaGenerationObserver: MediaGenerationObserver;
  originalsLibraryPath: string;
  reader: DvdRecoverySourceReader;
  reconcile?: typeof reconcileDvdRecoveryCheckpoint;
  signal?: AbortSignal;
  stopPollIntervalMs?: number;
  workerExecutionId: string;
}): Promise<boolean> {
  const signal = input.signal ?? new AbortController().signal;
  const archiveImageOwnership = input.archiveImageOwnership ??
    defaultArchiveImageOwnership;
  const reconcile = input.reconcile ?? reconcileDvdRecoveryCheckpoint;
  const stopping = input.access.archiveRecoveryWork.findNextStopping();
  if (stopping !== null) {
    await finalizeStopSafely({
      ...input,
      archiveImageOwnership,
      reconcile,
      recovery: stopping,
      signal,
    });
    return true;
  }

  const candidate = input.access.archiveRecoveryWork
    .claimNextVerifiedCandidate(input.workerExecutionId);
  if (candidate === null) return false;
  const claim: ClaimedArchiveRecoveryWork = candidate.claim;
  try {
    const authority = dvdRecoveryWriteAuthority(candidate.verification);
    if (authority === null) {
      throw new Error("DVD Recovery candidate lacks write authority");
    }
    const checkpoint = await input.access.readDvdCheckpoint(
      candidate.recovery.originalDiscArchiveId,
      archiveImageOwnership,
    );
    if (checkpoint === null) {
      throw new DvdRecoveryPassFault("SOURCE_READ_FAILED");
    }
    const ranges = checkpoint.unrecoveredSourceRanges.map((range) => ({
      startLba: range.startLba,
      sectorCount: range.sectorCount,
    }));
    const devicePath = devicePathForAuthority(input.access, authority);
    for (const range of ranges) {
      for (
        let startLba = range.startLba;
        startLba < range.startLba + range.sectorCount;
        startLba += 1
      ) {
        signal.throwIfAborted();
        const before = currentRecovery(input.access, candidate.recovery);
        if (before.status === "stopping") {
          await finalizeStopSafely({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: before,
            signal,
          });
          return true;
        }
        if (before.status !== "running") {
          throw new DvdRecoveryPassFault("SOURCE_CHANGED");
        }
        input.access.archiveRecoveryWork.assertClaim(claim);
        if (!await insertionIsCurrent({
          access: input.access,
          authority,
          mediaGenerationObserver: input.mediaGenerationObserver,
          signal,
        })) {
          throw new DvdRecoveryPassFault("SOURCE_CHANGED");
        }
        let admittedRead: ActiveBoundedProcess<DvdSourceRead> | undefined;
        try {
          input.access.archiveRecoveryWork.admitSourceRead(claim, () => {
            try {
              admittedRead = input.reader.start({
                devicePath,
                startLba,
                sectorCount: 1,
                acceptedEndLbaExclusive: checkpoint.acceptedEndLbaExclusive,
              });
            } catch (cause) {
              throw new DvdRecoveryPassFault("SOURCE_READ_FAILED", { cause });
            }
          });
        } catch (error) {
          if (admittedRead !== undefined) {
            admittedRead.cancel();
            await admittedRead.closed;
          }
          throw error;
        }
        if (admittedRead === undefined) {
          throw new DvdRecoveryPassFault("SOURCE_READ_FAILED");
        }
        const completed = await waitForRead({
          active: admittedRead,
          access: input.access,
          recovery: candidate.recovery,
          signal,
          stopPollIntervalMs: input.stopPollIntervalMs ??
            DEFAULT_STOP_POLL_INTERVAL_MS,
        });
        const afterRead = currentRecovery(input.access, candidate.recovery);
        if (completed.outcome === "stopped" || afterRead.status === "stopping") {
          await finalizeStopSafely({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: afterRead,
            signal,
          });
          return true;
        }
        if (!await insertionIsCurrent({
          access: input.access,
          authority,
          mediaGenerationObserver: input.mediaGenerationObserver,
          signal,
        })) {
          throw new DvdRecoveryPassFault("SOURCE_CHANGED");
        }
        const observation = completed.read.outcome === "readable"
          ? {
              startLba,
              outcome: "recovered" as const,
              bytes: completed.read.bytes,
            }
          : completed.read.diagnostic.category === "medium_error"
            ? { startLba, outcome: "failed" as const }
            : (() => {
                throw new DvdRecoveryPassFault(
                  sourceFaultCode(completed.read.diagnostic),
                );
              })();
        await commitDvdRecoveryBatch({
          access: input.access,
          originalsLibraryPath: input.originalsLibraryPath,
          originalDiscArchiveId: candidate.recovery.originalDiscArchiveId,
          recoveryWorkClaim: claim,
          writeAuthority: authority,
          observation,
          archiveImageOwnership,
          atomicWriter: input.atomicWriter,
          signal,
        });
        const afterBatch = currentRecovery(input.access, candidate.recovery);
        if (afterBatch.status === "stopping") {
          await finalizeStopSafely({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: afterBatch,
            signal,
          });
          return true;
        }
      }
    }
    input.access.archiveRecoveryWork.settlePass(claim);
  } catch (error) {
    if (signal.aborted) throw error;
    const recovery = currentRecovery(input.access, candidate.recovery);
    if (recovery.status === "stopping") {
      await finalizeStopSafely({
        ...input,
        archiveImageOwnership,
        reconcile,
        recovery,
        signal,
      });
      return true;
    }
    input.access.archiveRecoveryWork.markFault({
      claim,
      faultCode: error instanceof DvdRecoveryPassFault ||
          error instanceof DvdRecoveryBatchFault
        ? error.code
        : "CONSISTENCY_FAULT",
      retainWork: error instanceof DvdRecoveryBatchFault &&
        error.retainRecoveryWork,
    });
  }
  return true;
}

export async function runDvdRecoveryWorker(input: {
  access: DataAccess;
  deviceInactivity: Pick<DvdCopyRunner, "withDeviceInactive">;
  intervalMs: number;
  log(message: string): void;
  originalsLibraryPath: string;
  signal: AbortSignal;
  workerExecutionId: string;
  reader?: DvdRecoverySourceReader;
  mediaGenerationObserver?: MediaGenerationObserver;
}): Promise<void> {
  const reader = input.reader ?? createNodeDvdRecoverySourceReader();
  const mediaGenerationObserver = input.mediaGenerationObserver ??
    createNodeMediaGenerationObserver();
  await runDurableWorkPoller({
    intervalMs: input.intervalMs,
    signal: input.signal,
    log: input.log,
    poll: () => pollDvdRecoveryPass({
      ...input,
      reader,
      mediaGenerationObserver,
    }),
    pollFailureMessage: "DVD Recovery worker poll failed.",
    waitFailureMessage: "DVD Recovery worker wait failed",
  });
}
