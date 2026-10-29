import type { EncodeClaimSource } from "./encode-claim-snapshot.js";
import type { EncodeJobClaimToken, EncodeJobId, EncodeOutputFilesystemIdentity, ValidationFailedEncodeOutputId } from "./types.js";

export interface EncodeOutputVideoFingerprint {
  frameCount: number;
  width: number;
  height: number;
  pixelFormat: "yuv420p";
  sequenceSha256: string;
}

export interface EncodeOutputCellVideoMeasurement extends EncodeOutputVideoFingerprint {
  timeBase: { numerator: number; denominator: number };
  firstPts: number;
  endPts: number;
}

/** Produced under source ownership, then bound to the exact validated file. */
export type EncodeOutputCellCorrespondence = {
  policyVersion: "encode-output-exact-cell-video-v1";
} & ({
  status: "unknown";
  reasonCode: "OUTPUT_CELL_UNSUPPORTED" | "OUTPUT_MEASUREMENT_FAILED" | "OUTPUT_CONTENT_UNRESOLVED" | "OUTPUT_CONTENT_AMBIGUOUS";
} | {
  status: "measured";
  claimSnapshotId: EncodeJobClaimToken;
  assessmentIdentity: string;
  titleIdentityObservationId: string;
  checkpoint: EncodeClaimSource["checkpoint"];
  resolvedSource: EncodeClaimSource["resolvedSource"];
  sourceRange: { startLba: number; sectorCount: number };
  sourceBytesSha256: string;
  sourceVideo: EncodeOutputVideoFingerprint;
  outputFileIdentity: EncodeOutputFilesystemIdentity;
  outputBytesSha256: string;
  outputVideo: EncodeOutputCellVideoMeasurement;
  outputTimelineOriginSeconds: number;
  outputInterval: { startMilliseconds: number; endMilliseconds: number };
});

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
  audio: { firstPacketSeconds: number | null; expectedSourceIds: readonly number[] | null;
    outputSourceIds: readonly number[] | null; observedStreams: number | null; firstPacketsSeconds: readonly number[] | null };
  subtitles: { expectedSourceStreams: number | null; checked: true };
  decode: { seconds: number; frames: number; completed: true };
  correspondence?: EncodeOutputCellCorrespondence;
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

/** A completed write that failed media validation, separate from normal generations. */
export interface ValidationFailedEncodeOutput extends Omit<EncodeOutputValidationRecord, "evidence"> {
  id: ValidationFailedEncodeOutputId;
  outputPath: string;
  changeTimeMs: number;
  failure: import("./types.js").EncodeJobFailureReportInput;
}

/** Artifact discovery never loads media paths or full failure/source evidence. */
export type ValidationFailedEncodeOutputSummary = Pick<ValidationFailedEncodeOutput, "id" | "encodeJobId">;

export interface ValidationFailedEncodeOutputInput {
  outputPath: string;
  filesystemIdentity: EncodeOutputFilesystemIdentity;
  changeTimeMs: number;
  failure: import("./types.js").EncodeJobFailureReportInput;
}
