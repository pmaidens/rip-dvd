export interface EncodeOutputInspectionReceiptRecord {
  id: string;
  artifactIdentity: string;
  generationIdentity: string;
  encodeJobId: string;
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
    prepare: () => Pick<EncodeOutputInspectionReceiptRecord, "generationIdentity" | "encodeJobId" | "evidenceJson">,
  ): EncodeOutputInspectionReceiptRecord;
  list(encodeJobId: string): EncodeOutputInspectionReceiptRecord[];
}
