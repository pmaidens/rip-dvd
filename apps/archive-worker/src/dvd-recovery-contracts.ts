import {
  ARCHIVE_READ_FAILURE_CATEGORIES,
  classifyArchiveReadFailureEvidence,
  createCleanReadArchiveIntegrityEvidence,
  isArchiveReadFailureEvidenceConsistent,
  type ArchiveReadFailureCategory,
  type CleanReadArchiveIntegrityEvidence,
  type UnreadableSectorRange,
  type WatchableSalvageArchiveIntegrityEvidence,
} from "@rip-dvd/data-access";

export const DVD_SECTOR_SIZE_BYTES = 2_048;
export const DVD_RECOVERY_POLICY_VERSION = "dvd-recovery-v1";
export const DVD_RECOVERY_RESULT_PREFIX = "rip-dvd-recovery-result ";
export const DVD_READ_FAILURE_CLASSIFIER_VERSION =
  "scsi-read-classifier-v1";
export const DVD_READ_FAILURE_RESULT_PREFIX = "rip-dvd-read-failure ";
export const DVD_SECTOR_BOUNDARY_PROOF_VERSION =
  "dvd-sector-boundary-proof-v1";

interface DvdReadFailureResultBase {
  protocolVersion: 1;
  classifierVersion: typeof DVD_READ_FAILURE_CLASSIFIER_VERSION;
  scsiStatus: number | null;
  hostStatus: number | null;
  driverStatus: number | null;
  senseResponseCode: number | null;
  senseKey: number | null;
  asc: number | null;
  ascq: number | null;
  informationLba: number | null;
  requestedLba: number;
  requestedBlockCount: number;
  retryOrdinal: number;
}

export interface UnknownDvdReadFailureResult
  extends DvdReadFailureResultBase {
  category: "unknown";
}

export interface NonBoundaryDvdReadFailureResult
  extends DvdReadFailureResultBase {
  category: Exclude<ArchiveReadFailureCategory, "out_of_range">;
}

interface OutOfRangeDvdReadFailureResultBase
  extends DvdReadFailureResultBase {
  category: "out_of_range";
  declaredByteCount: number;
  firstFailingLba: number;
  retainedImageByteCount: number;
  informationLba: number;
  scsiStatus: 2;
  hostStatus: 0;
  driverStatus: 0 | 8;
  senseResponseCode: 0x70 | 0x72;
  senseKey: 0x05;
  asc: 0x21;
  ascq: 0;
}

export type UnprovenOutOfRangeDvdReadFailureResult =
  OutOfRangeDvdReadFailureResultBase;

export interface ProvenOutOfRangeDvdReadFailureResult
  extends OutOfRangeDvdReadFailureResultBase {
  boundaryProofVersion: typeof DVD_SECTOR_BOUNDARY_PROOF_VERSION;
  candidateConfirmationCount: 2;
  precedingSectorLba: number;
}

export type OutOfRangeDvdReadFailureResult =
  | UnprovenOutOfRangeDvdReadFailureResult
  | ProvenOutOfRangeDvdReadFailureResult;

export type DvdReadFailureResult =
  | NonBoundaryDvdReadFailureResult
  | OutOfRangeDvdReadFailureResult;

export class DvdReadFailureError extends Error {
  readonly readFailure: DvdReadFailureResult;

  constructor(readFailure: DvdReadFailureResult) {
    super({
      unknown: "DVD read failed with structured unknown evidence",
      not_ready: "DVD read failed because the Optical Drive was not ready",
      unit_attention:
        "DVD read failed after an Optical Drive media-state change",
      hardware_error: "DVD read failed after an Optical Drive hardware fault",
      transport_error: "DVD read failed while communicating with the Optical Drive",
      protection_error: "DVD read failed because DVD access was protected",
      out_of_range: "DVD read stopped at the readable boundary",
    }[readFailure.category]);
    this.name = "DvdReadFailureError";
    this.readFailure = readFailure;
  }
}

