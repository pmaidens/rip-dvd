import { DomainInvariantError } from "./errors.js";
import type { EncodeJobFailureReportInput } from "./types.js";

export const ENCODE_JOB_FAILURE_REPORT_SCHEMA_VERSIONS = [1] as const;
export const ENCODE_JOB_FAILURE_REASON_CODES = [
  "command_failed",
  "command_timeout",
] as const;
export const ENCODE_JOB_FAILURE_PHASES = ["encoding"] as const;
export const ENCODE_JOB_FAILURE_RETRYABILITIES = ["appropriate"] as const;
export const ENCODE_JOB_FAILURE_SIGNALS = [
  "SIGABRT",
  "SIGALRM",
  "SIGBREAK",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGLOST",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGINFO",
] as const;

export const ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH = 500;
export const ENCODE_JOB_FAILURE_REPORT_HISTORY_LIMIT = 20;

export interface ValidatedEncodeJobFailureReportInput
  extends EncodeJobFailureReportInput {
  diagnostic: string | null;
}

function requireAllowlistedKeys(
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw new DomainInvariantError(
      `Encode Job Failure Report ${field} is invalid`,
    );
  }
}

export function validateEncodeJobFailureReport(
  input: EncodeJobFailureReportInput,
): ValidatedEncodeJobFailureReportInput {
  requireAllowlistedKeys(
    input,
    [
      "schemaVersion",
      "reasonCode",
      "phase",
      "retryability",
      "diagnostic",
      "evidence",
    ],
    "fields",
  );
  if (!ENCODE_JOB_FAILURE_REPORT_SCHEMA_VERSIONS.includes(input.schemaVersion)) {
    throw new DomainInvariantError(
      "Encode Job Failure Report schema version is invalid",
    );
  }
  if (!ENCODE_JOB_FAILURE_REASON_CODES.includes(input.reasonCode)) {
    throw new DomainInvariantError(
      "Encode Job Failure Report reason code is invalid",
    );
  }
  if (!ENCODE_JOB_FAILURE_PHASES.includes(input.phase)) {
    throw new DomainInvariantError(
      "Encode Job Failure Report phase is invalid",
    );
  }
  if (!ENCODE_JOB_FAILURE_RETRYABILITIES.includes(input.retryability)) {
    throw new DomainInvariantError(
      "Encode Job Failure Report retryability is invalid",
    );
  }

  if (
    input.diagnostic !== undefined &&
    input.diagnostic !== null &&
    typeof input.diagnostic !== "string"
  ) {
    throw new DomainInvariantError(
      "Encode Job Failure Report diagnostic is invalid",
    );
  }
  const diagnostic = input.diagnostic?.trim() || null;
  if (
    diagnostic !== null &&
    diagnostic.length > ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH
  ) {
    throw new DomainInvariantError(
      `Encode Job Failure Report diagnostic cannot exceed ${ENCODE_JOB_FAILURE_DIAGNOSTIC_MAX_LENGTH} characters`,
    );
  }

  requireAllowlistedKeys(
    input.evidence,
    input.evidence?.kind === "exit_status"
      ? ["kind", "exitStatus"]
      : input.evidence?.kind === "signal"
        ? ["kind", "signal"]
        : input.evidence?.kind === "timeout"
          ? ["kind", "timeoutSeconds"]
          : [],
    "evidence",
  );

  if (input.reasonCode === "command_failed") {
    if (input.evidence.kind === "exit_status") {
      if (
        !Number.isSafeInteger(input.evidence.exitStatus) ||
        input.evidence.exitStatus < 1 ||
        input.evidence.exitStatus > 255
      ) {
        throw new DomainInvariantError(
          "Encode Job Failure Report exit status is invalid",
        );
      }
    } else if (
      input.evidence.kind !== "signal" ||
      !ENCODE_JOB_FAILURE_SIGNALS.includes(input.evidence.signal)
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report command failure evidence is invalid",
      );
    }
  } else if (
    input.evidence.kind !== "timeout" ||
    !Number.isSafeInteger(input.evidence.timeoutSeconds) ||
    input.evidence.timeoutSeconds < 1 ||
    input.evidence.timeoutSeconds > 604_800
  ) {
    throw new DomainInvariantError(
      "Encode Job Failure Report timeout evidence is invalid",
    );
  }

  return { ...input, diagnostic };
}
