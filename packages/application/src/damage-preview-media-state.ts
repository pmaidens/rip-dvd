import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalPublicationJson, type DamagePreviewRecord, type ConsistentReadAccess, type OriginalDiscArchiveId } from "@rip-dvd/data-access";

import type { DamagePreviewFinishedOutputInspection } from "./damage-preview-output-inspection.js";

export const DAMAGE_PREVIEW_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
export function previewGenerationActive(record: DamagePreviewRecord) {
  return ["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status);
}
export function previewMediaFileObservation(path: string) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile()
      ? { state: "retained", filesystemIdentity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"), reasonCode: null }
      : { state: "unsafe", filesystemIdentity: null, reasonCode: "DAMAGE_PREVIEW_MEDIA_UNSAFE" };
  } catch (error) {
    const missing = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
    return { state: missing ? "missing" : "unavailable", filesystemIdentity: null, reasonCode: missing ? "DAMAGE_PREVIEW_MEDIA_MISSING" : "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE" };
  }
}
export function previewMediaTargets(record: DamagePreviewRecord) {
  const paths = new Map(record.artifacts.map((artifact) => [artifact.path, artifact.identity]));
  for (const [index, command] of record.commands.entries()) {
    const outputIndex = command.indexOf("-o");
    const path = command[outputIndex + 1];
    if (!path || outputIndex < 0 || basename(path) !== `${index}.partial.mkv`) continue;
    paths.set(path, `damage-preview-unpublished.${record.id}.${index}`);
    const final = join(dirname(path), `${index}.mkv`);
    if (!paths.has(final)) paths.set(final, `damage-preview-unpublished.${record.id}.${index}.final`);
  }
  return [...paths].map(([path, identity]) => ({ path, identity, observation: previewMediaFileObservation(path) }));
}
export function damagePreviewMediaState(record: DamagePreviewRecord, targets = previewMediaTargets(record)) {
  const removal = record.mediaRemoval ?? null;
  const removalCondition = removal === null ? null : {
    cancelled: null,
    pending: { state: "removing", reasonCode: "DAMAGE_PREVIEW_MEDIA_REMOVING" },
    complete: { state: "removed", reasonCode: removal.cause === "explicit_deletion" ? "DAMAGE_PREVIEW_MEDIA_DELETED" : "DAMAGE_PREVIEW_MEDIA_EXPIRED" },
    failed: { state: "removal_failed", reasonCode: "DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED" },
  }[removal.state];
  const files = record.artifacts.map((artifact) => {
    const { filesystemIdentity: identity, ...observation } = targets.find((target) => target.identity === artifact.identity)!.observation;
    const retainedAfterFailure = removal?.state === "failed" && removal.cause === "idle_cleanup" &&
      removal.outcomes.some((outcome) => outcome.identity === artifact.identity && outcome.outcome === "retained");
    const media = retainedAfterFailure ? observation : removalCondition ?? observation;
    return { identity, media };
  });
  const unavailable = targets.find((target) => ["unsafe", "unavailable"].includes(target.observation.state));
  const state = removalCondition?.state ?? unavailable?.observation.state ?? (record.artifacts.length === 0 ? "not_generated" : files.some((file) => file.media.state !== "retained") ? "missing" : "retained");
  const identities = targets.map(({ path: _path, ...target }) => target);
  const token = `damage-preview-media:${createHash("sha256").update(canonicalPublicationJson({ id: record.id, status: record.status, artifacts: record.artifacts, targets: identities, lastAccessedAt: record.mediaLastAccessedAt ?? null, removal })).digest("hex")}`;
  return { state, token, lastAccessedAt: record.mediaLastAccessedAt ?? record.updatedAt, removal, history: record.mediaRemovalHistory ?? [], files };
}

export function damagePreviewRetention(access: ConsistentReadAccess, record: DamagePreviewRecord, outdated: boolean, outputInspection: DamagePreviewFinishedOutputInspection | null) {
  const archive = access.catalog.listOriginalDiscArchives({ ids: [record.originalDiscArchiveId as OriginalDiscArchiveId] })[0];
  const archiveOnly = archive?.catalogReviewOutcome === "archive_only";
  const activeCatalogReview = archive !== undefined && archive.catalogReviewedAt === null && !archiveOnly;
  const currentSample = !outdated && record.status === "complete";
  const awaitingFinishedOutputInspection = currentSample && !archiveOnly && outputInspection?.retentionSatisfied !== true;
  const protectedForReview = currentSample && (activeCatalogReview || awaitingFinishedOutputInspection);
  const idleSince = record.mediaLastAccessedAt ?? record.updatedAt;
  const outputReasons = outputInspection?.outputs.flatMap((output) => output.reasonCode === null ? [] : [output.reasonCode]) ?? [];
  return {
    protectedForReview, activeCatalogReview, awaitingFinishedOutputInspection,
    reasonCodes: protectedForReview ? [
      ...(activeCatalogReview ? ["CATALOG_REVIEW_ACTIVE"] : []),
      ...(awaitingFinishedOutputInspection ? [...new Set(outputReasons.length > 0 ? outputReasons : ["FINISHED_OUTPUT_INSPECTION_NOT_RECORDED"])] : []),
    ] : [],
    idleSince, eligibleAt: protectedForReview ? null : new Date(Date.parse(idleSince) + DAMAGE_PREVIEW_IDLE_MS).toISOString(),
  };
}

export function presentDamagePreviewMedia(record: DamagePreviewRecord, retention: ReturnType<typeof damagePreviewRetention> | null, targets?: ReturnType<typeof previewMediaTargets>) {
  const { files, ...media } = damagePreviewMediaState(record, targets);
  const deletionReasons = previewGenerationActive(record) ? [{ code: "DAMAGE_PREVIEW_GENERATION_ACTIVE", message: "Cancel the preview and wait for generation to settle before removing media." }]
    : media.state === "removing" ? [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVING", message: "Media removal is pending in the writable Encode worker. Inspect this request for completion or failure." }]
    : media.state === "removed" ? [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVED", message: "Media was already removed. The request history is retained." }]
    : media.state === "unsafe" || media.state === "unavailable" ? [{ code: media.state === "unsafe" ? "DAMAGE_PREVIEW_MEDIA_UNSAFE" : "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", message: "The preview file cannot be safely inspected. Its absence is not proven." }]
    : record.artifacts.length === 0 && record.commands.length === 0 ? [{ code: "DAMAGE_PREVIEW_MEDIA_NOT_GENERATED", message: "This request has no generated media." }] : [];
  const cleanupReasons = [...deletionReasons,
    ...(media.state === "removal_failed" ? [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED", message: "Automatic cleanup stopped after a removal failure. Review the media and explicitly retry deletion." }] : []),
    ...(retention === null ? [{ code: "DAMAGE_PREVIEW_RETENTION_NOT_INSPECTED", message: "Inspect current retention before cleanup." }] : retention.protectedForReview ? [{ code: "DAMAGE_PREVIEW_REVIEW_RETENTION", message: "Current media is retained for Catalog Review or finished-output inspection." }] : []),
    ...(retention?.eligibleAt !== null && retention?.eligibleAt !== undefined && Date.parse(retention.eligibleAt) > Date.now() ? [{ code: "DAMAGE_PREVIEW_NOT_IDLE", message: "Media has not been idle for 30 days." }] : []),
  ];
  return { ...media, files, retention, deletion: { available: deletionReasons.length === 0, reasons: deletionReasons }, cleanup: { available: cleanupReasons.length === 0, reasons: cleanupReasons } };
}
