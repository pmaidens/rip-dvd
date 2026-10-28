import { decodeDvdTitleMap } from "@rip-dvd/data-access";
import { createHash } from "node:crypto";
import {
  DvdCheckpointReadFault,
  RecordNotFoundError,
  canonicalPublicationJson,
  encodingProfileQueueBlockingReasons,
  type DataAccess,
  type ConsistentReadAccess,
  type CommittedDvdCheckpointEvidence,
  type DvdTitleDamageAffectedPlaybackInterval,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import { InvalidDamagePreviewInputError, parseDamagePreviewInput, type DamagePreviewInput, type PlaybackRange } from "./damage-preview-input.js";

interface Reason { code: string; message: string }
interface Marker extends DvdTitleDamageAffectedPlaybackInterval { intervalIndex: number }
interface Group extends PlaybackRange { markerIndexes: number[] }



function overlaps(left: PlaybackRange, right: PlaybackRange): boolean {
  return left.startMilliseconds < right.endMilliseconds && right.startMilliseconds < left.endMilliseconds;
}

function groupMarkers(markers: readonly Marker[]): Group[] {
  const groups: Group[] = [];
  for (const marker of [...markers].sort((a, b) => a.startMilliseconds - b.startMilliseconds || a.endMilliseconds - b.endMilliseconds)) {
    const previous = groups.at(-1);
    if (previous && marker.startMilliseconds - previous.endMilliseconds <= 30_000) {
      previous.endMilliseconds = Math.max(previous.endMilliseconds, marker.endMilliseconds);
      previous.markerIndexes.push(marker.intervalIndex);
    } else {
      groups.push({ startMilliseconds: marker.startMilliseconds, endMilliseconds: marker.endMilliseconds, markerIndexes: [marker.intervalIndex] });
    }
  }
  return groups;
}

function planClips(input: DamagePreviewInput, markers: Marker[], reasons: Reason[]) {
  const groups = groupMarkers(markers);
  const coarse = markers.filter((marker) => marker.coverage === "whole_cell");
  const window = input.samplingWindow;
  if (coarse.length > 0 && window === null) {
    reasons.push({ code: "COARSE_SAMPLING_WINDOW_REQUIRED", message: "Choose a bounded sampling window for coarse whole-cell timing." });
  }
  if (window !== null && (window.startMilliseconds < input.playbackRange.startMilliseconds || window.endMilliseconds > input.playbackRange.endMilliseconds)) {
    reasons.push({ code: "SAMPLING_WINDOW_OUTSIDE_PLAYBACK_RANGE", message: "The sampling window must stay inside the selected playback range." });
  }
  if (window !== null && coarse.some((marker) => !overlaps(window, marker))) {
    reasons.push({ code: "SAMPLING_WINDOW_MISSES_INTERVAL", message: "The sampling window must intersect every selected coarse interval." });
  }
  if (markers.some((marker) => !overlaps(marker, input.playbackRange))) {
    reasons.push({ code: "INTERVAL_OUTSIDE_PLAYBACK_RANGE", message: "A selected damage interval is outside the selected playback range." });
  }
  const spans = input.mode === "ordinary_playback" ? [input.playbackRange] : groups.flatMap((group) => {
    const hasCoarse = coarse.some((marker) => group.markerIndexes.includes(marker.intervalIndex));
    if (hasCoarse && window === null) return [];
    // Precise markers in a mixed group must remain covered even when a coarse
    // marker uses a smaller operator-selected sampling window.
    const precise = markers.filter((marker) => group.markerIndexes.includes(marker.intervalIndex) && marker.coverage !== "whole_cell");
    if (!hasCoarse) return [group];
    return [{
      startMilliseconds: Math.min(window!.startMilliseconds, ...precise.map((marker) => marker.startMilliseconds)),
      endMilliseconds: Math.max(window!.endMilliseconds, ...precise.map((marker) => marker.endMilliseconds)),
    }];
  });
  const clips: PlaybackRange[] = [];
  for (const span of spans.map((span) => ({
    startMilliseconds: Math.max(input.playbackRange.startMilliseconds, span.startMilliseconds - input.context.beforeMilliseconds),
    // Compare before adding to avoid overflowing safe millisecond integers.
    endMilliseconds: span.endMilliseconds >= input.playbackRange.endMilliseconds - input.context.afterMilliseconds
      ? input.playbackRange.endMilliseconds : span.endMilliseconds + input.context.afterMilliseconds,
  })).filter((span) => span.endMilliseconds > span.startMilliseconds).sort((a, b) => a.startMilliseconds - b.startMilliseconds)) {
    const previous = clips.at(-1);
    if (previous && span.startMilliseconds <= previous.endMilliseconds) {
      previous.endMilliseconds = Math.max(previous.endMilliseconds, span.endMilliseconds);
    } else clips.push(span);
  }
  const duration = clips.reduce((sum, clip) => sum + clip.endMilliseconds - clip.startMilliseconds, 0);
  const incomplete = (coarse.length > 0 && window === null) ||
    markers.length !== input.intervalIndexes.length;
  return { groups, clips, estimatedDurationMilliseconds: incomplete || clips.length === 0 ? null : duration };
}

export async function inspectDamagePreviewAvailability(
  access: DataAccess,
  archiveId: string,
  rawInput?: unknown,
  ownership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(archiveId)) {
    throw new InvalidDamagePreviewInputError("Invalid Original Disc Archive ID.");
  }
  const input = rawInput === undefined ? null : parseDamagePreviewInput(rawInput);
  const id = archiveId as OriginalDiscArchiveId;
  if (!access.catalog.listOriginalDiscArchives({ ids: [id] })[0]) throw new RecordNotFoundError("Original Disc Archive", id);
  const reasons: Reason[] = [];
  let durableCheckpoint = null;
  try {
    durableCheckpoint = await access.readDvdCheckpoint(id, ownership);
  } catch (error) {
    reasons.push({
      code: error instanceof DvdCheckpointReadFault || error instanceof ArchiveImageOwnershipError ? error.code : "DVD_EVIDENCE_PROJECTION_INVALID",
      message: "The saved checkpoint cannot currently be verified for a consistent preview read.",
    });
  }
  return access.readConsistentSnapshot((snapshot) => reviewDamagePreviewEvidence(snapshot, archiveId, input, durableCheckpoint, reasons));
}

