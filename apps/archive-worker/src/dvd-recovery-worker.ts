import {
  dvdDiscVerificationInsertionIsCurrent,
  DVD_DISC_VERIFICATION_READ_DEADLINE_MS,
  type ArchiveRecovery,
  type ClaimedArchiveRecoveryWork,
  type DataAccess,
  type DvdDiscVerification,
  type DvdRecoveryWriteAuthority,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import type { ActiveBoundedProcess } from "./bounded-child-process.js";
import {
  createNodeDvdRecoverySourceReader,
  type DvdVerificationSourceRead,
  type DvdVerificationSourceReader,
} from "./dvd-disc-verifier.js";
import {
  commitDvdRecoveryBatch,
  DvdRecoveryBatchFault,
  type DvdRecoveryAtomicWriter,
} from "./dvd-recovery-batch.js";
import { reconcileDvdRecoveryCheckpoint } from "./dvd-recovery-reconciliation.js";
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

function writeAuthority(
  verification: DvdDiscVerification,
): DvdRecoveryWriteAuthority | null {
  if (
    verification.status !== "completed" ||
    verification.outcome !== "match" ||
    verification.workerExecutionId === null
  ) return null;
  return {
    verificationId: verification.id,
    archiveRecoveryId: verification.archiveRecoveryId,
    originalDiscArchiveId: verification.originalDiscArchiveId,
    discInspectionId: verification.discInspectionId,
    detectedDiscId: verification.detectedDiscId,
    mediaGeneration: verification.mediaGeneration,
    verificationWorkerExecutionId: verification.workerExecutionId,
    checkpointRevision: verification.checkpointRevision,
    checkpointDigest: verification.checkpointDigest,
  };
}

function sourceFaultCode(
  diagnostic: Extract<
    DvdVerificationSourceRead,
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
  active: ActiveBoundedProcess<DvdVerificationSourceRead>;
  access: DataAccess;
  recovery: Pick<ArchiveRecovery, "id" | "attemptId">;
  signal: AbortSignal;
  stopPollIntervalMs: number;
}): Promise<
  | { outcome: "completed"; read: DvdVerificationSourceRead }
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
  const archive = input.access.catalog.listOriginalDiscArchives({
    ids: [input.recovery.originalDiscArchiveId],
  })[0];
  const source = archive === undefined
    ? undefined
    : input.access.catalog.listDetectedDiscs(undefined, {
        ids: [archive.detectedDiscId],
      })[0];
  const drive = source === undefined
    ? undefined
    : input.access.catalog.listOpticalDrives({
        ids: [source.opticalDriveId],
      })[0];
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

export async function pollDvdRecoveryPass(input: {
  access: DataAccess;
  atomicWriter?: DvdRecoveryAtomicWriter;
  archiveImageOwnership?: ArchiveImageOwnership;
  deviceInactivity: Pick<DvdCopyRunner, "withDeviceInactive">;
  mediaGenerationObserver: MediaGenerationObserver;
  originalsLibraryPath: string;
  reader: DvdVerificationSourceReader;
  reconcile?: typeof reconcileDvdRecoveryCheckpoint;
  signal?: AbortSignal;
  stopPollIntervalMs?: number;
  workerExecutionId: string;
}): Promise<boolean> {
  const signal = input.signal ?? new AbortController().signal;
  const archiveImageOwnership = input.archiveImageOwnership ??
    defaultArchiveImageOwnership;
  const reconcile = input.reconcile ?? reconcileDvdRecoveryCheckpoint;
  const stopping = input.access.catalog.listArchiveRecoveries({ limit: 100 })
    .find((recovery) => recovery.status === "stopping");
  if (stopping !== undefined) {
    await finalizeStop({
      ...input,
      archiveImageOwnership,
      reconcile,
      recovery: stopping,
      signal,
    });
    return true;
  }

  const candidate = input.access.catalog.listArchiveRecoveries({ limit: 100 })
    .map((recovery) => ({
      recovery,
      verification: input.access.dvdDiscVerifications
        .findLatestForRecovery(recovery.id),
    }))
    .find(({ recovery, verification }) =>
      recovery.status === "eligible" &&
      verification !== null &&
      writeAuthority(verification) !== null
    );
  if (candidate === undefined || candidate.verification === null) return false;
  const authority = writeAuthority(candidate.verification)!;
  const requested = input.access.archiveRecoveryWork.request(
    candidate.recovery.id,
  );
  let claim: ClaimedArchiveRecoveryWork = input.access.archiveRecoveryWork
    .claim(requested.archiveRecoveryId, input.workerExecutionId);
  try {
    claim = input.access.archiveRecoveryWork.bindVerification(claim, authority);
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
          await finalizeStop({
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
        const active = input.reader.start({
          devicePath,
          startLba,
          sectorCount: 1,
          acceptedEndLbaExclusive: checkpoint.acceptedEndLbaExclusive,
          timeoutMs: DVD_DISC_VERIFICATION_READ_DEADLINE_MS,
        });
        const completed = await waitForRead({
          active,
          access: input.access,
          recovery: candidate.recovery,
          signal,
          stopPollIntervalMs: input.stopPollIntervalMs ??
            DEFAULT_STOP_POLL_INTERVAL_MS,
        });
        const afterRead = currentRecovery(input.access, candidate.recovery);
        if (completed.outcome === "stopped" || afterRead.status === "stopping") {
          await finalizeStop({
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
          await finalizeStop({
            ...input,
            archiveImageOwnership,
            reconcile,
            recovery: afterBatch,
            signal,
          });
          return true;
        }
        if (afterBatch.status === "completed") {
          input.access.archiveRecoveryWork.settlePass(claim);
          return true;
        }
      }
    }
    input.access.archiveRecoveryWork.settlePass(claim);
  } catch (error) {
    if (signal.aborted) throw error;
    const recovery = currentRecovery(input.access, candidate.recovery);
    if (recovery.status === "stopping") return true;
    input.access.archiveRecoveryWork.markFault({
      archiveRecoveryId: recovery.id,
      attemptId: recovery.attemptId,
      faultCode: error instanceof DvdRecoveryPassFault ||
          error instanceof DvdRecoveryBatchFault
        ? error.code
        : "CONSISTENCY_FAULT",
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
  reader?: DvdVerificationSourceReader;
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
