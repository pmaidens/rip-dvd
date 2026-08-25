import type { UnreadableSectorRange } from "@rip-dvd/data-access";

import {
  classifyDvdImageDamage,
  proveDvdImageLayoutCompleteness,
} from "./dvd-layout-classifier.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import { DVD_SECTOR_SIZE_BYTES } from "./dvd-recovery-contracts.js";

function decodeRanges(value: string): readonly UnreadableSectorRange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("DVD salvage classifier ranges are malformed");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new Error("DVD salvage classifier ranges are invalid");
  }
  let previousEndLba = -1;
  const ranges: UnreadableSectorRange[] = [];
  for (const valueRange of parsed) {
    if (
      typeof valueRange !== "object" ||
      valueRange === null ||
      !("startLba" in valueRange) ||
      !Number.isSafeInteger(valueRange.startLba) ||
      (valueRange.startLba as number) < 0 ||
      !("sectorCount" in valueRange) ||
      !Number.isSafeInteger(valueRange.sectorCount) ||
      (valueRange.sectorCount as number) <= 0
    ) {
      throw new Error("DVD salvage classifier ranges are invalid");
    }
    const startLba = valueRange.startLba as number;
    const sectorCount = valueRange.sectorCount as number;
    const endLba = startLba + sectorCount;
    if (!Number.isSafeInteger(endLba) || startLba <= previousEndLba) {
      throw new Error("DVD salvage classifier ranges are not normalized");
    }
    ranges.push({ startLba, sectorCount });
    previousEndLba = endLba;
  }
  return ranges;
}

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "proof") {
  const [_, imagePath, candidateBoundaryLbaText, ...extraArguments] = arguments_;
  const candidateBoundaryLba = Number(candidateBoundaryLbaText);
  if (
    imagePath === undefined ||
    extraArguments.length > 0 ||
    !Number.isSafeInteger(candidateBoundaryLba) ||
    candidateBoundaryLba <= 0
  ) {
    throw new Error("DVD completeness classifier arguments are invalid");
  }
  requireDvdContentSize(candidateBoundaryLba * DVD_SECTOR_SIZE_BYTES);
  const result = await proveDvdImageLayoutCompleteness({
    candidateBoundaryLba,
    imagePath,
  });
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, ...result })}\n`);
} else {
  const [imagePath, expectedByteCountText, rangesText, ...extraArguments] =
    arguments_;
  const expectedByteCount = Number(expectedByteCountText);
  if (
    imagePath === undefined ||
    rangesText === undefined ||
    extraArguments.length > 0 ||
    !Number.isSafeInteger(expectedByteCount) ||
    expectedByteCount <= 0
  ) {
    throw new Error("DVD salvage classifier arguments are invalid");
  }
  requireDvdContentSize(expectedByteCount);

  const result = await classifyDvdImageDamage({
    imagePath,
    expectedByteCount,
    unreadableSectorRanges: decodeRanges(rangesText),
  });
  process.stdout.write(`${JSON.stringify({ protocolVersion: 3, ...result })}\n`);
}
