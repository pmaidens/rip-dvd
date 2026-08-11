import {
  MAX_DVD_AUDIO_STREAMS_PER_TITLE,
  MAX_DVD_SCAN_INTEGER,
  MAX_DVD_STREAM_TEXT_LENGTH,
  MAX_DVD_SUBTITLES_PER_TITLE,
  MAX_DVD_TITLES,
  type DvdAudioStream,
  type DvdSubtitleStream,
  type DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";

import { optionalBoundedText } from "./bounded-text.js";
import { MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES } from "./optical-drive-command-runner.js";

const MAX_LABEL_LENGTH = 256;

interface ParsedDvdTitle extends DvdTitle {
  audioOrdinals: Set<number>;
  audioSourceIds: Set<number>;
  audioStreams: DvdAudioStream[];
  subtitleOrdinals: Set<number>;
  subtitleSourceIds: Set<number>;
  subtitles: DvdSubtitleStream[];
  expectedAudioStreams: number;
  expectedSubtitles: number;
}

export interface DecodedDvdMetadata {
  volumeLabel?: string;
  titles: DvdTitle[];
}

function boundedNonNegativeInteger(value: string, field: string): number {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    number > MAX_DVD_SCAN_INTEGER
  ) {
    throw new Error(`lsdvd returned an invalid ${field}`);
  }
  return number;
}

function parseStreamId(value: string): number {
  const parsed = value.toLowerCase().startsWith("0x")
    ? Number.parseInt(value, 16)
    : Number(value);
  return boundedNonNegativeInteger(String(parsed), "stream id");
}

function boundedStreamText(value: string, field: string): string {
  const text = optionalBoundedText(value, MAX_DVD_STREAM_TEXT_LENGTH);
  if (text === undefined) {
    throw new Error(`lsdvd returned invalid ${field}`);
  }
  return text;
}

function recordStreamOrdinal(
  value: string,
  expectedCount: number,
  seen: Set<number>,
): void {
  const ordinal = boundedNonNegativeInteger(value, "stream ordinal");
  if (ordinal === 0 || ordinal > expectedCount || seen.has(ordinal)) {
    throw new Error("lsdvd returned invalid stream ordinals");
  }
  seen.add(ordinal);
}

