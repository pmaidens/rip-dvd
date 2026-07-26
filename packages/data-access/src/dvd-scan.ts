export const DVD_TITLE_MAP_SCHEMA_VERSION = 2 as const;
export const MAX_DVD_TITLES = 512;
export const MAX_DVD_AUDIO_STREAMS_PER_TITLE = 8;
export const MAX_DVD_SUBTITLES_PER_TITLE = 32;
export const MAX_DVD_SCAN_INTEGER = 100_000;
export const MAX_DVD_STREAM_TEXT_LENGTH = 64;

export interface DvdAudioStream {
  id: number;
  languageCode?: string;
  language?: string;
  format?: string;
  channels?: number;
}

export interface DvdSubtitleStream {
  id: number;
  languageCode?: string;
  language?: string;
  content?: string;
}

export interface DvdTitle {
  number: number;
  durationSeconds: number;
  chapters: number;
  audioStreams: readonly DvdAudioStream[];
  subtitles: readonly DvdSubtitleStream[];
}

export interface DvdTitleMap {
  schemaVersion: typeof DVD_TITLE_MAP_SCHEMA_VERSION;
  contentId: string;
  titles: readonly DvdTitle[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInteger(value: unknown, { positive = false } = {}): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (positive ? 1 : 0) &&
    value <= MAX_DVD_SCAN_INTEGER
    ? value
    : null;
}

function readOptionalText(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_DVD_STREAM_TEXT_LENGTH
    ? trimmed
    : null;
}

function decodeAudioStream(value: unknown): DvdAudioStream | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readInteger(value.id);
  const languageCode = readOptionalText(value.languageCode);
  const language = readOptionalText(value.language);
  const format = readOptionalText(value.format);
  const channels =
    value.channels === undefined ? undefined : readInteger(value.channels, { positive: true });
  if (
    id === null ||
    languageCode === null ||
    language === null ||
    format === null ||
    channels === null
  ) {
    return null;
  }
  return {
    id,
    ...(languageCode ? { languageCode } : {}),
    ...(language ? { language } : {}),
    ...(format ? { format } : {}),
    ...(channels ? { channels } : {}),
  };
}

function decodeSubtitleStream(value: unknown): DvdSubtitleStream | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readInteger(value.id);
  const languageCode = readOptionalText(value.languageCode);
  const language = readOptionalText(value.language);
  const content = readOptionalText(value.content);
  if (
    id === null ||
    languageCode === null ||
    language === null ||
    content === null
  ) {
    return null;
  }
  return {
    id,
    ...(languageCode ? { languageCode } : {}),
    ...(language ? { language } : {}),
    ...(content ? { content } : {}),
  };
}

function decodeStreamList<T>(
  value: unknown,
  maximumLength: number,
  decode: (item: unknown) => T | null,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > maximumLength) {
    return null;
  }
  const decoded: T[] = [];
  for (const item of value) {
    const stream = decode(item);
    if (stream === null) {
      return null;
    }
    decoded.push(stream);
  }
  return decoded;
}

function decodeTitle(value: unknown): DvdTitle | null {
  if (!isRecord(value)) {
    return null;
  }
  const number = readInteger(value.number, { positive: true });
  const durationSeconds = readInteger(value.durationSeconds);
  const chapters = readInteger(value.chapters);
  const audioStreams = decodeStreamList(
    value.audioStreams,
    MAX_DVD_AUDIO_STREAMS_PER_TITLE,
    decodeAudioStream,
  );
  const subtitles = decodeStreamList(
    value.subtitles,
    MAX_DVD_SUBTITLES_PER_TITLE,
    decodeSubtitleStream,
  );
  if (
    number === null ||
    durationSeconds === null ||
    chapters === null ||
    audioStreams === null ||
    subtitles === null
  ) {
    return null;
  }
  return { number, durationSeconds, chapters, audioStreams, subtitles };
}

export function decodeDvdTitleMap(value: unknown): DvdTitleMap | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DVD_TITLE_MAP_SCHEMA_VERSION ||
    typeof value.contentId !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.contentId) ||
    !Array.isArray(value.titles) ||
    value.titles.length === 0 ||
    value.titles.length > MAX_DVD_TITLES
  ) {
    return null;
  }
  const titles: DvdTitle[] = [];
  const titleNumbers = new Set<number>();
  for (const valueTitle of value.titles) {
    const title = decodeTitle(valueTitle);
    if (title === null || titleNumbers.has(title.number)) {
      return null;
    }
    titleNumbers.add(title.number);
    titles.push(title);
  }
  return {
    schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
    contentId: value.contentId,
    titles,
  };
}
