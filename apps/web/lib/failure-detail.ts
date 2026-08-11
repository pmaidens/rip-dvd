interface FailureReasonRule {
  pattern: RegExp;
  reason: string;
}

const FAILURE_REASON_RULES: readonly FailureReasonRule[] = [
  {
    pattern: /no medium (?:found|present)|medium not present/i,
    reason: "No optical medium was found in the drive.",
  },
  {
    pattern: /\bnot ready\b/i,
    reason: "The optical drive was not ready.",
  },
  {
    pattern: /permission denied|operation not permitted/i,
    reason: "The worker did not have permission to complete the operation.",
  },
  {
    pattern: /no space left|disk (?:is )?full/i,
    reason: "The destination does not have enough free space.",
  },
  {
    pattern: /read-only file system/i,
    reason: "The destination filesystem is read-only.",
  },
  {
    pattern: /input\/output error|\bI\/O error\b/i,
    reason: "The worker reported an input/output error.",
  },
  {
    pattern: /timed out|timeout/i,
    reason: "The worker operation timed out.",
  },
  {
    pattern: /interrupted|cancelled|canceled|aborted/i,
    reason: "The worker operation was interrupted.",
  },
  {
    pattern: /medium changed|disc changed/i,
    reason: "The disc changed during the operation.",
  },
  {
    pattern: /device is still active|device or resource busy|drive is busy/i,
    reason: "The optical drive is still busy.",
  },
  {
    pattern: /archive copy is still active/i,
    reason: "Another archive copy is still active.",
  },
  {
    pattern: /lease expired/i,
    reason: "The worker lost its job lease before completing the operation.",
  },
  {
    pattern: /malformed .{0,24}(?:output|response)|(?:output|response).{0,24}malformed/i,
    reason: "A worker tool returned malformed output.",
  },
  {
    pattern: /catalog review/i,
    reason: "The job requires completed catalog review before it can continue.",
  },
  {
    pattern: /disc selection is unavailable/i,
    reason: "The Encode Job's Disc Selection is no longer available.",
  },
  {
    pattern: /requires a DVD ISO original disc archive/i,
    reason: "The Encode Job requires a DVD ISO Original Disc Archive.",
  },
  {
    pattern: /invalid DVD video profile settings/i,
    reason: "The Encode Job has invalid DVD video profile settings.",
  },
  {
    pattern: /output already exists|final output already exists/i,
    reason: "The Encode Job output already exists.",
  },
  {
    pattern: /did not produce (?:a |the )?(?:expected )?complete (?:regular )?(?:output file|image)/i,
    reason: "The worker did not produce a complete output file.",
  },
  {
    pattern: /does not match the detected disc|fingerprint does not match/i,
    reason: "The archived content does not match the detected disc.",
  },
  {
    pattern: /(?:output|archive|final).{0,32}changed|changed.{0,32}(?:output|archive|final)/i,
    reason: "The output changed unexpectedly during the operation.",
  },
  {
    pattern: /claim token is unsafe/i,
    reason: "The worker's job claim failed integrity validation.",
  },
  {
    pattern: /device lock is unsafe/i,
    reason: "The archive worker could not safely lock the optical drive.",
  },
  {
    pattern: /path escaped|path is unsafe|directory is ambiguous|directory hierarchy is invalid|library (?:path )?.{0,24}(?:invalid|unsafe|real directory)|safety limit/i,
    reason: "A configured library or output path failed safety validation.",
  },
  {
    pattern: /could not safely discover .{0,24}partials/i,
    reason: "The archive worker could not safely inspect partial archives for recovery.",
  },
  {
    pattern: /not a regular file/i,
    reason: "An expected input or output is not a regular file.",
  },
  {
    pattern: /publication.{0,24}(?:unavailable|already active)/i,
    reason: "The output publication state is unavailable or already active.",
  },
  {
    pattern: /output bound|exceeded its bound/i,
    reason: "A worker tool produced more diagnostic output than allowed.",
  },
  {
    pattern: /(?:content|identity|fingerprint|size).{0,24}invalid|invalid.{0,24}(?:content|identity|fingerprint|size)/i,
    reason: "The worker received invalid disc content metadata.",
  },
  {
    pattern: /\bunavailable\b/i,
    reason: "Required job data became unavailable.",
  },
  {
    pattern: /cleanup failed|could not clean|partial cleanup/i,
    reason: "The worker could not clean up a partial output.",
  },
  {
    pattern: /publication.{0,24}(?:failed|abandoned|interrupted)/i,
    reason: "The worker could not publish the completed output.",
  },
  {
    pattern: /failed while (?:reading|opening)|read failed|error reading/i,
    reason: "The worker could not read its input.",
  },
  {
    pattern: /archive copy failed|copy failed/i,
    reason: "The archive worker could not copy the disc.",
  },
  {
    pattern: /scan failed|scanning failed/i,
    reason: "The worker could not scan the disc.",
  },
  {
    pattern: /handbrake.{0,24}failed|encod(?:e|ing).{0,24}failed/i,
    reason: "The encoding command failed.",
  },
];

const UNCLASSIFIED_FAILURE_REASON =
  "The worker reported an unclassified failure. Check the worker logs for the full diagnostic.";

export function formatFailureDetail(errorMessage: string | null): string | null {
  if (errorMessage === null) {
    return null;
  }
  for (const rule of FAILURE_REASON_RULES) {
    if (rule.pattern.test(errorMessage)) {
      return rule.reason;
    }
  }
  const status = /(?:exit |status )(-?\d{1,4})\b/i.exec(errorMessage)?.[1];
  if (status !== undefined) {
    return `A worker command exited with status ${status}.`;
  }
  const signal = /\bsignal ([A-Z][A-Z0-9]{1,15})\b/.exec(errorMessage)?.[1];
  if (signal !== undefined) {
    return `A worker command stopped after receiving signal ${signal}.`;
  }
  return UNCLASSIFIED_FAILURE_REASON;
}
