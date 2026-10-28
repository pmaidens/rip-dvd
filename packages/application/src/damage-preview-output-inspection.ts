import { RecordNotFoundError, type DataAccess, type OriginalDiscArchiveId } from "@rip-dvd/data-access";
import { encodeOutputArtifactReferences, inspectEncodeOutput, type EncodeOutputInspectionReceipt, type EncodeOutputMediaProbe } from "./encode-output-inspection.js";

const CANDIDATE_LIMIT = 100;
const OUTPUT_LIMIT = 10;
interface OutputAcknowledgement {
  artifactIdentity: string;
  generationIdentity: string | null;
  acknowledgementStatus: "acknowledged" | "not_acknowledged" | "unavailable";
  matchingReceipts: EncodeOutputInspectionReceipt[];
  reasonCode: "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED" | "FINISHED_OUTPUT_SOURCE_NOT_RECORDED" | "FINISHED_OUTPUT_UNAVAILABLE";
}
export interface DamagePreviewFinishedOutputInspection {
  state: "unproved";
  retentionSatisfied: false;
  discovery: "bounded_current_catalog";
  truncated: boolean;
  outputs: OutputAcknowledgement[];
}

export async function inspectDamagePreviewOutputAcknowledgements(access: DataAccess, archiveId: string, mediaProbe?: EncodeOutputMediaProbe): Promise<DamagePreviewFinishedOutputInspection | null> {
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
  if (references.length === 0 && !truncated) return null;
  truncated ||= references.length > OUTPUT_LIMIT;
  const outputs: OutputAcknowledgement[] = [];
  for (const reference of references.slice(0, OUTPUT_LIMIT)) {
    try {
      const inspected = await inspectEncodeOutput(access, reference.identity, mediaProbe, { receiptLimit: 1 });
      const { generationIdentity, status, receipts } = inspected.operatorInspection;
      const available = inspected.artifact.file.status === "available" && inspected.artifact.file.identityContinuity === "verified";
      outputs.push({
        artifactIdentity: inspected.artifact.identity, generationIdentity, acknowledgementStatus: available ? status : "unavailable",
        matchingReceipts: available ? receipts : [],
        // The current producer records no immutable source snapshot. Never
        // enrich a receipt from today's catalog, title, streams or profile.
        reasonCode: !available ? "FINISHED_OUTPUT_UNAVAILABLE" : receipts.length > 0 ? "FINISHED_OUTPUT_SOURCE_NOT_RECORDED" : "FINISHED_OUTPUT_INSPECTION_NOT_RECORDED",
      });
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
      outputs.push({ artifactIdentity: reference.identity, generationIdentity: null, acknowledgementStatus: "unavailable", matchingReceipts: [], reasonCode: "FINISHED_OUTPUT_UNAVAILABLE" });
    }
  }
  // Source equivalence and release remain unavailable until their producer
  // supplies generation-bound proof. A receipt alone never releases retention.
  return { state: "unproved", retentionSatisfied: false, discovery: "bounded_current_catalog", truncated, outputs };
}
