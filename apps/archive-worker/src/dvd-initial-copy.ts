import { lstat } from "node:fs/promises";

import type {
  ArchiveJobProgress,
  DvdUnrecoveredSourceRange,
} from "@rip-dvd/data-access";

export const DVD_INITIAL_COPY_POLICY_VERSION =
  "dvd-initial-copy-v1" as const;
export const DVD_INITIAL_COPY_RESULT_PREFIX =
  "rip-dvd-initial-copy-result ";
export const DVD_INITIAL_COPY_DIAGNOSTIC_LIMIT = 64;
export const DVD_SECTOR_SIZE_BYTES = 2_048;

export interface DvdInitialCopyDiagnostic {
  classification: "tolerable_medium_error";
  classifierVersion: "scsi-read-classifier-v2";
  requestedLba: number;
  requestedBlockCount: number;
  retryOrdinal: number;
  scsiStatus: number;
  hostStatus: 0;
  driverStatus: number;
  senseResponseCode: 0x70 | 0x72;
  senseKey: 0x03;
  asc: number;
  ascq: number;
  informationLba: number | null;
}

export interface DvdInitialCopyResult {
  copyPolicyVersion: typeof DVD_INITIAL_COPY_POLICY_VERSION;
  declaredByteCount: number;
  recoveredByteCount: number;
  skippedRequestCount: number;
  diagnosticsTruncated: boolean;
  diagnostics: readonly DvdInitialCopyDiagnostic[];
  unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
}

export interface DvdInitialCopyRequest {
  authorizeStart?(): void | Promise<void>;
  devicePath: string;
  outputPath: string;
  sizeBytes: number;
  signal: AbortSignal;
  onBytesCopied(bytes: number): void;
}

export interface DvdInitialCopyRunner {
  copyInitial(request: DvdInitialCopyRequest): Promise<DvdInitialCopyResult>;
  waitForInactive(devicePath: string, outputPath: string): Promise<void>;
}

export interface CompletedDvdInitialCopy extends DvdInitialCopyResult {
  imageFilesystemIdentity: string;
  imagePath: string;
}

const INITIAL_COPY_RESULT_KEYS = [
  "copyPolicyVersion",
  "declaredByteCount",
  "diagnostics",
  "diagnosticsTruncated",
  "protocolVersion",
  "recoveredByteCount",
  "skippedRegionCount",
  "skippedRequestCount",
  "skippedSectorBitmapHex",
  "skippedSectorCount",
] as const;

const INITIAL_COPY_DIAGNOSTIC_KEYS = [
  "asc",
  "ascq",
  "classification",
  "classifierVersion",
  "driverStatus",
  "hostStatus",
  "informationLba",
  "requestedBlockCount",
  "requestedLba",
  "retryOrdinal",
  "scsiStatus",
  "senseKey",
  "senseResponseCode",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  candidate: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(candidate).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum;
}

function parseDiagnostic(
  value: unknown,
  totalSectorCount: number,
): DvdInitialCopyDiagnostic {
  if (!isRecord(value) || !hasExactKeys(value, INITIAL_COPY_DIAGNOSTIC_KEYS)) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  const requestEndLba = Number(value.requestedLba) +
    Number(value.requestedBlockCount);
  const driverBaseStatus = Number(value.driverStatus) & 0x0f;
  if (
    value.classification !== "tolerable_medium_error" ||
    value.classifierVersion !== "scsi-read-classifier-v2" ||
    !isIntegerInRange(value.requestedLba, 0, totalSectorCount - 1) ||
    !isIntegerInRange(value.requestedBlockCount, 1, 0xffff_ffff) ||
    !Number.isSafeInteger(requestEndLba) ||
    requestEndLba > totalSectorCount ||
    !isIntegerInRange(value.retryOrdinal, 0, 0xffff_ffff) ||
    !isIntegerInRange(value.scsiStatus, 0, 0xff) ||
    (Number(value.scsiStatus) & 0xfe) !== 0x02 ||
    value.hostStatus !== 0 ||
    !isIntegerInRange(value.driverStatus, 0, 0xffff) ||
    (driverBaseStatus !== 0 && driverBaseStatus !== 8) ||
    (value.senseResponseCode !== 0x70 && value.senseResponseCode !== 0x72) ||
    value.senseKey !== 0x03 ||
    !isIntegerInRange(value.asc, 0, 0xff) ||
    !isIntegerInRange(value.ascq, 0, 0xff) ||
    (value.informationLba !== null &&
      !isIntegerInRange(
        value.informationLba,
        Number(value.requestedLba),
        requestEndLba - 1,
      ))
  ) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  return value as unknown as DvdInitialCopyDiagnostic;
}

