import type { DataAccess } from "@rip-dvd/data-access";

import { runDurableWorkPoller } from "./durable-work-poller.js";
import {
  createNodeDvdVerificationSourceReader,
  pollDvdDiscVerification,
  type DvdVerificationSourceReader,
} from "./dvd-disc-verifier.js";

export async function runDvdDiscVerificationWorker(input: {
  access: DataAccess;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
  workerExecutionId: string;
  reader?: DvdVerificationSourceReader;
}): Promise<void> {
  const reader = input.reader ?? createNodeDvdVerificationSourceReader();
  await runDurableWorkPoller({
    intervalMs: input.intervalMs,
    signal: input.signal,
    log: input.log,
    poll: () => pollDvdDiscVerification({
      access: input.access,
      reader,
      workerExecutionId: input.workerExecutionId,
    }),
    pollFailureMessage: "DVD disc verification worker poll failed.",
    waitFailureMessage: "DVD disc verification worker wait failed",
  });
}
