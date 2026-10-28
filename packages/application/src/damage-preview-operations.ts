import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalPublicationJson, DvdCheckpointReadFault, RecordNotFoundError, type DataAccess, type DamagePreviewRecord, type OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { ArchiveImageOwnershipError, defaultArchiveImageOwnership, type ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { parseMutationKey } from "./mutation-key.js";
import { InvalidDamagePreviewInputError, parseDamagePreviewInput } from "./damage-preview-input.js";
import { inspectDamagePreviewAvailability, reviewDamagePreviewEvidence } from "./damage-preview.js";
import { damagePreviewMediaState, damagePreviewRetention, presentDamagePreviewMedia, type previewMediaTargets } from "./damage-preview-media-state.js";

type Review = Awaited<ReturnType<typeof inspectDamagePreviewAvailability>>;
export class DamagePreviewRejectedError extends Error {
  constructor(readonly code: string, readonly reasons: { code: string; message: string }[], readonly current: unknown = null) {
    super(reasons[0]?.message ?? code);
  }
}
function requiredRecord(access: DataAccess, id: string) {
  const record = access.damagePreviews.find(id);
  if (!record) throw new RecordNotFoundError("Damage Preview", id);
  return record;
}
function previewMediaInputs(review: Review) {
  const request = review.reviewedRequest;
  if (!request) return null;
  const { recovery: _recovery, titleIdentityReviewSetIdentity: _reviewSet, archive, encodingProfile, ...selection } = request;
  const { catalogRevision: _revision, ...source } = archive;
  const { isActive: _active, ...intendedSettings } = encodingProfile ?? {};
  return canonicalPublicationJson({ ...selection, archive: source, encodingProfile: encodingProfile === null ? null : intendedSettings });
}
export function presentDamagePreview(record: DamagePreviewRecord, context: {
  outdated?: boolean; retention?: ReturnType<typeof damagePreviewRetention>;
  mediaTargets?: ReturnType<typeof previewMediaTargets>;
} = {}) {
  const review = JSON.parse(record.reviewJson) as Review;
  const outdated = context.outdated ?? false;
  const { files, ...media } = presentDamagePreviewMedia(record, context.retention ?? null, context.mediaTargets);
  return {
    schemaVersion: 1, id: record.id, originalDiscArchiveId: record.originalDiscArchiveId,
    status: outdated && record.artifacts.length > 0 ? "outdated" : record.status,
    generationStatus: record.status, outdated, checkpointVerified: record.checkpointVerified ?? review.current?.checkpointVerified ?? false,
    outdatedReasons: outdated ? [{ code: "DAMAGE_PREVIEW_INPUTS_CHANGED", message: "The current archive, title, selection, streams or intended settings differ from this sample." }] : [],
    recoveryPause: review.reviewedRequest?.recovery && !["stopped", "completed"].includes(review.reviewedRequest.recovery.status) ? {
      recoveryId: review.reviewedRequest.recovery.id,
      attemptId: review.reviewedRequest.recovery.attemptId,
      state: record.sourceReleased || !["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status) ? "released" : record.status === "generating" ? "paused" : "waiting",
      reason: { code: "DAMAGE_PREVIEW_PLANNED_RECOVERY_PAUSE", message: "Recovery finishes its admitted command and durable checkpoint, then pauses for this preview. This planned pause does not start the contention grace period." },
    } : null,
    reason: record.reason, cancellationRequested: record.cancellationRequested, progress: record.progress,
    artifacts: record.artifacts.map(({ path: _path, ...artifact }, index) => ({ ...artifact, media: files[index]!.media })),
    media,
    provenance: { preflightToken: record.preflightToken, ...review.reviewedRequest, clips: review.clips, commands: record.commands, streamMapping: record.streamMapping, toolVersions: record.toolVersions, deviations: record.deviations },
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    warning: "A sample illustrates decoding at the recorded interval. Failed, empty or partial media never means no damage.",
  };
}
export async function requestDamagePreview(access: DataAccess, archiveId: string, raw: unknown, ownership: ArchiveImageOwnership = defaultArchiveImageOwnership) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).some((key) => !["selection", "preflightToken", "mutationKey"].includes(key))) throw new InvalidDamagePreviewInputError("Invalid Damage Preview request.");
  const input = raw as Record<string, unknown>;
  const mutationKey = parseMutationKey(input.mutationKey);
  if (typeof input.preflightToken !== "string" || input.preflightToken.length > 256) throw new InvalidDamagePreviewInputError("A reviewed preflight token is required.");
  const selection = parseDamagePreviewInput(input.selection);
  const admission = { mutationKey, archiveId, preflightToken: input.preflightToken, selectionJson: canonicalPublicationJson(selection) };
  // Stable requests validate the durable checkpoint under OS ownership.
  // Active requests retain the reviewed identity while deferring that proof.
  // Replay precedes preparation even after source changes.
  const activeToken = /^damage-preview-preflight:v2:([a-f0-9]{64}):[a-f0-9]{64}$/.exec(input.preflightToken);
  const submit = (checkpoint: Awaited<ReturnType<DataAccess["readDvdCheckpoint"]>>, deferCheckpoint = false) => access.damagePreviews.submit(admission, () => access.readConsistentSnapshot((snapshot) => {
    const header = deferCheckpoint ? snapshot.catalog.findDvdArchiveEvidenceHeader(archiveId as OriginalDiscArchiveId) : null;
    const reviewedCheckpoint = header && activeToken ? {
      id: header.currentManifestId, revision: header.currentManifestRevision, manifestDigest: header.currentManifestDigest, publicationDigest: activeToken[1]!,
    } : checkpoint;
    const current = reviewDamagePreviewEvidence(snapshot, archiveId, selection, reviewedCheckpoint);
    if (current.preflightToken !== input.preflightToken) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_STALE", [{ code: "DAMAGE_PREVIEW_STALE", message: "Review current preview inputs before requesting work." }], current);
    if (!current.available) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_UNAVAILABLE", current.blockingReasons, current);
    if (deferCheckpoint) {
      current.current.checkpointVerified = false;
      current.knownUnknowns.push({ code: "DAMAGE_PREVIEW_CHECKPOINT_PENDING", message: "Generation must verify the reviewed durable checkpoint under image ownership after Recovery pauses." });
    }
    return JSON.stringify(current);
  }));
  const replay = access.damagePreviews.replay(admission);
  if (replay) return presentDamagePreview(replay);
  // Active requests commit a durable waiting identity before any ownership wait.
  // The token and all database identities are checked in that same transaction;
  // source admission remains fenced until the worker verifies the exact bytes.
  if (activeToken) return presentDamagePreview(submit(null, true));
  let record: DamagePreviewRecord | null;
  try {
    record = await access.withDvdCheckpoint<DamagePreviewRecord | null>(archiveId as OriginalDiscArchiveId, ownership,
      async (_checkpoint, handle) => { handle.assertOwned(); return null; },
      (checkpoint) => submit(checkpoint));
  } catch (error) {
    const committed = access.damagePreviews.replay(admission);
    if (committed) return presentDamagePreview(committed);
    if (!(error instanceof DvdCheckpointReadFault) && !(error instanceof ArchiveImageOwnershipError)) throw error;
    const stale = error.code === "DVD_EVIDENCE_CHANGED_DURING_READ";
    const reason = { code: stale ? "DAMAGE_PREVIEW_STALE" : error.code, message: stale ? "The saved checkpoint changed while the request waited. Review current evidence." : "The saved checkpoint cannot be admitted under proven image ownership." };
    const current = access.readConsistentSnapshot((snapshot) => reviewDamagePreviewEvidence(snapshot, archiveId, selection, null, [reason]));
    throw new DamagePreviewRejectedError(stale ? "DAMAGE_PREVIEW_STALE" : "DAMAGE_PREVIEW_UNAVAILABLE", [reason], current);
  }
  if (record === null) record = submit(null);
  return presentDamagePreview(record);
}
export function describeDamagePreview(access: DataAccess, record: DamagePreviewRecord, mediaTargets?: ReturnType<typeof previewMediaTargets>) {
  const original = JSON.parse(record.reviewJson) as Review;
  const saved = original.reviewedRequest!.checkpoint!;
  const current = access.readConsistentSnapshot((snapshot) => reviewDamagePreviewEvidence(snapshot, record.originalDiscArchiveId, parseDamagePreviewInput(JSON.parse(record.selectionJson)), {
    id: saved.manifestId, revision: saved.manifestRevision, manifestDigest: saved.manifestDigest, publicationDigest: saved.publicationDigest!,
  }));
  const originalTitle = original.reviewedRequest?.title?.titleIdentityId;
  const history = access.damagePreviews.list(record.originalDiscArchiveId);
  const newerIntent = history.slice(history.findIndex((candidate) => candidate.id === record.id) + 1).filter((candidate) =>
    (JSON.parse(candidate.reviewJson) as Review).reviewedRequest?.title?.titleIdentityId === originalTitle).at(-1);
  const superseded = newerIntent !== undefined && previewMediaInputs(JSON.parse(newerIntent.reviewJson) as Review) !== previewMediaInputs(original);
  const outdated = superseded || previewMediaInputs(current) !== previewMediaInputs(original);
  return presentDamagePreview(record, { outdated, retention: damagePreviewRetention(access, record, outdated), mediaTargets });
}
export async function inspectDamagePreview(access: DataAccess, id: string, _ownership?: ArchiveImageOwnership) {
  return describeDamagePreview(access, requiredRecord(access, id));
}
export function cancelDamagePreview(access: DataAccess, id: string, mutationKey: unknown) {
  return access.damagePreviews.cancel(id, parseMutationKey(mutationKey), presentDamagePreview);
}
export async function waitDamagePreview(access: DataAccess, id: string, options: { timeoutMs: number; pollMs?: number }, ownership?: ArchiveImageOwnership) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 3_600_000 || (options.pollMs !== undefined && (!Number.isSafeInteger(options.pollMs) || options.pollMs < 100 || options.pollMs > 5_000))) throw new InvalidDamagePreviewInputError("Invalid Damage Preview wait duration.");
  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const record = requiredRecord(access, id);
    const terminal = !["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status);
    if (terminal || Date.now() >= deadline) return { ...await inspectDamagePreview(access, id, ownership), wait: { terminal, timedOut: !terminal } };
    await delay(Math.min(options.pollMs ?? 500, Math.max(0, deadline - Date.now())));
  }
}
export function damagePreviewArtifact(access: DataAccess, identity: string) {
  const match = /^damage-preview-v1\.([a-f0-9-]{36})\.(\d+)$/.exec(identity);
  if (!match) throw new InvalidDamagePreviewInputError("Invalid Damage Preview artifact identity.");
  const record = requiredRecord(access, match[1]!);
  const artifact = record.artifacts.find((item) => item.identity === identity);
  if (!artifact) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", [{ code: "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", message: "This request has no retained canonical media with that identity." }]);
  const state = damagePreviewMediaState(record).files[record.artifacts.indexOf(artifact)]!;
  if (state.media.reasonCode) throw new DamagePreviewRejectedError(state.media.reasonCode, [{ code: state.media.reasonCode, message: "Canonical media is absent or unavailable. Original provenance and generation results remain in request inspection." }], describeDamagePreview(access, record));
  return { record, artifact };
}
export async function openDamagePreviewArtifact(access: DataAccess, identity: string) {
  const { record, artifact } = damagePreviewArtifact(access, identity);
  const file = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== artifact.sizeBytes) throw new Error("Preview media identity changed.");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) throw new Error("Preview media identity changed.");
    if (!access.damagePreviews.touchMedia(record.id)) {
      const current = describeDamagePreview(access, requiredRecord(access, record.id));
      const code = current.artifacts.find((item) => item.identity === identity)?.media.reasonCode ?? "DAMAGE_PREVIEW_MEDIA_UNAVAILABLE";
      throw new DamagePreviewRejectedError(code, [{ code, message: "Media removal won the access race. Inspect the retained request history." }], current);
    }
    return { file, record, artifact };
  } catch (error) { await file.close(); throw error; }
}
export async function exportDamagePreview(access: DataAccess, identity: string, destination: string, ownership?: ArchiveImageOwnership) {
  if (!isAbsolute(destination) || destination.includes("\0")) throw new InvalidDamagePreviewInputError("Choose an absolute destination on the executing host.");
  const { file, record, artifact } = await openDamagePreviewArtifact(access, identity);
  const target = resolve(destination);
  const temporary = `${target}.${randomUUID()}.partial`;
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(1_048_576);
      let position = 0;
      const hash = createHash("sha256");
      while (true) {
        const read = await file.read(buffer, 0, buffer.length, position);
        if (read.bytesRead === 0) break;
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        await output.writeFile(chunk);
        position += read.bytesRead;
      }
      if (position !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) throw new Error("Preview media changed during export.");
      if ((await output.stat()).size !== artifact.sizeBytes) throw new Error("Canonical export was not written completely.");
      await output.sync();
    } finally { await output.close(); }
    const preview = await inspectDamagePreview(access, record.id, ownership);
    await link(temporary, target);
    return { artifactIdentity: identity, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes, path: target, preview };
  } finally { await file.close(); await unlink(temporary).catch(() => undefined); }
}
