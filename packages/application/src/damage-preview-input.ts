export class InvalidDamagePreviewInputError extends Error {}

export interface PlaybackRange {
  startMilliseconds: number;
  endMilliseconds: number;
}

export interface DamagePreviewInput {
  mode: "damage" | "ordinary_playback";
  titleIdentityObservationId: string;
  playbackRange: PlaybackRange;
  intervalIndexes: number[];
  assessmentIdentity: string | null;
  samplingWindow: PlaybackRange | null;
  streams: { audio: number[]; subtitles: number[] };
  context: { beforeMilliseconds: number; afterMilliseconds: number };
  encodingProfileId: string;
}

function invalid(): never {
  throw new InvalidDamagePreviewInputError("Invalid Damage Preview selection.");
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value) invalid();
  return value;
}

function indexes(value: unknown, maximum: number): number[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const result = value.map(integer);
  if (new Set(result).size !== result.length) invalid();
  return result.sort((left, right) => left - right);
}

function range(value: unknown): PlaybackRange {
  const input = record(value, ["startMilliseconds", "endMilliseconds"]);
  const startMilliseconds = integer(input.startMilliseconds);
  const endMilliseconds = integer(input.endMilliseconds);
  if (endMilliseconds <= startMilliseconds) invalid();
  return { startMilliseconds, endMilliseconds };
}

export function parseDamagePreviewInput(value: unknown): DamagePreviewInput {
  const input = record(value, ["mode", "titleIdentityObservationId", "playbackRange", "intervalIndexes", "assessmentIdentity", "samplingWindow", "streams", "context", "encodingProfileId"]);
  if (input.mode !== "damage" && input.mode !== "ordinary_playback") invalid();
  const streams = record(input.streams, ["audio", "subtitles"]);
  const context = input.context === undefined ? null : record(input.context, ["beforeMilliseconds", "afterMilliseconds"]);
  const intervalIndexes = indexes(input.intervalIndexes ?? [], 10_000);
  const samplingWindow = input.samplingWindow === undefined || input.samplingWindow === null ? null : range(input.samplingWindow);
  if (input.mode === "ordinary_playback" && (intervalIndexes.length > 0 || samplingWindow !== null)) invalid();
  return {
    mode: input.mode,
    titleIdentityObservationId: text(input.titleIdentityObservationId),
    playbackRange: range(input.playbackRange),
    intervalIndexes,
    assessmentIdentity: input.assessmentIdentity === undefined || input.assessmentIdentity === null ? null : text(input.assessmentIdentity),
    samplingWindow,
    streams: { audio: indexes(streams.audio, 8), subtitles: indexes(streams.subtitles, 32) },
    context: {
      beforeMilliseconds: context === null ? 5_000 : integer(context.beforeMilliseconds),
      afterMilliseconds: context === null ? 5_000 : integer(context.afterMilliseconds),
    },
    encodingProfileId: text(input.encodingProfileId),
  };
}
