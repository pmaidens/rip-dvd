import type { EncodeJobId, EncodeOutputInspectionReceiptId } from "./types.js";

export interface EncodeOutputInspectionReceiptRecord {
  id: EncodeOutputInspectionReceiptId;
  artifactIdentity: string;
  generationIdentity: string;
  encodeJobId: EncodeJobId;
  reviewToken: string;
  evidenceJson: string;
  acknowledgedAt: string;
}

export interface EncodeOutputInspectionAcknowledgement {
  mutationKey: string;
  artifactIdentity: string;
  reviewToken: string;
  acknowledged: true;
}

export interface EncodeOutputInspectionReceiptAccess {
  replay(input: EncodeOutputInspectionAcknowledgement): EncodeOutputInspectionReceiptRecord | null;
  record(
    input: EncodeOutputInspectionAcknowledgement,
    prepare: () => Pick<EncodeOutputInspectionReceiptRecord, "generationIdentity" | "encodeJobId" | "evidenceJson"> & {
      /** Database-only recheck. Media filesystem work belongs in prepare. */
      assertAuthority(): void;
    },
  ): EncodeOutputInspectionReceiptRecord;
  list(encodeJobId: EncodeJobId, page: { limit: number; offset: number }): {
    receipts: EncodeOutputInspectionReceiptRecord[];
    nextOffset: number | null;
  };
  latestForGeneration(encodeJobId: EncodeJobId, generationIdentity: string): EncodeOutputInspectionReceiptRecord | null;
}
