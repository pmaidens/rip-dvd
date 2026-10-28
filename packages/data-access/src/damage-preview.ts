export type DamagePreviewStatus = "queued" | "waiting_for_checkpoint_or_ownership" | "generating" | "complete" | "failed" | "cancelled" | "interrupted" | "partial";
export interface DamagePreviewArtifact {
  identity: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  mediaType: "video/x-matroska";
  coverage: { startMilliseconds: number; endMilliseconds: number };
  durationMilliseconds: number;
  coverageMethod?: "handbrake_seek_and_probed_duration";
}
export interface DamagePreviewRecord {
  id: string;
  originalDiscArchiveId: string;
  status: DamagePreviewStatus;
  preflightToken: string;
  selectionJson: string;
  reviewJson: string;
  workerId: string | null;
  cancellationRequested: boolean;
  reason: { code: string; message: string } | null;
  progress: { completedClips: number; totalClips: number; percent: number | null };
  commands: string[][];
  toolVersions: Record<string, string>;
  deviations: string[];
  artifacts: DamagePreviewArtifact[];
  createdAt: string;
  updatedAt: string;
}
export interface DamagePreviewAccess {
  find(id: string): DamagePreviewRecord | null;
  list(archiveId?: string): DamagePreviewRecord[];
  replay(input: { mutationKey: string; archiveId: string; preflightToken: string; selectionJson: string }): DamagePreviewRecord | null;
  submit(input: { mutationKey: string; archiveId: string; preflightToken: string; selectionJson: string }, prepare: () => string): DamagePreviewRecord;
  cancel(id: string, mutationKey: string): DamagePreviewRecord;
  claim(workerId: string): DamagePreviewRecord | null;
  update(record: DamagePreviewRecord): void;
}
