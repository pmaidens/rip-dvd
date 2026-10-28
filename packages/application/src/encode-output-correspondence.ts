import { canonicalPublicationJson, type DataAccess } from "@rip-dvd/data-access";
import { inspectEncodeOutput, type EncodeOutputInspection, type EncodeOutputMediaProbe } from "./encode-output-inspection.js";

export class InvalidEncodeOutputIntervalInputError extends Error {
  constructor() {
    super("Interval query requires an assessment identity, title observation identity, and 1 to 100 distinct nonnegative interval indexes.");
    this.name = "InvalidEncodeOutputIntervalInputError";
  }
}

interface IntervalQuery {
  assessmentIdentity: string;
  titleIdentityObservationId: string;
  intervalIndexes: number[];
}

function parseQuery(value: unknown): IntervalQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidEncodeOutputIntervalInputError();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["assessmentIdentity", "titleIdentityObservationId", "intervalIndexes"].includes(key)) ||
      ![input.assessmentIdentity, input.titleIdentityObservationId].every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 256) ||
      !Array.isArray(input.intervalIndexes) || input.intervalIndexes.length < 1 || input.intervalIndexes.length > 100 ||
      input.intervalIndexes.some((index) => !Number.isSafeInteger(index) || index < 0) ||
      new Set(input.intervalIndexes).size !== input.intervalIndexes.length) throw new InvalidEncodeOutputIntervalInputError();
  return {
    assessmentIdentity: input.assessmentIdentity as string,
    titleIdentityObservationId: input.titleIdentityObservationId as string,
    intervalIndexes: [...input.intervalIndexes] as number[],
  };
}

type SourceSnapshot = NonNullable<EncodeOutputInspection["artifact"]["provenance"]["sourceSnapshot"]>;

type SourceInterval = SourceSnapshot["source"]["assessment"]["items"][number]["estimatedAffectedPlayback"];
type RecordedInterval = NonNullable<SourceInterval>["intervals"][number];

interface IntervalClassification {
  intervalIndex: number;
  status: "absent" | "unknown";
  sourceInterval: RecordedInterval | null;
  outputInterval: null;
  reasonCode: string;
  reason: string;
  evidence: {
    sourceSnapshotAvailability: string;
    claimSnapshotId: string | null;
    assessmentIdentity: string | null;
    observedFileIdentity: string | null;
    inspectionReasonCode: string | null;
    requestedMapping: SourceSnapshot["source"]["assessment"]["items"][number] | null;
    selectedMapping: SourceSnapshot["source"]["assessment"]["items"][number] | null;
  };
}

