import { createHash } from "node:crypto";
import { constants, lstatSync, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { browserRenditionConfig } from "@rip-dvd/config";
import { canonicalPublicationJson, matchesEncodeOutputFilesystemIdentity, RecordNotFoundError, type BrowserRenditionRecord, type DataAccess } from "@rip-dvd/data-access";
import { prepareEncodeOutputEvidenceCommit, inspectEncodeOutputEvidence, type EncodeOutputMediaProbe, type EncodeOutputMediaInspection } from "./encode-output-inspection.js";
import { burnableSubtitleCodecs, planBrowserRendition } from "./browser-rendition-conversion.js";
import { parseMutationKey } from "./mutation-key.js";

export class InvalidBrowserRenditionInputError extends Error {
  constructor() { super("A rendition identity and valid subtitle selection are required. Requests also require an exact review token and mutation key."); }
}
export class BrowserRenditionRejectedError extends Error {
  constructor(readonly code: string, readonly current: BrowserRenditionAvailability | null = null) {
    super(current?.reasons[0]?.message ?? "Browser Viewing Rendition is unavailable. Review the current output evidence.");
  }
}
function renditionMediaMatches(media: NonNullable<BrowserRenditionRecord["media"]>, metadata: Stats) {
  return metadata.isFile() && !metadata.isSymbolicLink() && matchesEncodeOutputFilesystemIdentity(media.filesystemIdentity, metadata) && metadata.ctimeMs === media.changeTimeMs;
}
function renditionMediaAvailability(media: NonNullable<BrowserRenditionRecord["media"]>) {
  try {
    return renditionMediaMatches(media, lstatSync(media.path)) ? { available: true as const, reasonCode: null }
      : { available: false as const, reasonCode: "RENDITION_MEDIA_IDENTITY_CHANGED" };
  } catch { return { available: false as const, reasonCode: "RENDITION_MEDIA_UNAVAILABLE" }; }
}
export function presentBrowserRendition(record: BrowserRenditionRecord) {
  const { sourceJson, sourceIdentity: _sourceIdentity, media, mediaProbeJson, ...details } = record;
  return {
    schemaVersion: 1 as const, ...details,
    type: "browser_viewing_rendition" as const,
    source: JSON.parse(sourceJson) as Awaited<ReturnType<typeof inspectEncodeOutputEvidence>>["artifact"],
    actualMedia: mediaProbeJson ? JSON.parse(mediaProbeJson) as EncodeOutputMediaInspection : null,
    playback: { kind: "ordinary" as const, damageSeek: null, watchability: "not_assessed" as const },
    media: media === null ? null : { identity: media.identity, sizeBytes: media.sizeBytes, mediaType: "video/mp4" as const, availability: renditionMediaAvailability(media) },
  };
}
function parseRenditionSelection(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).some((key) => key !== "burnSubtitleIndex")) throw new InvalidBrowserRenditionInputError();
  const index = (raw as Record<string, unknown>).burnSubtitleIndex;
  if (index === undefined) return null;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new InvalidBrowserRenditionInputError();
  return index;
}
export async function inspectEncodeOutputRenditionAvailability(access: DataAccess, identity: unknown, probe?: EncodeOutputMediaProbe, enabled = browserRenditionConfig().enabled, selection: unknown = {}) {
  const burnSubtitleIndex = parseRenditionSelection(selection);
  const inspection = await inspectEncodeOutputEvidence(access, identity, probe);
  const source = inspection.artifact;
  const reasons: { code: string; message: string }[] = [];
  if (!enabled) reasons.push({ code: "BROWSER_RENDITIONS_DISABLED", message: "Browser Viewing Renditions are disabled pending media validation." });
  if (source.file.identityContinuity !== "verified" || source.file.completeness !== "complete" || source.inspectability.status !== "inspected") {
    reasons.push({ code: source.inspectability.reasonCode ?? "OUTPUT_COMPLETE_IDENTITY_REQUIRED", message: source.inspectability.reason ?? "A complete Encode Output with recorded file identity is required." });
  }
  const streams = source.media.streams ?? [];
  const video = streams.filter((stream) => stream.kind === "video");
  if (source.inspectability.status === "inspected") {
    if (video.length !== 1) reasons.push({ code: "RENDITION_VIDEO_STREAM_UNSUPPORTED", message: "A rendition requires exactly one actual video stream." });
    if (burnSubtitleIndex !== null) {
      const subtitle = streams.find((stream) => stream.index === burnSubtitleIndex && stream.kind === "subtitle");
      if (!subtitle) reasons.push({ code: "RENDITION_SUBTITLE_NOT_FOUND", message: "The selected subtitle is not present in the actual canonical output." });
      else if (!burnableSubtitleCodecs.includes(subtitle.codecName ?? "")) reasons.push({ code: "RENDITION_SUBTITLE_CODEC_UNSUPPORTED", message: "The selected subtitle format cannot be burned into this rendition." });
    }
    if (source.media.durationSeconds === null || source.media.durationSeconds <= 0) reasons.push({ code: "RENDITION_DURATION_UNKNOWN", message: "The actual output duration is unavailable." });
  }
  const conversion = planBrowserRendition(source.media.streams, burnSubtitleIndex);
  const reviewToken = createHash("sha256").update(canonicalPublicationJson({ policy: "encode-output-viewing-v2", inspection, burnSubtitleIndex, conversion })).digest("hex");
  return { schemaVersion: 1 as const, available: reasons.length === 0, reasons, reviewToken, source, conversion,
    current: { authorityRevision: inspection.authorityRevision, fileIdentity: source.file.identity, fileMutationRevision: source.file.mutationRevision } };
}
export type BrowserRenditionAvailability = Awaited<ReturnType<typeof inspectEncodeOutputRenditionAvailability>>;

