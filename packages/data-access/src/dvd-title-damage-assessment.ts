import { createHash } from "node:crypto";

import type { DvdStructuralFindingOutcome } from "./dvd-structural-assessment.js";
import type {
  DvdTitleIdentityId,
  DvdTitleIdentityObservationId,
  DvdTitleIdentitySelectedPathEntry,
  DvdUnrecoveredSourceRange,
  OriginalDiscArchiveId,
  UnreadableSectorRange,
} from "./types.js";

export const DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION =
  "dvd-title-damage-assessment-v1" as const;

const ASSESSMENT_ID_DOMAIN = "rip-dvd:dvd-title-damage-assessment:v1\0";

export type DvdTitleSourceReferenceKind =
  | "navigation"
  | "multiplexed_content";

export interface DvdTitleSourceReference extends UnreadableSectorRange {
  kind: DvdTitleSourceReferenceKind;
}

export interface DvdTitleDamageUnknownReason {
  code: string;
  message: string;
}

export interface DvdTitleDamageMappingInput {
  titleIdentityId: DvdTitleIdentityId;
  titleIdentityObservationId: DvdTitleIdentityObservationId;
  displayTitleNumber: number;
  selection: {
    selectedPath: readonly DvdTitleIdentitySelectedPathEntry[];
    angleNumber: number;
    chapterStart: number;
    chapterEnd: number;
  };
  sourceReferences: readonly DvdTitleSourceReference[];
  mappingCoverage: {
    state: "complete" | "partial";
    policyVersion: string;
    unknownReasons: readonly DvdTitleDamageUnknownReason[];
  };
}

export interface DvdTitleDamageAssessmentInput {
  checkpoint: {
    originalDiscArchiveId: OriginalDiscArchiveId;
    manifestId: string;
    manifestRevision: number;
    manifestDigest: string;
    acceptedEndLbaExclusive: number;
  };
  titleIdentityReviewSetIdentity: string;
  structuralAssessmentIdentity: string;
  structuralFindings: {
    dvdNavigation: DvdStructuralFindingOutcome;
    titleEnumeration: DvdStructuralFindingOutcome;
  };
  unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
  titles: DvdTitleDamageMappingInput[];
}

export interface DvdTitleDamageAssessmentItem {
  titleIdentityId: DvdTitleIdentityId;
  titleIdentityObservationId: DvdTitleIdentityObservationId;
  displayTitleNumber: number;
  selection: DvdTitleDamageMappingInput["selection"];
  mappingCoverage: DvdTitleDamageMappingInput["mappingCoverage"];
  uniqueSourceRanges: readonly UnreadableSectorRange[];
  uniqueSourceSectorCount: number | null;
  knownUnrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
  unrecoveredUniqueSourceSectorCount: number;
  titleMissingSourcePercentage: number | null;
}

export interface DvdTitleDamageAssessment {
  id: string;
  policyVersion: typeof DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION;
  checkpoint: DvdTitleDamageAssessmentInput["checkpoint"];
  titleIdentityReviewSetIdentity: string;
  structuralAssessmentIdentity: string;
  structuralFindings: DvdTitleDamageAssessmentInput["structuralFindings"];
  items: readonly DvdTitleDamageAssessmentItem[];
  unknownTitleImpact: {
    unrecoveredSourceSectorCount: number;
    unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
    reasons: readonly DvdTitleDamageUnknownReason[];
  };
  noTitleMissingSourceProved: boolean;
}

export interface DvdTitleDamageAssessmentRecord
  extends DvdTitleDamageAssessment {
  createdAt: Date;
}

export interface RecordDvdTitleDamageMappingInput {
  titleIdentityObservationId: DvdTitleIdentityObservationId;
  sourceReferences: readonly DvdTitleSourceReference[];
  mappingCoverage: DvdTitleDamageMappingInput["mappingCoverage"];
}

export interface RecordDvdTitleDamageAssessmentInput {
  originalDiscArchiveId: OriginalDiscArchiveId;
  checkpoint: {
    manifestId: string;
    manifestRevision: number;
    manifestDigest: string;
  };
  titleIdentityReviewSetIdentity: string;
  structuralAssessmentIdentity: string;
  titles: readonly RecordDvdTitleDamageMappingInput[];
}

export interface DvdTitleDamageAssessmentInspection {
  schemaVersion: 1;
  policyVersion: typeof DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION;
  originalDiscArchiveId: OriginalDiscArchiveId;
  state: "unavailable" | "pending" | "current" | "outdated";
  checkpoint: DvdTitleDamageAssessmentInput["checkpoint"] | null;
  currentAssessmentIdentity: string | null;
  assessment: DvdTitleDamageAssessmentRecord | null;
  unavailableReasons: readonly DvdTitleDamageUnknownReason[];
}

