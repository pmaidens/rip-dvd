import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MutationKeyConflictError } from "../errors.js";
import type { EncodeOutputKeepAccess, EncodeOutputKeepInput, KeptFailedEncodeOutput } from "../encode-output-keep.js";

const operation = "keep-failed-encode-output";

export function createEncodeOutputKeepAccess(sqlite: DatabaseSync, now: () => Date): EncodeOutputKeepAccess {
  const semanticInput = ({ artifactIdentity, validationIdentity, previewToken, acknowledged }: EncodeOutputKeepInput) =>
    JSON.stringify({ artifactIdentity, validationIdentity, previewToken, acknowledged });
  function replay(input: EncodeOutputKeepInput) {
    const row = sqlite.prepare("SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?").get(input.mutationKey);
    if (!row) return null;
    if (row.operation !== operation || row.semantic_input !== semanticInput(input)) throw new MutationKeyConflictError();
    return JSON.parse(String(row.outcome)) as KeptFailedEncodeOutput;
  }
  return {
    replay,
    record(input, prepare) {
      const previous = replay(input);
      if (previous !== null) return previous;
      // Media mounts may stall. Keep every filesystem check outside the writer lock.
      const { assertAuthority, ...prepared } = prepare();
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        let kept = replay(input);
        if (kept === null) {
          assertAuthority();
          const timestamp = now();
          kept = { ...prepared, id: randomUUID(), artifactIdentity: input.artifactIdentity,
            validationIdentity: input.validationIdentity, previewToken: input.previewToken, keptAt: timestamp.toISOString() };
          const outcome = JSON.stringify(kept);
          sqlite.prepare(`INSERT INTO kept_failed_encode_outputs (id, artifact_identity, failed_output_id, record, created_at)
            VALUES (?, ?, ?, ?, ?)`).run(kept.id, input.artifactIdentity, input.validationIdentity, outcome, timestamp.getTime());
          sqlite.prepare(`INSERT INTO mutation_invocations (key, operation, semantic_input, outcome, created_at)
            VALUES (?, ?, ?, ?, ?)`).run(input.mutationKey, operation, semanticInput(input), outcome, timestamp.getTime());
        }
        sqlite.exec("COMMIT");
        return kept;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    latest(artifactIdentity) {
      const row = sqlite.prepare(`SELECT record FROM kept_failed_encode_outputs WHERE artifact_identity = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(artifactIdentity);
      return row ? JSON.parse(String(row.record)) as KeptFailedEncodeOutput : null;
    },
  };
}
