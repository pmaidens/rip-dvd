import {
  DvdReadFailureError,
  DVD_READ_FAILURE_CLASSIFIER_VERSION,
  DVD_SECTOR_SIZE_BYTES,
  type OutOfRangeDvdReadFailureResult,
} from "./dvd-recovery-contracts.js";

export interface OutOfRangeDvdReadFailureFixtureOptions {
  declaredByteCount: number;
  firstFailingLba: number;
  requestedBlockCount?: number;
  requestedLba?: number;
  retainedImageByteCount?: number;
}

export function createOutOfRangeDvdReadFailureResult({
  declaredByteCount,
  firstFailingLba,
  requestedBlockCount = 4,
  requestedLba = 0,
  retainedImageByteCount = firstFailingLba * DVD_SECTOR_SIZE_BYTES,
}: OutOfRangeDvdReadFailureFixtureOptions): OutOfRangeDvdReadFailureResult {
  return {
    protocolVersion: 1,
    classifierVersion: DVD_READ_FAILURE_CLASSIFIER_VERSION,
    category: "out_of_range",
    scsiStatus: 2,
    hostStatus: 0,
    driverStatus: 8,
    senseResponseCode: 0x70,
    senseKey: 5,
    asc: 0x21,
    ascq: 0,
    informationLba: firstFailingLba,
    requestedLba,
    requestedBlockCount,
    retryOrdinal: 0,
    declaredByteCount,
    firstFailingLba,
    retainedImageByteCount,
  };
}

export function createOutOfRangeDvdReadFailure(
  options: OutOfRangeDvdReadFailureFixtureOptions,
): DvdReadFailureError {
  return new DvdReadFailureError(
    createOutOfRangeDvdReadFailureResult(options),
  );
}