export interface DvdTitleDamageAssessmentAccess {
  /** Worker persistence boundary for one checkpoint-stable title map. */
  record(
    input: RecordDvdTitleDamageAssessmentInput,
  ): DvdTitleDamageAssessmentRecord;
  inspect(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): DvdTitleDamageAssessmentInspection;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1
  ) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return value;
}

function validateCheckpoint(
  checkpoint: DvdTitleDamageAssessmentInput["checkpoint"],
): DvdTitleDamageAssessmentInput["checkpoint"] {
  if (
    !boundedText(checkpoint.originalDiscArchiveId, 128) ||
    !boundedText(checkpoint.manifestId, 256) ||
    !Number.isSafeInteger(checkpoint.manifestRevision) ||
    checkpoint.manifestRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(checkpoint.manifestDigest) ||
    !Number.isSafeInteger(checkpoint.acceptedEndLbaExclusive) ||
    checkpoint.acceptedEndLbaExclusive < 1
  ) {
    throw new TypeError("Invalid DVD Title Damage Assessment checkpoint");
  }
  return { ...checkpoint };
}

function validateUnknownReasons(
  reasons: readonly DvdTitleDamageUnknownReason[],
): readonly DvdTitleDamageUnknownReason[] {
  if (!Array.isArray(reasons)) {
    throw new TypeError("Invalid DVD title source coverage reasons");
  }
  const normalized = reasons.map((reason) => {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(reason.code) ||
      !boundedText(reason.message, 512)
    ) {
      throw new TypeError("Invalid DVD title source coverage reason");
    }
    return { code: reason.code, message: reason.message };
  });
  return [...new Map(normalized.map((reason) => [
    `${reason.code}\0${reason.message}`,
    reason,
  ])).values()].sort((left, right) =>
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function normalizeRanges(
  ranges: readonly UnreadableSectorRange[],
  acceptedEndLbaExclusive: number,
  label: string,
): readonly UnreadableSectorRange[] {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new TypeError(`${label} must contain at least one source range`);
  }
  const ordered = ranges.map((range) => {
    const startLba = nonnegativeSafeInteger(range.startLba, `${label} start`);
    const sectorCount = positiveSafeInteger(
      range.sectorCount,
      `${label} length`,
    );
    const endLbaExclusive = startLba + sectorCount;
    if (
      !Number.isSafeInteger(endLbaExclusive) ||
      endLbaExclusive > acceptedEndLbaExclusive
    ) {
      throw new TypeError(`${label} falls outside the accepted archive extent`);
    }
    return { startLba, sectorCount };
  }).sort((left, right) => left.startLba - right.startLba ||
    left.sectorCount - right.sectorCount);
  const normalized: UnreadableSectorRange[] = [];
  for (const range of ordered) {
    const previous = normalized.at(-1);
    if (previous === undefined) {
      normalized.push(range);
      continue;
    }
    const previousEnd = previous.startLba + previous.sectorCount;
    const currentEnd = range.startLba + range.sectorCount;
    if (range.startLba > previousEnd) {
      normalized.push(range);
      continue;
    }
    previous.sectorCount = Math.max(previousEnd, currentEnd) -
      previous.startLba;
  }
  return normalized;
}

function validateUnrecoveredRanges(
  ranges: readonly DvdUnrecoveredSourceRange[],
  acceptedEndLbaExclusive: number,
): readonly DvdUnrecoveredSourceRange[] {
  let previousEnd = -1;
  return ranges.map((range) => {
    if (
      range.classification !== "skipped_untested" &&
      range.classification !== "individually_failed"
    ) {
      throw new TypeError("Invalid Unrecovered Source classification");
    }
    const normalized = normalizeRanges(
      [range],
      acceptedEndLbaExclusive,
      "Unrecovered Source range",
    )[0]!;
    if (normalized.startLba <= previousEnd) {
      throw new TypeError("Unrecovered Source ranges must be normalized");
    }
    previousEnd = normalized.startLba + normalized.sectorCount - 1;
    return { ...normalized, classification: range.classification };
  });
}

function intersections(
  source: readonly UnreadableSectorRange[],
  unrecovered: readonly DvdUnrecoveredSourceRange[],
): readonly DvdUnrecoveredSourceRange[] {
  const result: DvdUnrecoveredSourceRange[] = [];
  for (const sourceRange of source) {
    const sourceEnd = sourceRange.startLba + sourceRange.sectorCount;
    for (const missing of unrecovered) {
      const missingEnd = missing.startLba + missing.sectorCount;
      const startLba = Math.max(sourceRange.startLba, missing.startLba);
      const endLbaExclusive = Math.min(sourceEnd, missingEnd);
      if (endLbaExclusive > startLba) {
        result.push({
          startLba,
          sectorCount: endLbaExclusive - startLba,
          classification: missing.classification,
        });
      }
    }
  }
  return result;
}