export interface CleanDvdRecoveryResult {
  outcome: "clean";
  declaredByteCount: number;
  recoveredByteCount: number;
  recoveryPolicyVersion: typeof DVD_RECOVERY_POLICY_VERSION;
  badSectorCount: 0;
  badAreaCount: 0;
  unrecoveredSectorRanges: readonly [];
}

export interface DamagedDvdRecoveryResult {
  outcome: "damaged";
  declaredByteCount: number;
  recoveredByteCount: number;
  recoveryPolicyVersion: typeof DVD_RECOVERY_POLICY_VERSION;
  badSectorCount: number;
  badAreaCount: number;
  unrecoveredSectorRanges: readonly UnreadableSectorRange[];
}

export type DvdRecoveryResult =
  | CleanDvdRecoveryResult
  | DamagedDvdRecoveryResult;

export interface DvdRecoveryProtocolPayload {
  protocolVersion: 1;
  declaredByteCount: number;
  recoveredByteCount: number;
  recoveryPolicyVersion: typeof DVD_RECOVERY_POLICY_VERSION;
  badSectorCount: number;
  badAreaCount: number;
  badSectorBitmapHex: string;
}

export interface PublishableDvdValidationResult {
  outcome: "publish";
  integrityEvidence:
    | CleanReadArchiveIntegrityEvidence
    | WatchableSalvageArchiveIntegrityEvidence;
}

export interface UnvalidatedDvdRecoveryResult {
  outcome: "requires_validation";
  recoveryResult: DamagedDvdRecoveryResult;
}

export type DvdValidationResult =
  | PublishableDvdValidationResult
  | UnvalidatedDvdRecoveryResult;

export function createCleanDvdRecoveryResult(
  declaredByteCount: number,
): CleanDvdRecoveryResult {
  return {
    outcome: "clean",
    declaredByteCount,
    recoveredByteCount: declaredByteCount,
    recoveryPolicyVersion: DVD_RECOVERY_POLICY_VERSION,
    badSectorCount: 0,
    badAreaCount: 0,
    unrecoveredSectorRanges: [],
  };
}

