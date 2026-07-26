import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { platform as operatingSystem } from "node:os";
import { isAbsolute, normalize } from "node:path";

import type {
  DiscoveredOpticalDrive,
  OpticalDriveHardware,
  ScannedDvd,
} from "./archive-worker.js";

const COMMAND_TIMEOUT_MS = 90_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_DISCOVERED_DEVICES = 32;
const MAX_BLOCK_DEVICE_NODES = 256;
const MAX_DVD_TITLES = 512;
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

interface LinuxOpticalDriveHardwareOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
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
  if (!Number.isSafeInteger(number) || number < 0 || number > 100_000) {
    throw new Error(`lsdvd returned an invalid ${field}`);
  }
  return number;
}

function parseDvdScan(output: string): ScannedDvd {
  if (Buffer.byteLength(output) > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error("lsdvd output exceeds the scan size limit");
  }
  const volumeMatch = output.match(/^Disc Title:\s*(.+)$/im);
  const volumeLabel = optionalText(volumeMatch?.[1]);
  const titles: ScannedDvd["scanData"]["titles"][number][] = [];
  const titlePattern =
    /Title:\s*(\d+),\s*Length:\s*(\d+):(\d{2}):(\d{2})(?:\.\d+)?\s*Chapters:\s*(\d+).*?Audio streams:\s*(\d+),\s*Subpictures:\s*(\d+)/gi;
  for (const match of output.matchAll(titlePattern)) {
    if (titles.length >= MAX_DVD_TITLES) {
      throw new Error(`lsdvd returned more than ${MAX_DVD_TITLES} DVD titles`);
    }
    const number = boundedNonNegativeInteger(match[1], "title number");
    const hours = boundedNonNegativeInteger(match[2], "duration hours");
    const minutes = boundedNonNegativeInteger(match[3], "duration minutes");
    const seconds = boundedNonNegativeInteger(match[4], "duration seconds");
    if (number === 0 || minutes >= 60 || seconds >= 60) {
      throw new Error("lsdvd returned an invalid DVD title map");
    }
    titles.push({
      number,
      durationSeconds: hours * 3_600 + minutes * 60 + seconds,
      chapters: boundedNonNegativeInteger(match[5], "chapter count"),
      audioStreams: boundedNonNegativeInteger(match[6], "audio stream count"),
      subtitles: boundedNonNegativeInteger(match[7], "subtitle count"),
    });
  }
  if (titles.length === 0) {
    throw new Error("lsdvd returned no reviewable DVD titles");
  }
  titles.sort((left, right) => left.number - right.number);
  if (new Set(titles.map((title) => title.number)).size !== titles.length) {
    throw new Error("lsdvd returned duplicate DVD title numbers");
  }
  const identity = {
    discKind: "dvd",
    volumeLabel: volumeLabel ?? "",
    titles,
  };
  return {
    fingerprint: `sha256:${createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")}`,
    ...(volumeLabel ? { volumeLabel } : {}),
    scanData: { schemaVersion: 1, titles },
  };
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

export function createLinuxOpticalDriveHardware({
  platform = operatingSystem(),
  runner = nodeCommandRunner,
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
      const result = await runner.run(
        "lsdvd",
        ["-a", "-c", "-s", safeDevicePath],
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
      return parseDvdScan(`${result.stdout}\n${result.stderr}`);
    },
  };
}
