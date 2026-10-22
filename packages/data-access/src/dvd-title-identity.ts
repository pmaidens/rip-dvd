import { createHash } from "node:crypto";

import { DomainInvariantError } from "./errors.js";
import type {
  DvdTitleIdentityObservationInput,
  DvdTitleIdentitySelectedPathEntry,
  UnreadableSectorRange,
} from "./types.js";

export const DVD_TITLE_IDENTITY_CONTINUITY_VERSION =
  "dvd-title-identity-continuity-v1";

export interface NormalizedDvdTitleIdentityObservation
  extends DvdTitleIdentityObservationInput {
  readonly navigation: {
    readonly videoTitleSetNumber: number;
    readonly titleSetTitleNumber: number;
    readonly programChainNumber: number;
  };
  readonly selectedPath: readonly DvdTitleIdentitySelectedPathEntry[];
  readonly sourceExtents: readonly UnreadableSectorRange[];
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
  ) {
    throw new DomainInvariantError(`${label} must be a positive integer`);
  }
  return value;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new DomainInvariantError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function normalizeSelectedPath(
  entries: readonly DvdTitleIdentitySelectedPathEntry[],
): readonly DvdTitleIdentitySelectedPathEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new DomainInvariantError(
      "Title Identity selected path must contain at least one entry",
    );
  }
  return entries.map((entry) => ({
    programNumber: positiveSafeInteger(
      entry.programNumber,
      "Title Identity program number",
    ),
    cellNumber: positiveSafeInteger(
      entry.cellNumber,
      "Title Identity cell number",
    ),
    vobId: positiveSafeInteger(entry.vobId, "Title Identity VOB ID"),
    cellId: positiveSafeInteger(entry.cellId, "Title Identity cell ID"),
  }));
}

function normalizeSourceExtents(
  extents: readonly UnreadableSectorRange[],
  acceptedEndLbaExclusive: number,
): readonly UnreadableSectorRange[] {
  if (!Array.isArray(extents) || extents.length === 0) {
    throw new DomainInvariantError(
      "Title Identity source extents must contain at least one range",
    );
  }
  const normalized = extents.map((extent) => ({
    startLba: nonnegativeSafeInteger(
      extent.startLba,
      "Title Identity source extent start",
    ),
    sectorCount: positiveSafeInteger(
      extent.sectorCount,
      "Title Identity source extent length",
    ),
  })).sort((left, right) => left.startLba - right.startLba);
  let priorEnd = 0;
  for (const [index, extent] of normalized.entries()) {
    const end = extent.startLba + extent.sectorCount;
    if (!Number.isSafeInteger(end) || end > acceptedEndLbaExclusive) {
      throw new DomainInvariantError(
        "Title Identity source extent falls outside the accepted archive extent",
      );
    }
    if (index > 0 && extent.startLba <= priorEnd) {
      throw new DomainInvariantError(
        "Title Identity source extents must be normalized and non-adjacent",
      );
    }
    priorEnd = end;
  }
  return normalized;
}

export function normalizeDvdTitleIdentityObservation(
  input: DvdTitleIdentityObservationInput,
  acceptedEndLbaExclusive: number,
): NormalizedDvdTitleIdentityObservation {
  const displayTitleNumber = positiveSafeInteger(
    input.displayTitleNumber,
    "Title Identity display title number",
  );
  const angleNumber = positiveSafeInteger(
    input.angleNumber,
    "Title Identity angle number",
  );
  const angleCount = positiveSafeInteger(
    input.angleCount,
    "Title Identity angle count",
  );
  if (angleNumber > angleCount) {
    throw new DomainInvariantError(
      "Title Identity selected angle exceeds the observed angle count",
    );
  }
  const chapterStart = positiveSafeInteger(
    input.chapterStart,
    "Title Identity chapter start",
  );
  const chapterEnd = positiveSafeInteger(
    input.chapterEnd,
    "Title Identity chapter end",
  );
  const chapterCount = positiveSafeInteger(
    input.chapterCount,
    "Title Identity chapter count",
  );
  if (chapterEnd < chapterStart || chapterEnd > chapterCount) {
    throw new DomainInvariantError(
      "Title Identity chapter evidence is outside the observed chapter count",
    );
  }
  return {
    displayTitleNumber,
    navigation: {
      videoTitleSetNumber: positiveSafeInteger(
        input.navigation.videoTitleSetNumber,
        "Title Identity video title set number",
      ),
      titleSetTitleNumber: positiveSafeInteger(
        input.navigation.titleSetTitleNumber,
        "Title Identity title-set title number",
      ),
      programChainNumber: positiveSafeInteger(
        input.navigation.programChainNumber,
        "Title Identity program chain number",
      ),
    },
    selectedPath: normalizeSelectedPath(input.selectedPath),
    angleNumber,
    angleCount,
    chapterStart,
    chapterEnd,
    chapterCount,
    sourceExtents: normalizeSourceExtents(
      input.sourceExtents,
      acceptedEndLbaExclusive,
    ),
  };
}

export function dvdTitleIdentityContentDigest(
  observation: NormalizedDvdTitleIdentityObservation,
): string {
  const { displayTitleNumber: _displayTitleNumber, ...continuityEvidence } =
    observation;
  return createHash("sha256")
    .update(JSON.stringify(continuityEvidence))
    .digest("hex");
}

export function dvdTitleIdentityObservationSetDigest(
  observations: readonly (NormalizedDvdTitleIdentityObservation & {
    readonly contentDigest: string;
  })[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(observations.map((observation) => ({
      ...observation,
    })).sort((left, right) =>
      left.displayTitleNumber - right.displayTitleNumber ||
      left.contentDigest.localeCompare(right.contentDigest)
    )))
    .digest("hex");
}
