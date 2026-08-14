import { createHash } from "node:crypto";

import type { DvdTitle } from "./dvd-scan.js";

const DVD_METADATA_FINGERPRINT_DOMAIN = "rip-dvd-metadata-v1\0";

export interface DvdMetadataFingerprintInput {
  sizeBytes: number;
  titles: readonly DvdTitle[];
  volumeLabel?: string;
}

export function createDvdMetadataFingerprint({
  sizeBytes,
  titles,
  volumeLabel,
}: DvdMetadataFingerprintInput): string {
  const identity = {
    sizeBytes,
    titles: [...titles]
      .sort((left, right) => left.number - right.number)
      .map((title) => ({
        number: title.number,
        durationSeconds: title.durationSeconds,
        chapters: title.chapters,
        audioStreams: [...title.audioStreams]
          .sort((left, right) => left.id - right.id)
          .map((stream) => ({
            id: stream.id,
            languageCode: stream.languageCode ?? null,
            language: stream.language ?? null,
            format: stream.format ?? null,
            channels: stream.channels ?? null,
          })),
        subtitles: [...title.subtitles]
          .sort((left, right) => left.id - right.id)
          .map((stream) => ({
            id: stream.id,
            languageCode: stream.languageCode ?? null,
            language: stream.language ?? null,
            content: stream.content ?? null,
          })),
      })),
    volumeLabel: volumeLabel?.trim() ?? "",
  };
  const digest = createHash("sha256")
    .update(DVD_METADATA_FINGERPRINT_DOMAIN)
    .update(JSON.stringify(identity))
    .digest("hex");
  return `dvdmeta-sha256:${digest}`;
}