export async function requestEncodeOutputRendition(access: DataAccess, identity: unknown, raw: unknown, probe?: EncodeOutputMediaProbe, enabled = browserRenditionConfig().enabled) {
  if (typeof identity !== "string" || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InvalidBrowserRenditionInputError();
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["mutationKey", "reviewToken", "burnSubtitleIndex"].includes(key)) || typeof body.reviewToken !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewToken)) throw new InvalidBrowserRenditionInputError();
  const selection = body.burnSubtitleIndex === undefined ? {} : { burnSubtitleIndex: body.burnSubtitleIndex };
  const burnSubtitleIndex = parseRenditionSelection(selection);
  const input = { sourceIdentity: identity, mutationKey: parseMutationKey(body.mutationKey), reviewToken: body.reviewToken,
    ...(burnSubtitleIndex === null ? {} : { burnSubtitleIndex }) };
  const replay = access.browserRenditions.replay(input);
  if (replay) return presentBrowserRendition(replay);
  let current: BrowserRenditionAvailability;
  try { current = await inspectEncodeOutputRenditionAvailability(access, identity, probe, enabled, selection); }
  catch (error) {
    const committed = access.browserRenditions.replay(input);
    if (committed) return presentBrowserRendition(committed);
    if (error instanceof RecordNotFoundError) throw new BrowserRenditionRejectedError("RENDITION_SOURCE_UNAVAILABLE");
    throw error;
  }
  const concurrentReplay = access.browserRenditions.replay(input);
  if (concurrentReplay) return presentBrowserRendition(concurrentReplay);
  if (!current.available) throw new BrowserRenditionRejectedError(current.reasons[0]!.code, current);
  if (current.reviewToken !== input.reviewToken) throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", current);
  try {
    return presentBrowserRendition(access.browserRenditions.submit(input, () => {
      const assertAuthority = prepareEncodeOutputEvidenceCommit(access, { schemaVersion: 1, authorityRevision: current.current.authorityRevision, artifact: current.source });
      return { assertAuthority, sourceJson: canonicalPublicationJson(current.source), sourceAuthorityRevision: current.current.authorityRevision, conversion: current.conversion };
    }));
  } catch (error) {
    const committed = access.browserRenditions.replay(input);
    if (committed) return presentBrowserRendition(committed);
    const fileError = typeof error === "object" && error !== null && "code" in error && ["ENOENT", "EACCES", "ELOOP", "ENOTDIR", "ESTALE"].includes(String(error.code));
    if (error instanceof RecordNotFoundError || fileError || (error instanceof Error && ["OUTPUT_AUTHORITY_CHANGED", "OUTPUT_IDENTITY_CHANGED"].includes(error.message))) {
      let refreshed: BrowserRenditionAvailability | null = null;
      try { refreshed = await inspectEncodeOutputRenditionAvailability(access, identity, probe, enabled, selection); } catch (refreshError) { if (!(refreshError instanceof RecordNotFoundError)) throw refreshError; }
      throw new BrowserRenditionRejectedError("RENDITION_REVIEW_STALE", refreshed);
    }
    throw error;
  }
}
export function inspectBrowserRendition(access: DataAccess, id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new InvalidBrowserRenditionInputError();
  const record = access.browserRenditions.find(id);
  if (!record) throw new RecordNotFoundError("Browser Viewing Rendition", id);
  return presentBrowserRendition(record);
}
export async function openBrowserRendition(access: DataAccess, id: unknown, enabled = browserRenditionConfig().enabled) {
  if (!enabled) throw new BrowserRenditionRejectedError("BROWSER_RENDITIONS_DISABLED");
  inspectBrowserRendition(access, id);
  const record = access.browserRenditions.find(id as string)!;
  if (record.status !== "complete" || record.media === null) throw new BrowserRenditionRejectedError("RENDITION_MEDIA_UNAVAILABLE");
  const media = record.media;
  let file;
  try { file = await open(media.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new BrowserRenditionRejectedError("RENDITION_MEDIA_UNAVAILABLE"); }
  try {
    const held = await file.stat(), named = await lstat(media.path);
    if (!renditionMediaMatches(media, held) || !renditionMediaMatches(media, named)) throw new BrowserRenditionRejectedError("RENDITION_MEDIA_IDENTITY_CHANGED");
    return { file, rendition: presentBrowserRendition(record), sizeBytes: held.size };
  } catch (error) { await file.close(); throw error; }
}
