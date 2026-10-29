import type { EncodeJobId } from "./types.js";

export interface EncodeOutputKeepInput {
  mutationKey: string;
  artifactIdentity: string;
  validationIdentity: string;
  previewToken: string;
  acknowledged: true;
}

export interface KeptFailedEncodeOutput {
  id: string;
  artifactIdentity: string;
  validationIdentity: string;
  previewToken: string;
  encodeJobId: EncodeJobId;
  evidenceJson: string;
  keptAt: string;
}

export interface EncodeOutputKeepAccess {
  replay(input: EncodeOutputKeepInput): KeptFailedEncodeOutput | null;
  record(input: EncodeOutputKeepInput, prepare: () => Pick<KeptFailedEncodeOutput, "encodeJobId" | "evidenceJson"> & {
    /** Database-only check. Stage media filesystem evidence in prepare. */
    assertAuthority(): void;
  }): KeptFailedEncodeOutput;
  latest(artifactIdentity: string): KeptFailedEncodeOutput | null;
}
