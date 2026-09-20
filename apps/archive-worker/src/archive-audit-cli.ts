import {
  ARCHIVE_AUDIT_DEFAULT_RECORD_LIMIT,
  ARCHIVE_AUDIT_MAX_RECORD_LIMIT,
  readArchiveAuditRecords,
} from "@rip-dvd/data-access/archive-audit-records";

import {
  ARCHIVE_AUDIT_MAX_CONCURRENCY,
  type ArchiveAuditFileInspector,
  runArchiveAudit,
} from "./archive-audit.js";
import { createBoundedArchiveAuditFileInspector } from "./archive-audit-file-client.js";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_TIMEOUT_MS = 120_000;
const MAX_FILE_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_TIMEOUT_MS = 600_000;

interface ArchiveAuditCliOptions {
  concurrency: number;
  fileTimeoutMs: number;
  limit: number;
  runtimeTimeoutMs: number;
}

function parsePositiveInteger(
  raw: string | undefined,
  option: string,
  maximum: number,
): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${option} must be between 1 and ${maximum}`);
  }
  return value;
}

function parseOptions(argv: readonly string[]): ArchiveAuditCliOptions {
  const options: ArchiveAuditCliOptions = {
    concurrency: DEFAULT_CONCURRENCY,
    fileTimeoutMs: DEFAULT_FILE_TIMEOUT_MS,
    limit: ARCHIVE_AUDIT_DEFAULT_RECORD_LIMIT,
    runtimeTimeoutMs: DEFAULT_RUNTIME_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--limit") {
      options.limit = parsePositiveInteger(
        value,
        option,
        ARCHIVE_AUDIT_MAX_RECORD_LIMIT,
      );
    } else if (option === "--concurrency") {
      options.concurrency = parsePositiveInteger(
        value,
        option,
        ARCHIVE_AUDIT_MAX_CONCURRENCY,
      );
    } else if (option === "--file-timeout-ms") {
      options.fileTimeoutMs = parsePositiveInteger(
        value,
        option,
        MAX_FILE_TIMEOUT_MS,
      );
    } else if (option === "--runtime-timeout-ms") {
      options.runtimeTimeoutMs = parsePositiveInteger(
        value,
        option,
        MAX_RUNTIME_TIMEOUT_MS,
      );
    } else {
      throw new TypeError("Archive audit received an unsupported option");
    }
    index += 1;
  }
  return options;
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new TypeError(`Archive audit requires ${name}`);
  }
  return value;
}

export interface ArchiveAuditCliHost {
  environment: Readonly<Record<string, string | undefined>>;
  stderr(message: string): void;
  stdout(message: string): void;
}

export interface ArchiveAuditCliDependencies {
  createFileInspector(timeoutMs: number): ArchiveAuditFileInspector;
  readRecords: typeof readArchiveAuditRecords;
  runAudit: typeof runArchiveAudit;
}

const nodeCliHost: ArchiveAuditCliHost = {
  environment: process.env,
  stderr: (message) => process.stderr.write(message),
  stdout: (message) => process.stdout.write(message),
};

const nodeCliDependencies: ArchiveAuditCliDependencies = {
  createFileInspector: (timeoutMs) =>
    createBoundedArchiveAuditFileInspector({ timeoutMs }),
  readRecords: readArchiveAuditRecords,
  runAudit: runArchiveAudit,
};

export async function runArchiveAuditCli(
  argv: readonly string[],
  host: ArchiveAuditCliHost = nodeCliHost,
  dependencies: ArchiveAuditCliDependencies = nodeCliDependencies,
): Promise<number> {
  let runtimeTimedOut = false;
  try {
    const options = parseOptions(argv);
    const databasePath = requiredEnvironmentValue(
      host.environment,
      "RIP_DVD_DATABASE_PATH",
    );
    const originalsLibraryPath = requiredEnvironmentValue(
      host.environment,
      "RIP_DVD_ORIGINALS_LIBRARY_PATH",
    );
    const controller = new AbortController();
    const runtimeTimer = setTimeout(() => {
      runtimeTimedOut = true;
      controller.abort(new Error("Archive audit runtime limit reached"));
    }, options.runtimeTimeoutMs);
    try {
      const page = dependencies.readRecords(databasePath, options.limit);
      const report = await dependencies.runAudit({
        records: page.records,
        recordsTruncated: page.truncated,
        recordLimit: options.limit,
        concurrency: options.concurrency,
        fileTimeoutMs: options.fileTimeoutMs,
        runtimeTimeoutMs: options.runtimeTimeoutMs,
        originalsLibraryPath,
        fileInspector: dependencies.createFileInspector(options.fileTimeoutMs),
        signal: controller.signal,
      });
      host.stdout(`${JSON.stringify(report)}\n`);
      return 0;
    } finally {
      clearTimeout(runtimeTimer);
    }
  } catch (error) {
    const code = runtimeTimedOut
      ? "archive_audit_runtime_timeout"
      : "archive_audit_failed";
    host.stderr(`${JSON.stringify({ error: code })}\n`);
    return 1;
  }
}