export function createDamagedDvdRecoveryResult(
  declaredByteCount: number,
  unreadableSectorRanges: readonly UnreadableSectorRange[],
): DamagedDvdRecoveryResult {
  const ranges = unreadableSectorRanges.map(({ startLba, sectorCount }) => ({
    startLba,
    sectorCount,
  }));
  const badSectorCount = ranges.reduce(
    (total, range) => total + range.sectorCount,
    0,
  );
  const result: DamagedDvdRecoveryResult = {
    outcome: "damaged",
    declaredByteCount,
    recoveredByteCount:
      declaredByteCount - badSectorCount * DVD_SECTOR_SIZE_BYTES,
    recoveryPolicyVersion: DVD_RECOVERY_POLICY_VERSION,
    badSectorCount,
    badAreaCount: ranges.length,
    unrecoveredSectorRanges: ranges,
  };
  validateDvdRecoveryResult(result, declaredByteCount);
  return result;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalBoundedInteger(
  value: unknown,
  maximum: number,
): value is number | null {
  return value === null ||
    (isSafeNonNegativeInteger(value) && value <= maximum);
}

const DVD_READ_FAILURE_PROTOCOL_KEYS = [
  "asc",
  "ascq",
  "category",
  "classifierVersion",
  "driverStatus",
  "hostStatus",
  "informationLba",
  "protocolVersion",
  "requestedBlockCount",
  "requestedLba",
  "retryOrdinal",
  "scsiStatus",
  "senseKey",
  "senseResponseCode",
] as const;

const DVD_OUT_OF_RANGE_FAILURE_PROTOCOL_KEYS = [
  ...DVD_READ_FAILURE_PROTOCOL_KEYS,
  "declaredByteCount",
  "firstFailingLba",
  "retainedImageByteCount",
].sort();

const DVD_PROVEN_OUT_OF_RANGE_FAILURE_PROTOCOL_KEYS = [
  ...DVD_OUT_OF_RANGE_FAILURE_PROTOCOL_KEYS,
  "boundaryProofVersion",
  "candidateConfirmationCount",
  "precedingSectorLba",
].sort();

export function isProvenDvdBoundaryCandidate(
  result: DvdReadFailureResult,
): result is ProvenOutOfRangeDvdReadFailureResult {
  return result.category === "out_of_range" &&
    "boundaryProofVersion" in result &&
    result.boundaryProofVersion === DVD_SECTOR_BOUNDARY_PROOF_VERSION;
}

export function parseDvdReadFailureResultProtocol(
  payload: string,
  expectedByteCount: number,
): DvdReadFailureResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD read failure helper result is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DVD read failure helper result is malformed");
  }
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = candidate.category === "out_of_range"
    ? candidate.boundaryProofVersion === DVD_SECTOR_BOUNDARY_PROOF_VERSION
      ? DVD_PROVEN_OUT_OF_RANGE_FAILURE_PROTOCOL_KEYS
      : DVD_OUT_OF_RANGE_FAILURE_PROTOCOL_KEYS
    : DVD_READ_FAILURE_PROTOCOL_KEYS;
  const totalSectorCount = expectedByteCount / DVD_SECTOR_SIZE_BYTES;
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    candidate.protocolVersion !== 1 ||
    candidate.classifierVersion !== DVD_READ_FAILURE_CLASSIFIER_VERSION ||
    !ARCHIVE_READ_FAILURE_CATEGORIES.includes(
      candidate.category as ArchiveReadFailureCategory,
    ) ||
    !isOptionalBoundedInteger(candidate.scsiStatus, 0xff) ||
    !isOptionalBoundedInteger(candidate.hostStatus, 0xffff) ||
    !isOptionalBoundedInteger(candidate.driverStatus, 0xffff) ||
    !isOptionalBoundedInteger(candidate.senseResponseCode, 0xff) ||
    !isOptionalBoundedInteger(candidate.senseKey, 0x0f) ||
    !isOptionalBoundedInteger(candidate.asc, 0xff) ||
    !isOptionalBoundedInteger(candidate.ascq, 0xff) ||
    !isOptionalBoundedInteger(candidate.informationLba, Number.MAX_SAFE_INTEGER) ||
    !isSafeNonNegativeInteger(candidate.requestedLba) ||
    !isSafeNonNegativeInteger(candidate.requestedBlockCount) ||
    candidate.requestedBlockCount === 0 ||
    candidate.requestedBlockCount > 0xffff_ffff ||
    !isSafeNonNegativeInteger(candidate.retryOrdinal) ||
    candidate.retryOrdinal > 0xffff_ffff ||
    !Number.isSafeInteger(totalSectorCount) ||
    totalSectorCount <= 0 ||
    candidate.requestedLba >= totalSectorCount ||
    candidate.requestedLba + candidate.requestedBlockCount > totalSectorCount ||
    (candidate.informationLba !== null &&
      (candidate.informationLba < candidate.requestedLba ||
        candidate.informationLba >=
          candidate.requestedLba + candidate.requestedBlockCount)) ||
    ((candidate.scsiStatus === null ||
      candidate.hostStatus === null ||
      candidate.driverStatus === null) &&
      (candidate.scsiStatus !== null ||
        candidate.hostStatus !== null ||
        candidate.driverStatus !== null)) ||
    (candidate.senseResponseCode === null &&
      (candidate.senseKey !== null ||
        candidate.asc !== null ||
        candidate.ascq !== null ||
        candidate.informationLba !== null)) ||
    (candidate.asc === null) !== (candidate.ascq === null)
  ) {
    throw new Error("DVD read failure helper result is malformed");
  }
  const candidateEvidence = candidate as unknown as DvdReadFailureResult;
  const hasOutOfRangeSenseEvidence =
    isArchiveReadFailureEvidenceConsistent({
      ...candidateEvidence,
      category: "out_of_range",
    });
  if (
    candidate.category === "unknown" &&
    hasOutOfRangeSenseEvidence &&
    (candidate.senseResponseCode === 0x70 ||
      candidate.senseResponseCode === 0x72) &&
    candidate.informationLba !== null
  ) {
    throw new Error("DVD read failure helper result is malformed");
  }
  if (
    candidate.category === "out_of_range" &&
    (candidate.declaredByteCount !== expectedByteCount ||
      !isSafeNonNegativeInteger(candidate.firstFailingLba) ||
      candidate.firstFailingLba !== candidate.informationLba ||
      !isSafeNonNegativeInteger(candidate.retainedImageByteCount) ||
      candidate.retainedImageByteCount > expectedByteCount ||
      candidate.retainedImageByteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
      (candidate.retainedImageByteCount !== expectedByteCount &&
        candidate.retainedImageByteCount >
          candidate.firstFailingLba * DVD_SECTOR_SIZE_BYTES) ||
      !isArchiveReadFailureEvidenceConsistent(candidateEvidence) ||
      (candidate.senseResponseCode !== 0x70 &&
        candidate.senseResponseCode !== 0x72) ||
      candidate.informationLba === null)
  ) {
    throw new Error("DVD read failure helper result is malformed");
  }
  const provenFirstFailingLba = candidate.firstFailingLba;
  if (
    candidate.category === "out_of_range" &&
    candidate.boundaryProofVersion === DVD_SECTOR_BOUNDARY_PROOF_VERSION &&
    (!isSafeNonNegativeInteger(provenFirstFailingLba) ||
      candidate.candidateConfirmationCount !== 2 ||
      provenFirstFailingLba === 0 ||
      candidate.precedingSectorLba !== provenFirstFailingLba - 1 ||
      candidate.retainedImageByteCount !==
        provenFirstFailingLba * DVD_SECTOR_SIZE_BYTES ||
      candidate.requestedLba !== provenFirstFailingLba ||
      candidate.requestedBlockCount !== 1 ||
      candidate.retryOrdinal !== 1)
  ) {
    throw new Error("DVD read failure helper result is malformed");
  }
  if (candidate.category === "out_of_range") {
    return candidate as unknown as OutOfRangeDvdReadFailureResult;
  }
  const result = candidate as unknown as NonBoundaryDvdReadFailureResult;
  const evidenceClassification = classifyArchiveReadFailureEvidence(result);
  const normalizedCategory =
    evidenceClassification === "transport_error"
      ? "transport_error"
      : result.senseResponseCode === 0x70 || result.senseResponseCode === 0x72
        ? evidenceClassification
        : "unknown";
  if (
    normalizedCategory === "recognized_medium_error" ||
    result.category !== normalizedCategory
  ) {
    throw new Error("DVD read failure helper result is malformed");
  }
  return result;
}

