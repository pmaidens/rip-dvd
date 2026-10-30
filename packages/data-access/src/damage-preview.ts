export type DamagePreviewStatus = "queued" | "waiting_for_checkpoint_or_ownership" | "generating" | "complete" | "failed" | "cancelled" | "interrupted" | "partial";
export interface DamagePreviewArtifact {
  identity: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  mediaType: "video/x-matroska";
  coverage: { startMilliseconds: number; endMilliseconds: number };
  durationMilliseconds: number;
  coverageMethod?: "handbrake_seek_and_probed_video_packets";
}
export interface DamagePreviewResolvedAudio {
  sourceId: number; physicalId: number; trackNumber: number; codec: string; channels: number;
}
export interface DamagePreviewResolvedSubtitle {
  sourceId: number; physicalId: number; trackNumber: number; style: string;
}
export interface DamagePreviewStreamMapping {
  policyVersion: "dvd-preview-stream-map-v1";
  audio: DamagePreviewResolvedAudio[];
  subtitles: DamagePreviewResolvedSubtitle[];
}
export interface DamagePreviewMediaRemoval {
  requestId: string;
  mutationKey: string;
  mediaToken: string;
  cause: "explicit_deletion" | "idle_cleanup";
  state: "pending" | "complete" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  expectedFiles: { identity: string; filesystemIdentity: string | null }[];
  outcomes: { identity: string; outcome: "removed" | "already_missing" | "failed" | "retained"; reasonCode: string | null }[];
}
export interface DamagePreviewRecreationDifference { field: string; before: unknown; after: unknown }
export interface DamagePreviewRecreation {
  sourceRequestId: string;
  mode: "exact" | "current_revision";
  differences: DamagePreviewRecreationDifference[];
  originalToolVersions: Record<string, string>;
  originalStreamMapping: DamagePreviewStreamMapping | null;
  originalDeviations: string[];
}
export interface DamagePreviewAdmission {
  mutationKey: string; archiveId: string; preflightToken: string; selectionJson: string;
  recreation?: { sourceRequestId: string; mode: "exact" | "current_revision"; recreationToken: string };
}
export interface DamagePreviewRecord {
  id: string;
  originalDiscArchiveId: string;
  status: DamagePreviewStatus;
  preflightToken: string;
  selectionJson: string;
  reviewJson: string;
  recreation?: DamagePreviewRecreation;
  workerId: string | null;
  cancellationRequested: boolean;
  /** True only after all admitted source readers have closed. Old records hold until terminal. */
  sourceReleased?: boolean;
  checkpointVerified?: boolean;
  reason: { code: string; message: string } | null;
  progress: { completedClips: number; totalClips: number; percent: number | null };
  commands: string[][];
  streamMapping: DamagePreviewStreamMapping | null;
  toolVersions: Record<string, string>;
  deviations: string[];
  artifacts: DamagePreviewArtifact[];
  // Optional for requests written before media retention was introduced.
  mediaLastAccessedAt?: string;
  mediaRemoval?: DamagePreviewMediaRemoval;
  mediaRemovalHistory?: DamagePreviewMediaRemoval[];
  createdAt: string;
  updatedAt: string;
}
export interface DamagePreviewAccess {
  find(id: string): DamagePreviewRecord | null;
  pendingForRecovery(archiveId: string): DamagePreviewRecord | null;
  list(archiveId?: string): DamagePreviewRecord[];
  replay(input: DamagePreviewAdmission): DamagePreviewRecord | null;
  submit(input: DamagePreviewAdmission, prepare: () => { reviewJson: string; recreation?: DamagePreviewRecreation }): DamagePreviewRecord;
  cancel(id: string, mutationKey: string): DamagePreviewRecord;
  cancel<T>(id: string, mutationKey: string, present: (record: DamagePreviewRecord) => T): T;
  claim(workerId: string): DamagePreviewRecord | null;
  update(record: DamagePreviewRecord): void;
  touchMedia(id: string, artifactIdentity?: string): boolean;
  requestMediaRemoval<T>(input: { id: string; mutationKey: string; mediaToken: string; cause: DamagePreviewMediaRemoval["cause"] },
    prepare: (record: DamagePreviewRecord) => {
      expectedFiles: DamagePreviewMediaRemoval["expectedFiles"];
      /** Database-only recheck inside deletion admission. */
      assertCurrent(record: DamagePreviewRecord): void;
    },
    present: (record: DamagePreviewRecord) => T): T;
  completeMediaRemoval(id: string, requestId: string, remove: (record: DamagePreviewRecord) => DamagePreviewMediaRemoval["outcomes"]): DamagePreviewRecord | null;
}