function classifyInterval(
  inspection: EncodeOutputInspection, snapshot: SourceSnapshot | null,
  query: IntervalQuery, intervalIndex: number,
): IntervalClassification {
  const { artifact } = inspection;
  const source = snapshot?.source;
  const assessment = source?.assessment;
  const requested = assessment?.id === query.assessmentIdentity
    ? assessment.items.find((item) => item.titleIdentityObservationId === query.titleIdentityObservationId)
    : undefined;
  const interval = requested?.estimatedAffectedPlayback?.intervals[intervalIndex] ?? null;
  const selected = assessment?.items.find((item) => item.titleIdentityObservationId === source?.titleIdentity.id);
  const base = {
    intervalIndex, sourceInterval: interval, outputInterval: null,
    evidence: {
      sourceSnapshotAvailability: artifact.provenance.sourceSnapshotAvailability,
      claimSnapshotId: snapshot?.id ?? null,
      assessmentIdentity: assessment?.id ?? null,
      observedFileIdentity: artifact.file.identity,
      inspectionReasonCode: artifact.inspectability.reasonCode,
      requestedMapping: requested ?? null,
      selectedMapping: selected ?? null,
    },
  };
  const unknown = (reasonCode: string, reason: string): IntervalClassification => ({ ...base, status: "unknown", reasonCode, reason });
  if (artifact.inspectability.status !== "inspected" || artifact.file.identityContinuity !== "verified") {
    return unknown("OUTPUT_INSPECTION_UNAVAILABLE", "Inspection could not establish the actual canonical Encode Output identity and media.");
  }
  if (!source) return unknown("OUTPUT_SOURCE_NOT_RECORDED", "The Encode Output has no immutable source snapshot bound to this artifact generation.");
  if (assessment?.id !== query.assessmentIdentity) return unknown("SOURCE_ASSESSMENT_MISMATCH", "The requested assessment is not the assessment recorded for this output generation.");
  if (!requested || !selected || !interval) return unknown("SOURCE_INTERVAL_NOT_RECORDED", "The requested interval or selected title map is absent from the output's immutable source assessment.");
  if (selected.selection.angleNumber !== source.resolvedSource.angleNumber ||
      canonicalPublicationJson(selected.selection.selectedPath) !== canonicalPublicationJson(source.resolvedSource.selectedPath) ||
      source.resolvedSource.chapterStart < selected.selection.chapterStart || source.resolvedSource.chapterEnd > selected.selection.chapterEnd) {
    return unknown("SOURCE_MAPPING_INCOMPLETE", "The recorded source map does not cover the output's concrete playback selection.");
  }
  if (requested.mappingCoverage.state !== "complete" || selected.mappingCoverage.state !== "complete" ||
      requested.mappingCoverage.unknownReasons.length > 0 || selected.mappingCoverage.unknownReasons.length > 0) {
    return unknown("SOURCE_MAPPING_INCOMPLETE", "Incomplete source mapping cannot prove that content is omitted from the output.");
  }
  const expectedDuration = source.output.expectedDurationSeconds;
  if (expectedDuration !== null && artifact.media.durationSeconds !== null && artifact.media.durationSeconds < expectedDuration * 0.98) {
    return unknown("OUTPUT_TRUNCATED", "The output is shorter than its recorded full-title validation minimum. Truncation does not prove interval absence.");
  }
  // Estimated interval sourceRanges contain only missing sectors. Prove the
  // complete requested playback path excluded, including coarse timing spans.
  // The selected-title map is a superset for bounded chapter selections too.
  if (requested.uniqueSourceRanges.length > 0 && selected.uniqueSourceRanges.length > 0 &&
      requested.uniqueSourceRanges.every((range) => selected.uniqueSourceRanges.every((selectedRange) =>
        range.startLba + range.sectorCount <= selectedRange.startLba ||
        selectedRange.startLba + selectedRange.sectorCount <= range.startLba))) {
    return { ...base, status: "absent", reasonCode: "SOURCE_EXCLUDED_BY_SELECTION",
      reason: "The complete requested playback source map is disjoint from the complete source map of the output's concrete playback selection." };
  }
  if (source.resolvedSource.chapterStart !== selected.selection.chapterStart || source.resolvedSource.chapterEnd !== selected.selection.chapterEnd) {
    return unknown("SOURCE_CHAPTER_MAPPING_INCOMPLETE", "The recorded title source map does not locate this interval within the selected chapter bounds.");
  }
  return unknown("OUTPUT_TIMING_UNSUPPORTED", "Recorded source timing does not establish correspondence with the actual output time base or decoder omissions.");
}

/** Query recorded Estimated Affected Playback, never caller-supplied source estimates. */
export async function inspectEncodeOutputIntervals(
  access: DataAccess, artifactIdentity: unknown, input: unknown, mediaProbe?: EncodeOutputMediaProbe,
) {
  const query = parseQuery(input);
  const inspection = await inspectEncodeOutput(access, artifactIdentity, mediaProbe);
  const snapshot: SourceSnapshot | null = inspection.artifact.provenance.sourceSnapshot;
  const intervals = query.intervalIndexes.map((index) => classifyInterval(inspection, snapshot, query, index));
  const unknown = intervals.some((interval) => interval.status === "unknown");
  return {
    schemaVersion: 1 as const, query, inspection, intervals,
    targetedLocation: { eligible: false as const,
      reasonCode: unknown ? "OUTPUT_MAPPING_UNKNOWN" as const : "SOURCE_EXCLUDED_BY_SELECTION" as const,
      reason: unknown ? "No verified output location is available for these source intervals."
        : "The requested source intervals are excluded by the output's concrete playback selection." },
  };
}

export type EncodeOutputIntervalInspection = Awaited<ReturnType<typeof inspectEncodeOutputIntervals>>;