function isNormalizedDamagedResult(
  result: Record<string, unknown>,
  expectedByteCount: number,
): result is Record<string, unknown> & DamagedDvdRecoveryResult {
  if (
    expectedByteCount % DVD_SECTOR_SIZE_BYTES !== 0 ||
    result.outcome !== "damaged" ||
    result.declaredByteCount !== expectedByteCount ||
    !isSafeNonNegativeInteger(result.recoveredByteCount) ||
    result.recoveryPolicyVersion !== DVD_RECOVERY_POLICY_VERSION ||
    !isSafeNonNegativeInteger(result.badSectorCount) ||
    result.badSectorCount === 0 ||
    !isSafeNonNegativeInteger(result.badAreaCount) ||
    result.badAreaCount === 0 ||
    !Array.isArray(result.unrecoveredSectorRanges) ||
    result.unrecoveredSectorRanges.length !== result.badAreaCount
  ) {
    return false;
  }
  const totalSectorCount = expectedByteCount / DVD_SECTOR_SIZE_BYTES;
  let previousEndLba = -1;
  let countedBadSectors = 0;
  for (const value of result.unrecoveredSectorRanges) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("startLba" in value) ||
      !isSafeNonNegativeInteger(value.startLba) ||
      !("sectorCount" in value) ||
      !isSafeNonNegativeInteger(value.sectorCount) ||
      value.sectorCount === 0
    ) {
      return false;
    }
    const endLba = value.startLba + value.sectorCount;
    if (
      !Number.isSafeInteger(endLba) ||
      endLba > totalSectorCount ||
      value.startLba <= previousEndLba
    ) {
      return false;
    }
    previousEndLba = endLba;
    countedBadSectors += value.sectorCount;
  }
  return (
    countedBadSectors === result.badSectorCount &&
    result.recoveredByteCount ===
      expectedByteCount - countedBadSectors * DVD_SECTOR_SIZE_BYTES
  );
}

