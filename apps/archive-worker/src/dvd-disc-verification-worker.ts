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
import {
  createNodeDvdDriveSpeedController,
  type DvdDriveSpeedController,
} from "./dvd-drive-speed.js";

export async function runDvdDiscVerificationWorker(input: {
  access: DataAccess;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
  workerExecutionId: string;
  reader?: DvdVerificationSourceReader;
  mediaGenerationObserver?: MediaGenerationObserver;
  speedController?: DvdDriveSpeedController;
}): Promise<void> {
  const reader = input.reader ?? createNodeDvdVerificationSourceReader();
  const mediaGenerationObserver = input.mediaGenerationObserver ??
    createNodeMediaGenerationObserver();
  const speedController = input.speedController ??
    createNodeDvdDriveSpeedController();
  await runDurableWorkPoller({
    intervalMs: input.intervalMs,
    signal: input.signal,
    log: input.log,
    poll: () => pollDvdDiscVerification({
      access: input.access,
      reader,
      workerExecutionId: input.workerExecutionId,
      mediaGenerationObserver,
      speedController,
      signal: input.signal,
    }),
    pollFailureMessage: "DVD Disc Verification worker poll failed.",
    waitFailureMessage: "DVD Disc Verification worker wait failed",
  });
}
