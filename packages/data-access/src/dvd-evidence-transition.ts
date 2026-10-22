import { DomainInvariantError } from "./errors.js";
import type { DvdUnrecoveredSourceRange } from "./types.js";

export type DvdArchiveRecoveryReadOutcome = "recovered" | "failed";

/** Apply one persisted one-sector observation to the normalized current map. */
export function dvdEvidenceRangesAfterRecoveryRead(
  ranges: readonly DvdUnrecoveredSourceRange[],
  startLba: number,
  outcome: DvdArchiveRecoveryReadOutcome,
): DvdUnrecoveredSourceRange[] {
  const containingIndex = ranges.findIndex((range) =>
    startLba >= range.startLba &&
    startLba < range.startLba + range.sectorCount
  );
  if (containingIndex < 0) {
    throw new DomainInvariantError(
      "Persisted DVD Archive Recovery evidence does not target Unrecovered Source",
    );
  }

  const containing = ranges[containingIndex]!;
  const replacements: DvdUnrecoveredSourceRange[] = [];
  if (startLba > containing.startLba) {
    replacements.push({
      startLba: containing.startLba,
      sectorCount: startLba - containing.startLba,
      classification: containing.classification,
    });
  }
  if (outcome === "failed") {
    replacements.push({
      startLba,
      sectorCount: 1,
      classification: "individually_failed",
    });
  }
  const containingEndLbaExclusive =
    containing.startLba + containing.sectorCount;
  if (startLba + 1 < containingEndLbaExclusive) {
    replacements.push({
      startLba: startLba + 1,
      sectorCount: containingEndLbaExclusive - startLba - 1,
      classification: containing.classification,
    });
  }

  return [
    ...ranges.slice(0, containingIndex),
    ...replacements,
    ...ranges.slice(containingIndex + 1),
  ].reduce<DvdUnrecoveredSourceRange[]>((normalized, range) => {
    const previous = normalized.at(-1);
    if (
      previous !== undefined &&
      previous.classification === range.classification &&
      previous.startLba + previous.sectorCount === range.startLba
    ) {
      normalized[normalized.length - 1] = {
        ...previous,
        sectorCount: previous.sectorCount + range.sectorCount,
      };
    } else {
      normalized.push(range);
    }
    return normalized;
  }, []);
}

export function assertDvdEvidenceRangeTransition(
  previous: readonly DvdUnrecoveredSourceRange[],
  current: readonly DvdUnrecoveredSourceRange[],
  recoveryRead: { startLba: number; outcome: DvdArchiveRecoveryReadOutcome },
): void {
  const expected = dvdEvidenceRangesAfterRecoveryRead(
    previous,
    recoveryRead.startLba,
    recoveryRead.outcome,
  );
  if (
    expected.length !== current.length ||
    expected.some((range, index) => {
      const actual = current[index];
      return actual === undefined ||
        actual.startLba !== range.startLba ||
        actual.sectorCount !== range.sectorCount ||
        actual.classification !== range.classification;
    })
  ) {
    throw new DomainInvariantError(
      "Persisted DVD Archive Evidence ranges do not match their recovery read",
    );
  }
}
