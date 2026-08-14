import {
  createCleanReadArchiveIntegrityEvidence,
  type CleanReadArchiveIntegrityEvidence,
  type UnreadableSectorRange,
} from "@rip-dvd/data-access";

export const DVD_SECTOR_SIZE_BYTES = 2_048;
export const DVD_RECOVERY_POLICY_VERSION = "dvd-recovery-v1";
export const DVD_RECOVERY_RESULT_PREFIX = "rip-dvd-recovery-result ";

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

export interface PublishableDvdValidationResult {
  outcome: "publish";
  integrityEvidence: CleanReadArchiveIntegrityEvidence;
}

export interface UnvalidatedDvdRecoveryResult {
  outcome: "requires_validation";
  recoveryResult: DamagedDvdRecoveryResult;
}

/** Extended with validated salvage outcomes by later rescue slices. */
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
  return `DVD rescue requires validation: ${result.badSectorCount} unreadable ${result.badSectorCount === 1 ? "sector" : "sectors"} in ${result.badAreaCount} ${result.badAreaCount === 1 ? "area" : "areas"}; LBAs ${lbas.join(", ")}`;
}
