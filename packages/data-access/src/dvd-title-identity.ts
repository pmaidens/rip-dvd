import { createHash } from "node:crypto";

import { DomainInvariantError } from "./errors.js";
import type {
  DvdTitleIdentityReviewSet,
  DvdTitleIdentityReviewSetItem,
  DvdTitleIdentityObservationInput,
  DvdTitleIdentityContinuityResult,
  DvdTitleIdentitySelectedPathEntry,
  UnreadableSectorRange,
} from "./types.js";

export const DVD_TITLE_IDENTITY_CONTINUITY_VERSION =
  "dvd-title-identity-continuity-v1";

const TITLE_IDENTITY_CONTENT_DOMAIN =
  "rip-dvd:dvd-title-identity-content:v1\0";
const TITLE_IDENTITY_OBSERVATION_SET_DOMAIN =
  "rip-dvd:dvd-title-identity-observation-set:v1\0";
const TITLE_IDENTITY_REVIEW_SET_DOMAIN =
  "rip-dvd:dvd-title-identity-review-set:v1\0";

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

export interface DvdTitleIdentityContinuityPlan {
  readonly previousIndex: number | null;
  readonly result: DvdTitleIdentityContinuityResult;
}

interface DvdTitleIdentityContinuityEvidence {
  readonly displayTitleNumber: number;
  readonly contentDigest: string;
}

export function planDvdTitleIdentityContinuity(
  current: readonly DvdTitleIdentityContinuityEvidence[],
  previous: readonly DvdTitleIdentityContinuityEvidence[],
  hasPreviousCheckpoint: boolean,
): readonly DvdTitleIdentityContinuityPlan[] {
  const currentDigestCounts = new Map<string, number>();
  const previousIndexesByDigest = new Map<string, number[]>();
  for (const observation of current) {
    currentDigestCounts.set(
      observation.contentDigest,
      (currentDigestCounts.get(observation.contentDigest) ?? 0) + 1,
    );
  }
  for (const [index, observation] of previous.entries()) {
    const indexes = previousIndexesByDigest.get(observation.contentDigest) ?? [];
    indexes.push(index);
    previousIndexesByDigest.set(observation.contentDigest, indexes);
  }

  // Reserve every unambiguous content match before considering title
  // numbers. Changed content that kept an old number must not consume the
  // predecessor of unchanged content that was renumbered.
  const exactMatches = new Map<number, number>();
  const usedPreviousIndexes = new Set<number>();
  for (const [index, observation] of current.entries()) {
    const candidates = previousIndexesByDigest.get(observation.contentDigest) ??
      [];
    if (
      currentDigestCounts.get(observation.contentDigest) === 1 &&
      candidates.length === 1
    ) {
      exactMatches.set(index, candidates[0]!);
      usedPreviousIndexes.add(candidates[0]!);
    }
  }

  // Title number is only uncertain fallback evidence when it identifies one
  // unmatched observation on each side. Grouping before assignment makes the
  // result independent of worker reporting order for paths and angles.
  const currentIndexesByDisplayNumber = new Map<number, number[]>();
  for (const [index, observation] of current.entries()) {
    if (exactMatches.has(index)) continue;
    const indexes = currentIndexesByDisplayNumber.get(
      observation.displayTitleNumber,
    ) ?? [];
    indexes.push(index);
    currentIndexesByDisplayNumber.set(observation.displayTitleNumber, indexes);
  }
  const previousIndexesByDisplayNumber = new Map<number, number[]>();
  for (const [index, observation] of previous.entries()) {
    if (usedPreviousIndexes.has(index)) continue;
    const indexes = previousIndexesByDisplayNumber.get(
      observation.displayTitleNumber,
    ) ?? [];
    indexes.push(index);
    previousIndexesByDisplayNumber.set(observation.displayTitleNumber, indexes);
  }
  const uncertainMatches = new Map<number, number>();
  for (const [displayTitleNumber, indexes] of currentIndexesByDisplayNumber) {
    const candidates = previousIndexesByDisplayNumber.get(displayTitleNumber) ??
      [];
    if (indexes.length === 1 && candidates.length === 1) {
      uncertainMatches.set(indexes[0]!, candidates[0]!);
    }
  }

  return current.map((_observation, index) => {
    const exactMatch = exactMatches.get(index);
    const uncertainMatch = uncertainMatches.get(index);
    if (exactMatch !== undefined) {
      return { previousIndex: exactMatch, result: "proved" };
    }
    if (uncertainMatch !== undefined) {
      return { previousIndex: uncertainMatch, result: "uncertain" };
    }
    return {
      previousIndex: null,
      result: hasPreviousCheckpoint ? "new" : "initial",
    };
  });
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
  return digest(
    TITLE_IDENTITY_CONTENT_DOMAIN,
    canonicalTitleIdentityContent(observation),
  );
}

export function dvdTitleIdentityObservationSetDigest(
  observations: readonly (NormalizedDvdTitleIdentityObservation & {
    readonly contentDigest: string;
  })[],
): string {
  const ordered = [...observations].sort((left, right) =>
    left.displayTitleNumber - right.displayTitleNumber ||
    left.contentDigest.localeCompare(right.contentDigest)
  );
  return digest(
    TITLE_IDENTITY_OBSERVATION_SET_DOMAIN,
    ordered.map((observation) => [
      observation.displayTitleNumber,
      observation.contentDigest,
      canonicalTitleIdentityContent(observation),
    ]),
  );
}

export function dvdTitleIdentityReviewSetDigest(
  checkpoint: DvdTitleIdentityReviewSet["checkpoint"],
  items: readonly DvdTitleIdentityReviewSetItem[],
): string {
  const ordered = [...items].sort((left, right) =>
    left.titleIdentityId.localeCompare(right.titleIdentityId)
  );
  return digest(TITLE_IDENTITY_REVIEW_SET_DOMAIN, [
    checkpoint.manifestId,
    checkpoint.manifestRevision,
    checkpoint.manifestDigest,
    ordered.map((item) => [
      item.titleIdentityId,
      item.presentAtCurrentCheckpoint,
      [
        item.observation.id,
        item.observation.checkpoint.manifestId,
        item.observation.checkpoint.manifestRevision,
        item.observation.checkpoint.manifestDigest,
        item.observation.contentDigest,
      ],
      [
        item.reviewContinuity.result,
        item.reviewContinuity.policyVersion,
        item.reviewContinuity.previousObservationId,
      ],
      item.mappingState,
      [...item.discSelectionMappings]
        .sort((left, right) =>
          left.discSelectionId.localeCompare(right.discSelectionId)
        )
        .map((mapping) => [
          mapping.discSelectionId,
          mapping.mappingState,
        ]),
    ]),
  ]);
}

function canonicalTitleIdentityContent(
  observation: NormalizedDvdTitleIdentityObservation,
): unknown {
  return [
    observation.navigation.videoTitleSetNumber,
    observation.navigation.titleSetTitleNumber,
    observation.navigation.programChainNumber,
    observation.selectedPath.map((entry) => [
      entry.programNumber,
      entry.cellNumber,
      entry.vobId,
      entry.cellId,
    ]),
    observation.angleNumber,
    observation.angleCount,
    observation.chapterStart,
    observation.chapterEnd,
    observation.chapterCount,
    observation.sourceExtents.map((extent) => [
      extent.startLba,
      extent.sectorCount,
    ]),
  ];
}

function digest(domain: string, payload: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update(JSON.stringify(payload))
    .digest("hex");
}