export function reviewDamagePreviewEvidence(
  snapshot: ConsistentReadAccess,
  archiveId: string,
  input: DamagePreviewInput | null,
  durableCheckpoint: Pick<CommittedDvdCheckpointEvidence, "id" | "revision" | "manifestDigest" | "publicationDigest"> | null,
  initialReasons: Reason[] = [],
) {
  const id = archiveId as OriginalDiscArchiveId;
  const archive = snapshot.catalog.listOriginalDiscArchives({ ids: [id] })[0];
  if (!archive) throw new RecordNotFoundError("Original Disc Archive", id);
  const reasons = [...initialReasons];
  const evidence = {
    header: snapshot.catalog.findDvdArchiveEvidenceHeader(id),
    titles: snapshot.catalog.readDvdTitleIdentityReviewSet(id),
    damage: snapshot.dvdTitleDamageAssessments.inspect(id),
    profiles: snapshot.encodingProfiles.list({ mediaDomain: "dvd_video" }),
    recovery: snapshot.catalog.findArchiveRecovery(id),
    disc: snapshot.catalog.listDetectedDiscs(undefined, { ids: [archive.detectedDiscId] })[0],
  };
  if (!evidence.recovery || ["stopping", "faulted"].includes(evidence.recovery.status)) {
    reasons.push({ code: "DAMAGE_PREVIEW_RECOVERY_UNAVAILABLE", message: "Damage Preview waits for a consistent Recovery checkpoint. Stopping or faulted Recovery cannot admit a new preview." });
  }
  const header = evidence.header;
  const checkpoint = header === null ? null : {
    manifestId: header.currentManifestId,
    manifestRevision: header.currentManifestRevision,
    manifestDigest: header.currentManifestDigest,
    publicationDigest: durableCheckpoint?.id === header.currentManifestId &&
      durableCheckpoint.revision === header.currentManifestRevision &&
      durableCheckpoint.manifestDigest === header.currentManifestDigest
      ? durableCheckpoint.publicationDigest : null,
  };
  const checkpointVerified = checkpoint !== null && durableCheckpoint !== null &&
    durableCheckpoint.id === checkpoint.manifestId && durableCheckpoint.revision === checkpoint.manifestRevision && durableCheckpoint.manifestDigest === checkpoint.manifestDigest;
  if (header === null) reasons.push({ code: "UNSUPPORTED_EVIDENCE_FORMAT", message: "Damage Preview requires a saved DVD recovery evidence checkpoint." });
  else if (!checkpointVerified) reasons.push({ code: "CHECKPOINT_UNVERIFIED", message: "The current saved checkpoint and durable manifest must agree." });
  const savedTitles = decodeDvdTitleMap(evidence.disc?.scanData)?.titles ?? [];
  const titleItems = evidence.titles?.items.filter((item) => item.presentAtCurrentCheckpoint &&
    item.observation.checkpoint.manifestId === checkpoint?.manifestId &&
    item.observation.checkpoint.manifestRevision === checkpoint?.manifestRevision &&
    item.observation.checkpoint.manifestDigest === checkpoint?.manifestDigest) ?? [];
  if (titleItems.length === 0) reasons.push({ code: "TITLE_IDENTITY_UNAVAILABLE", message: "No identified title is available at the current checkpoint." });
  const title = titleItems.find((item) => item.observation.id === input?.titleIdentityObservationId)?.observation ?? null;
  const profile = evidence.profiles.find((item) => item.id === input?.encodingProfileId) ?? null;
  const currentAssessment = evidence.damage.state === "current" && evidence.damage.assessment?.id === evidence.damage.currentAssessmentIdentity
    ? evidence.damage.assessment : null;
  const damageItem = currentAssessment?.items.find((item) => item.titleIdentityObservationId === title?.id) ?? null;
  const markers: Marker[] = [];
  if (input !== null) {
    if (title === null) reasons.push({ code: "TITLE_IDENTITY_NOT_CURRENT", message: "The selected Title Identity observation is not present at the current checkpoint." });
    if (title !== null && (title.angleNumber !== 1 || title.angleCount !== 1)) reasons.push({ code: "DAMAGE_PREVIEW_PATH_UNREPRESENTABLE", message: "Canonical preview generation currently supports single-angle title paths only." });
    if (profile === null) reasons.push({ code: "ENCODING_PROFILE_UNAVAILABLE", message: "The intended DVD Encoding Profile is unavailable." });
    else if (Object.keys(profile.settings).some((key) => !["preset", "container"].includes(key))) reasons.push({ code: "DAMAGE_PREVIEW_SETTINGS_UNREPRESENTABLE", message: "This profile contains settings that a Damage Preview cannot represent." });
    if (profile !== null) for (const code of encodingProfileQueueBlockingReasons(profile)) reasons.push({ code: `ENCODING_PROFILE_${code.toUpperCase()}`, message: `The intended Encoding Profile is blocked: ${code}.` });
    if (input.mode === "damage") {
      if (damageItem === null) {
        reasons.push({ code: "TITLE_DAMAGE_ASSESSMENT_NOT_CURRENT", message: "Damage targeting requires a current assessment for the selected title path." }, ...evidence.damage.unavailableReasons);
      }
      const assessmentMatches = input.assessmentIdentity !== null && input.assessmentIdentity === currentAssessment?.id;
      if (!assessmentMatches) reasons.push({ code: "DAMAGE_PREVIEW_ASSESSMENT_STALE", message: "Select intervals from the current Title Damage Assessment and review again." });
      const intervals = assessmentMatches ? damageItem?.estimatedAffectedPlayback?.intervals ?? [] : [];
      for (const index of input.intervalIndexes) {
        const interval = intervals[index];
        if (interval === undefined) reasons.push({ code: "DAMAGE_INTERVAL_NOT_CURRENT", message: `Selected damage interval ${index} is unavailable in the current assessment.` });
        else markers.push({ intervalIndex: index, ...interval });
      }
      if (input.intervalIndexes.length === 0) reasons.push({ code: "NO_DAMAGE_INTERVALS_SELECTED", message: "Select at least one Estimated Affected Playback interval, or choose ordinary playback." });
      if (intervals.length === 0 && (damageItem?.estimatedAffectedPlayback === null || (damageItem?.estimatedAffectedPlayback?.unknownCoverage.length ?? 0) > 0)) {
        reasons.push({ code: "DAMAGE_TIMING_UNKNOWN", message: "Damage timing is unknown. Ordinary identified-title playback has no damage seek." });
      }
    }
    const sourceTitle = savedTitles.find((item) => item.number === title?.displayTitleNumber);
    if (!sourceTitle) reasons.push({ code: "STREAM_AVAILABILITY_UNVERIFIED", message: "The saved title has no representable stream evidence." });
    else if (input.streams.audio.some((stream) => !sourceTitle.audioStreams.some((item) => item.id === stream)) ||
      input.streams.subtitles.some((stream) => !sourceTitle.subtitles.some((item) => item.id === stream))) {
      reasons.push({ code: "DAMAGE_PREVIEW_STREAM_UNREPRESENTABLE", message: "A selected stream is absent from the saved title. Choose available stream IDs." });
    }

  }
  const plan = input === null ? { groups: [], clips: [], estimatedDurationMilliseconds: null } : planClips(input, markers, reasons);
  const reviewedRequest = input === null ? null : {
    ...input,
    archive: { fingerprint: archive.fingerprint, path: archive.archivePath, catalogRevision: archive.updatedAt.toISOString() },
    recovery: evidence.recovery === null ? null : { id: evidence.recovery.id, attemptId: evidence.recovery.attemptId, status: evidence.recovery.status },
    sourceTitle: savedTitles.find((item) => item.number === title?.displayTitleNumber) ?? null,
    requestedAssessmentIdentity: input.assessmentIdentity,
    originalDiscArchiveId: archiveId,
    checkpoint,
    title: title === null ? null : {
      titleIdentityId: title.titleIdentityId, observationId: title.id, contentDigest: title.contentDigest,
      displayTitleNumber: title.displayTitleNumber, navigation: title.navigation, selectedPath: title.selectedPath,
      angleNumber: title.angleNumber, angleCount: title.angleCount, chapterStart: title.chapterStart, chapterEnd: title.chapterEnd,
    },
    titleIdentityReviewSetIdentity: evidence.titles?.reviewSetIdentity ?? null,
    assessmentIdentity: input.mode === "damage" ? currentAssessment?.id ?? null : null,
    timingEvidence: input.mode === "damage" ? damageItem?.timingEvidence ?? null : null,
    markers,
    encodingProfile: profile === null ? null : { id: profile.id, key: profile.key, version: profile.version, isActive: profile.isActive, settings: profile.settings },
  };
  if (input === null) reasons.push({ code: "DAMAGE_PREVIEW_SELECTION_REQUIRED", message: "Review a concrete title, range, streams and intended settings before requesting generation." });
  const preflightDigest = reviewedRequest === null ? null : createHash("sha256").update("rip-dvd:damage-preview-preflight:v1\0").update(canonicalPublicationJson({
    ...reviewedRequest,
    recovery: evidence.recovery === null ? null : { id: evidence.recovery.id, attemptId: evidence.recovery.attemptId, status: ["stopped", "completed"].includes(evidence.recovery.status) ? evidence.recovery.status : "active" },
  })).digest("hex");
  // The active format carries the reviewed immutable publication identity so
  // admission can check database identities without reading a changing image.
  // Only the worker's owned checkpoint read proves that publication is current.
  const activeRecovery = evidence.recovery !== null && !["stopped", "completed"].includes(evidence.recovery.status);
  const preflightToken = preflightDigest === null ? null : activeRecovery && checkpoint?.publicationDigest
    ? `damage-preview-preflight:v2:${checkpoint.publicationDigest}:${preflightDigest}`
    : `damage-preview-preflight:${preflightDigest}`;
  return {
    schemaVersion: 1,
    originalDiscArchiveId: archiveId,
    available: input !== null && reasons.length === 0,
    blockingReasons: reasons,
    current: { checkpoint, checkpointVerified, titleIdentityReviewSetIdentity: evidence.titles?.reviewSetIdentity ?? null, assessmentIdentity: currentAssessment?.id ?? null },
    titles: titleItems.map((item) => ({
      titleIdentityId: item.titleIdentityId,
      observationId: item.observation.id,
      displayTitleNumber: item.observation.displayTitleNumber,
      selectedPath: item.observation.selectedPath,
      audioStreams: savedTitles.find((saved) => saved.number === item.observation.displayTitleNumber)?.audioStreams ?? [],
      subtitles: savedTitles.find((saved) => saved.number === item.observation.displayTitleNumber)?.subtitles ?? [],
      angleNumber: item.observation.angleNumber,
      chapterStart: item.observation.chapterStart,
      chapterEnd: item.observation.chapterEnd,
      estimatedAffectedPlayback: currentAssessment?.items.find((damage) => damage.titleIdentityObservationId === item.observation.id)?.estimatedAffectedPlayback ?? null,
    })),
    encodingProfiles: evidence.profiles.map((item) => ({ id: item.id, displayName: item.displayName, version: item.version, settings: item.settings })),
    ordinaryPlayback: { identifiable: checkpointVerified && (input === null ? titleItems.length > 0 : title !== null), available: input !== null && reasons.length === 0, damageSeek: null, blockingReasons: reasons },
    preflightToken,
    reviewedRequest,
    markers,
    ...plan,
    uncertainSpans: markers.filter((marker) => marker.coverage === "whole_cell"),
    unknownTimingCoverage: damageItem?.estimatedAffectedPlayback?.unknownCoverage ?? [],
    estimatedStorageBytes: null,
    knownUnknowns: [
      { code: "STORAGE_ESTIMATE_UNKNOWN", message: "Intended preset settings do not provide a reliable encoded byte-rate estimate." },
      { code: "PLAYBACK_RANGE_OPERATOR_SELECTED", message: "The requested timeline range is operator-selected; actual decoded coverage is not yet verified." },
    ],
  };
}
