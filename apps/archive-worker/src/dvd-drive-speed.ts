import type {
  ArchiveRecoverySpeedMode,
  ArchiveRecoverySpeedRequestOutcome,
} from "@rip-dvd/data-access";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  createNodeCommandRunner,
  MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
  OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import { requireSafeOpticalDevicePath } from "./optical-media-generation.js";

export interface DvdDriveSpeedResult {
  attemptedSpeeds: readonly number[];
  selectedSpeed: number | null;
  observedSpeed: number | null;
  outcome: ArchiveRecoverySpeedRequestOutcome;
}

export interface DvdDriveSpeedController {
  apply(input: {
    devicePath: string;
    mode: ArchiveRecoverySpeedMode;
    signal: AbortSignal;
  }): Promise<DvdDriveSpeedResult>;
}

export function reportedOpticalDriveSpeed(
  info: string,
  devicePath: string,
): number | null {
  const rows = new Map(info.split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator < 0) return [];
    return [[
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim().split(/\s+/),
    ] as const];
  }));
  const names = rows.get("drive name");
  const speeds = rows.get("drive speed");
  const index = names?.findIndex((name) => name === basename(devicePath)) ?? -1;
  if (index < 0 || speeds === undefined) return null;
  const speed = Number(speeds[index]);
  return Number.isSafeInteger(speed) && speed >= 0 && speed <= 255
    ? speed
    : null;
}

export function createNodeDvdDriveSpeedController(
  runner: CommandRunner = createNodeCommandRunner(),
  readText: (path: string) => Promise<string> = (path) =>
    readFile(path, "utf8"),
): DvdDriveSpeedController {
  return {
    async apply(input) {
      const devicePath = requireSafeOpticalDevicePath(input.devicePath);
      const requestedSpeeds = input.mode === "low" ? [4, 2] : [0];
      const attemptedSpeeds: number[] = [];
      for (const requestedSpeed of requestedSpeeds) {
        attemptedSpeeds.push(requestedSpeed);
        let selected = false;
        try {
          const result = await runner.run(
            "eject",
            ["--cdspeed", String(requestedSpeed), devicePath],
            {
              maxBufferBytes: MAX_OPTICAL_DRIVE_COMMAND_OUTPUT_BYTES,
              signal: input.signal,
              timeoutMs: OPTICAL_DRIVE_COMMAND_TIMEOUT_MS,
            },
          );
          selected = result.exitCode === 0;
        } catch (error) {
          if (input.signal.aborted) throw error;
        }
        if (!selected) continue;
        let observedSpeed: number | null = null;
        try {
          observedSpeed = reportedOpticalDriveSpeed(
            await readText("/proc/sys/dev/cdrom/info"),
            devicePath,
          );
        } catch (error) {
          if (input.signal.aborted) throw error;
        }
        const outcome = input.mode === "normal"
          ? "accepted" as const
          : observedSpeed !== null && observedSpeed > 0 &&
              observedSpeed <= requestedSpeed
            ? "accepted" as const
            : "ignored" as const;
        return {
          attemptedSpeeds,
          selectedSpeed: requestedSpeed,
          observedSpeed,
          outcome,
        };
      }
      return {
        attemptedSpeeds,
        selectedSpeed: null,
        observedSpeed: null,
        outcome: "rejected",
      };
    },
  };
}