export function validateDvdRecoveryResult(
  result: unknown,
  expectedByteCount: number,
): DvdValidationResult {
  if (typeof result !== "object" || result === null) {
    throw new Error("DVD recovery result is invalid");
  }
  const candidate = result as Record<string, unknown>;
  if (
    candidate.outcome === "clean" &&
    candidate.declaredByteCount === expectedByteCount &&
    candidate.recoveredByteCount === expectedByteCount &&
    candidate.recoveryPolicyVersion === DVD_RECOVERY_POLICY_VERSION &&
    candidate.badSectorCount === 0 &&
    candidate.badAreaCount === 0 &&
    Array.isArray(candidate.unrecoveredSectorRanges) &&
    candidate.unrecoveredSectorRanges.length === 0
  ) {
    return {
      outcome: "publish",
      integrityEvidence: createCleanReadArchiveIntegrityEvidence(
        DVD_RECOVERY_POLICY_VERSION,
      ),
    };
  }
  if (isNormalizedDamagedResult(candidate, expectedByteCount)) {
    return {
      outcome: "requires_validation",
      recoveryResult: candidate,
    };
  }
  throw new Error("DVD recovery result is invalid");
}

export function validateResumedDvdRecoveryResult(
  result: unknown,
  prior: DamagedDvdRecoveryResult,
  expectedByteCount: number,
): DvdValidationResult {
  const validation = validateDvdRecoveryResult(result, expectedByteCount);
  if (validation.outcome === "requires_validation") {
    let priorIndex = 0;
    for (const range of validation.recoveryResult.unrecoveredSectorRanges) {
      while (
        priorIndex < prior.unrecoveredSectorRanges.length &&
        prior.unrecoveredSectorRanges[priorIndex]!.startLba +
          prior.unrecoveredSectorRanges[priorIndex]!.sectorCount <=
          range.startLba
      ) {
        priorIndex += 1;
      }
      const priorRange = prior.unrecoveredSectorRanges[priorIndex];
      if (
        priorRange === undefined ||
        range.startLba < priorRange.startLba ||
        range.startLba + range.sectorCount >
          priorRange.startLba + priorRange.sectorCount
      ) {
        throw new Error("Resumed DVD recovery result is invalid");
      }
    }
  }
  return validation;
}

export function formatDvdRecoveryResumeBitmap(
  result: DamagedDvdRecoveryResult,
): string {
  const totalSectorCount = result.declaredByteCount / DVD_SECTOR_SIZE_BYTES;
  const bitmap = Buffer.alloc(Math.ceil(totalSectorCount / 8));
  for (const range of result.unrecoveredSectorRanges) {
    for (
      let lba = range.startLba;
      lba < range.startLba + range.sectorCount;
      lba += 1
    ) {
      bitmap[Math.floor(lba / 8)]! |= 1 << (lba % 8);
    }
  }
  return bitmap.toString("hex");
}

export function createDvdRecoveryProtocolPayload(
  result: DvdRecoveryResult,
): DvdRecoveryProtocolPayload {
  return {
    protocolVersion: 1,
    declaredByteCount: result.declaredByteCount,
    recoveredByteCount: result.recoveredByteCount,
    recoveryPolicyVersion: result.recoveryPolicyVersion,
    badSectorCount: result.badSectorCount,
    badAreaCount: result.badAreaCount,
    badSectorBitmapHex:
      result.outcome === "clean"
        ? ""
        : formatDvdRecoveryResumeBitmap(result),
  };
}

