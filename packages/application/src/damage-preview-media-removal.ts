import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { canonicalPublicationJson, type DataAccess, type DamagePreviewRecord, type DamagePreviewMediaRemoval } from "@rip-dvd/data-access";
import { InvalidDamagePreviewInputError } from "./damage-preview-input.js";
import { DamagePreviewRejectedError, describeDamagePreview } from "./damage-preview-operations.js";
import { DAMAGE_PREVIEW_IDLE_MS, previewGenerationActive, previewMediaFileObservation, previewMediaTargets } from "./damage-preview-media-state.js";
import { observeDamagePreviewOutputAcknowledgements } from "./damage-preview-output-inspection.js";
import { parseMutationKey } from "./mutation-key.js";

function synchronizeRemovalDirectory(directory: string) {
  let target = directory;
  try { realpathSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // If the entire request directory is absent, flush its existing parent.
    // A missing media root remains a failure, rather than proof of cleanup.
    target = dirname(directory);
  }
  if (realpathSync(target) !== target) throw new Error("Unsafe media directory");
  const handle = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
function removeFiles(record: DamagePreviewRecord): DamagePreviewMediaRemoval["outcomes"] {
  return previewMediaTargets(record).map(({ path, identity }) => {
    try {
      const directory = dirname(path);
      if (basename(directory) !== record.id || basename(dirname(directory)) !== ".damage-previews" || !/^\d+(?:\.partial)?\.mkv$/.test(basename(path))) throw new Error("Unsafe media path");
      // A missing request directory also means its media is already absent.
      if (realpathSync(directory) !== directory) throw new Error("Unsafe media directory");
      if (!lstatSync(path).isFile()) throw new Error("Unsafe media file");
      const expected = record.mediaRemoval!.expectedFiles.find((file) => file.identity === identity);
      if (!expected || expected.filesystemIdentity !== previewMediaFileObservation(path).filesystemIdentity) throw new Error("Preview media identity changed after deletion admission");
      unlinkSync(path);
      synchronizeRemovalDirectory(directory);
      return { identity, outcome: "removed" as const, reasonCode: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          synchronizeRemovalDirectory(dirname(path));
          return { identity, outcome: "already_missing" as const, reasonCode: "DAMAGE_PREVIEW_MEDIA_MISSING" };
        } catch { /* An observed absence is not complete until its directory is durable. */ }
      }
      return { identity, outcome: "failed" as const, reasonCode: "DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED" };
    }
  });
}
export function removeDamagePreviewMedia(access: DataAccess, id: string, raw: unknown, cause: DamagePreviewMediaRemoval["cause"]) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).some((key) => !["mediaToken", "mutationKey"].includes(key))) throw new InvalidDamagePreviewInputError("Invalid preview media removal input.");
  const input = raw as Record<string, unknown>;
  const mutationKey = parseMutationKey(input.mutationKey);
  if (typeof input.mediaToken !== "string" || input.mediaToken.length > 256) throw new InvalidDamagePreviewInputError("A reviewed media token is required.");
  let result: ReturnType<typeof describeDamagePreview>;
  try {
    result = access.damagePreviews.removeMedia({ id, mutationKey, mediaToken: input.mediaToken, cause }, (record) => {
      const targets = previewMediaTargets(record);
      const output = observeDamagePreviewOutputAcknowledgements(access, record);
      const originalRecord = canonicalPublicationJson(record);
      const check = (current: ReturnType<typeof describeDamagePreview>) => {
        if (current.media.token !== input.mediaToken) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_MEDIA_STALE", [{ code: "DAMAGE_PREVIEW_MEDIA_STALE", message: "Review the current preview media before removing it." }], current);
        if (!current.media.deletion.available) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_MEDIA_UNAVAILABLE", current.media.deletion.reasons, current);
        if (cause === "idle_cleanup" && !current.media.cleanup.available) throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_CLEANUP_UNAVAILABLE", current.media.cleanup.reasons, current);
      };
      check(describeDamagePreview(access, record, targets, false, output.inspection));
      return {
        expectedFiles: targets.map(({ identity, observation }) => ({ identity, filesystemIdentity: observation.filesystemIdentity })),
        assertCurrent(currentRecord) {
          if (canonicalPublicationJson(currentRecord) !== originalRecord || !output.isCurrent()) {
            throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_MEDIA_STALE", [{ code: "DAMAGE_PREVIEW_MEDIA_STALE", message: "Preview media or its retention evidence changed before deletion admission." }]);
          }
          // All filesystem observations are staged. Only database state is read
          // while the durable intent and invocation are admitted atomically.
          check(describeDamagePreview(access, currentRecord, targets, false, output.inspection));
        },
      };
    }, removeFiles, (record) => describeDamagePreview(access, record));
  } catch (error) {
    if (error instanceof DamagePreviewRejectedError && error.current === null) {
      const current = access.damagePreviews.find(id);
      throw new DamagePreviewRejectedError(error.code, error.reasons, current ? describeDamagePreview(access, current) : null);
    }
    throw error;
  }
  if (result.media.state === "removal_failed") throw new DamagePreviewRejectedError("DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED", [{ code: "DAMAGE_PREVIEW_MEDIA_REMOVAL_FAILED", message: "Some media could not be removed. Review the durable outcomes before retrying with a new key." }], result);
  return result;
}

export function cleanupDamagePreviewMedia(access: DataAccess) {
  const results = [];
  for (const record of access.damagePreviews.list()) {
    if (previewGenerationActive(record)) continue;
    if (record.mediaRemoval?.state === "complete" || record.mediaRemoval?.state === "failed") continue;
    const pending = record.mediaRemoval?.state === "pending" ? record.mediaRemoval : null;
    if (!pending && record.artifacts.length === 0 && record.commands.length === 0) continue;
    if (!pending && Date.parse(record.mediaLastAccessedAt ?? record.updatedAt) + DAMAGE_PREVIEW_IDLE_MS > Date.now()) continue;
    const current = pending ? null : describeDamagePreview(access, record);
    if (!pending && !current!.media.cleanup.available) continue;
    try {
      results.push(removeDamagePreviewMedia(access, record.id, {
        mediaToken: pending?.mediaToken ?? current!.media.token,
        mutationKey: pending?.mutationKey ?? `preview-cleanup:${record.id}:${current!.media.token.slice(-64)}`,
      }, pending?.cause ?? "idle_cleanup"));
    } catch (error) {
      if (!(error instanceof DamagePreviewRejectedError)) throw error;
      // A concurrent access or explicit deletion wins over this cleanup pass.
    }
  }
  return results;
}
