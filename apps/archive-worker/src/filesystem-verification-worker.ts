import { setTimeout as delay } from "node:timers/promises";

import type { DataAccess } from "@rip-dvd/data-access";
import {
  recordArchiveClaimRecoveryIncident,
  recordFilesystemVerificationPollIncident,
  resolveArchiveClaimRecoveryIncident,
  resolveFilesystemVerificationPollIncident,
} from "./worker-incidents.js";

export async function pollFilesystemVerification(
  access: DataAccess,
  log: (message: string) => void = () => {},
): Promise<boolean> {
  const incidentOptions = { access, log };
  try {
    access.filesystemVerification.recoverExpiredClaims();
    resolveArchiveClaimRecoveryIncident(incidentOptions, "filesystem_verification");
  } catch {
    recordArchiveClaimRecoveryIncident(incidentOptions, "filesystem_verification");
    throw new Error("Filesystem verification claim recovery failed");
  }
  try {
    const claim = access.filesystemVerification.claimNext();
    if (claim === null) {
      resolveFilesystemVerificationPollIncident(incidentOptions);
      return false;
    }
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      try {
        if (!access.filesystemVerification.renewClaim(claim)) {
          throw new Error("Filesystem verification claim expired");
        }
      } catch (error) {
        heartbeatError = error;
        clearInterval(heartbeat);
      }
    }, 5_000);
    try {
      await access.filesystemVerification.execute(claim);
    } catch {
      // A stale claim cannot change a newer attempt. Other failures retain a
      // generic outcome; filesystem paths and raw diagnostics stay private.
      access.filesystemVerification.fail(claim);
    } finally {
      clearInterval(heartbeat);
    }
    if (heartbeatError !== undefined) throw heartbeatError;
    resolveFilesystemVerificationPollIncident(incidentOptions);
    return true;
  } catch {
    recordFilesystemVerificationPollIncident(incidentOptions);
    throw new Error("Filesystem verification poll failed");
  }
}

export async function runFilesystemVerificationWorker(input: {
  access: DataAccess;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      const handled = await pollFilesystemVerification(input.access, input.log);
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
