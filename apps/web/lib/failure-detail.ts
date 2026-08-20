import { DVD_SALVAGE_REJECTION_DESCRIPTIONS } from "@rip-dvd/data-access";

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
    pattern: /DVD archive copy stalled/i,
    reason:
      "The archive copy stopped because no data was copied during the configured stall interval.",
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

const DVD_SALVAGE_REJECTION_PATTERN = new RegExp(
  `^DVD salvage rejected: unreadable sectors affect (${Object.values(
    DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  ).map((description) => description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}); (\\d{1,7}) sectors? in (\\d{1,7}) areas?; LBAs (.{1,200})$`,
);

function formatByteOffset(byteOffset: string): string {
  return byteOffset.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatArchiveRescueFailure(errorMessage: string): string | null {
  const rejection = DVD_SALVAGE_REJECTION_PATTERN.exec(errorMessage);
  if (
    rejection?.[1] !== undefined &&
    rejection[2] !== undefined &&
    rejection[3] !== undefined &&
    rejection[4] !== undefined &&
    /^\d{1,7}(?:-\d{1,7})?(?:, \d{1,7}(?:-\d{1,7})?){0,7}(?:, and \d{1,7} more)?$/.test(
      rejection[4],
    ) &&
    Number(rejection[2]) > 0 &&
    Number(rejection[3]) > 0
  ) {
    const ranges = rejection[4].replace(/(\d+)-(\d+)/g, "$1–$2");
    return `Automatic salvage validation rejected damage to ${rejection[1]}; the image remains available for another recovery attempt with ${rejection[2]} unreadable ${Number(rejection[2]) === 1 ? "sector" : "sectors"} across ${rejection[3]} ${Number(rejection[3]) === 1 ? "area" : "areas"} (LBAs ${ranges}).`;
  }
  const damage =
    /^DVD rescue requires validation: (\d{1,7}) unreadable sectors? in (\d{1,7}) areas?; LBAs (.{1,200})$/.exec(
      errorMessage,
    );
  if (
    damage?.[1] === undefined ||
    damage[2] === undefined ||
    damage[3] === undefined ||
    !/^\d{1,7}(?:-\d{1,7})?(?:, \d{1,7}(?:-\d{1,7})?){0,7}(?:, and \d{1,7} more)?$/.test(
      damage[3],
    )
  ) {
    return null;
  }
  const badSectorCount = Number(damage[1]);
  const badAreaCount = Number(damage[2]);
  if (badSectorCount <= 0 || badAreaCount <= 0) {
    return null;
  }
  const ranges = damage[3].replace(/(\d+)-(\d+)/g, "$1–$2");
  return `The rescued image was retained for validation with ${badSectorCount} unreadable ${badSectorCount === 1 ? "sector" : "sectors"} across ${badAreaCount} ${badAreaCount === 1 ? "area" : "areas"} (LBAs ${ranges}).`;
}

function formatArchiveCopyFailure(errorMessage: string): string | null {
  const readFailure =
    /DVD content read failed at byte (\d+)/i.exec(errorMessage);
  if (readFailure?.[1] !== undefined) {
    const byteOffset = formatByteOffset(readFailure[1]);
    return /input\/output error|\bI\/O error\b/i.test(errorMessage)
      ? `The archive worker encountered an input/output error while reading the disc at byte ${byteOffset}.`
      : `The archive worker could not read the disc at byte ${byteOffset}.`;
  }
  if (/DVD content read ended before the declared media size/i.test(errorMessage)) {
    return "The archive worker reached the end of the disc before its declared size.";
  }
  const status =
    /DVD archive copy failed with status (-?\d{1,4})\b/i.exec(errorMessage)?.[1];
  if (status !== undefined) {
    return `The archive copy command exited with status ${status}.`;
  }
  const signal =
    /DVD archive copy failed with signal ([A-Z][A-Z0-9]{1,15})\b/.exec(
      errorMessage,
    )?.[1];
  return signal === undefined
    ? null
    : `The archive copy command stopped after receiving signal ${signal}.`;
}

export function formatFailureDetail(errorMessage: string | null): string | null {
  if (errorMessage === null) {
    return null;
  }
  const archiveRescueFailure = formatArchiveRescueFailure(errorMessage);
  if (archiveRescueFailure !== null) {
    return archiveRescueFailure;
  }
  const archiveCopyFailure = formatArchiveCopyFailure(errorMessage);
  if (archiveCopyFailure !== null) {
    return archiveCopyFailure;
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
