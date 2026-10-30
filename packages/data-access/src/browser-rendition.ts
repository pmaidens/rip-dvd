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
    kind: "stream_copy_remux" | "h264_aac_transcode" | "undetermined";
    container: "mp4";
    copiedStreamIndexes: number[] | null;
    omittedStreamIndexes: number[] | null;
    subtitles: "omitted" | "none" | "unknown" | "burned_in";
    // Optional only for retained records created before conversion support.
    containerDifferences?: string[];
    streams?: { sourceIndex: number; outputIndex: number; kind: "video" | "audio"; sourceCodec: string | null; codec: string; mode: "copy" | "transcode"; language: string | null; title: string | null; default: boolean | null; forced: boolean | null; differences: string[] }[] | null;
    burnedSubtitle?: { sourceIndex: number; subtitleOrdinal: number; codecName: string; language: string | null; title: string | null; forced: boolean | null } | null;
  };
  command: string[];
  mediaProbeJson?: string | null;
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
  burnSubtitleIndex?: number;
}
export interface BrowserRenditionAccess {
  find(id: string): BrowserRenditionRecord | null;
  replay(input: BrowserRenditionRequest): BrowserRenditionRecord | null;
  submit(input: BrowserRenditionRequest, prepare: () => Pick<BrowserRenditionRecord, "sourceJson" | "sourceAuthorityRevision" | "conversion"> & { assertAuthority(): void }): BrowserRenditionRecord;
  active(): BrowserRenditionRecord[];
  claim(): BrowserRenditionRecord | null;
  update(record: BrowserRenditionRecord): void;
}
