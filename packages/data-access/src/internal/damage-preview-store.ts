import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { damagePreviews } from "./schema.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MutationKeyConflictError, RecordNotFoundError } from "../errors.js";
import type { DamagePreviewAccess, DamagePreviewRecord, DamagePreviewAdmission } from "../damage-preview.js";

// Shared by the recovery admission transaction and the preview store.
export const damagePreviewHoldsRecovery = sql`${damagePreviews.status} IN ('queued', 'waiting_for_checkpoint_or_ownership', 'generating') AND coalesce(json_extract(${damagePreviews.record}, '$.sourceReleased'), 0) = 0`;

export function createDamagePreviewAccess(sqlite: DatabaseSync, now: () => Date): DamagePreviewAccess {
  const database = drizzle({ client: sqlite });
  function transaction<T>(action: () => T): T {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = action(); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  function find(id: string): DamagePreviewRecord | null {
    const row = sqlite.prepare("SELECT record FROM damage_previews WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.record)) as DamagePreviewRecord : null;
  }
  function update(record: DamagePreviewRecord) {
    const payload = JSON.stringify({ ...record, updatedAt: now().toISOString() });
    const updated = sqlite.prepare(`UPDATE damage_previews
      SET status = ?, record = json_set(?, '$.cancellationRequested',
        json(CASE WHEN json_extract(record, '$.cancellationRequested') OR json_extract(?, '$.cancellationRequested') THEN 'true' ELSE 'false' END))
      WHERE id = ? AND json_extract(record, '$.workerId') IS ? RETURNING record`).get(record.status, payload, payload, record.id, record.workerId);
    if (!updated) throw new Error("Damage Preview worker identity changed.");
    Object.assign(record, JSON.parse(String(updated.record)) as DamagePreviewRecord);
  }
  function mutate<T extends DamagePreviewRecord>(key: string, operation: string, input: unknown, action: () => T) {
    return transaction(() => {
      const semantic = JSON.stringify(input);
      const previous = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(key);
      if (previous) {
        if (previous.operation !== operation || previous.semantic_input !== semantic) throw new MutationKeyConflictError();
        return JSON.parse(String(previous.outcome)) as T;
      }
      const result = action();
      sqlite.prepare("INSERT INTO mutation_invocations (key, operation, semantic_input, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(key, operation, semantic, JSON.stringify(result), now().getTime());
      return result;
    });
  }
  function cancel(id: string, mutationKey: string): DamagePreviewRecord;
  function cancel<T>(id: string, mutationKey: string, present: (record: DamagePreviewRecord) => T): T;
  function cancel<T>(id: string, mutationKey: string, present?: (record: DamagePreviewRecord) => T): T | DamagePreviewRecord {
    type CancellationReceipt = DamagePreviewRecord & { cancellationResult?: T };
    const receipt = mutate<CancellationReceipt>(mutationKey, "damage-preview-cancel", { id }, () => {
      const record = find(id);
      if (!record) throw new RecordNotFoundError("Damage Preview", id);
      if (["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status)) {
        if (["queued", "waiting_for_checkpoint_or_ownership"].includes(record.status) && record.workerId === null) record.status = "cancelled";
        record.cancellationRequested = true;
        record.reason = { code: "CANCELLATION_REQUESTED", message: "Cancellation targets this Damage Preview request." };
        update(record);
      }
      return record;
    });
    if (!present) return receipt;
    if (Object.hasOwn(receipt, "cancellationResult")) return receipt.cancellationResult!;
    // Project media outside the writer transaction, then save the first
    // response once. Historical receipts use the same upgrade path.
    const result = present(receipt);
    return transaction(() => {
      const current = JSON.parse(String(sqlite.prepare("SELECT outcome FROM mutation_invocations WHERE key = ?").get(mutationKey)!.outcome)) as CancellationReceipt;
      if (Object.hasOwn(current, "cancellationResult")) return current.cancellationResult!;
      sqlite.prepare("UPDATE mutation_invocations SET outcome = ? WHERE key = ?").run(JSON.stringify({ ...current, cancellationResult: result }), mutationKey);
      return result;
    });
  }

  const operation = (input: DamagePreviewAdmission) => input.recreation ? "damage-preview-recreate" : "damage-preview-request";
  const semantic = (input: DamagePreviewAdmission) => ({ archiveId: input.archiveId, preflightToken: input.preflightToken, selectionJson: input.selectionJson, ...(input.recreation ? { recreation: input.recreation } : {}) });
  return {
    find,
    pendingForRecovery(archiveId) {
      const row = database.select({ record: damagePreviews.record }).from(damagePreviews).where(and(
        eq(damagePreviews.originalDiscArchiveId, archiveId), damagePreviewHoldsRecovery,
      )).orderBy(damagePreviews.createdAt, damagePreviews.id).limit(1).get();
      return row ? JSON.parse(row.record) as DamagePreviewRecord : null;
    },
    replay(input) {
      const previous = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(input.mutationKey);
      if (!previous) return null;
      if (previous.operation !== operation(input) || previous.semantic_input !== JSON.stringify(semantic(input))) throw new MutationKeyConflictError();
      return JSON.parse(String(previous.outcome)) as DamagePreviewRecord;
    },
    list(archiveId) {
      const rows = archiveId === undefined
        ? sqlite.prepare("SELECT record FROM damage_previews ORDER BY rowid").all()
        : sqlite.prepare("SELECT record FROM damage_previews WHERE original_disc_archive_id = ? ORDER BY rowid").all(archiveId);
      return rows.map((row) => JSON.parse(String(row.record)) as DamagePreviewRecord);
    },
    submit(input, prepare) {
      return mutate(input.mutationKey, operation(input), semantic(input), () => {
        const { reviewJson, recreation } = prepare();
        const review = JSON.parse(reviewJson) as { clips: unknown[]; current: { checkpointVerified: boolean } };
        const timestamp = now();
        const record: DamagePreviewRecord = {
          id: randomUUID(), originalDiscArchiveId: input.archiveId, status: review.current.checkpointVerified ? "queued" : "waiting_for_checkpoint_or_ownership", preflightToken: input.preflightToken,
          ...(recreation ? { recreation } : {}),
          selectionJson: input.selectionJson, reviewJson, workerId: null, cancellationRequested: false,
          reason: review.current.checkpointVerified ? null : { code: "DAMAGE_PREVIEW_WAITING_FOR_CHECKPOINT", message: "The request is waiting for Recovery to settle and for verification of its reviewed checkpoint under image ownership." },
          progress: { completedClips: 0, totalClips: review.clips.length, percent: null },
          commands: [], streamMapping: null, toolVersions: {}, deviations: [], artifacts: [], createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
        };
        sqlite.prepare("INSERT INTO damage_previews (id, original_disc_archive_id, status, record, created_at) VALUES (?, ?, ?, ?, ?)").run(record.id, input.archiveId, record.status, JSON.stringify(record), timestamp.getTime());
        return record;
      });
    },
    cancel,
    claim(workerId) {
      return transaction(() => {
        const row = sqlite.prepare("SELECT record FROM damage_previews WHERE status = 'queued' OR (status = 'waiting_for_checkpoint_or_ownership' AND json_extract(record, '$.workerId') IS NULL) ORDER BY rowid LIMIT 1").get();
        if (!row) return null;
        const record = JSON.parse(String(row.record)) as DamagePreviewRecord;
        record.workerId = workerId;
        record.status = "waiting_for_checkpoint_or_ownership";
        sqlite.prepare("UPDATE damage_previews SET status = ?, record = ? WHERE id = ?").run(record.status, JSON.stringify(record), record.id);
        return record;
      });
    },
    update,
    touchMedia(id, artifactIdentity) {
      return sqlite.prepare(`UPDATE damage_previews SET record = json_set(record, '$.mediaLastAccessedAt', ?) WHERE id = ? AND (
        json_extract(record, '$.mediaRemoval') IS NULL OR json_extract(record, '$.mediaRemoval.state') = 'cancelled' OR (
          json_extract(record, '$.mediaRemoval.state') = 'failed' AND json_extract(record, '$.mediaRemoval.cause') = 'idle_cleanup' AND
          EXISTS (SELECT 1 FROM json_each(json_extract(record, '$.mediaRemoval.outcomes'))
            WHERE json_extract(value, '$.identity') = ? AND json_extract(value, '$.outcome') = 'retained')
        )) RETURNING id`).get(now().toISOString(), id, artifactIdentity ?? null) !== undefined;
    },
    requestMediaRemoval<T>(input: Parameters<DamagePreviewAccess["requestMediaRemoval"]>[0], prepare: Parameters<DamagePreviewAccess["requestMediaRemoval"]>[1], present: (record: DamagePreviewRecord) => T): T {
      const operation = `damage-preview-${input.cause}`;
      const semantic = JSON.stringify({ id: input.id, mediaToken: input.mediaToken });
      type Receipt = { record: DamagePreviewRecord; result?: T };
      const previousReceipt = (): Receipt | null => {
        const previous = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(input.mutationKey);
        if (!previous) return null;
        if (previous.operation !== operation || previous.semantic_input !== semantic) throw new MutationKeyConflictError();
        return JSON.parse(String(previous.outcome)) as Receipt;
      };
      const admit = (): Receipt => {
        const previous = previousReceipt();
        if (previous) return previous;
        const observed = find(input.id);
        if (!observed) throw new RecordNotFoundError("Damage Preview", input.id);
        let prepared: ReturnType<typeof prepare>;
        try { prepared = prepare(observed); }
        catch (error) {
          // A same-input winner takes precedence over stale observations from
          // a slower caller that prepared outside the writer transaction.
          const winner = previousReceipt();
          if (winner) return winner;
          throw error;
        }
        return transaction(() => {
          const winner = previousReceipt();
          if (winner) return winner;
          const record = find(input.id);
          if (!record) throw new RecordNotFoundError("Damage Preview", input.id);
          prepared.assertCurrent(record);
          record.mediaLastAccessedAt ??= record.updatedAt;
          if (record.mediaRemoval) record.mediaRemovalHistory = [...record.mediaRemovalHistory ?? [], record.mediaRemoval];
          record.mediaRemoval = { requestId: randomUUID(), mutationKey: input.mutationKey, mediaToken: input.mediaToken, cause: input.cause, state: "pending", startedAt: now().toISOString(), completedAt: null, expectedFiles: prepared.expectedFiles, outcomes: [] };
          update(record);
          const receipt: Receipt = { record };
          sqlite.prepare("INSERT INTO mutation_invocations (key, operation, semantic_input, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(input.mutationKey, operation, semantic, JSON.stringify(receipt), now().getTime());
          return receipt;
        });
      };
      const pending = admit();
      if (Object.hasOwn(pending, "result")) return pending.result!;
      // The first response records acceptance, not filesystem completion.
      // Worker settlement never rewrites this mutation's replay result.
      let result: T;
      try { result = present(pending.record); }
      catch (error) {
        const winner = previousReceipt()!;
        if (Object.hasOwn(winner, "result")) return winner.result!;
        throw error;
      }
      return transaction(() => {
        const previous = previousReceipt()!;
        if (Object.hasOwn(previous, "result")) return previous.result!;
        sqlite.prepare("UPDATE mutation_invocations SET outcome = ? WHERE key = ?").run(JSON.stringify({ ...previous, result }), input.mutationKey);
        return result;
      });
    },
    completeMediaRemoval(id, requestId, remove) {
      const observed = find(id);
      if (!observed || observed.mediaRemoval?.requestId !== requestId || observed.mediaRemoval.state !== "pending") return observed;
      // Only the writable worker supplies this callback. A crash leaves the
      // admitted request pending so another worker can resume the same intent.
      const outcomes = remove(observed);
      return transaction(() => {
        const current = find(id);
        if (!current || current.mediaRemoval?.requestId !== requestId || current.mediaRemoval.state !== "pending") return current;
        current.mediaRemoval = { ...current.mediaRemoval, state: outcomes.some((item) => item.outcome === "failed") ? "failed" : outcomes.some((item) => item.outcome === "retained") ? "cancelled" : "complete", completedAt: now().toISOString(), outcomes };
        update(current);
        return current;
      });
    },
  };
}
