import { setTimeout as delay } from "node:timers/promises";

import type { DataAccess } from "@rip-dvd/data-access";

import {
  createBoundedArchiveAuditFileInspector,
} from "./archive-audit-file-client.js";
import {
  createBoundedArchiveAuditRecordReader,
  type ArchiveAuditRecordReader,
} from "./archive-audit-record-reader.js";
import {
  runArchiveAudit,
  type ArchiveAuditFileInspector,
} from "./archive-audit.js";
import {
  recordArchiveAuditPollIncident,
  recordArchiveClaimRecoveryIncident,
  resolveArchiveAuditPollIncident,
  resolveArchiveClaimRecoveryIncident,
} from "./worker-incidents.js";

export interface ArchiveAuditWorkerDependencies {
  createFileInspector(timeoutMs: number): ArchiveAuditFileInspector;
  readRecords: ArchiveAuditRecordReader["read"];
  runAudit: typeof runArchiveAudit;
}

const defaultDependencies: ArchiveAuditWorkerDependencies = {
  createFileInspector: (timeoutMs) =>
    createBoundedArchiveAuditFileInspector({ timeoutMs }),
  readRecords: createBoundedArchiveAuditRecordReader().read,
  runAudit: runArchiveAudit,
};

interface PollArchiveAuditInput {
  access: DataAccess;
  databasePath: string;
  originalsLibraryPath: string;
  dependencies?: Partial<ArchiveAuditWorkerDependencies>;
  log?: (message: string) => void;
}

export async function pollArchiveAudit({
  access,
  databasePath,
  originalsLibraryPath,
  dependencies: overrides,
  log = () => {},
}: PollArchiveAuditInput): Promise<boolean> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const incidentOptions = { access, log };
  try {
    access.archiveAudits.recoverExpiredClaims();
    resolveArchiveClaimRecoveryIncident(incidentOptions, "archive_audit");
  } catch {
    recordArchiveClaimRecoveryIncident(incidentOptions, "archive_audit");
    throw new Error("Archive audit claim recovery failed");
  }

  try {
    const claim = access.archiveAudits.claimNext();
    if (claim === null) {
      resolveArchiveAuditPollIncident(incidentOptions);
      return false;
    }
    let runtimeTimedOut = false;
    let heartbeatError: unknown;
    const controller = new AbortController();
    const runtimeTimer = setTimeout(() => {
      runtimeTimedOut = true;
      controller.abort(new Error("Archive audit runtime limit reached"));
    }, claim.bounds.runtimeTimeoutMs);
    const heartbeat = setInterval(() => {
      try {
        if (!access.archiveAudits.renewClaim(claim)) {
          throw new Error("Archive audit claim expired");
        }
      } catch (error) {
        heartbeatError = error;
        controller.abort(error);
        clearInterval(heartbeat);
      }
    }, 5_000);
    try {
      const page = await dependencies.readRecords(
        databasePath,
        claim.bounds.recordLimit,
        controller.signal,
      );
      access.archiveAudits.beginAudit(claim, {
        recordCount: page.records.length,
        truncated: page.truncated,
      });
      const report = await dependencies.runAudit({
        records: page.records,
        recordsTruncated: page.truncated,
        ...claim.bounds,
        originalsLibraryPath,
        fileInspector: dependencies.createFileInspector(claim.bounds.fileTimeoutMs),
        signal: controller.signal,
        onFinding: (finding, index) => {
          access.archiveAudits.recordFinding(claim, { finding, index });
        },
      });
      access.archiveAudits.complete(claim, {
        findings: report.findings,
        resultStatus: "complete",
      });
    } catch {
      if (runtimeTimedOut) {
        access.archiveAudits.completeIncomplete(claim, "runtime_timeout");
      } else {
        access.archiveAudits.fail(claim);
      }
    } finally {
      clearTimeout(runtimeTimer);
      clearInterval(heartbeat);
    }
    if (heartbeatError !== undefined) throw heartbeatError;
    resolveArchiveAuditPollIncident(incidentOptions);
    return true;
  } catch {
    recordArchiveAuditPollIncident(incidentOptions);
    throw new Error("Archive audit poll failed");
  }
}

export async function runArchiveAuditWorker(input: {
  access: DataAccess;
  databasePath: string;
  originalsLibraryPath: string;
  intervalMs: number;
  log(message: string): void;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      const handled = await pollArchiveAudit(input);
      if (handled) continue;
    } catch {
      input.log("Archive audit worker poll failed.");
    }
    try {
      await delay(input.intervalMs, undefined, { signal: input.signal });
    } catch {
      if (!input.signal.aborted) throw new Error("Archive audit worker wait failed");
    }
  }
}
