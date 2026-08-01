import { platform as operatingSystem } from "node:os";

import {
  decodeDvdTitleMap,
  DVD_TITLE_MAP_SCHEMA_VERSION,
  isDvdContentId,
  MAX_DVD_AUDIO_STREAMS_PER_TITLE,
  MAX_DVD_SCAN_INTEGER,
  MAX_DVD_STREAM_TEXT_LENGTH,
  MAX_DVD_SUBTITLES_PER_TITLE,
  MAX_DVD_TITLES,
  type DvdAudioStream,
  type DvdSubtitleStream,
  type DvdTitle,
} from "@rip-dvd/data-access/dvd-scan";
import type { DiscoveredOpticalDrive } from "@rip-dvd/data-access";

import type {
  OpticalDriveHardware,
  ScannedDvd,
} from "./archive-worker.js";
import {
  createBoundedSingleFlightCoordinator,
  createNodeBoundedCommandProcessLauncher,
  type BoundedCommandProcessLauncher,
} from "./bounded-child-process.js";
import { optionalBoundedText } from "./bounded-text.js";
import { requireDvdContentSize } from "./dvd-content-policy.js";
import {
  nodeDiscContentReader,
  type DiscContentReader,
} from "./optical-disc-content.js";
import {
  nodeMediaGenerationObserver,
  requireSafeOpticalDevicePath as requireSafeDevicePath,
  type MediaGenerationObserver,
} from "./optical-media-generation.js";

export {
  createNodeDiscContentProbeLauncher,
  createNodeDiscContentReader,
  nodeDiscContentProbeLauncher,
  nodeDiscContentReader,
  type DiscContentProbeLauncher,
  type DiscContentReader,
} from "./optical-disc-content.js";

export {
  createNodeMediaGenerationObserver,
  createNodeMediaGenerationProbeLauncher,
  nodeMediaGenerationProbeLauncher,
  type MediaGenerationObserver,
  type MediaGenerationProbeLauncher,
} from "./optical-media-generation.js";

const COMMAND_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ACTIVE_COMMANDS = 32;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_DISCOVERED_DEVICES = 32;
const MAX_BLOCK_DEVICE_NODES = 256;
const MAX_DEVICE_PATH_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 256;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  maxBufferBytes: number;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface CommandRunner {
  run(
    executable: string,
    arguments_: readonly string[],
    options: CommandRunnerOptions,
  ): Promise<CommandResult>;
}

interface NodeCommandRunnerOptions {
  maxActiveCommands?: number;
  processLauncher?: BoundedCommandProcessLauncher;
}

interface CommandProcessRequest {
  arguments_: readonly string[];
  executable: string;
  maxOutputBytes: number;
}

export function createNodeCommandRunner(
  options: NodeCommandRunnerOptions = {},
): CommandRunner {
  const maxActiveCommands =
    options.maxActiveCommands ?? DEFAULT_MAX_ACTIVE_COMMANDS;
  const processLauncher =
    options.processLauncher ?? createNodeBoundedCommandProcessLauncher();
  const activeCommands = createBoundedSingleFlightCoordinator({
    maxActiveProcesses: maxActiveCommands,
    invalidCapacityError: "device command capacity is invalid",
    exhaustedCapacityError: "device command capacity is exhausted",
    start(request: CommandProcessRequest) {
      return processLauncher.start(
        request.executable,
        request.arguments_,
        request.maxOutputBytes,
      );
    },
    validateReuse(activeRequest, requested) {
      if (activeRequest.maxOutputBytes !== requested.maxOutputBytes) {
        throw new Error("device command output bound changed while active");
      }
    },
  });
  return {
    async run(executable, arguments_, commandOptions) {
      if (
        !Number.isSafeInteger(commandOptions.timeoutMs) ||
        commandOptions.timeoutMs <= 0
      ) {
        throw new Error("device command timeout is invalid");
      }
      if (
        !Number.isSafeInteger(commandOptions.maxBufferBytes) ||
        commandOptions.maxBufferBytes <= 0
      ) {
        throw new Error("device command output bound is invalid");
      }
      const commandKey = JSON.stringify([executable, ...arguments_]);
      const completion = await activeCommands.run(
        commandKey,
        {
          executable,
          arguments_,
          maxOutputBytes: commandOptions.maxBufferBytes,
        },
        {
          signal: commandOptions.signal,
          timeoutError: "device command timed out",
          timeoutMs: commandOptions.timeoutMs,
        },
      );
      return {
        exitCode: completion.exitCode ?? 1,
        stderr: completion.stderr,
        stdout: completion.stdout,
      };
    },
  };
}

