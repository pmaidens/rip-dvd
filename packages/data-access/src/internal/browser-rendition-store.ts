import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MutationKeyConflictError } from "../errors.js";
import type { BrowserRenditionAccess, BrowserRenditionRecord, BrowserRenditionRequest } from "../browser-rendition.js";

const operation = "encode-output-request-rendition";
function semanticInput(input: BrowserRenditionRequest) {
  // Leave the original no-subtitle shape intact for durable replay.
  return JSON.stringify({ sourceIdentity: input.sourceIdentity, reviewToken: input.reviewToken,
    ...(input.burnSubtitleIndex === undefined ? {} : { burnSubtitleIndex: input.burnSubtitleIndex }) });
}
export function createBrowserRenditionAccess(sqlite: DatabaseSync, now: () => Date): BrowserRenditionAccess {
  function transaction<T>(task: () => T): T {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = task(); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  function decode(row: Record<string, unknown> | undefined): BrowserRenditionRecord | null {
    return row ? JSON.parse(String(row.record)) as BrowserRenditionRecord : null;
  }
  function replay(input: BrowserRenditionRequest) {
    const previous = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(input.mutationKey);
    if (!previous) return null;
    if (previous.operation !== operation || previous.semantic_input !== semanticInput(input)) throw new MutationKeyConflictError();
    return JSON.parse(String(previous.outcome)) as BrowserRenditionRecord;
  }
  function update(record: BrowserRenditionRecord) {
    record.updatedAt = now().toISOString();
    const result = sqlite.prepare("UPDATE browser_renditions SET status = ?, record = ? WHERE id = ?").run(record.status, JSON.stringify(record), record.id);
    if (result.changes !== 1) throw new Error("Browser Viewing Rendition no longer exists.");
  }
  return {
    find: (id) => decode(sqlite.prepare("SELECT record FROM browser_renditions WHERE id = ?").get(id)),
    replay,
    submit(input, prepare) {
      const replayed = replay(input);
      if (replayed) return replayed;
      // Media mounts can stall. Stage filesystem checks before SQLite's writer
      // lock; only authenticate the recorded authority inside the transaction.
      const { assertAuthority, ...prepared } = prepare();
      return transaction(() => {
        const previous = replay(input);
        if (previous) return previous;
        assertAuthority();
        const timestamp = now();
        const record: BrowserRenditionRecord = {
          ...prepared, id: randomUUID(), sourceIdentity: input.sourceIdentity, reviewToken: input.reviewToken,
          status: "queued", reason: null, progress: { percent: null }, command: [], toolVersion: null,
          media: null, durationCoverage: null, createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
        };
        sqlite.prepare("INSERT INTO browser_renditions (id, source_identity, status, record, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(record.id, record.sourceIdentity, record.status, JSON.stringify(record), timestamp.getTime());
        sqlite.prepare("INSERT INTO mutation_invocations (key, operation, semantic_input, outcome, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(input.mutationKey, operation, semanticInput(input), JSON.stringify(record), timestamp.getTime());
        return record;
      });
    },
    active: () => sqlite.prepare("SELECT record FROM browser_renditions WHERE status IN ('queued', 'generating') ORDER BY created_at, id").all().map((row) => decode(row)!),
    claim() {
      return transaction(() => {
        const record = decode(sqlite.prepare("SELECT record FROM browser_renditions WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get());
        if (record) { record.status = "generating"; update(record); }
        return record;
      });
    },
    update,
  };
}
