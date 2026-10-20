import type { DataAccess } from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import { runDurableWorkPoller } from "./durable-work-poller.js";
import {
  recordArchiveClaimRecoveryIncident,
  recordFilesystemVerificationPollIncident,
  resolveArchiveClaimRecoveryIncident,
  resolveFilesystemVerificationPollIncident,
} from "./worker-incidents.js";

export async function pollFilesystemVerification(
  access: DataAccess,
  log: (message: string) => void = () => {},
  options: {
    originalsLibraryPath?: string;
    archiveImageOwnership?: ArchiveImageOwnership;
    signal?: AbortSignal;
  } = {},
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
      const evidenceHeader = claim.target === "original_disc_archive"
        ? access.catalog.findDvdArchiveEvidenceHeader(claim.targetId)
        : null;
      if (evidenceHeader === null) {
        await access.filesystemVerification.execute(claim);
      } else {
        if (options.originalsLibraryPath === undefined) {
          throw new Error("Archive image ownership is unavailable");
        }
        if (claim.target !== "original_disc_archive") {
          throw new Error("Archive image ownership target is invalid");
        }
        const archive = access.catalog.listOriginalDiscArchives({
          ids: [claim.targetId],
        })[0];
        if (archive === undefined) {
          throw new Error("Archive image ownership is unavailable");
        }
        await (options.archiveImageOwnership ?? defaultArchiveImageOwnership)
          .withConsistentRead({
            archiveId: claim.targetId,
            imagePath: archive.archivePath,
            originalsLibraryPath: options.originalsLibraryPath,
            signal: options.signal ?? new AbortController().signal,
            task: ({ assertOwned }) => access.filesystemVerification.execute(
              claim,
              { assertStable: assertOwned },
            ),
          });
      }
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
  originalsLibraryPath: string;
  signal: AbortSignal;
}): Promise<void> {
  await runDurableWorkPoller({
    intervalMs: input.intervalMs,
    signal: input.signal,
    log: input.log,
    poll: () => pollFilesystemVerification(input.access, input.log, {
      originalsLibraryPath: input.originalsLibraryPath,
      signal: input.signal,
    }),
    pollFailureMessage: "Filesystem verification worker poll failed.",
    waitFailureMessage: "Verification worker wait failed",
  });
}
