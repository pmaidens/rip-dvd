import { DomainInvariantError } from "./errors.js";
import type {
  EncodeJobFailureEvidence,
  EncodeJobFailureReportInput,
} from "./types.js";

export const ENCODE_JOB_FAILURE_REPORT_SCHEMA_VERSIONS = [1] as const;
export const ENCODE_JOB_FAILURE_REASON_CODES = [
  "input_unavailable",
  "invalid_configuration",
  "output_conflict",
  "unsafe_output_state",
  "command_failed",
  "command_timeout",
  "output_validation_failed",
  "unknown_failure",
  "cleanup_failed",
  "publication_failed",
  "lease_expired",
  "worker_interrupted",
  "publication_recovery_failed",
] as const;
export const ENCODE_JOB_FAILURE_PHASES = [
  "preparation",
  "scanning",
  "previewing",
  "encoding",
  "validation",
  "cleanup",
  "publication",
  "recovery",
] as const;
export const ENCODE_JOB_FAILURE_RETRYABILITIES = [
  "appropriate",
  "after_action",
  "not_appropriate",
] as const;
export const ENCODE_JOB_FAILURE_VALIDATION_CHECKS = [
  "subtitle_streams",
  "subtitle_packets",
  "subtitle_cleanup",
  "video_metadata",
  "duration_metadata",
  "video_packets",
  "audio_timing",
  "video_decode",
  "output_file",
] as const;
export const ENCODE_JOB_FAILURE_CONTEXTS = [
  "partial_output",
  "replacement_artifact",
  "published_output",
  "publication_completion",
  "publication_mutation",
  "job_claim",
  "publication_cleanup",
  "worker_shutdown",
  "publication_recovery",
  "cleanup_recovery",
] as const;
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
const ENCODE_JOB_FAILURE_DURATION_MAX_SECONDS = 604_800;

export interface ValidatedEncodeJobFailureReportInput
  extends EncodeJobFailureReportInput {
  diagnostic: string | null;
}

export const ENCODE_JOB_FAILURE_CLEANUP_OPERATIONS = [
  "partial_output",
  "replacement_artifact",
  "published_output",
  "publication_completion",
] as const;
export const ENCODE_JOB_FAILURE_PUBLICATION_OPERATIONS = [
  "publication_mutation",
  "publication_completion",
] as const;
export const ENCODE_JOB_FAILURE_LEASE_SCOPES = [
  "job_claim",
  "publication_cleanup",
] as const;
export const ENCODE_JOB_FAILURE_INTERRUPTION_SOURCES = [
  "worker_shutdown",
  "publication_completion",
] as const;
export const ENCODE_JOB_FAILURE_RECOVERY_OPERATIONS = [
  "publication_recovery",
  "cleanup_recovery",
] as const;

export type EncodeJobFailureContext =
  (typeof ENCODE_JOB_FAILURE_CONTEXTS)[number];

function includesFailureContext<
  const Values extends readonly EncodeJobFailureContext[],
>(
  values: Values,
  context: EncodeJobFailureContext | null,
): context is Values[number] {
  return context !== null && values.some((value) => value === context);
}

export function encodeJobFailureEvidenceFromContext(
  reasonCode: EncodeJobFailureReportInput["reasonCode"],
  context: EncodeJobFailureContext | null,
): EncodeJobFailureEvidence | null {
  if (
    reasonCode === "cleanup_failed" &&
    includesFailureContext(ENCODE_JOB_FAILURE_CLEANUP_OPERATIONS, context)
  ) {
    return { kind: "cleanup", operation: context };
  }
  if (
    reasonCode === "publication_failed" &&
    includesFailureContext(
      ENCODE_JOB_FAILURE_PUBLICATION_OPERATIONS,
      context,
    )
  ) {
    return { kind: "publication", operation: context };
  }
  if (
    reasonCode === "lease_expired" &&
    includesFailureContext(ENCODE_JOB_FAILURE_LEASE_SCOPES, context)
  ) {
    return { kind: "lease", scope: context };
  }
  if (
    reasonCode === "worker_interrupted" &&
    includesFailureContext(
      ENCODE_JOB_FAILURE_INTERRUPTION_SOURCES,
      context,
    )
  ) {
    return { kind: "interruption", source: context };
  }
  if (
    reasonCode === "publication_recovery_failed" &&
    includesFailureContext(ENCODE_JOB_FAILURE_RECOVERY_OPERATIONS, context)
  ) {
    return { kind: "recovery", operation: context };
  }
  return null;
}

