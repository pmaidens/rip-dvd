import type { DataAccess } from "@rip-dvd/data-access";
import type { ArchiveImageOwnership } from "@rip-dvd/worker-runtime";

import { runDurableWorkPoller } from "./durable-work-poller.js";
import {
  DvdRecoveryReconciliationFault,
  reconcileDvdRecoveryCheckpoint,
} from "./dvd-recovery-reconciliation.js";

export async function pollDvdRecoveryReconciliation(input: {
  access: DataAccess;
  originalsLibraryPath: string;
  workerExecutionId: string;
  signal?: AbortSignal;
  archiveImageOwnership?: ArchiveImageOwnership;
  reconcile?: typeof reconcileDvdRecoveryCheckpoint;
}): Promise<boolean> {
  input.access.dvdRecoveryReconciliations.recoverExpiredClaims();
  const initialClaim = input.access.dvdRecoveryReconciliations.claimNext(
    input.workerExecutionId,
  );
  if (initialClaim === null) return false;
  let claim = initialClaim;

  let heartbeatError: unknown;
  const assertClaim = () => {
    if (heartbeatError !== undefined) throw heartbeatError;
    if (!input.access.dvdRecoveryReconciliations.renewClaim(claim)) {
      throw new Error("DVD recovery reconciliation claim expired");
    }
  };
  const heartbeat = setInterval(() => {
    try {
      assertClaim();
    } catch (error) {
      heartbeatError = error;
      clearInterval(heartbeat);
    }
  }, 5_000);
  try {
    const reconcile = input.reconcile ?? reconcileDvdRecoveryCheckpoint;
    const result = await reconcile({
      access: input.access,
      originalsLibraryPath: input.originalsLibraryPath,
      originalDiscArchiveId: claim.originalDiscArchiveId,
      signal: input.signal,
      archiveImageOwnership: input.archiveImageOwnership,
      assertClaim,
      setPhase(phase) {
        claim = input.access.dvdRecoveryReconciliations.setPhase(claim, phase);
      },
    });
    assertClaim();
    input.access.dvdRecoveryReconciliations.complete(claim, result);
  } catch (error) {
    if (input.signal?.aborted) {
      input.access.dvdRecoveryReconciliations.requeue(claim);
      return true;
    }
    const failureCode = error instanceof DvdRecoveryReconciliationFault
      ? error.code
      : "CONSISTENCY_FAULT";
    input.access.dvdRecoveryReconciliations.fail(claim, failureCode);
  } finally {
    clearInterval(heartbeat);
  }
  if (heartbeatError !== undefined) throw heartbeatError;
  return true;
}

export async function runDvdRecoveryReconciliationWorker(input: {
  access: DataAccess;
  originalsLibraryPath: string;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
  workerExecutionId: string;
}): Promise<void> {
  await runDurableWorkPoller({
    intervalMs: input.intervalMs,
    signal: input.signal,
    log: input.log,
    poll: () => pollDvdRecoveryReconciliation(input),
    pollFailureMessage: "DVD recovery reconciliation worker poll failed.",
    waitFailureMessage: "DVD recovery reconciliation worker wait failed",
  });
}
