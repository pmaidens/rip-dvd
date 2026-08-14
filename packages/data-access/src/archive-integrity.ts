import { DomainInvariantError } from "./errors.js";
import { MAX_DVD_TITLES } from "./dvd-scan.js";
import type {
  CleanReadArchiveIntegrityEvidence,
  DvdTitleBadSectorCount,
  UnreadableSectorRange,
  UnknownArchiveIntegrityEvidence,
  WatchableSalvageArchiveIntegrityEvidence,
} from "./types.js";

const MAX_WATCHABLE_SALVAGE_BAD_SECTORS = 32;

function normalizePolicyVersion(policyVersion: string): string {
  const normalizedPolicyVersion = policyVersion.trim();
  if (
    normalizedPolicyVersion.length === 0 ||
    normalizedPolicyVersion.length > 128
  ) {
    throw new DomainInvariantError(
      "Archive Integrity policy version must contain 1 to 128 characters",
    );
  }
  return normalizedPolicyVersion;
}

export function createCleanReadArchiveIntegrityEvidence(
  policyVersion: string,
): CleanReadArchiveIntegrityEvidence {
  return {
    integrity: "clean_read",
    policyVersion: normalizePolicyVersion(policyVersion),
    badSectorCount: 0,
    badAreaCount: 0,
    badSectorRanges: [],
  };
}

export function createWatchableSalvageArchiveIntegrityEvidence(
  policyVersion: string,
  unreadableSectorRanges: readonly UnreadableSectorRange[],
  badSectorCountsByTitle: readonly DvdTitleBadSectorCount[],
): WatchableSalvageArchiveIntegrityEvidence {
  const ranges = unreadableSectorRanges.map(({ startLba, sectorCount }) => ({
    startLba,
    sectorCount,
  }));
  let previousEndLba = -1;
  let badSectorCount = 0;
  for (const range of ranges) {
    const endLba = range.startLba + range.sectorCount;
    if (
      !Number.isSafeInteger(range.startLba) ||
      range.startLba < 0 ||
      !Number.isSafeInteger(range.sectorCount) ||
      range.sectorCount <= 0 ||
      !Number.isSafeInteger(endLba) ||
      range.startLba <= previousEndLba
    ) {
      throw new DomainInvariantError(
        "Watchable-salvage sector ranges must be normalized",
      );
    }
    if (range.sectorCount !== 1) {
      throw new DomainInvariantError(
        "Watchable-salvage sector evidence exceeds the policy bound",
      );
    }
    previousEndLba = endLba;
    badSectorCount += range.sectorCount;
  }
  if (
    ranges.length === 0 ||
    !Number.isSafeInteger(badSectorCount) ||
    badSectorCount > MAX_WATCHABLE_SALVAGE_BAD_SECTORS
  ) {
    throw new DomainInvariantError(
      "Watchable-salvage sector evidence exceeds the policy bound",
    );
  }
  if (
    !Array.isArray(badSectorCountsByTitle) ||
    badSectorCountsByTitle.length > MAX_DVD_TITLES
  ) {
    throw new DomainInvariantError(
      "Watchable-salvage per-title evidence exceeds the policy bound",
    );
  }
  let previousTitleNumber = 0;
  const titleCounts = badSectorCountsByTitle.map(
    ({ titleNumber, badSectorCount: titleBadSectorCount }) => {
      if (
        !Number.isSafeInteger(titleNumber) ||
        titleNumber <= previousTitleNumber ||
        !Number.isSafeInteger(titleBadSectorCount) ||
        titleBadSectorCount <= 0 ||
        titleBadSectorCount > 16 ||
        titleBadSectorCount > badSectorCount
      ) {
        throw new DomainInvariantError(
          "Watchable-salvage per-title evidence exceeds the policy bound",
        );
      }
      previousTitleNumber = titleNumber;
      return { titleNumber, badSectorCount: titleBadSectorCount };
    },
  );
  return {
    integrity: "watchable_salvage",
    policyVersion: normalizePolicyVersion(policyVersion),
    badSectorCount,
    badAreaCount: ranges.length,
    badSectorRanges: ranges,
    badSectorCountsByTitle: titleCounts,
  };
}

export function createUnknownArchiveIntegrityEvidence(): UnknownArchiveIntegrityEvidence {
  return {
    integrity: "unknown",
    policyVersion: null,
    badSectorCount: null,
    badAreaCount: null,
    badSectorRanges: null,
  };
}
