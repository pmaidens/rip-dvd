import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

function canonicalizeDvdTitles(titles: DvdTitleMap["titles"]): string {
  return JSON.stringify(
    [...titles]
      .sort((left, right) => left.number - right.number)
      .map((title) => ({
        audioStreams: title.audioStreams.map((stream) => ({
          channels: stream.channels,
          format: stream.format,
          id: stream.id,
          language: stream.language,
          languageCode: stream.languageCode,
        })),
        chapters: title.chapters,
        durationSeconds: title.durationSeconds,
        number: title.number,
        subtitles: title.subtitles.map((stream) => ({
          content: stream.content,
          id: stream.id,
          language: stream.language,
          languageCode: stream.languageCode,
        })),
      })),
  );
}

export function dvdTitleMapsAgree(
  expected: DvdTitleMap,
  observedTitles: DvdTitleMap["titles"],
): boolean {
  return canonicalizeDvdTitles(observedTitles) ===
    canonicalizeDvdTitles(expected.titles);
}