function subtractRanges(
  unrecovered: readonly DvdUnrecoveredSourceRange[],
  known: readonly UnreadableSectorRange[],
): readonly DvdUnrecoveredSourceRange[] {
  const result: DvdUnrecoveredSourceRange[] = [];
  for (const missing of unrecovered) {
    let segments: UnreadableSectorRange[] = [{
      startLba: missing.startLba,
      sectorCount: missing.sectorCount,
    }];
    for (const covered of known) {
      const coveredEnd = covered.startLba + covered.sectorCount;
      segments = segments.flatMap((segment) => {
        const segmentEnd = segment.startLba + segment.sectorCount;
        if (
          coveredEnd <= segment.startLba || covered.startLba >= segmentEnd
        ) {
          return [segment];
        }
        const pieces: UnreadableSectorRange[] = [];
        if (covered.startLba > segment.startLba) {
          pieces.push({
            startLba: segment.startLba,
            sectorCount: covered.startLba - segment.startLba,
          });
        }
        if (coveredEnd < segmentEnd) {
          pieces.push({
            startLba: coveredEnd,
            sectorCount: segmentEnd - coveredEnd,
          });
        }
        return pieces;
      });
    }
    result.push(...segments.map((segment) => ({
      ...segment,
      classification: missing.classification,
    })));
  }
  return result;
}

function sectorCount(ranges: readonly UnreadableSectorRange[]): number {
  return ranges.reduce((total, range) => total + range.sectorCount, 0);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) =>
        left.localeCompare(right)
      ))
      : nested
  );
}

