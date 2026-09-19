import { DVD_LOGICAL_SECTOR_BYTES } from "@rip-dvd/data-access";

import { DiscInspectionError } from "./disc-inspection-error.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import {
  commandFailure,
  reportsDriveUnavailable,
  reportsNoMedium,
  type CommandResult,
} from "./optical-drive-command-runner.js";

const TRANSIENT_READ_CAPACITY_EXIT_STATUSES = new Set([2, 6, 12, 13]);
const UNAVAILABLE_READ_CAPACITY_EXIT_STATUSES = new Set([15, 126, 127]);
const MALFORMED_READ_CAPACITY_EXIT_STATUSES = new Set([1, 97]);

export type DirectDvdCapacityResult =
  | { kind: "capacity"; capacityBytes: number }
  | { kind: "no_medium" }
  | { kind: "retryable" };

function invalidCapacity(message: string, options?: ErrorOptions): never {
  throw new DiscInspectionError(
    "fail",
    "invalid_content",
    message,
    options,
  );
}

function decodeBriefCapacity(output: string): number {
  const match = /^0x([0-9a-f]+)\s+0x([0-9a-f]+)\s*$/i.exec(output);
  if (match === null) {
    invalidCapacity("sg_readcap returned malformed DVD capacity");
  }

  const blockCountText = match[1];
  const blockSizeText = match[2];
  if (blockCountText === undefined || blockSizeText === undefined) {
    invalidCapacity("sg_readcap returned malformed DVD capacity");
  }
  const blockCount = BigInt(`0x${blockCountText}`);
  const blockSize = BigInt(`0x${blockSizeText}`);
  if (blockCount === 0n || blockSize !== BigInt(DVD_LOGICAL_SECTOR_BYTES)) {
    invalidCapacity("sg_readcap returned invalid DVD geometry");
  }
  const capacityBytes = blockCount * blockSize;
  if (capacityBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalidCapacity("sg_readcap returned an unsafe DVD capacity");
  }
  try {
    return requireDvdContentSize(Number(capacityBytes));
  } catch (error) {
    invalidCapacity("sg_readcap returned an invalid DVD capacity", {
      cause: error,
    });
  }
}

export function decodeDirectDvdCapacity(
  result: CommandResult,
): DirectDvdCapacityResult {
  if (reportsNoMedium(result)) {
    return { kind: "no_medium" };
  }
  if (
    result.exitCode !== null &&
    TRANSIENT_READ_CAPACITY_EXIT_STATUSES.has(result.exitCode)
  ) {
    return { kind: "retryable" };
  }
  if (
    reportsDriveUnavailable(result) ||
    (result.exitCode !== null &&
      UNAVAILABLE_READ_CAPACITY_EXIT_STATUSES.has(result.exitCode))
  ) {
    throw new DiscInspectionError(
      "retry",
      "drive_unavailable",
      "Optical Drive is unavailable during direct capacity observation",
    );
  }
  if (
    result.exitCode !== null &&
    MALFORMED_READ_CAPACITY_EXIT_STATUSES.has(result.exitCode)
  ) {
    invalidCapacity(commandFailure("sg_readcap", result).message);
  }
  if (result.exitCode !== 0) {
    const failure = commandFailure("sg_readcap", result);
    throw new DiscInspectionError(
      "fail",
      "content_size_failed",
      failure.message,
      { cause: failure },
    );
  }
  return {
    kind: "capacity",
    capacityBytes: decodeBriefCapacity(result.stdout),
  };
}
