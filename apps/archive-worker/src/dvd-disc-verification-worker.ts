import type { DataAccess } from "@rip-dvd/data-access";

import { runDurableWorkPoller } from "./durable-work-poller.js";
import {
  createNodeDvdVerificationSourceReader,
  pollDvdDiscVerification,
  type DvdVerificationSourceReader,
} from "./dvd-disc-verifier.js";
import {
  createNodeMediaGenerationObserver,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";

export async function runDvdDiscVerificationWorker(input: {
  access: DataAccess;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
  workerExecutionId: string;
  reader?: DvdVerificationSourceReader;
  mediaGenerationObserver?: MediaGenerationObserver;
}): Promise<void> {
  const reader = input.reader ?? createNodeDvdVerificationSourceReader();
  const mediaGenerationObserver = input.mediaGenerationObserver ??
    createNodeMediaGenerationObserver();
  await runDurableWorkPoller({
    intervalMs: input.intervalMs,
    signal: input.signal,
    log: input.log,
    poll: () => pollDvdDiscVerification({
      access: input.access,
      reader,
      workerExecutionId: input.workerExecutionId,
      mediaGenerationObserver,
      signal: input.signal,
    }),
    pollFailureMessage: "DVD disc verification worker poll failed.",
    waitFailureMessage: "DVD disc verification worker wait failed",
  });
}
