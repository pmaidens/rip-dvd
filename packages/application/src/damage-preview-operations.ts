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
import { damagePreviewMediaState, damagePreviewRetention, presentDamagePreviewMedia } from "./damage-preview-media-state.js";

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
export function presentDamagePreview(record: DamagePreviewRecord, current?: Review, superseded = false, retention: ReturnType<typeof damagePreviewRetention> | null = null) {
  const review = JSON.parse(record.reviewJson) as Review;
  const outdated = superseded || (current !== undefined && current.preflightToken !== record.preflightToken);
  const { files, ...media } = presentDamagePreviewMedia(record, retention);
  return {
    schemaVersion: 1, id: record.id, originalDiscArchiveId: record.originalDiscArchiveId,
    status: outdated && record.artifacts.length > 0 ? "outdated" : record.status,
    generationStatus: record.status, outdated,
    outdatedReasons: outdated ? [{ code: "DAMAGE_PREVIEW_INPUTS_CHANGED", message: "The current archive, title, selection, streams or intended settings differ from this sample." }] : [],
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
  // The OS ownership interval covers durable validation and the transaction that admits work.
  // A replay is resolved before its prepare callback, even when evidence has since changed.
  const submit = (checkpoint: Awaited<ReturnType<DataAccess["readDvdCheckpoint"]>>) => access.damagePreviews.submit(admission, () => access.readConsistentSnapshot((snapshot) => {
    const current = reviewDamagePreviewEvidence(snapshot, archiveId, selection, checkpoint);
    if (current.preflightToken !== input.preflightToken) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_STALE", [{ code: "DAMAGE_PREVIEW_STALE", message: "Review current preview inputs before requesting work." }], current);
    if (!current.available) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_UNAVAILABLE", current.blockingReasons, current);
    return JSON.stringify(current);
  }));
  const replay = access.damagePreviews.replay(admission);
  if (replay) return presentDamagePreview(replay);
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
export function describeDamagePreview(access: DataAccess, record: DamagePreviewRecord) {
  const saved = (JSON.parse(record.reviewJson) as Review).reviewedRequest!.checkpoint!;
  const current = access.readConsistentSnapshot((snapshot) => reviewDamagePreviewEvidence(snapshot, record.originalDiscArchiveId, parseDamagePreviewInput(JSON.parse(record.selectionJson)), {
    id: saved.manifestId, revision: saved.manifestRevision, manifestDigest: saved.manifestDigest, publicationDigest: saved.publicationDigest!,
  }));
  const originalTitle = (JSON.parse(record.reviewJson) as Review).reviewedRequest?.title?.titleIdentityId;
  const history = access.damagePreviews.list(record.originalDiscArchiveId);
  const newerIntent = history.slice(history.findIndex((candidate) => candidate.id === record.id) + 1).filter((candidate) =>
    (JSON.parse(candidate.reviewJson) as Review).reviewedRequest?.title?.titleIdentityId === originalTitle).at(-1);
  const superseded = newerIntent !== undefined && newerIntent.preflightToken !== record.preflightToken;
  const outdated = superseded || current.preflightToken !== record.preflightToken;
  return presentDamagePreview(record, current, superseded, damagePreviewRetention(access, record, outdated));
}
export async function inspectDamagePreview(access: DataAccess, id: string, _ownership?: ArchiveImageOwnership) {
  return describeDamagePreview(access, requiredRecord(access, id));
}
export function cancelDamagePreview(access: DataAccess, id: string, mutationKey: unknown) {
  return presentDamagePreview(access.damagePreviews.cancel(id, parseMutationKey(mutationKey)));
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
    access.damagePreviews.touchMedia(record.id);
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