function bitmapHasSector(bitmap: Buffer, lba: number): boolean {
  return (bitmap[Math.floor(lba / 8)]! & (1 << (lba % 8))) !== 0;
}

function rangesFromBitmap(
  bitmap: Buffer,
  totalSectorCount: number,
): DvdUnrecoveredSourceRange[] {
  const ranges: DvdUnrecoveredSourceRange[] = [];
  let startLba: number | undefined;
  for (let lba = 0; lba < totalSectorCount; lba += 1) {
    const skipped = bitmapHasSector(bitmap, lba);
    if (skipped && startLba === undefined) {
      startLba = lba;
    } else if (!skipped && startLba !== undefined) {
      ranges.push({
        startLba,
        sectorCount: lba - startLba,
        classification: "skipped_untested",
      });
      startLba = undefined;
    }
  }
  if (startLba !== undefined) {
    ranges.push({
      startLba,
      sectorCount: totalSectorCount - startLba,
      classification: "skipped_untested",
    });
  }
  return ranges;
}

function skippedSectorCount(bitmap: Buffer): number {
  let count = 0;
  for (const byte of bitmap) {
    let remaining = byte;
    while (remaining !== 0) {
      count += remaining & 1;
      remaining >>>= 1;
    }
  }
  return count;
}

function validateDiagnosticCoverage(
  bitmap: Buffer,
  diagnostics: readonly DvdInitialCopyDiagnostic[],
  diagnosticsTruncated: boolean,
  skippedRequestCount: number,
): void {
  let previousEndLba = 0;
  let coveredSectorCount = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.requestedLba < previousEndLba) {
      throw new Error("DVD initial-copy helper result is malformed");
    }
    const endLba = diagnostic.requestedLba + diagnostic.requestedBlockCount;
    for (let lba = diagnostic.requestedLba; lba < endLba; lba += 1) {
      if (!bitmapHasSector(bitmap, lba)) {
        throw new Error("DVD initial-copy helper result is malformed");
      }
    }
    coveredSectorCount += diagnostic.requestedBlockCount;
    previousEndLba = endLba;
  }
  if (
    diagnostics.length > DVD_INITIAL_COPY_DIAGNOSTIC_LIMIT ||
    (diagnosticsTruncated
      ? skippedRequestCount <= diagnostics.length
      : skippedRequestCount !== diagnostics.length) ||
    (!diagnosticsTruncated && coveredSectorCount !== skippedSectorCount(bitmap))
  ) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
}

export function parseDvdInitialCopyResultProtocol(
  payload: string,
  expectedByteCount: number,
): DvdInitialCopyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, INITIAL_COPY_RESULT_KEYS)) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  if (
    !Number.isSafeInteger(expectedByteCount) ||
    expectedByteCount <= 0 ||
    expectedByteCount % DVD_SECTOR_SIZE_BYTES !== 0
  ) {
    throw new Error("DVD initial-copy expected size is invalid");
  }
  const totalSectorCount = expectedByteCount / DVD_SECTOR_SIZE_BYTES;
  const skippedRequestCount = Number(parsed.skippedRequestCount);
  if (
    parsed.protocolVersion !== 1 ||
    parsed.copyPolicyVersion !== DVD_INITIAL_COPY_POLICY_VERSION ||
    parsed.declaredByteCount !== expectedByteCount ||
    !isIntegerInRange(parsed.recoveredByteCount, 0, expectedByteCount) ||
    !isIntegerInRange(parsed.skippedSectorCount, 0, totalSectorCount) ||
    !isIntegerInRange(parsed.skippedRegionCount, 0, totalSectorCount) ||
    !isIntegerInRange(parsed.skippedRequestCount, 0, totalSectorCount) ||
    typeof parsed.diagnosticsTruncated !== "boolean" ||
    !Array.isArray(parsed.diagnostics) ||
    typeof parsed.skippedSectorBitmapHex !== "string" ||
    !/^[0-9a-f]*$/.test(parsed.skippedSectorBitmapHex)
  ) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  const expectedBitmapByteCount = Math.ceil(totalSectorCount / 8);
  const bitmap = parsed.skippedSectorCount === 0
    ? Buffer.alloc(expectedBitmapByteCount)
    : Buffer.from(parsed.skippedSectorBitmapHex, "hex");
  if (
    (parsed.skippedSectorCount === 0 && parsed.skippedSectorBitmapHex !== "") ||
    (parsed.skippedSectorCount > 0 &&
      bitmap.length !== expectedBitmapByteCount) ||
    (totalSectorCount % 8 !== 0 &&
      (bitmap.at(-1)! >>> (totalSectorCount % 8)) !== 0)
  ) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  const ranges = rangesFromBitmap(bitmap, totalSectorCount);
  const actualSkippedSectorCount = skippedSectorCount(bitmap);
  if (
    actualSkippedSectorCount !== parsed.skippedSectorCount ||
    ranges.length !== parsed.skippedRegionCount ||
    parsed.recoveredByteCount !==
      expectedByteCount - actualSkippedSectorCount * DVD_SECTOR_SIZE_BYTES ||
    (actualSkippedSectorCount === 0) !== (skippedRequestCount === 0) ||
    skippedRequestCount < ranges.length
  ) {
    throw new Error("DVD initial-copy helper result is malformed");
  }
  const diagnostics = parsed.diagnostics.map((diagnostic) =>
    parseDiagnostic(diagnostic, totalSectorCount)
  );
  validateDiagnosticCoverage(
    bitmap,
    diagnostics,
    parsed.diagnosticsTruncated,
    skippedRequestCount,
  );
  return {
    copyPolicyVersion: DVD_INITIAL_COPY_POLICY_VERSION,
    declaredByteCount: expectedByteCount,
    recoveredByteCount: parsed.recoveredByteCount,
    skippedRequestCount,
    diagnosticsTruncated: parsed.diagnosticsTruncated,
    diagnostics,
    unrecoveredSourceRanges: ranges,
  };
}

