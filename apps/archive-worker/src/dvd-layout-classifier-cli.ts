import type { UnreadableSectorRange } from "@rip-dvd/data-access";

import { classifyDvdImageDamage } from "./dvd-layout-classifier.js";

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

const [imagePath, expectedByteCountText, rangesText, ...extraArguments] =
  process.argv.slice(2);
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

const result = await classifyDvdImageDamage({
  imagePath,
  expectedByteCount,
  unreadableSectorRanges: decodeRanges(rangesText),
});
process.stdout.write(`${JSON.stringify({ protocolVersion: 3, ...result })}\n`);
