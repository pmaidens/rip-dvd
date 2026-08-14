import type {
  ArchiveIntegrity,
  UnreadableSectorRange,
} from "@rip-dvd/data-access";

const ARCHIVE_INTEGRITY_LABELS = {
  unknown: "Unknown read quality",
  clean_read: "Clean read",
  watchable_salvage: "Watchable salvage",
} satisfies Record<ArchiveIntegrity, string>;

export function archiveIntegrityLabel(integrity: ArchiveIntegrity): string {
  return ARCHIVE_INTEGRITY_LABELS[integrity];
}

export interface ArchiveIntegrityDetailInput {
  badAreaCount: number | null;
  badSectorCount: number | null;
  badSectorRanges: readonly UnreadableSectorRange[] | null;
  integrity: ArchiveIntegrity;
}

export function archiveIntegrityDetail({
  badAreaCount,
  badSectorCount,
  badSectorRanges,
  integrity,
}: ArchiveIntegrityDetailInput): string | null {
  if (integrity !== "watchable_salvage") {
    return null;
  }
  if (
    !Number.isSafeInteger(badSectorCount) ||
    badSectorCount === null ||
    badSectorCount <= 0 ||
    badSectorCount > 32 ||
    !Number.isSafeInteger(badAreaCount) ||
    badAreaCount === null ||
    badAreaCount <= 0 ||
    !Array.isArray(badSectorRanges) ||
    badSectorRanges.length !== badAreaCount
  ) {
    return "Accepted salvage evidence is unavailable.";
  }
  const displayedRanges = badSectorRanges.slice(0, 8);
  const lbas: string[] = [];
  for (const range of displayedRanges) {
    if (
      !Number.isSafeInteger(range.startLba) ||
      range.startLba < 0 ||
      !Number.isSafeInteger(range.sectorCount) ||
      range.sectorCount <= 0
    ) {
      return "Accepted salvage evidence is unavailable.";
    }
    lbas.push(
      range.sectorCount === 1
        ? String(range.startLba)
        : `${range.startLba}-${range.startLba + range.sectorCount - 1}`,
    );
  }
  const hiddenAreaCount = badSectorRanges.length - displayedRanges.length;
  if (hiddenAreaCount > 0) {
    lbas.push(`and ${hiddenAreaCount} more`);
  }
  return `Automatically accepted with ${badSectorCount} unreadable ${badSectorCount === 1 ? "sector" : "sectors"} across ${badAreaCount} ${badAreaCount === 1 ? "area" : "areas"} (LBAs ${lbas.join(", ")}).`;
}