function validateInjectedResult(
  result: DvdInitialCopyResult,
  expectedByteCount: number,
): void {
  const totalSectorCount = expectedByteCount / DVD_SECTOR_SIZE_BYTES;
  let skippedSectorCount = 0;
  let previousEndLba = 0;
  for (const range of result.unrecoveredSourceRanges) {
    const endLba = range.startLba + range.sectorCount;
    if (
      range.classification !== "skipped_untested" ||
      !Number.isSafeInteger(range.startLba) ||
      range.startLba < previousEndLba ||
      !Number.isSafeInteger(range.sectorCount) ||
      range.sectorCount <= 0 ||
      !Number.isSafeInteger(endLba) ||
      endLba > totalSectorCount
    ) {
      throw new Error("DVD initial-copy result is invalid");
    }
    skippedSectorCount += range.sectorCount;
    previousEndLba = endLba;
  }
  if (
    result.copyPolicyVersion !== DVD_INITIAL_COPY_POLICY_VERSION ||
    result.declaredByteCount !== expectedByteCount ||
    result.recoveredByteCount !==
      expectedByteCount - skippedSectorCount * DVD_SECTOR_SIZE_BYTES ||
    !Number.isSafeInteger(result.skippedRequestCount) ||
    result.skippedRequestCount < result.unrecoveredSourceRanges.length ||
    result.diagnostics.length > DVD_INITIAL_COPY_DIAGNOSTIC_LIMIT ||
    (!result.diagnosticsTruncated &&
      result.diagnostics.length !== result.skippedRequestCount)
  ) {
    throw new Error("DVD initial-copy result is invalid");
  }
}

export async function runDvdInitialCopyForArchiveJob({
  authorizeCopy,
  devicePath,
  onProgress,
  outputPath,
  runner,
  signal,
  sizeBytes,
}: {
  authorizeCopy?(): void | Promise<void>;
  devicePath: string;
  onProgress(progress: ArchiveJobProgress): void;
  outputPath: string;
  runner: DvdInitialCopyRunner;
  signal: AbortSignal;
  sizeBytes: number;
}): Promise<CompletedDvdInitialCopy> {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes % DVD_SECTOR_SIZE_BYTES !== 0
  ) {
    throw new Error("DVD initial-copy size is invalid");
  }
  signal.throwIfAborted();
  onProgress({ phase: "copying", progressPercent: 0 });
  let result: DvdInitialCopyResult;
  try {
    result = await runner.copyInitial({
      authorizeStart: authorizeCopy,
      devicePath,
      outputPath,
      sizeBytes,
      signal,
      onBytesCopied(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0) return;
        const progressBytes = Math.min(bytes, sizeBytes);
        onProgress({
          phase: "copying",
          progressBytes,
          progressPercent: Math.min(
            99,
            Math.floor((progressBytes * 100) / sizeBytes),
          ),
        });
      },
    });
  } catch (error) {
    await runner.waitForInactive(devicePath, outputPath);
    throw error;
  }
  signal.throwIfAborted();
  validateInjectedResult(result, sizeBytes);
  const image = await lstat(outputPath);
  if (
    !image.isFile() ||
    image.isSymbolicLink() ||
    image.size !== sizeBytes ||
    !Number.isSafeInteger(image.dev) ||
    image.dev < 0 ||
    !Number.isSafeInteger(image.ino) ||
    image.ino <= 0
  ) {
    throw new Error("DVD initial copy did not produce the expected image");
  }
  return {
    ...result,
    imageFilesystemIdentity: `${image.dev}:${image.ino}`,
    imagePath: outputPath,
  };
}