export function createDvdTitleDamageAssessment(
  input: DvdTitleDamageAssessmentInput,
): DvdTitleDamageAssessment {
  const checkpoint = validateCheckpoint(input.checkpoint);
  if (
    !/^[a-f0-9]{64}$/.test(input.titleIdentityReviewSetIdentity) ||
    !/^dvd-structural-assessment:[a-f0-9]{64}$/.test(
      input.structuralAssessmentIdentity,
    )
  ) {
    throw new TypeError("Invalid DVD Title Damage Assessment dependency identity");
  }
  const structuralFindings = { ...input.structuralFindings };
  const structuralMapIsValid =
    structuralFindings.dvdNavigation === "valid" &&
    structuralFindings.titleEnumeration === "valid";
  const unrecoveredSourceRanges = validateUnrecoveredRanges(
    input.unrecoveredSourceRanges,
    checkpoint.acceptedEndLbaExclusive,
  );
  const seenIdentityIds = new Set<string>();
  const seenObservationIds = new Set<string>();
  const items = input.titles.map((title) => {
    if (
      !boundedText(title.titleIdentityId, 128) ||
      !boundedText(title.titleIdentityObservationId, 128) ||
      seenIdentityIds.has(title.titleIdentityId) ||
      seenObservationIds.has(title.titleIdentityObservationId)
    ) {
      throw new TypeError("Invalid or repeated DVD Title Identity reference");
    }
    seenIdentityIds.add(title.titleIdentityId);
    seenObservationIds.add(title.titleIdentityObservationId);
    const displayTitleNumber = positiveSafeInteger(
      title.displayTitleNumber,
      "DVD title display number",
    );
    const selection = {
      selectedPath: title.selection.selectedPath.map((entry) => ({
        programNumber: positiveSafeInteger(
          entry.programNumber,
          "DVD title program number",
        ),
        cellNumber: positiveSafeInteger(
          entry.cellNumber,
          "DVD title cell number",
        ),
        vobId: positiveSafeInteger(entry.vobId, "DVD title VOB ID"),
        cellId: positiveSafeInteger(entry.cellId, "DVD title cell ID"),
      })),
      angleNumber: positiveSafeInteger(
        title.selection.angleNumber,
        "DVD title angle number",
      ),
      chapterStart: positiveSafeInteger(
        title.selection.chapterStart,
        "DVD title chapter start",
      ),
      chapterEnd: positiveSafeInteger(
        title.selection.chapterEnd,
        "DVD title chapter end",
      ),
    };
    if (
      selection.selectedPath.length === 0 ||
      selection.chapterEnd < selection.chapterStart
    ) {
      throw new TypeError("Invalid concrete DVD title playback selection");
    }
    const references = title.sourceReferences.map((reference) => {
      if (
        reference.kind !== "navigation" &&
        reference.kind !== "multiplexed_content"
      ) {
        throw new TypeError("Invalid DVD title source reference kind");
      }
      return {
        kind: reference.kind,
        startLba: reference.startLba,
        sectorCount: reference.sectorCount,
      };
    });
    const uniqueSourceRanges = normalizeRanges(
      references,
      checkpoint.acceptedEndLbaExclusive,
      "DVD title source reference",
    );
    if (
      title.mappingCoverage.state !== "complete" &&
      title.mappingCoverage.state !== "partial"
    ) {
      throw new TypeError("Invalid DVD title source mapping coverage");
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(
      title.mappingCoverage.policyVersion,
    )) {
      throw new TypeError("Invalid DVD title source mapping policy version");
    }
    const unknownReasons = validateUnknownReasons(
      title.mappingCoverage.unknownReasons,
    );
    if (
      title.mappingCoverage.state === "complete" &&
      (!structuralMapIsValid || unknownReasons.length > 0)
    ) {
      throw new TypeError(
        "Complete title source coverage requires valid navigation and title enumeration",
      );
    }
    if (
      title.mappingCoverage.state === "partial" && unknownReasons.length === 0
    ) {
      throw new TypeError(
        "Partial title source coverage requires an explicit unknown reason",
      );
    }
    const knownUnrecoveredSourceRanges = intersections(
      uniqueSourceRanges,
      unrecoveredSourceRanges,
    );
    const missingSectorCount = sectorCount(knownUnrecoveredSourceRanges);
    const complete = title.mappingCoverage.state === "complete";
    const denominator = complete ? sectorCount(uniqueSourceRanges) : null;
    return {
      titleIdentityId: title.titleIdentityId,
      titleIdentityObservationId: title.titleIdentityObservationId,
      displayTitleNumber,
      selection,
      mappingCoverage: {
        state: title.mappingCoverage.state,
        policyVersion: title.mappingCoverage.policyVersion,
        unknownReasons,
      },
      uniqueSourceRanges,
      uniqueSourceSectorCount: denominator,
      knownUnrecoveredSourceRanges,
      unrecoveredUniqueSourceSectorCount: missingSectorCount,
      titleMissingSourcePercentage: denominator === null
        ? null
        : missingSectorCount / denominator * 100,
    } satisfies DvdTitleDamageAssessmentItem;
  }).sort((left, right) =>
    left.displayTitleNumber - right.displayTitleNumber ||
    left.titleIdentityObservationId.localeCompare(
      right.titleIdentityObservationId,
    )
  );
  const knownTitleSourceInputs = items.flatMap((item) =>
    item.uniqueSourceRanges
  );
  const knownTitleSourceRanges = knownTitleSourceInputs.length === 0
    ? []
    : normalizeRanges(
      knownTitleSourceInputs,
      checkpoint.acceptedEndLbaExclusive,
      "Known DVD title source range",
    );
  const unknownRanges = subtractRanges(
    unrecoveredSourceRanges,
    knownTitleSourceRanges,
  );
  const unknownReasons: DvdTitleDamageUnknownReason[] = [];
  if (structuralFindings.dvdNavigation !== "valid") {
    unknownReasons.push({
      code: "DVD_NAVIGATION_NOT_PROVED",
      message: "DVD navigation is not proved for this checkpoint.",
    });
  }
  if (structuralFindings.titleEnumeration !== "valid") {
    unknownReasons.push({
      code: "TITLE_ENUMERATION_NOT_PROVED",
      message: "Title enumeration is not proved for this checkpoint.",
    });
  }
  if (items.some((item) => item.mappingCoverage.state === "partial")) {
    unknownReasons.push({
      code: "TITLE_SOURCE_MAP_INCOMPLETE",
      message: "At least one selected title path has incomplete source coverage.",
    });
  }
  const unknownTitleImpact = {
    unrecoveredSourceSectorCount: sectorCount(unknownRanges),
    unrecoveredSourceRanges: unknownRanges,
    reasons: validateUnknownReasons(unknownReasons),
  };
  const noTitleMissingSourceProved = structuralMapIsValid &&
    items.every((item) =>
      item.mappingCoverage.state === "complete" &&
      item.unrecoveredUniqueSourceSectorCount === 0
    ) &&
    unknownTitleImpact.unrecoveredSourceSectorCount === 0;
  const semanticEvidence = {
    checkpoint,
    titleIdentityReviewSetIdentity: input.titleIdentityReviewSetIdentity,
    structuralAssessmentIdentity: input.structuralAssessmentIdentity,
    structuralFindings,
    items,
    unknownTitleImpact,
    noTitleMissingSourceProved,
  };
  const digest = createHash("sha256")
    .update(ASSESSMENT_ID_DOMAIN)
    .update(canonicalJson(semanticEvidence))
    .digest("hex");
  return {
    id: `dvd-title-damage-assessment:${digest}`,
    policyVersion: DVD_TITLE_DAMAGE_ASSESSMENT_POLICY_VERSION,
    ...semanticEvidence,
  };
}
