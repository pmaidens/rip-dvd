import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalPublicationJson, type DamagePreviewRecord, type ConsistentReadAccess, type OriginalDiscArchiveId } from "@rip-dvd/data-access";

export const DAMAGE_PREVIEW_IDLE_MS = 30 * 24 * 60 * 60 * 1_000;
export function previewGenerationActive(record: DamagePreviewRecord) {
  return ["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status);
}
export function previewMediaFilesystemIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") : null;
  } catch { return null; }
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
  return [...paths].map(([path, identity]) => ({ path, identity, filesystemIdentity: previewMediaFilesystemIdentity(path) }));
}
export function damagePreviewMediaState(record: DamagePreviewRecord) {
  const removal = record.mediaRemoval ?? null;
  const removalCondition = removal === null ? null : {
    pending: { state: "removing", reasonCode: "DAMAGE_PREVIEW_MEDIA_REMOVING" },
    complete: { state: "removed", reasonCode: removal.cause === "explicit_deletion" ? "DAMAGE_PREVIEW_MEDIA_DELETED" : "DAMAGE_PREVIEW_MEDIA_EXPIRED" },
    failed: { state: "removal_failed", reasonCode: "DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED" },
  }[removal.state];
  const files = record.artifacts.map((artifact) => {
    const identity = previewMediaFilesystemIdentity(artifact.path);
    const media = removalCondition ?? { state: identity === null ? "missing" : "retained", reasonCode: identity === null ? "DAMAGE_PREVIEW_MEDIA_MISSING" : null };
    return { identity, media };
  });
  const state = removalCondition?.state ?? (record.artifacts.length === 0 ? "not_generated" : files.some((file) => file.media.state !== "retained") ? "missing" : "retained");
  const targets = previewMediaTargets(record).map(({ path: _path, ...target }) => target);
  const token = `damage-preview-media:${createHash("sha256").update(canonicalPublicationJson({ id: record.id, status: record.status, artifacts: record.artifacts, targets, lastAccessedAt: record.mediaLastAccessedAt ?? null, removal })).digest("hex")}`;
  return { state, token, lastAccessedAt: record.mediaLastAccessedAt ?? record.updatedAt, removal, history: record.mediaRemovalHistory ?? [], files };
}

export function damagePreviewRetention(access: ConsistentReadAccess, record: DamagePreviewRecord, outdated: boolean) {
  const archive = access.catalog.listOriginalDiscArchives({ ids: [record.originalDiscArchiveId as OriginalDiscArchiveId] })[0];
  const archiveOnly = archive?.catalogReviewOutcome === "archive_only";
  const activeCatalogReview = archive !== undefined && archive.catalogReviewedAt === null && !archiveOnly;
  const currentSample = !outdated && record.status === "complete";
  // A historical output's mutable selection is not proof that it represents
  // this preview. Until immutable output correspondence is supplied, retain it.
  const awaitingFinishedOutputInspection = currentSample && !archiveOnly;
  const protectedForReview = currentSample && (activeCatalogReview || awaitingFinishedOutputInspection);
  const idleSince = record.mediaLastAccessedAt ?? record.updatedAt;
  return {
    protectedForReview, activeCatalogReview, awaitingFinishedOutputInspection,
    reasonCodes: protectedForReview ? [
      ...(activeCatalogReview ? ["CATALOG_REVIEW_ACTIVE"] : []),
      ...(awaitingFinishedOutputInspection ? ["FINISHED_OUTPUT_INSPECTION_NOT_RECORDED"] : []),
    ] : [],
    idleSince, eligibleAt: protectedForReview ? null : new Date(Date.parse(idleSince) + DAMAGE_PREVIEW_IDLE_MS).toISOString(),
  };
}

export function presentDamagePreviewMedia(record: DamagePreviewRecord, retention: ReturnType<typeof damagePreviewRetention> | null) {
  const { files, ...media } = damagePreviewMediaState(record);
  const deletionReasons = previewGenerationActive(record) ? [{ code: "DAMAGE_PREVIEW_GENERATION_ACTIVE", message: "Cancel the preview and wait for generation to settle before removing media." }]
    : media.state === "removing" ? [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVING", message: "Media removal is pending. Replay its invocation to resume it." }]
    : media.state === "removed" ? [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVED", message: "Media was already removed. The request history is retained." }]
    : record.artifacts.length === 0 && record.commands.length === 0 ? [{ code: "DAMAGE_PREVIEW_MEDIA_NOT_GENERATED", message: "This request has no generated media." }] : [];
  const cleanupReasons = [...deletionReasons,
    ...(media.state === "removal_failed" ? [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED", message: "Automatic cleanup stopped after a removal failure. Review the media and explicitly retry deletion." }] : []),
    ...(retention === null ? [{ code: "DAMAGE_PREVIEW_RETENTION_NOT_INSPECTED", message: "Inspect current retention before cleanup." }] : retention.protectedForReview ? [{ code: "DAMAGE_PREVIEW_REVIEW_RETENTION", message: "Current media is retained for Catalog Review or finished-output inspection." }] : []),
    ...(retention?.eligibleAt !== null && retention?.eligibleAt !== undefined && Date.parse(retention.eligibleAt) > Date.now() ? [{ code: "DAMAGE_PREVIEW_NOT_IDLE", message: "Media has not been idle for 30 days." }] : []),
  ];
  return { ...media, files, retention, deletion: { available: deletionReasons.length === 0, reasons: deletionReasons }, cleanup: { available: cleanupReasons.length === 0, reasons: cleanupReasons } };
}
