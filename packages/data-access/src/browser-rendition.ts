import type { EncodeOutputFilesystemIdentity } from "./types.js";

export interface BrowserRenditionRecord {
  id: string;
  sourceIdentity: string;
  sourceJson: string;
  sourceAuthorityRevision: string;
  reviewToken: string;
  status: "queued" | "generating" | "complete" | "failed" | "interrupted";
  reason: { code: string; message: string } | null;
  progress: { percent: number | null };
  conversion: {
    kind: "stream_copy_remux";
    container: "mp4";
    copiedStreamIndexes: number[];
    omittedStreamIndexes: number[];
    subtitles: "omitted" | "none";
  };
  command: string[];
  durationCoverage: { sourceSeconds: number; renditionSeconds: number | null; toleranceSeconds: number } | null;
  toolVersion: string | null;
  media: { identity: string; path: string; filesystemIdentity: EncodeOutputFilesystemIdentity; changeTimeMs: number; sizeBytes: number } | null;
  createdAt: string;
  updatedAt: string;
}
export interface BrowserRenditionRequest {
  mutationKey: string;
  sourceIdentity: string;
  reviewToken: string;
}
export interface BrowserRenditionAccess {
  find(id: string): BrowserRenditionRecord | null;
  replay(input: BrowserRenditionRequest): BrowserRenditionRecord | null;
  submit(input: BrowserRenditionRequest, prepare: () => Pick<BrowserRenditionRecord, "sourceJson" | "sourceAuthorityRevision" | "conversion">): BrowserRenditionRecord;
  active(): BrowserRenditionRecord[];
  claim(): BrowserRenditionRecord | null;
  update(record: BrowserRenditionRecord): void;
}
