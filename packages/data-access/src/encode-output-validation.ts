import type { EncodeClaimSource } from "./encode-claim-snapshot.js";
import type { EncodeJobClaimToken, EncodeJobId, EncodeOutputFilesystemIdentity } from "./types.js";

export interface EncodeOutputSourceSnapshot {
  id: EncodeJobClaimToken;
  encodeJobId: EncodeJobId;
  source: EncodeClaimSource;
  createdAt: string;
}

/** Observations from the validator, before publication. This is not a playability claim. */
export interface EncodeOutputValidationEvidence {
  policyVersion: "encode-output-validation-v1";
  duration: { expectedSeconds: number | null; minimumRatio: number | null; observedSeconds: number | null };
  video: { codec: string; profile: string; pixelFormat: string; firstPacketSeconds: number };
  audio: { firstPacketSeconds: number | null; expectedStreams: number | null; observedStreams: number | null };
  subtitles: { expectedSourceStreams: number | null; checked: true };
  decode: { seconds: number; frames: number; completed: true };
}

/** An immutable validation event. Look it up by recorded output identities, never by latest claim. */
export interface EncodeOutputValidationRecord {
  id: string;
  encodeJobId: EncodeJobId;
  claimToken: EncodeJobClaimToken;
  filesystemIdentity: EncodeOutputFilesystemIdentity;
  validatedAt: Date;
  sourceSnapshot: EncodeOutputSourceSnapshot | null;
  evidence: EncodeOutputValidationEvidence | null;
}
