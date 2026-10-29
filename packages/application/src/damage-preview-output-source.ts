import { canonicalPublicationJson, type DamagePreviewRecord } from "@rip-dvd/data-access";
import type { reviewDamagePreviewEvidence } from "./damage-preview.js";
import type { EncodeOutputInspectionReceipt, inspectEncodeOutputIdentity } from "./encode-output-inspection.js";

export type FinishedOutputProofReason = "FINISHED_OUTPUT_SOURCE_NOT_RECORDED" | "FINISHED_OUTPUT_SOURCE_MISMATCH" | "FINISHED_OUTPUT_VALIDATION_UNPROVED";

const equal = (left: unknown, right: unknown) => canonicalPublicationJson(left) === canonicalPublicationJson(right);

/** The full-title containment and selected-stream equivalences are documented
 * in docs/damage-preview-retention.md. No current catalog data enters proof. */
export function previewOutputSourceProof(record: DamagePreviewRecord, receipt: EncodeOutputInspectionReceipt, current: ReturnType<typeof inspectEncodeOutputIdentity>["artifact"]): FinishedOutputProofReason | null {
  const evidence = receipt.evidence;
  const snapshot = evidence.provenance.sourceSnapshot;
  if (snapshot === null || evidence.provenance.sourceSnapshotAvailability !== "recorded") return "FINISHED_OUTPUT_SOURCE_NOT_RECORDED";
  const validation = evidence.validation;
  if (validation.result !== "passed" || validation.appliesToObservedFile !== true || validation.evidenceAvailability !== "recorded" ||
    validation.recordIdentity === null || validation.checks?.policyVersion !== "encode-output-validation-v1" ||
    !equal(validation.recordIdentity, current.validation.recordIdentity) || !equal(validation.checks, current.validation.checks) ||
    !equal(validation.identity, current.file.identity) || !equal(evidence.file.identity, current.file.identity) ||
    !equal(validation.evidence, current.validation.evidence) || current.validation.appliesToObservedFile !== true ||
    !["published", "retained"].includes(evidence.state) || !["published", "retained"].includes(current.state)) return "FINISHED_OUTPUT_VALIDATION_UNPROVED";
  const preview = (JSON.parse(record.reviewJson) as ReturnType<typeof reviewDamagePreviewEvidence>).reviewedRequest;
  if (preview === null || preview.title === null || preview.checkpoint === null || preview.encodingProfile === null || preview.sourceTitle === null) return "FINISHED_OUTPUT_SOURCE_MISMATCH";
  const source = snapshot.source;
  const title = preview.title;
  const intended = preview.encodingProfile;
  const output = source.output;
  const selectedTitle = source.titleIdentity;
  const fullTitle = source.resolvedSource.chapterStart === 1 && source.resolvedSource.chapterEnd === source.title.chapters &&
    title.chapterStart === 1 && title.chapterEnd === source.title.chapters && source.selection.sourceIdentity.kind !== "dvd_chapters";
  const matches = source.schemaVersion === 1 && snapshot.encodeJobId === receipt.encodeJobId &&
    source.archive.id === record.originalDiscArchiveId && source.archive.fingerprint === preview.archive.fingerprint &&
    equal(source.checkpoint, { manifestId: preview.checkpoint.manifestId, revision: preview.checkpoint.manifestRevision, manifestDigest: preview.checkpoint.manifestDigest }) &&
    equal(source.decision.checkpoint, source.checkpoint) && source.decision.titleIdentityId === title.titleIdentityId && source.decision.titleIdentityObservationId === title.observationId &&
    selectedTitle.titleIdentityId === title.titleIdentityId && selectedTitle.id === title.observationId && selectedTitle.contentDigest === title.contentDigest &&
    equal(source.resolvedSource, { navigation: title.navigation, selectedPath: title.selectedPath, displayTitleNumber: title.displayTitleNumber, angleNumber: title.angleNumber, chapterStart: title.chapterStart, chapterEnd: title.chapterEnd }) &&
    equal(selectedTitle.navigation, title.navigation) && equal(selectedTitle.selectedPath, title.selectedPath) &&
    selectedTitle.displayTitleNumber === title.displayTitleNumber && selectedTitle.chapterStart === title.chapterStart && selectedTitle.chapterEnd === title.chapterEnd &&
    selectedTitle.angleNumber === title.angleNumber && selectedTitle.angleCount === title.angleCount &&
    equal(source.title, preview.sourceTitle) && fullTitle &&
    preview.playbackRange.startMilliseconds >= 0 && preview.playbackRange.endMilliseconds <= source.title.durationSeconds * 1_000 &&
    validation.checks.duration.observedSeconds !== null && preview.playbackRange.endMilliseconds <= validation.checks.duration.observedSeconds * 1_000 &&
    equal(source.profile, { id: intended.id, key: intended.key, version: intended.version, settings: intended.settings }) &&
    output.policyVersion === "encode-claim-output-v1" && output.format === "av_mkv" && output.preset === String(intended.settings.preset).trim() &&
    output.dvdNavigation === "libdvdread" && output.audioSelection === "all" && output.subtitleSelection === "all" && output.subtitleBurn === "none" &&
    equal(output.selectionArguments, ["--title", String(title.displayTitleNumber), "--angle", String(title.angleNumber), "--chapters", `${title.chapterStart}-${title.chapterEnd}`, "--all-audio"]) &&
    equal(output.audioStreams, source.title.audioStreams) && equal(output.subtitleStreams, source.title.subtitles) &&
    preview.streams.audio.every((id) => output.audioStreams.some((stream) => stream.id === id) && validation.checks!.audio.outputSourceIds?.includes(id)) &&
    preview.streams.subtitles.every((id) => output.subtitleStreams.some((stream) => stream.id === id)) &&
    validation.checks.subtitles.checked && validation.checks.subtitles.expectedSourceStreams === output.subtitleStreams.length;
  return matches ? null : "FINISHED_OUTPUT_SOURCE_MISMATCH";
}
