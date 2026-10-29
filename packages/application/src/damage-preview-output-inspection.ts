import { RecordNotFoundError, type DataAccess, type DamagePreviewRecord, type OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { encodeOutputArtifactReferences, inspectEncodeOutputIdentity, type EncodeOutputInspectionReceipt } from "./encode-output-inspection.js";

import { previewOutputSourceProof, type FinishedOutputProofReason } from "./damage-preview-output-source.js";

const CANDIDATE_LIMIT = 100;
const OUTPUT_LIMIT = 10;
interface OutputAcknowledgement {
  artifactIdentity: string;
  generationIdentity: string | null;
  acknowledgementStatus: "acknowledged" | "not_acknowledged" | "unavailable";
  matchingReceipts: EncodeOutputInspectionReceipt[];
  reasonCode: FinishedOutputProofReason | "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED" | "FINISHED_OUTPUT_UNAVAILABLE" | null;
}
export interface DamagePreviewFinishedOutputInspection {
  state: "proved" | "unproved";
  retentionSatisfied: boolean;
  discovery: "bounded_current_catalog";
  truncated: boolean;
  outputs: OutputAcknowledgement[];
}

export function inspectDamagePreviewOutputAcknowledgements(access: DataAccess, record: DamagePreviewRecord): DamagePreviewFinishedOutputInspection | null {
  return observeDamagePreviewOutputAcknowledgements(access, record).inspection;
}

export function observeDamagePreviewOutputAcknowledgements(access: DataAccess, record: DamagePreviewRecord): { inspection: DamagePreviewFinishedOutputInspection | null; isCurrent(): boolean } {
  const authorityChecks: (() => boolean)[] = [];
  const archiveId = record.originalDiscArchiveId;
  const candidates = access.readConsistentSnapshot((snapshot) => {
    // Mutable catalog links discover candidates only. They never prove that
    // an acknowledged output represents this preview's immutable source.
    const jobs = snapshot.encodeJobs.listForOriginalDiscArchive(archiveId as OriginalDiscArchiveId, { limit: CANDIDATE_LIMIT + 1 });
    return { jobs: jobs.slice(0, CANDIDATE_LIMIT), truncated: jobs.length > CANDIDATE_LIMIT };
  });
  const references = [];
  let truncated = candidates.truncated;
  const links = access.encodeJobs.listCorrectionLinks(candidates.jobs.map((job) => job.id));
  for (const job of candidates.jobs) {
    // History presence avoids probing unacknowledged media. Only the shared
    // inspector's exact-generation receipts below can establish acknowledgement.
    if (access.encodeOutputInspectionReceipts.list(job.id, { limit: 1, offset: 0 }).receipts.length === 0) continue;
    const retained = access.encodeJobs.listRetainedOutputHistoryPage(job.id, { limit: OUTPUT_LIMIT + 1 });
    truncated ||= retained.nextOffset !== null;
    references.push(...encodeOutputArtifactReferences(job, links, retained.outputs));
  }
  if (references.length === 0 && !truncated) return { inspection: null, isCurrent: () => true };
  truncated ||= references.length > OUTPUT_LIMIT;
  const outputs: OutputAcknowledgement[] = [];
  for (const reference of references.slice(0, OUTPUT_LIMIT)) {
    try {
      const inspected = inspectEncodeOutputIdentity(access, reference.identity);
      const { generationIdentity } = inspected.operatorInspection;
      const receipts = inspected.matchingGenerationReceipts;
      const status = receipts.length > 0 ? "acknowledged" : "not_acknowledged";
      truncated ||= inspected.matchingGenerationReceiptsTruncated;
      const available = inspected.artifact.file.status === "available" && inspected.artifact.file.identityContinuity === "verified";
      const proof = receipts.map((receipt) => previewOutputSourceProof(record, receipt, inspected.artifact));
      if (available && proof.includes(null)) authorityChecks.push(inspected.isCurrent);
      outputs.push({
        artifactIdentity: inspected.artifact.identity, generationIdentity, acknowledgementStatus: available ? status : "unavailable",
        matchingReceipts: available ? receipts : [],
        reasonCode: !available ? "FINISHED_OUTPUT_UNAVAILABLE" : receipts.length === 0 ? "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED" : proof.includes(null) ? null : proof[0]!,
      });
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
      outputs.push({ artifactIdentity: reference.identity, generationIdentity: null, acknowledgementStatus: "unavailable", matchingReceipts: [], reasonCode: "FINISHED_OUTPUT_UNAVAILABLE" });
    }
  }
  const retentionSatisfied = outputs.some((output) => output.reasonCode === null);
  return { inspection: { state: retentionSatisfied ? "proved" : "unproved", retentionSatisfied, discovery: "bounded_current_catalog", truncated, outputs }, isCurrent: () => authorityChecks.every((check) => check()) };
}
