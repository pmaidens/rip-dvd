import { createHash } from "node:crypto";
import { canonicalPublicationJson, type DamagePreviewRecord, type DamagePreviewRecreationDifference } from "@rip-dvd/data-access";
import type { inspectDamagePreviewAvailability } from "./damage-preview.js";

type Review = Awaited<ReturnType<typeof inspectDamagePreviewAvailability>>;

/** Compare the recorded evidence, never title numbers or mutable catalog links. */
export function reviewDamagePreviewRecreation(record: DamagePreviewRecord, current: Review) {
  const original = JSON.parse(record.reviewJson) as Review;
  const old = original.reviewedRequest;
  const next = current.reviewedRequest;
  const differences: DamagePreviewRecreationDifference[] = [];
  function compare(field: string, before: unknown, after: unknown) {
    if (canonicalPublicationJson(before ?? null) !== canonicalPublicationJson(after ?? null)) differences.push({ field, before: before ?? null, after: after ?? null });
  }
  compare("checkpoint", old?.checkpoint, next?.checkpoint);
  compare("source", old ? { fingerprint: old.archive.fingerprint, path: old.archive.path } : null, next ? { fingerprint: next.archive.fingerprint, path: next.archive.path } : null);
  compare("titleIdentity", old?.title, next?.title);
  compare("sourceTitle", old?.sourceTitle, next?.sourceTitle);
  compare("playbackSelection", old ? { mode: old.mode, playbackRange: old.playbackRange, samplingWindow: old.samplingWindow, context: old.context } : null,
    next ? { mode: next.mode, playbackRange: next.playbackRange, samplingWindow: next.samplingWindow, context: next.context } : null);
  compare("streams", old?.streams, next?.streams);
  const settings = (request: typeof old) => request?.encodingProfile ? { id: request.encodingProfile.id, key: request.encodingProfile.key, version: request.encodingProfile.version, settings: request.encodingProfile.settings } : null;
  compare("intendedSettings", settings(old), settings(next));
  compare("damageEvidence", old ? { assessmentIdentity: old.assessmentIdentity, timingEvidence: old.timingEvidence, markers: old.markers } : null,
    next ? { assessmentIdentity: next.assessmentIdentity, timingEvidence: next.timingEvidence, markers: next.markers } : null);
  compare("clips", original.clips, current.clips);
  const reasons: { code: string; message: string }[] = [];
  if (!old?.checkpoint?.publicationDigest || !current.current.checkpointVerified || differences.some((item) => ["checkpoint", "source"].includes(item.field))) {
    reasons.push({ code: "DAMAGE_PREVIEW_OLD_SOURCE_UNAVAILABLE", message: "The exact old source bytes cannot be proved at the current durable checkpoint. A retained manifest or preview file alone is not the old source." });
  }
  if (!old?.title || !next?.title || differences.some((item) => item.field === "titleIdentity")) {
    reasons.push({ code: "DAMAGE_PREVIEW_OLD_TITLE_IDENTITY_UNAVAILABLE", message: "The exact old Title Identity and playback path are not available. A matching title number does not prove continuity." });
  }
  if (["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status)) reasons.push({ code: "DAMAGE_PREVIEW_ORIGINAL_UNSETTLED", message: "Wait for or cancel the original generation before reviewing recreation." });
  if (differences.length > 0) reasons.push({ code: "DAMAGE_PREVIEW_RECREATION_INPUTS_CHANGED", message: "Review the differences, run a fresh current-revision preflight and explicitly request current-revision work." });
  reasons.push(...current.blockingReasons);
  const recreationToken = `damage-preview-recreation:v1:${createHash("sha256").update(canonicalPublicationJson({ sourceRequestId: record.id, originalReview: original, originalStatus: record.status, originalToolVersions: record.toolVersions, originalStreamMapping: record.streamMapping, originalDeviations: record.deviations, originalCommands: record.commands, currentPreflightToken: current.preflightToken, currentAvailable: current.available, checkpointVerified: current.current.checkpointVerified, differences, reasons })).digest("hex")}`;
  return {
    schemaVersion: 1, sourceRequestId: record.id, recreationToken,
    exact: { available: reasons.length === 0, reasons }, differences,
    preflight: current,
    original: { generationStatus: record.status, reason: record.reason, toolVersions: record.toolVersions, streamMapping: record.streamMapping, deviations: record.deviations },
    warning: "Exact inputs do not promise byte-identical output or watchability. The new generation records its current tool versions and material generation differences.",
  };
}

function commandSemantics(commands: string[][]) {
  return commands.map((command) => command.map((argument, index) =>
    index > 0 && ["-o", "--output"].includes(command[index - 1]!) ? "<preview-output>" : argument.startsWith("--output=") ? "--output=<preview-output>" : argument));
}

function toolVersionIdentities(versions: Record<string, string>) {
  const handbrake = versions.handbrake?.split(/\r?\n/).find((line) => /^HandBrake[ \t]+\d/.test(line));
  return handbrake ? { ...versions, handbrake: handbrake.trim() } : versions;
}

export function presentDamagePreviewRecreation(record: DamagePreviewRecord) {
  const recreation = record.recreation;
  if (!recreation) return null;
  const differences: DamagePreviewRecreationDifference[] = [];
  const compare = (field: string, before: unknown, after: unknown) => {
    if (canonicalPublicationJson(before) !== canonicalPublicationJson(after)) differences.push({ field, before, after });
  };
  const active = ["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status);
  const toolsRecorded = Object.keys(record.toolVersions).length > 0;
  if (toolsRecorded && !active) {
    compare("resolvedCommands", commandSemantics(recreation.originalCommands), commandSemantics(record.commands));
    if (canonicalPublicationJson(toolVersionIdentities(recreation.originalToolVersions)) !== canonicalPublicationJson(toolVersionIdentities(record.toolVersions))) {
      differences.push({ field: "toolVersions", before: recreation.originalToolVersions, after: record.toolVersions });
    }
    compare("streamMapping", recreation.originalStreamMapping, record.streamMapping);
    compare("sampleDeviations", recreation.originalDeviations, record.deviations);
  }
  return { ...recreation, generationComparison: active ? toolsRecorded ? "in_progress" : "pending" : toolsRecorded ? "recorded" : "unavailable", generationDifferences: differences };
}
