import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { browserRenditionConfig } from "@rip-dvd/config";
import { canonicalPublicationJson, RecordNotFoundError, type DataAccess } from "@rip-dvd/data-access";
import { describeDamagePreview } from "./damage-preview-operations.js";
import { previewGenerationActive, previewMediaFileObservation, previewMediaTargets } from "./damage-preview-media-state.js";
import { probeEncodeOutputMedia, type EncodeOutputMediaProbe, type EncodeOutputMediaInspection } from "./encode-output-inspection.js";
import { browserRenditionStreamReasons, planBrowserRendition } from "./browser-rendition-conversion.js";
import { BrowserRenditionRejectedError, InvalidBrowserRenditionInputError, parseRenditionSelection, parseRenditionRequest, presentBrowserRendition } from "./encode-output-rendition.js";

function retainedPreview(access: DataAccess, identity: unknown, targets?: ReturnType<typeof previewMediaTargets>) {
  if (typeof identity !== "string" || !/^damage-preview-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9][0-9]*)$/.test(identity)) throw new InvalidBrowserRenditionInputError();
  const id = identity.split(".")[1]!;
  const record = access.damagePreviews.find(id);
  if (!record) throw new RecordNotFoundError("Damage Preview", id);
  const artifact = record.artifacts.find((candidate) => candidate.identity === identity);
  if (!artifact) throw new BrowserRenditionRejectedError("DAMAGE_PREVIEW_MEDIA_UNAVAILABLE");
  const preview = describeDamagePreview(access, record, targets, false, null);
  return { record, artifact, preview, media: preview.artifacts.find((candidate) => candidate.identity === identity)!.media };
}
function previewCondition({ preview, media }: ReturnType<typeof retainedPreview>) {
  return { status: preview.status, generationStatus: preview.generationStatus, outdated: preview.outdated,
    outdatedReasons: preview.outdatedReasons, reason: preview.reason, canonicalMedia: media, warning: preview.warning };
}
export function inspectDamagePreviewRenditionCondition(access: DataAccess, identity: string) {
  return previewCondition(retainedPreview(access, identity));
}
function previewSource(retained: ReturnType<typeof retainedPreview>, media: { durationSeconds: number | null; streams: EncodeOutputMediaInspection["streams"] | null }) {
  const { artifact, record, preview } = retained;
  return { kind: "damage_preview" as const, identity: artifact.identity, requestId: record.id,
    generationStatus: record.status, generationReason: record.reason,
    canonical: { mediaType: artifact.mediaType, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
    coverage: artifact.coverage, coverageMethod: artifact.coverageMethod ?? null,
    durationMilliseconds: artifact.durationMilliseconds, provenance: preview.provenance, media };
}
export type DamagePreviewRenditionSource = ReturnType<typeof previewSource>;
function digest(value: unknown) { return createHash("sha256").update(canonicalPublicationJson(value)).digest("hex"); }
export async function inspectDamagePreviewRenditionAvailability(access: DataAccess, identity: unknown, probe: EncodeOutputMediaProbe = probeEncodeOutputMedia, enabled = browserRenditionConfig().enabled, selection: unknown = {}) {
  const burnSubtitleIndex = parseRenditionSelection(selection);
  const retained = retainedPreview(access, identity);
  const reasons: { code: string; message: string }[] = [];
  if (!enabled) reasons.push({ code: "BROWSER_RENDITIONS_DISABLED", message: "Browser Viewing Renditions are disabled pending media validation." });
  if (previewGenerationActive(retained.record)) reasons.push({ code: "DAMAGE_PREVIEW_GENERATION_ACTIVE", message: "Wait for canonical sample generation to settle before requesting a rendition." });
  if (retained.media.reasonCode) reasons.push({ code: retained.media.reasonCode, message: "Retained canonical sample media is unavailable. Its absence is not evidence about damage." });
  const observation = previewMediaFileObservation(retained.artifact.path);
  let media: { durationSeconds: number | null; streams: EncodeOutputMediaInspection["streams"] | null } = { durationSeconds: null, streams: null };
  if (reasons.length === 0) {
    try {
      const file = await open(retained.artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size === 0 || metadata.size !== retained.artifact.sizeBytes) throw new Error("Canonical sample identity changed.");
        const hash = createHash("sha256");
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
        if (hash.digest("hex") !== retained.artifact.sha256) throw new Error("Canonical sample checksum changed.");
        media = await probe(retained.artifact.path);
      } finally { await file.close(); }
    } catch { reasons.push({ code: "DAMAGE_PREVIEW_PROBE_FAILED", message: "The retained sample could not be verified and probed. No playback conclusion was recorded." }); }
    if (previewMediaFileObservation(retained.artifact.path).filesystemIdentity !== observation.filesystemIdentity ||
        canonicalPublicationJson(previewSource(retainedPreview(access, identity), media)) !== canonicalPublicationJson(previewSource(retained, media))) {
      reasons.push({ code: "RENDITION_SOURCE_CHANGED", message: "The canonical sample changed while it was inspected. Review it again." });
    }
    if (reasons.length === 0) reasons.push(...browserRenditionStreamReasons(media, burnSubtitleIndex));
  }
  const latest = retainedPreview(access, identity);
  if (latest.media.reasonCode && !reasons.some((reason) => reason.code === latest.media.reasonCode)) reasons.push({ code: latest.media.reasonCode, message: "The canonical sample is no longer retained for viewing." });
  const source = previewSource(retained, media);
  const condition = previewCondition(latest);
  const conversion = planBrowserRendition(media.streams, burnSubtitleIndex);
  const sourceRevision = digest(source);
  const current = { sourceRevision, filesystemIdentity: observation.filesystemIdentity };
  const reviewToken = digest({ policy: "damage-preview-viewing-v1", source, condition, current, conversion });
  return { schemaVersion: 1 as const, available: reasons.length === 0, reasons, reviewToken, source, previewCondition: condition, conversion, current };
}
export type DamagePreviewRenditionAvailability = Awaited<ReturnType<typeof inspectDamagePreviewRenditionAvailability>>;
export async function requestDamagePreviewRendition(access: DataAccess, identity: unknown, raw: unknown, probe?: EncodeOutputMediaProbe, enabled = browserRenditionConfig().enabled) {
  const { input, selection } = parseRenditionRequest(identity, raw, "damage_preview");
  const replay = access.browserRenditions.replay(input);
  if (replay) return presentBrowserRendition(replay, access);
  let current: DamagePreviewRenditionAvailability;
  try { current = await inspectDamagePreviewRenditionAvailability(access, identity, probe, enabled, selection); }
  catch (error) {
    const committed = access.browserRenditions.replay(input);
    if (committed) return presentBrowserRendition(committed, access);
    if (error instanceof RecordNotFoundError) throw new BrowserRenditionRejectedError("RENDITION_SOURCE_UNAVAILABLE");
    throw error;
  }
  const concurrent = access.browserRenditions.replay(input);
  if (concurrent) return presentBrowserRendition(concurrent, access);
  if (!current.available) throw new BrowserRenditionRejectedError(current.reasons[0]!.code, current);
  if (current.reviewToken !== input.reviewToken) throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", current);
  try {
    const record = access.browserRenditions.submit(input, () => {
      // Stage path and output-retention observations before SQLite's writer lock.
      const staged = retainedPreview(access, identity);
      const targets = previewMediaTargets(staged.record);
      if (staged.media.reasonCode || previewMediaFileObservation(staged.artifact.path).filesystemIdentity !== current.current.filesystemIdentity) throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", current);
      return {
        sourceJson: canonicalPublicationJson(current.source), sourceAuthorityRevision: current.current.sourceRevision, conversion: current.conversion,
        assertAuthority() {
          const latest = access.damagePreviews.find(staged.record.id);
          if (!latest || canonicalPublicationJson(latest.artifacts) !== canonicalPublicationJson(staged.record.artifacts)) throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", current);
          const retained = retainedPreview(access, identity, targets);
          if (previewGenerationActive(retained.record) || retained.media.reasonCode ||
              digest(previewSource(retained, current.source.media)) !== current.current.sourceRevision ||
              canonicalPublicationJson(previewCondition(retained)) !== canonicalPublicationJson(current.previewCondition)) {
            throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", current);
          }
          if (!access.damagePreviews.touchMedia(retained.record.id, current.source.identity)) throw new BrowserRenditionRejectedError("DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", current);
        },
      };
    });
    return presentBrowserRendition(record, access);
  } catch (error) {
    const committed = access.browserRenditions.replay(input);
    if (committed) return presentBrowserRendition(committed, access);
    if (error instanceof BrowserRenditionRejectedError && error.code === "RENDITION_REVIEW_STALE") {
      let refreshed: DamagePreviewRenditionAvailability | null = null;
      try { refreshed = await inspectDamagePreviewRenditionAvailability(access, identity, probe, enabled, selection); }
      catch (refreshError) { if (!(refreshError instanceof RecordNotFoundError)) throw refreshError; }
      throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", refreshed);
    }
    throw error;
  }
}
