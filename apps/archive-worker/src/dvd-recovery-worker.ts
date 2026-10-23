import {
  dvdDiscVerificationInsertionIsCurrent,
  dvdRecoveryWriteAuthority,
  DVD_RECOVERY_PASS_CLAIM_LEASE_MS,
  type ArchiveRecovery,
  type ArchiveRecoveryFaultCode,
  type ClaimedArchiveRecoveryWork,
  type DataAccess,
  type DvdRecoveryWriteAuthority,
  type OpticalDeviceIdentity,
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
import type {
  DvdCopyRunner,
  DvdDeviceIdentityInactivityGuard,
} from "./dvd-archiver.js";
import {
  createNodeMediaGenerationObserver,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";

const DEFAULT_STOP_POLL_INTERVAL_MS = 100;

type DvdRecoveryDeviceInactivity = Pick<
  DvdCopyRunner,
  "withDeviceInactive"
> & DvdDeviceIdentityInactivityGuard;

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

class DvdRecoveryStopDeferred extends Error {
  override readonly name = "DvdRecoveryStopDeferred";
}

function admittedDeviceIdentity(
  recovery: ArchiveRecovery,
): OpticalDeviceIdentity | null {
  const work = recovery.work;
  if (work === null || work.admittedDevicePath === null) return null;
  if (
    work.admittedDeviceId === null ||
    work.admittedDeviceInode === null
  ) {
    throw new DvdRecoveryPassFault("SOURCE_CHANGED");
  }
  return {
    devicePath: work.admittedDevicePath,
    deviceId: work.admittedDeviceId,
    inode: work.admittedDeviceInode,
  };
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

async function currentInsertionDevicePath(input: {
  access: DataAccess;
  authority: DvdRecoveryWriteAuthority;
  mediaGenerationObserver: MediaGenerationObserver;
  signal: AbortSignal;
}): Promise<string | null> {
  const inspection = input.access.discInspections.list({
    ids: [input.authority.discInspectionId],
  })[0];
  if (!dvdDiscVerificationInsertionIsCurrent(input.authority, inspection)) {
    return null;
  }
  const drive = input.access.catalog.listOpticalDrives({
    ids: [inspection.opticalDriveId],
  })[0];
  if (drive === undefined || !drive.isPresent || !drive.isEnabled) return null;
  const devicePath = drive.devicePath;
  try {
    const mediaGeneration = await input.mediaGenerationObserver.observe(
      devicePath,
      input.signal,
    );
    const currentInspection = input.access.discInspections.list({
      ids: [input.authority.discInspectionId],
    })[0];
    const currentDrive = currentInspection === undefined
      ? undefined
      : input.access.catalog.listOpticalDrives({
          ids: [currentInspection.opticalDriveId],
        })[0];
    return mediaGeneration === input.authority.mediaGeneration &&
        dvdDiscVerificationInsertionIsCurrent(
          input.authority,
          currentInspection,
        ) &&
        currentDrive?.isPresent === true &&
        currentDrive.isEnabled &&
        currentDrive.devicePath === devicePath
      ? devicePath
      : null;
  } catch (cause) {
    if (input.signal.aborted) throw cause;
    throw new DvdRecoveryPassFault("SOURCE_OBSERVATION_FAILED", { cause });
  }
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
  deviceInactivity: DvdRecoveryDeviceInactivity;
  originalsLibraryPath: string;
  recovery: ArchiveRecovery;
  reconcile: typeof reconcileDvdRecoveryCheckpoint;
  signal: AbortSignal;
}): Promise<void> {
  const stopOperationId = input.recovery.stopOperationId;
  if (stopOperationId === null) {
    throw new Error("Archive Recovery Stop has no operation identity");
  }
  if (!input.access.archiveRecoveryWork.prepareStop({
    archiveRecoveryId: input.recovery.id,
    attemptId: input.recovery.attemptId,
    stopOperationId,
  })) {
    throw new DvdRecoveryStopDeferred(
      "Stop is waiting for DVD Disc Verification to settle",
    );
  }
  const reconcileAndComplete = async () => {
    await input.reconcile({
      access: input.access,
      originalsLibraryPath: input.originalsLibraryPath,
      originalDiscArchiveId: input.recovery.originalDiscArchiveId,
      archiveImageOwnership: input.archiveImageOwnership,
      releaseRecoveryWork: false,
      signal: input.signal,
    });
    input.access.archiveRecoveryWork.completeStop({
      archiveRecoveryId: input.recovery.id,
      attemptId: input.recovery.attemptId,
      stopOperationId,
    });
  };
  const deviceIdentity = admittedDeviceIdentity(input.recovery);
  if (deviceIdentity === null) {
    try {
      await reconcileAndComplete();
    } catch (cause) {
      if (
        cause instanceof DvdRecoveryReconciliationFault &&
        cause.code === "WRITER_NOT_QUIESCENT"
      ) {
        throw new DvdRecoveryStopDeferred(
          "Stop is waiting for quiescence",
          { cause },
        );
      }
      throw cause;
    }
    return;
  }
  let deviceInactive = false;
  try {
    await input.deviceInactivity.withDeviceIdentityInactive(
      deviceIdentity,
      async () => {
        deviceInactive = true;
        await reconcileAndComplete();
      },
    );
  } catch (cause) {
    if (
      !deviceInactive ||
      (cause instanceof DvdRecoveryReconciliationFault &&
        cause.code === "WRITER_NOT_QUIESCENT")
    ) {
      throw new DvdRecoveryStopDeferred("Stop is waiting for quiescence", {
        cause,
      });
    }
    throw cause;
  }
}

async function reclaimInterruptedPass(input: {
  access: DataAccess;
  atomicWriter?: DvdRecoveryAtomicWriter;
  archiveImageOwnership: ArchiveImageOwnership;
  deviceInactivity: DvdRecoveryDeviceInactivity;
  originalsLibraryPath: string;
  recovery: ArchiveRecovery;
  reconcile: typeof reconcileDvdRecoveryCheckpoint;
  signal: AbortSignal;
}): Promise<"reclaimed" | "deferred" | "faulted"> {
  const work = input.recovery.work;
  if (
    work === null ||
    work.status !== "claimed" ||
    work.claimedBy === null ||
    work.claimToken === null ||
    work.claimedAt === null
  ) {
    throw new DvdRecoveryPassFault("SOURCE_CHANGED");
  }
  const claim = work as ClaimedArchiveRecoveryWork;
  const reconcileAndRequeue = async () => {
    await input.reconcile({
      access: input.access,
      originalsLibraryPath: input.originalsLibraryPath,
      originalDiscArchiveId: input.recovery.originalDiscArchiveId,
      archiveImageOwnership: input.archiveImageOwnership,
      atomicWriter: input.atomicWriter,
      releaseRecoveryWork: false,
      signal: input.signal,
    });
    input.access.archiveRecoveryWork.requeue(claim);
  };
  let quiescenceEntered = false;
  try {
    const deviceIdentity = admittedDeviceIdentity(input.recovery);
    if (deviceIdentity === null) {
      quiescenceEntered = true;
      await reconcileAndRequeue();
    } else {
      await input.deviceInactivity.withDeviceIdentityInactive(
        deviceIdentity,
        async () => {
          quiescenceEntered = true;
          await reconcileAndRequeue();
        },
      );
    }
    return "reclaimed";
  } catch (error) {
    if (
      !quiescenceEntered ||
      (error instanceof DvdRecoveryReconciliationFault &&
        error.code === "WRITER_NOT_QUIESCENT")
    ) {
      return "deferred";
    }
    input.access.archiveRecoveryWork.markFault({
      claim,
      faultCode: stopFaultCode(error),
      retainWork: true,
    });
    return "faulted";
  }
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
    return "completed" as const;
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (input.recovery.stopOperationId === null) throw error;
    if (error instanceof DvdRecoveryStopDeferred) {
      input.access.archiveRecoveryWork.deferStop({
        archiveRecoveryId: input.recovery.id,
        attemptId: input.recovery.attemptId,
        stopOperationId: input.recovery.stopOperationId,
      });
      return "deferred" as const;
    }
    input.access.archiveRecoveryWork.markStopFault({
      archiveRecoveryId: input.recovery.id,
      attemptId: input.recovery.attemptId,
      stopOperationId: input.recovery.stopOperationId,
      faultCode: stopFaultCode(error),
    });
    return "faulted" as const;
  }
}

export async function pollDvdRecoveryPass(input: {
  access: DataAccess;
  atomicWriter?: DvdRecoveryAtomicWriter;
  archiveImageOwnership?: ArchiveImageOwnership;
  commit?: typeof commitDvdRecoveryBatch;
  deviceInactivity: DvdRecoveryDeviceInactivity;
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
    const outcome = await finalizeStopSafely({
      ...input,
      archiveImageOwnership,
      reconcile,
      recovery: stopping,
      signal,
    });
    if (outcome !== "deferred") return true;
  }

  const storage = input.access.dvdRecoveryStorage.readCurrent();
  if (
    storage?.status !== "supported" ||
    storage.facts.mutationProtection.status !== "verified"
  ) return false;

  const interrupted = input.access.archiveRecoveryWork.findNextInterrupted(
    input.workerExecutionId,
  );
  if (interrupted !== null) {
    const outcome = await reclaimInterruptedPass({
      ...input,
      archiveImageOwnership,
      reconcile,
      recovery: interrupted,
      signal,
    });
    return outcome !== "deferred";
  }

  const candidate = input.access.archiveRecoveryWork
    .claimNextVerifiedCandidate(input.workerExecutionId);
  if (candidate === null) return false;
  const claim: ClaimedArchiveRecoveryWork = candidate.claim;
  let renewalFault: unknown;
  const renewalInterval = setInterval(() => {
    try {
      if (!input.access.archiveRecoveryWork.renewClaim(claim)) {
        renewalFault = new DvdRecoveryPassFault("SOURCE_CHANGED");
      }
    } catch (error) {
      renewalFault = error;
    }
  }, Math.floor(DVD_RECOVERY_PASS_CLAIM_LEASE_MS / 2));
  renewalInterval.unref();
  const throwIfRenewalFailed = () => {
    if (renewalFault !== undefined) throw renewalFault;
  };
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
    const firstUnattemptedLba = claim.passCursorLba === null
      ? 0
      : claim.passCursorLba + 1;
    const ranges = checkpoint.unrecoveredSourceRanges.flatMap((range) => {
      const endLbaExclusive = range.startLba + range.sectorCount;
      const startLba = Math.max(range.startLba, firstUnattemptedLba);
      return startLba >= endLbaExclusive
        ? []
        : [{ startLba, sectorCount: endLbaExclusive - startLba }];
    });
    for (const range of ranges) {
      for (
        let startLba = range.startLba;
        startLba < range.startLba + range.sectorCount;
        startLba += 1
      ) {
        throwIfRenewalFailed();
        signal.throwIfAborted();
        const before = currentRecovery(input.access, candidate.recovery);
        if (before.status === "stopping") {
          const outcome = await finalizeStopSafely({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: before,
            signal,
          });
          return outcome !== "deferred";
        }
        if (before.status !== "running") {
          throw new DvdRecoveryPassFault("SOURCE_CHANGED");
        }
        input.access.archiveRecoveryWork.assertClaim(claim);
        const devicePath = await currentInsertionDevicePath({
          access: input.access,
          authority,
          mediaGenerationObserver: input.mediaGenerationObserver,
          signal,
        });
        if (devicePath === null) {
          throw new DvdRecoveryPassFault("SOURCE_CHANGED");
        }
        let admittedRead:
          | ReturnType<DvdRecoverySourceReader["start"]>
          | undefined;
        try {
          const admitted = input.access.archiveRecoveryWork.admitSourceRead(
            claim,
            devicePath,
            (admittedDevicePath) => {
              try {
                admittedRead = input.reader.start({
                  devicePath: admittedDevicePath,
                  startLba,
                  sectorCount: 1,
                  acceptedEndLbaExclusive:
                    checkpoint.acceptedEndLbaExclusive,
                });
                return admittedRead.deviceIdentity;
              } catch (cause) {
                throw new DvdRecoveryPassFault("SOURCE_READ_FAILED", {
                  cause,
                });
              }
            },
          );
          if (admitted === null) {
            throw new DvdRecoveryPassFault("SOURCE_CHANGED");
          }
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
          const outcome = await finalizeStopSafely({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: afterRead,
            signal,
          });
          return outcome !== "deferred";
        }
        if (await currentInsertionDevicePath({
          access: input.access,
          authority,
          mediaGenerationObserver: input.mediaGenerationObserver,
          signal,
        }) !== devicePath) {
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
        await (input.commit ?? commitDvdRecoveryBatch)({
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
        throwIfRenewalFailed();
        const afterBatch = currentRecovery(input.access, candidate.recovery);
        if (afterBatch.status === "stopping") {
          const outcome = await finalizeStopSafely({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: afterBatch,
            signal,
          });
          return outcome !== "deferred";
        }
      }
    }
    input.access.archiveRecoveryWork.settlePass(claim);
  } catch (error) {
    if (signal.aborted) {
      const recovery = currentRecovery(input.access, candidate.recovery);
      if (recovery.status !== "stopping") {
        if (error instanceof DvdRecoveryBatchFault) {
          try {
            await reconcile({
              access: input.access,
              originalsLibraryPath: input.originalsLibraryPath,
              originalDiscArchiveId: recovery.originalDiscArchiveId,
              archiveImageOwnership,
              atomicWriter: input.atomicWriter,
              releaseRecoveryWork: false,
            });
            input.access.archiveRecoveryWork.requeue(claim);
          } catch (reconciliationError) {
            input.access.archiveRecoveryWork.markFault({
              claim,
              faultCode: stopFaultCode(reconciliationError),
              retainWork: true,
            });
          }
        } else {
          input.access.archiveRecoveryWork.requeue(claim);
        }
      }
      throw error;
    }
    const recovery = currentRecovery(input.access, candidate.recovery);
    if (recovery.status === "stopping") {
      const outcome = await finalizeStopSafely({
        ...input,
        archiveImageOwnership,
        reconcile,
        recovery,
        signal,
      });
      return outcome !== "deferred";
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
  } finally {
    clearInterval(renewalInterval);
  }
  return true;
}

export async function runDvdRecoveryWorker(input: {
  access: DataAccess;
  deviceInactivity: DvdRecoveryDeviceInactivity;
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