export function encodeJobFailureEvidenceContext(
  evidence: EncodeJobFailureEvidence,
): EncodeJobFailureContext | null {
  switch (evidence.kind) {
    case "cleanup":
    case "publication":
    case "recovery":
      return evidence.operation;
    case "lease":
      return evidence.scope;
    case "interruption":
      return evidence.source;
    case "exit_status":
    case "signal":
    case "timeout":
      return null;
  }
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
          : input.evidence?.kind === "duration"
            ? ["kind", "expectedSeconds", "observedSeconds"]
            : input.evidence?.kind === "validation_check"
              ? ["kind", "check"]
              : input.evidence?.kind === "none"
                ? ["kind"]
                : input.evidence?.kind === "cleanup"
                  ? ["kind", "operation"]
                  : input.evidence?.kind === "publication"
                    ? ["kind", "operation"]
                    : input.evidence?.kind === "lease"
                      ? ["kind", "scope"]
                      : input.evidence?.kind === "interruption"
                        ? ["kind", "source"]
                        : input.evidence?.kind === "recovery"
                          ? ["kind", "operation"]
                          : [],
    "evidence",
  );

  if (input.reasonCode === "command_failed") {
    if (
      (input.phase !== "scanning" &&
        input.phase !== "previewing" &&
        input.phase !== "encoding") ||
      input.retryability !== "appropriate"
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report command failure classification is invalid",
      );
    }
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
  } else if (input.reasonCode === "command_timeout") {
    if (
      (input.phase !== "scanning" &&
        input.phase !== "previewing" &&
        input.phase !== "encoding") ||
      input.retryability !== "appropriate" ||
      input.evidence.kind !== "timeout" ||
      !Number.isSafeInteger(input.evidence.timeoutSeconds) ||
      input.evidence.timeoutSeconds < 1 ||
      input.evidence.timeoutSeconds > 604_800
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report timeout evidence is invalid",
      );
    }
  } else if (input.reasonCode === "output_validation_failed") {
    if (input.evidence.kind === "duration") {
      if (
        !Number.isFinite(input.evidence.expectedSeconds) ||
        input.evidence.expectedSeconds <= 0 ||
        input.evidence.expectedSeconds >
          ENCODE_JOB_FAILURE_DURATION_MAX_SECONDS ||
        !Number.isFinite(input.evidence.observedSeconds) ||
        input.evidence.observedSeconds < 0 ||
        input.evidence.observedSeconds > ENCODE_JOB_FAILURE_DURATION_MAX_SECONDS
      ) {
        throw new DomainInvariantError(
          "Encode Job Failure Report duration evidence is invalid",
        );
      }
    } else if (
      input.evidence.kind !== "validation_check" ||
      !ENCODE_JOB_FAILURE_VALIDATION_CHECKS.includes(input.evidence.check)
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report validation evidence is invalid",
      );
    }
  } else if (input.reasonCode === "cleanup_failed") {
    if (
      input.phase !== "cleanup" ||
      input.retryability !== "after_action" ||
      input.evidence.kind !== "cleanup" ||
      !ENCODE_JOB_FAILURE_CLEANUP_OPERATIONS.includes(
        input.evidence.operation,
      )
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report cleanup evidence is invalid",
      );
    }
  } else if (input.reasonCode === "publication_failed") {
    if (
      input.phase !== "publication" ||
      input.retryability !== "after_action" ||
      input.evidence.kind !== "publication" ||
      !ENCODE_JOB_FAILURE_PUBLICATION_OPERATIONS.includes(
        input.evidence.operation,
      )
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report publication evidence is invalid",
      );
    }
  } else if (input.reasonCode === "lease_expired") {
    if (
      input.retryability !== "after_action" ||
      input.evidence.kind !== "lease" ||
      !ENCODE_JOB_FAILURE_LEASE_SCOPES.includes(input.evidence.scope) ||
      (input.evidence.scope === "publication_cleanup" &&
        input.phase !== "publication") ||
      (input.evidence.scope === "job_claim" &&
        (input.phase === "cleanup" || input.phase === "recovery"))
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report lease evidence is invalid",
      );
    }
  } else if (input.reasonCode === "worker_interrupted") {
    if (
      input.retryability !== "after_action" ||
      input.evidence.kind !== "interruption" ||
      !ENCODE_JOB_FAILURE_INTERRUPTION_SOURCES.includes(
        input.evidence.source,
      ) ||
      (input.evidence.source === "publication_completion" &&
        input.phase !== "publication") ||
      input.phase === "cleanup" ||
      input.phase === "recovery"
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report interruption evidence is invalid",
      );
    }
  } else if (input.reasonCode === "publication_recovery_failed") {
    if (
      input.phase !== "recovery" ||
      input.retryability !== "after_action" ||
      input.evidence.kind !== "recovery" ||
      !ENCODE_JOB_FAILURE_RECOVERY_OPERATIONS.includes(
        input.evidence.operation,
      )
    ) {
      throw new DomainInvariantError(
        "Encode Job Failure Report recovery evidence is invalid",
      );
    }
  } else if (input.evidence.kind !== "none") {
    throw new DomainInvariantError(
      "Encode Job Failure Report evidence is invalid for its reason code",
    );
  }

  return { ...input, diagnostic };
}
