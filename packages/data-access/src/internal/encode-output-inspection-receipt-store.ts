import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MutationKeyConflictError } from "../errors.js";
import type { EncodeOutputInspectionReceiptId } from "../types.js";
import type {
  EncodeOutputInspectionAcknowledgement,
  EncodeOutputInspectionReceiptAccess,
  EncodeOutputInspectionReceiptRecord,
} from "../encode-output-inspection-receipt.js";

const operation = "acknowledge-encode-output-inspection";

export function createEncodeOutputInspectionReceiptAccess(
  sqlite: DatabaseSync,
  now: () => Date,
): EncodeOutputInspectionReceiptAccess {
  function semanticInput(input: EncodeOutputInspectionAcknowledgement): string {
    return JSON.stringify({
      artifactIdentity: input.artifactIdentity,
      reviewToken: input.reviewToken,
      acknowledged: input.acknowledged,
    });
  }

  function replay(input: EncodeOutputInspectionAcknowledgement) {
    const previous = sqlite.prepare(
      "SELECT operation, semantic_input, outcome FROM mutation_invocations WHERE key = ?",
    ).get(input.mutationKey);
    if (!previous) return null;
    if (previous.operation !== operation || previous.semantic_input !== semanticInput(input)) {
      throw new MutationKeyConflictError();
    }
    return JSON.parse(String(previous.outcome)) as EncodeOutputInspectionReceiptRecord;
  }

  return {
    replay,
    record(input, prepare) {
      const previous = replay(input);
      if (previous !== null) return previous;
      // Stage all media-filesystem evidence before taking SQLite's writer lock.
      const { assertAuthority, ...prepared } = prepare();
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        let receipt = replay(input);
        if (receipt === null) {
          assertAuthority();
          const timestamp = now();
          receipt = {
            ...prepared,
            id: randomUUID() as EncodeOutputInspectionReceiptId,
            artifactIdentity: input.artifactIdentity,
            reviewToken: input.reviewToken,
            acknowledgedAt: timestamp.toISOString(),
          };
          const outcome = JSON.stringify(receipt);
          sqlite.prepare(`INSERT INTO encode_output_inspection_receipts
            (id, encode_job_id, generation_identity, record, created_at)
            VALUES (?, ?, ?, ?, ?)`).run(
            receipt.id, receipt.encodeJobId, receipt.generationIdentity, outcome, timestamp.getTime(),
          );
          sqlite.prepare(`INSERT INTO mutation_invocations
            (key, operation, semantic_input, outcome, created_at) VALUES (?, ?, ?, ?, ?)`).run(
            input.mutationKey, operation, semanticInput(input), outcome, timestamp.getTime(),
          );
        }
        sqlite.exec("COMMIT");
        return receipt;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    list(encodeJobId, page) {
      const limit = Math.max(1, Math.min(100, Math.floor(page.limit)));
      const offset = Math.max(0, Math.floor(page.offset));
      const receipts = sqlite.prepare(`SELECT record FROM encode_output_inspection_receipts
        WHERE encode_job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(encodeJobId, limit + 1, offset)
        .map((row) => JSON.parse(String(row.record)) as EncodeOutputInspectionReceiptRecord);
      return { receipts: receipts.slice(0, limit), nextOffset: receipts.length > limit ? offset + limit : null };
    },
    latestForGeneration(encodeJobId, generationIdentity) {
      const row = sqlite.prepare(`SELECT record FROM encode_output_inspection_receipts
        WHERE encode_job_id = ? AND generation_identity = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(encodeJobId, generationIdentity);
      return row ? JSON.parse(String(row.record)) as EncodeOutputInspectionReceiptRecord : null;
    },
  };
}