function parseBadSectorBitmap(
  bitmapHex: string,
  totalSectorCount: number,
): UnreadableSectorRange[] {
  const expectedByteCount = Math.ceil(totalSectorCount / 8);
  if (
    bitmapHex.length !== expectedByteCount * 2 ||
    !/^[0-9a-f]*$/.test(bitmapHex)
  ) {
    throw new Error("DVD recovery helper result is malformed");
  }
  const bytes = Buffer.from(bitmapHex, "hex");
  const ranges: UnreadableSectorRange[] = [];
  let rangeStart: number | undefined;
  for (let lba = 0; lba < bytes.length * 8; lba += 1) {
    const isUnreadable =
      (bytes[Math.floor(lba / 8)]! & (1 << (lba % 8))) !== 0;
    if (lba >= totalSectorCount && isUnreadable) {
      throw new Error("DVD recovery helper result is malformed");
    }
    if (lba < totalSectorCount && isUnreadable && rangeStart === undefined) {
      rangeStart = lba;
    } else if (!isUnreadable && rangeStart !== undefined) {
      ranges.push({ startLba: rangeStart, sectorCount: lba - rangeStart });
      rangeStart = undefined;
    }
  }
  if (rangeStart !== undefined) {
    ranges.push({
      startLba: rangeStart,
      sectorCount: totalSectorCount - rangeStart,
    });
  }
  return ranges;
}

export function parseDvdRecoveryResultProtocol(
  payload: string,
  expectedByteCount: number,
): DvdRecoveryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD recovery helper result is malformed");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("protocolVersion" in parsed) ||
    parsed.protocolVersion !== 1 ||
    !("declaredByteCount" in parsed) ||
    parsed.declaredByteCount !== expectedByteCount ||
    !("recoveredByteCount" in parsed) ||
    !isSafeNonNegativeInteger(parsed.recoveredByteCount) ||
    !("recoveryPolicyVersion" in parsed) ||
    parsed.recoveryPolicyVersion !== DVD_RECOVERY_POLICY_VERSION ||
    !("badSectorCount" in parsed) ||
    !isSafeNonNegativeInteger(parsed.badSectorCount) ||
    !("badAreaCount" in parsed) ||
    !isSafeNonNegativeInteger(parsed.badAreaCount) ||
    !("badSectorBitmapHex" in parsed) ||
    typeof parsed.badSectorBitmapHex !== "string"
  ) {
    throw new Error("DVD recovery helper result is malformed");
  }
  if (parsed.badSectorCount === 0) {
    if (
      parsed.badAreaCount !== 0 ||
      parsed.recoveredByteCount !== expectedByteCount ||
      parsed.badSectorBitmapHex !== ""
    ) {
      throw new Error("DVD recovery helper result is malformed");
    }
    return createCleanDvdRecoveryResult(expectedByteCount);
  }
  if (expectedByteCount % DVD_SECTOR_SIZE_BYTES !== 0) {
    throw new Error("DVD recovery helper result is malformed");
  }
  const ranges = parseBadSectorBitmap(
    parsed.badSectorBitmapHex,
    expectedByteCount / DVD_SECTOR_SIZE_BYTES,
  );
  const result = createDamagedDvdRecoveryResult(expectedByteCount, ranges);
  if (
    result.recoveredByteCount !== parsed.recoveredByteCount ||
    result.badSectorCount !== parsed.badSectorCount ||
    result.badAreaCount !== parsed.badAreaCount
  ) {
    throw new Error("DVD recovery helper result is malformed");
  }
  return result;
}

export function formatUnvalidatedDvdRecovery(
  result: DamagedDvdRecoveryResult,
): string {
  return `DVD rescue requires validation: ${result.badSectorCount} unreadable ${result.badSectorCount === 1 ? "sector" : "sectors"} in ${result.badAreaCount} ${result.badAreaCount === 1 ? "area" : "areas"}; LBAs ${formatDvdDamageRanges(result)}`;
}

export function formatDvdDamageRanges(
  result: DamagedDvdRecoveryResult,
): string {
  const displayedRanges = result.unrecoveredSectorRanges.slice(0, 8);
  const lbas = displayedRanges.map(({ startLba, sectorCount }) =>
    sectorCount === 1
      ? String(startLba)
      : `${startLba}-${startLba + sectorCount - 1}`,
  );
  const hiddenAreaCount = result.badAreaCount - displayedRanges.length;
  if (hiddenAreaCount > 0) {
    lbas.push(`and ${hiddenAreaCount} more`);
  }
  return lbas.join(", ");
}
