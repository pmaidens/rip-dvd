import type { DvdTitle } from "./dvd-scan.js";
import type { DvdTitleDamageAssessmentRecord } from "./dvd-title-damage-assessment.js";
import type {
  DiscSelection, DvdTitleDamageDecision, DvdTitleIdentityObservation,
  EncodeJob, EncodeJobClaimToken, EncodeJobId, EncodeSourceDecision, EncodingProfile,
  OriginalDiscArchive,
} from "./types.js";

/** JSON evidence is self-contained, including timestamps, rather than live catalog references. */
export type EncodeClaimEvidence<T> = T extends Date ? string
  : T extends string | number | boolean | null | undefined ? T
  : T extends readonly (infer Item)[] ? readonly EncodeClaimEvidence<Item>[]
  : T extends object ? { readonly [Key in keyof T]: EncodeClaimEvidence<T[Key]> } : T;

export interface EncodeClaimSource {
  schemaVersion: 1;
  archive: Pick<OriginalDiscArchive, "id" | "archivePath" | "fingerprint">;
  checkpoint: NonNullable<EncodeSourceDecision["checkpoint"]>;
  decision: EncodeSourceDecision;
  selection: Pick<DiscSelection, "id" | "mediaItemId" | "sourceIdentity">;
  resolvedSource: Pick<DvdTitleIdentityObservation,
    "navigation" | "selectedPath" | "displayTitleNumber" | "angleNumber" | "chapterStart" | "chapterEnd">;
  title: DvdTitle;
  titleIdentity: EncodeClaimEvidence<DvdTitleIdentityObservation>;
  assessment: EncodeClaimEvidence<DvdTitleDamageAssessmentRecord>;
  acceptance: EncodeClaimEvidence<DvdTitleDamageDecision> | null;
  sourceContinuityRisk: boolean;
  profile: Pick<EncodingProfile, "id" | "key" | "version" | "settings">;
  output: {
    policyVersion: "encode-claim-output-v1";
    path: string;
    format: "av_mkv";
    preset: string;
    audioSelection: "all";
    subtitleSelection: "all";
    subtitleBurn: "none";
    dvdNavigation: "libdvdread";
    selectionArguments: readonly string[];
    audioStreams: DvdTitle["audioStreams"];
    subtitleStreams: DvdTitle["subtitles"];
    expectedDurationSeconds: number | null;
  };
}

export interface EncodeClaimSnapshot {
  id: EncodeJobClaimToken;
  encodeJobId: EncodeJobId;
  source: EncodeClaimSource;
  createdAt: Date;
}

/** Called only inside the winning immediate transaction, under prepared source ownership. */
export interface EncodeJobClaimOptions {
  jobId: EncodeJobId;
  snapshotSource(job: EncodeJob): EncodeClaimSource;
}