export const nodeCommandRunner = createNodeCommandRunner();

interface LinuxOpticalDriveHardwareOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  contentReader?: DiscContentReader;
  mediaGenerationObserver?: MediaGenerationObserver;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenBlockDevices(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("lsblk output does not contain a blockdevices array");
  }
  const pending = [...value];
  const records: UnknownRecord[] = [];
  while (pending.length > 0) {
    if (records.length >= MAX_BLOCK_DEVICE_NODES) {
      throw new Error(
        `lsblk output exceeds ${MAX_BLOCK_DEVICE_NODES} block-device nodes`,
      );
    }
    const item = pending.shift();
    if (!isRecord(item)) {
      throw new Error("lsblk output contains a malformed block-device node");
    }
    records.push(item);
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) {
        throw new Error("lsblk output contains malformed children");
      }
      pending.push(...item.children);
    }
  }
  return records;
}

function parseDiscoveredDrives(output: string): DiscoveredOpticalDrive[] {
  if (Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error("lsblk output exceeds the discovery size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("lsblk returned malformed JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("lsblk returned a malformed result");
  }
  const drives = flattenBlockDevices(parsed.blockdevices)
    .filter((record) => record.type === "rom")
    .map((record): DiscoveredOpticalDrive => {
      const vendor = optionalBoundedText(record.vendor, MAX_LABEL_LENGTH);
      const product = optionalBoundedText(record.model, MAX_LABEL_LENGTH);
      const serialNumber = optionalBoundedText(record.serial, MAX_LABEL_LENGTH);
      const displayName = [vendor, product].filter(Boolean).join(" ");
      return {
        devicePath: requireSafeDevicePath(record.path),
        ...(displayName ? { displayName } : {}),
        ...(vendor ? { vendor } : {}),
        ...(product ? { product } : {}),
        ...(serialNumber ? { serialNumber } : {}),
      };
    });
  if (drives.length > MAX_DISCOVERED_DEVICES) {
    throw new Error(
      `lsblk returned more than ${MAX_DISCOVERED_DEVICES} Optical Drives`,
    );
  }
  if (new Set(drives.map((drive) => drive.devicePath)).size !== drives.length) {
    throw new Error("lsblk returned duplicate Optical Drive device paths");
  }
  return drives.sort((left, right) =>
    left.devicePath.localeCompare(right.devicePath),
  );
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

function parseStreamId(value: string): number {
  const parsed = value.toLowerCase().startsWith("0x")
    ? Number.parseInt(value, 16)
    : Number(value);
  return boundedNonNegativeInteger(
    String(parsed),
    "stream id",
  );
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

function parseDvdMetadata(output: string): {
  volumeLabel?: string;
  titles: DvdTitle[];
} {
  if (Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) {
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

async function readDvdContentId(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
  contentReader: DiscContentReader,
): Promise<string> {
  const sizeResult = await runner.run(
    "blockdev",
    ["--getsize64", devicePath],
    { maxBufferBytes: 128, signal, timeoutMs: COMMAND_TIMEOUT_MS },
  );
  if (sizeResult.exitCode !== 0) {
    throw commandFailure("blockdev", sizeResult);
  }
  let sizeBytes: number;
  try {
    sizeBytes = requireDvdContentSize(Number(sizeResult.stdout.trim()));
  } catch {
    throw new Error("blockdev returned an invalid DVD size");
  }
  const contentId = await contentReader.hash(devicePath, sizeBytes, signal);
  if (!isDvdContentId(contentId)) {
    throw new Error("DVD content reader returned an invalid content identity");
  }
  return contentId;
}

function commandFailure(tool: string, result: CommandResult): Error {
  const detail = (result.stderr || result.stdout)
    .replaceAll(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
  return new Error(
    `${tool} exited with status ${result.exitCode}${detail ? `: ${detail}` : ""}`,
  );
}

async function inspectDvd(
  devicePath: string,
  signal: AbortSignal,
  runner: CommandRunner,
): Promise<ReturnType<typeof parseDvdMetadata> | null> {
  const result = await runner.run(
    "lsdvd",
    ["-Oh", "-a", "-c", "-s", devicePath],
    {
      maxBufferBytes: MAX_COMMAND_OUTPUT_BYTES,
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/no medium found|medium not present/i.test(output)) {
      return null;
    }
    if (/device not ready/i.test(output)) {
      throw new Error("Optical Drive is temporarily not ready");
    }
    throw commandFailure("lsdvd", result);
  }
  return parseDvdMetadata(`${result.stdout}\n${result.stderr}`);
}

export function createLinuxOpticalDriveHardware({
  platform = operatingSystem(),
  runner = nodeCommandRunner,
  contentReader = nodeDiscContentReader,
  mediaGenerationObserver = nodeMediaGenerationObserver,
}: LinuxOpticalDriveHardwareOptions = {}): OpticalDriveHardware {
  const scanCache = new Map<
    string,
    { generation: string; result: ScannedDvd | null }
  >();
  return {
    async discover(signal) {
      if (platform !== "linux") {
        throw new Error("Optical Drive discovery is supported only on Linux");
      }
      const result = await runner.run(
        "lsblk",
        ["--json", "--output", "PATH,TYPE,TRAN,VENDOR,MODEL,SERIAL"],
        {
          maxBufferBytes: MAX_COMMAND_OUTPUT_BYTES,
          signal,
          timeoutMs: COMMAND_TIMEOUT_MS,
        },
      );
      if (result.exitCode !== 0) {
        throw commandFailure("lsblk", result);
      }
      const discovered = parseDiscoveredDrives(result.stdout);
      const discoveredPaths = new Set(
        discovered.map((drive) => drive.devicePath),
      );
      for (const cachedPath of scanCache.keys()) {
        if (!discoveredPaths.has(cachedPath)) {
          scanCache.delete(cachedPath);
        }
      }
      return discovered;
    },

    async scanDvd(devicePath, signal) {
      const safeDevicePath = requireSafeDevicePath(devicePath);
      const generationBefore = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      const cached = scanCache.get(safeDevicePath);
      if (cached?.generation === generationBefore) {
        return cached.result === null
          ? null
          : { ...cached.result, isNewMediumObservation: false };
      }
      const metadata = await inspectDvd(safeDevicePath, signal, runner);
      if (metadata === null) {
        const generationAfter = await mediaGenerationObserver.observe(
          safeDevicePath,
          signal,
        );
        if (generationBefore !== generationAfter) {
          throw new Error("DVD medium changed during scanning");
        }
        scanCache.set(safeDevicePath, {
          generation: generationAfter,
          result: null,
        });
        return null;
      }
      const contentId = await readDvdContentId(
        safeDevicePath,
        signal,
        runner,
        contentReader,
      );
      const generationAfter = await mediaGenerationObserver.observe(
        safeDevicePath,
        signal,
      );
      if (generationBefore !== generationAfter) {
        throw new Error("DVD medium changed during scanning");
      }
      const scanData = decodeDvdTitleMap({
        schemaVersion: DVD_TITLE_MAP_SCHEMA_VERSION,
        contentId,
        titles: metadata.titles,
      });
      if (scanData === null) {
        throw new Error("lsdvd returned an invalid DVD title map");
      }
      const result = {
        fingerprint: contentId,
        isNewMediumObservation: true,
        ...(metadata.volumeLabel ? { volumeLabel: metadata.volumeLabel } : {}),
        scanData,
      };
      scanCache.set(safeDevicePath, {
        generation: generationAfter,
        result,
      });
      return result;
    },
  };
}
