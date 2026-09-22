import { setTimeout as delay } from "node:timers/promises";

import type { DataAccess } from "@rip-dvd/data-access";

export async function pollFilesystemVerification(access: DataAccess): Promise<boolean> {
  access.filesystemVerification.recoverExpiredClaims();
  const claim = access.filesystemVerification.claimNext();
  if (claim === null) return false;
  try {
    await access.filesystemVerification.execute(claim);
  } catch {
    // A stale claim cannot change a newer attempt. Other failures retain a
    // generic outcome; filesystem paths and raw diagnostics stay private.
    access.filesystemVerification.fail(claim);
  }
  return true;
}

export async function runFilesystemVerificationWorker(input: {
  access: DataAccess;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      const handled = await pollFilesystemVerification(input.access);
      if (handled) continue;
    } catch {
      input.log("Filesystem verification worker poll failed.");
    }
    try {
      await delay(input.intervalMs, undefined, { signal: input.signal });
    } catch {
      if (!input.signal.aborted) throw new Error("Verification worker wait failed");
    }
  }
}
