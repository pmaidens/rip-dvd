import { setTimeout as delay } from "node:timers/promises";

import type { DataAccess } from "@rip-dvd/data-access";

import {
  nodeHandBrakeRunner,
  type HandBrakeRunner,
} from "./handbrake-runner.js";
import { normalizeErrorMessage } from "./normalize-error-message.js";
import {
  executeEncodeClaim,
  nodeAtomicPathExchange,
  nodePublicationMutationLock,
  reconcileEncodePublications,
  type AtomicPathExchange,
  type PublicationMutationLock,
} from "./publication-recovery.js";

export {
  createNodeHandBrakeRunner,
  nodeHandBrakeRunner,
  type HandBrakeRunner,
  type HandBrakeRunRequest,
} from "./handbrake-runner.js";
export {
  createEncodePublicationMutationRecoveryLock,
  createNodeAtomicPathExchange,
  createNodePublicationMutationLock,
  nodeAtomicPathExchange,
  nodePublicationMutationLock,
  type AtomicPathExchange,
  type PublicationMutationLock,
} from "./publication-recovery.js";

export interface PollEncodeWorkerOptions {
  access: DataAccess;
  atomicPathExchange?: AtomicPathExchange;
  concurrency: number;
  log(message: string): void;
  mediaLibraryPath: string;
  mutationLock?: PublicationMutationLock;
  originalsLibraryPath: string;
  runner?: HandBrakeRunner;
  signal: AbortSignal;
  workerId?: string;
}

export interface RunEncodeWorkerOptions extends PollEncodeWorkerOptions {
  pollIntervalMs: number;
  waitForNextPoll?: (
    intervalMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export async function pollEncodeWorker(
  options: PollEncodeWorkerOptions,
): Promise<void> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("Encode worker concurrency is invalid");
  }
  const publicationOptions = {
    ...options,
    atomicPathExchange:
      options.atomicPathExchange ?? nodeAtomicPathExchange,
    mutationLock: options.mutationLock ?? nodePublicationMutationLock,
    runner: options.runner ?? nodeHandBrakeRunner,
  };
  await reconcileEncodePublications(publicationOptions);
  const runSlot = async () => {
    while (!options.signal.aborted) {
      const claim = options.access.encodeJobs.claimNext(
        options.workerId ?? "encode-worker",
      );
      if (!claim) {
        return;
      }
      await executeEncodeClaim(claim, publicationOptions);
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: options.concurrency }, () => runSlot()),
  );
  options.signal.throwIfAborted();
  const failedSlot = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedSlot) {
    throw failedSlot.reason;
  }
}

async function waitForNextPoll(
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(intervalMs, undefined, { signal });
}

export async function runEncodeWorker({
  pollIntervalMs,
  waitForNextPoll: wait = waitForNextPoll,
  ...pollOptions
}: RunEncodeWorkerOptions): Promise<void> {
  while (!pollOptions.signal.aborted) {
    try {
      await pollEncodeWorker(pollOptions);
    } catch (error) {
      if (pollOptions.signal.aborted) {
        break;
      }
      const message = normalizeErrorMessage(error);
      pollOptions.log(`Encode worker poll failed: ${message}`);
    }
    if (pollOptions.signal.aborted) {
      break;
    }
    try {
      await wait(pollIntervalMs, pollOptions.signal);
    } catch (error) {
      if (!pollOptions.signal.aborted) {
        throw error;
      }
    }
  }
}
