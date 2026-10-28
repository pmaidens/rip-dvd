import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MutationKeyConflictError, RecordNotFoundError } from "../errors.js";
import type { DamagePreviewAccess, DamagePreviewRecord } from "../damage-preview.js";

export function createDamagePreviewAccess(sqlite: DatabaseSync, now: () => Date): DamagePreviewAccess {
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
  function mutate(key: string, operation: string, input: unknown, action: () => DamagePreviewRecord) {
    return transaction(() => {
      const semantic = JSON.stringify(input);
      const previous = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(key);
      if (previous) {
        if (previous.operation !== operation || previous.semantic_input !== semantic) throw new MutationKeyConflictError();
        return JSON.parse(String(previous.outcome)) as DamagePreviewRecord;
      }
      const result = action();
      sqlite.prepare("INSERT INTO mutation_invocations (key, operation, semantic_input, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(key, operation, semantic, JSON.stringify(result), now().getTime());
      return result;
    });
  }
  return {
    find,
    replay(input) {
      const previous = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(input.mutationKey);
      if (!previous) return null;
      if (previous.operation !== "damage-preview-request" || previous.semantic_input !== JSON.stringify({ archiveId: input.archiveId, preflightToken: input.preflightToken, selectionJson: input.selectionJson })) throw new MutationKeyConflictError();
      return JSON.parse(String(previous.outcome)) as DamagePreviewRecord;
    },
    list(archiveId) {
      const rows = archiveId === undefined
        ? sqlite.prepare("SELECT record FROM damage_previews ORDER BY rowid").all()
        : sqlite.prepare("SELECT record FROM damage_previews WHERE original_disc_archive_id = ? ORDER BY rowid").all(archiveId);
      return rows.map((row) => JSON.parse(String(row.record)) as DamagePreviewRecord);
    },
    submit(input, prepare) {
      return mutate(input.mutationKey, "damage-preview-request", { archiveId: input.archiveId, preflightToken: input.preflightToken, selectionJson: input.selectionJson }, () => {
        const reviewJson = prepare();
        const review = JSON.parse(reviewJson) as { clips: unknown[] };
        const timestamp = now();
        const record: DamagePreviewRecord = {
          id: randomUUID(), originalDiscArchiveId: input.archiveId, status: "queued", preflightToken: input.preflightToken,
          selectionJson: input.selectionJson, reviewJson, workerId: null, cancellationRequested: false, reason: null,
          progress: { completedClips: 0, totalClips: review.clips.length, percent: null },
          commands: [], toolVersions: {}, deviations: [], artifacts: [], createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
        };
        sqlite.prepare("INSERT INTO damage_previews (id, original_disc_archive_id, status, record, created_at) VALUES (?, ?, ?, ?, ?)").run(record.id, input.archiveId, record.status, JSON.stringify(record), timestamp.getTime());
        return record;
      });
    },
    cancel(id, mutationKey) {
      return mutate(mutationKey, "damage-preview-cancel", { id }, () => {
        const record = find(id);
        if (!record) throw new RecordNotFoundError("Damage Preview", id);
        if (!["queued", "waiting_for_checkpoint_or_ownership", "generating"].includes(record.status)) return record;
        if (["queued", "waiting_for_checkpoint_or_ownership"].includes(record.status) && record.workerId === null) record.status = "cancelled";
        record.cancellationRequested = true;
        record.reason = { code: "CANCELLATION_REQUESTED", message: "Cancellation targets this Damage Preview request." };
        update(record);
        return record;
      });
    },
    claim(workerId) {
      return transaction(() => {
        const row = sqlite.prepare("SELECT record FROM damage_previews WHERE status = 'queued' ORDER BY rowid LIMIT 1").get();
        if (!row) return null;
        const record = JSON.parse(String(row.record)) as DamagePreviewRecord;
        record.workerId = workerId;
        record.status = "waiting_for_checkpoint_or_ownership";
        sqlite.prepare("UPDATE damage_previews SET status = ?, record = ? WHERE id = ?").run(record.status, JSON.stringify(record), record.id);
        return record;
      });
    },
    update,
  };
}