export function decodeLsdvdMetadata(output: string): DecodedDvdMetadata {
  if (Buffer.byteLength(output) > MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES) {
    throw new Error("lsdvd output exceeds the scan size limit");
  }
  const volumeMatch = output.match(/^Disc Title:\s*(.+)$/im);
  const volumeLabel = optionalBoundedText(volumeMatch?.[1], MAX_LABEL_LENGTH);
  const titles: ParsedDvdTitle[] = [];
  const titlePattern =
    /^\s*Title:\s*(\d+),\s*Length:\s*(\d+):(\d{2}):(\d{2})(?:\.\d+)?\s*Chapters:\s*(\d+),\s*Cells:\s*\d+,\s*Audio streams:\s*(\d+),\s*Subpictures:\s*(\d+)\s*$/i;
  const audioPattern =
    /^\s*Audio:\s*(\d+),\s*Language:\s*(.*?)\s*-\s*(.*?),\s*Format:\s*([^,]+),.*?\sChannels:\s*(\d+),.*?\sStream id:\s*(0x[0-9a-f]+|\d+)\s*$/i;
  const subtitlePattern =
    /^\s*(?:Subtitle|Subpicture):\s*(\d+),\s*Language:\s*(.*?)\s*-\s*(.*?),\s*Content:\s*(.*?),\s*Stream id:\s*(0x[0-9a-f]+|\d+),?\s*$/i;
  let currentTitle: ParsedDvdTitle | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Title:/i.test(line)) {
      const match = line.match(titlePattern);
      if (!match) {
        throw new Error("lsdvd returned a malformed DVD title summary");
      }
      if (titles.length >= MAX_DVD_TITLES) {
        throw new Error(
          `lsdvd returned more than ${MAX_DVD_TITLES} DVD titles`,
        );
      }
      const number = boundedNonNegativeInteger(match[1], "title number");
      const hours = boundedNonNegativeInteger(match[2], "duration hours");
      const minutes = boundedNonNegativeInteger(match[3], "duration minutes");
      const seconds = boundedNonNegativeInteger(match[4], "duration seconds");
      if (number === 0 || minutes >= 60 || seconds >= 60) {
        throw new Error("lsdvd returned an invalid DVD title map");
      }
      currentTitle = {
        number,
        durationSeconds: hours * 3_600 + minutes * 60 + seconds,
        chapters: boundedNonNegativeInteger(match[5], "chapter count"),
        audioOrdinals: new Set(),
        audioSourceIds: new Set(),
        audioStreams: [],
        subtitleOrdinals: new Set(),
        subtitleSourceIds: new Set(),
        subtitles: [],
        expectedAudioStreams: boundedNonNegativeInteger(
          match[6],
          "audio stream count",
        ),
        expectedSubtitles: boundedNonNegativeInteger(
          match[7],
          "subtitle count",
        ),
      };
      if (
        currentTitle.expectedAudioStreams > MAX_DVD_AUDIO_STREAMS_PER_TITLE ||
        currentTitle.expectedSubtitles > MAX_DVD_SUBTITLES_PER_TITLE
      ) {
        throw new Error("lsdvd returned too many DVD streams");
      }
      titles.push(currentTitle);
      continue;
    }
    if (/^\s*Audio:/i.test(line)) {
      const match = line.match(audioPattern);
      if (!currentTitle || !match) {
        throw new Error("lsdvd returned malformed DVD audio metadata");
      }
      recordStreamOrdinal(
        match[1],
        currentTitle.expectedAudioStreams,
        currentTitle.audioOrdinals,
      );
      const languageCode = optionalBoundedText(
        match[2],
        MAX_DVD_STREAM_TEXT_LENGTH,
      );
      const sourceId = parseStreamId(match[6]);
      if (currentTitle.audioSourceIds.has(sourceId)) {
        throw new Error("lsdvd returned an invalid DVD title map");
      }
      currentTitle.audioSourceIds.add(sourceId);
      currentTitle.audioStreams.push({
        id: sourceId,
        ...(languageCode ? { languageCode } : {}),
        language: boundedStreamText(match[3], "audio language"),
        format: boundedStreamText(match[4], "audio format"),
        channels: boundedNonNegativeInteger(match[5], "channel count"),
      });
      if (
        currentTitle.audioStreams.length > MAX_DVD_AUDIO_STREAMS_PER_TITLE
      ) {
        throw new Error("lsdvd returned too many DVD audio streams");
      }
      continue;
    }
    if (/^\s*(?:Subtitle|Subpicture):/i.test(line)) {
      const match = line.match(subtitlePattern);
      if (!currentTitle || !match) {
        throw new Error("lsdvd returned malformed DVD subtitle metadata");
      }
      recordStreamOrdinal(
        match[1],
        currentTitle.expectedSubtitles,
        currentTitle.subtitleOrdinals,
      );
      const languageCode = optionalBoundedText(
        match[2],
        MAX_DVD_STREAM_TEXT_LENGTH,
      );
      const sourceId = parseStreamId(match[5]);
      if (currentTitle.subtitleSourceIds.has(sourceId)) {
        throw new Error("lsdvd returned an invalid DVD title map");
      }
      currentTitle.subtitleSourceIds.add(sourceId);
      currentTitle.subtitles.push({
        id: sourceId,
        ...(languageCode ? { languageCode } : {}),
        language: boundedStreamText(match[3], "subtitle language"),
        content: boundedStreamText(match[4], "subtitle content"),
      });
      if (currentTitle.subtitles.length > MAX_DVD_SUBTITLES_PER_TITLE) {
        throw new Error("lsdvd returned too many DVD subtitles");
      }
    }
  }
  if (titles.length === 0) {
    throw new Error("lsdvd returned no reviewable DVD titles");
  }
  titles.sort((left, right) => left.number - right.number);
  if (new Set(titles.map((title) => title.number)).size !== titles.length) {
    throw new Error("lsdvd returned duplicate DVD title numbers");
  }
  for (const title of titles) {
    if (
      title.audioOrdinals.size !== title.expectedAudioStreams ||
      title.subtitleOrdinals.size !== title.expectedSubtitles
    ) {
      throw new Error("lsdvd returned invalid stream ordinals");
    }
    if (
      title.audioStreams.length !== title.expectedAudioStreams ||
      title.subtitles.length !== title.expectedSubtitles
    ) {
      throw new Error("lsdvd returned incomplete DVD stream metadata");
    }
  }
  return {
    ...(volumeLabel ? { volumeLabel } : {}),
    titles: titles.map(
      ({
        audioOrdinals: _audioOrdinals,
        audioSourceIds: _audioSourceIds,
        expectedAudioStreams: _audio,
        expectedSubtitles: _subtitles,
        subtitleOrdinals: _subtitleOrdinals,
        subtitleSourceIds: _subtitleSourceIds,
        ...title
      }) => title,
    ),
  };
}
