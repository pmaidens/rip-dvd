import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { platform as operatingSystem } from "node:os";
import { isAbsolute, normalize } from "node:path";

import {
  decodeDvdTitleMap,
  DVD_TITLE_MAP_SCHEMA_VERSION,
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

const COMMAND_TIMEOUT_MS = 90_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_DISCOVERED_DEVICES = 32;
const MAX_BLOCK_DEVICE_NODES = 256;
const MAX_DEVICE_PATH_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 256;
const MAX_DVD_CONTENT_BYTES = 9_000_000_000;
const DVD_CONTENT_READ_BUFFER_BYTES = 1_048_576;
const DVD_CONTENT_HASH_TIMEOUT_MS = 30 * 60_000;

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

export const nodeCommandRunner: CommandRunner = {
  run(executable, arguments_, options) {
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        [...arguments_],
        {
          encoding: "utf8",
          maxBuffer: options.maxBufferBytes,
          shell: false,
          signal: options.signal,
          timeout: options.timeoutMs,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          if (options.signal.aborted || error.name === "AbortError") {
            reject(error);
            return;
          }
          if (typeof error.code === "number") {
            resolve({ exitCode: error.code, stdout, stderr });
            return;
          }
          reject(error);
        },
      );
    });
  },
};

export interface DiscContentReader {
  hash(
    devicePath: string,
    sizeBytes: number,
    signal: AbortSignal,
  ): Promise<string>;
}

export const nodeDiscContentReader: DiscContentReader = {
  async hash(devicePath, sizeBytes, signal) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      DVD_CONTENT_HASH_TIMEOUT_MS,
    );
    timeout.unref();
    const readSignal = AbortSignal.any([signal, timeoutController.signal]);
    const hash = createHash("sha256");
    hash.update("rip-dvd-content-v2\0");
    hash.update(String(sizeBytes));
    let bytesRead = 0;
    try {
      const stream = createReadStream(devicePath, {
        end: sizeBytes - 1,
        highWaterMark: DVD_CONTENT_READ_BUFFER_BYTES,
        signal: readSignal,
        start: 0,
      });
      for await (const chunk of stream) {
        bytesRead += chunk.length;
        if (bytesRead > sizeBytes) {
          throw new Error("DVD content read exceeded the declared media size");
        }
        hash.update(chunk);
      }
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (timeoutController.signal.aborted) {
        throw new Error("DVD content hashing timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (bytesRead !== sizeBytes) {
      throw new Error("DVD content read ended before the declared media size");
    }
    return `sha256:${hash.digest("hex")}`;
  },
};

interface LinuxOpticalDriveHardwareOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  contentReader?: DiscContentReader;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, maximumLength = MAX_LABEL_LENGTH) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : undefined;
}

function requireSafeDevicePath(value: unknown): string {
  const path = optionalText(value, MAX_DEVICE_PATH_LENGTH);
  if (
    path === undefined ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    !path.startsWith("/dev/") ||
    normalize(path) !== path
  ) {
    throw new Error("Optical Drive discovery returned an unsafe device path");
  }
  return path;
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
      const vendor = optionalText(record.vendor);
      const product = optionalText(record.model);
      const serialNumber = optionalText(record.serial);
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
  audioStreams: DvdAudioStream[];
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
  const text = optionalText(value, MAX_DVD_STREAM_TEXT_LENGTH);
  if (text === undefined) {
    throw new Error(`lsdvd returned invalid ${field}`);
  }
  return text;
}

function parseDvdMetadata(output: string): {
  volumeLabel?: string;
  titles: DvdTitle[];
} {
  if (Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error("lsdvd output exceeds the scan size limit");
  }
  const volumeMatch = output.match(/^Disc Title:\s*(.+)$/im);
  const volumeLabel = optionalText(volumeMatch?.[1]);
  const titles: ParsedDvdTitle[] = [];
  const titlePattern =
    /^\s*Title:\s*(\d+),\s*Length:\s*(\d+):(\d{2}):(\d{2})(?:\.\d+)?\s*Chapters:\s*(\d+),\s*Cells:\s*\d+,\s*Audio streams:\s*(\d+),\s*Subpictures:\s*(\d+)\s*$/i;
  const audioPattern =
    /^\s*Audio:\s*\d+,\s*Language:\s*([^\s,]+)\s*-\s*([^,]+),\s*Format:\s*([^,]+),.*?\sChannels:\s*(\d+),.*?\sStream id:\s*(0x[0-9a-f]+|\d+)\s*$/i;
  const subtitlePattern =
    /^\s*(?:Subtitle|Subpicture):\s*\d+,\s*Language:\s*([^\s,]+)\s*-\s*([^,]+),\s*Content:\s*([^,]+),\s*Stream id:\s*(0x[0-9a-f]+|\d+),?\s*$/i;
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
        audioStreams: [],
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
      currentTitle.audioStreams.push({
        id: parseStreamId(match[5]),
        languageCode: boundedStreamText(match[1], "audio language code"),
        language: boundedStreamText(match[2], "audio language"),
        format: boundedStreamText(match[3], "audio format"),
        channels: boundedNonNegativeInteger(match[4], "channel count"),
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
      currentTitle.subtitles.push({
        id: parseStreamId(match[4]),
        languageCode: boundedStreamText(match[1], "subtitle language code"),
        language: boundedStreamText(match[2], "subtitle language"),
        content: boundedStreamText(match[3], "subtitle content"),
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
      title.audioStreams.length !== title.expectedAudioStreams ||
      title.subtitles.length !== title.expectedSubtitles
    ) {
      throw new Error("lsdvd returned incomplete DVD stream metadata");
    }
  }
  return {
    ...(volumeLabel ? { volumeLabel } : {}),
    titles: titles.map(
      ({ expectedAudioStreams: _audio, expectedSubtitles: _subtitles, ...title }) =>
        title,
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
  const sizeBytes = Number(sizeResult.stdout.trim());
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_DVD_CONTENT_BYTES
  ) {
    throw new Error("blockdev returned an invalid DVD size");
  }
  const contentId = await contentReader.hash(devicePath, sizeBytes, signal);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentId)) {
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
    if (/no medium found|medium not present|device not ready/i.test(output)) {
      return null;
    }
    throw commandFailure("lsdvd", result);
  }
  return parseDvdMetadata(`${result.stdout}\n${result.stderr}`);
}

export function createLinuxOpticalDriveHardware({
  platform = operatingSystem(),
  runner = nodeCommandRunner,
  contentReader = nodeDiscContentReader,
}: LinuxOpticalDriveHardwareOptions = {}): OpticalDriveHardware {
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
      return parseDiscoveredDrives(result.stdout);
    },

    async scanDvd(devicePath, signal) {
      const safeDevicePath = requireSafeDevicePath(devicePath);
      const probe = await inspectDvd(safeDevicePath, signal, runner);
      if (probe === null) {
        return null;
      }
      const contentIdBefore = await readDvdContentId(
        safeDevicePath,
        signal,
        runner,
        contentReader,
      );
      const metadata = await inspectDvd(safeDevicePath, signal, runner);
      if (metadata === null) {
        throw new Error("DVD medium changed during scanning");
      }
      const contentId = await readDvdContentId(
        safeDevicePath,
        signal,
        runner,
        contentReader,
      );
      if (contentIdBefore !== contentId) {
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
      return {
        fingerprint: contentId,
        ...(metadata.volumeLabel ? { volumeLabel: metadata.volumeLabel } : {}),
        scanData,
      };
    },
  };
}
