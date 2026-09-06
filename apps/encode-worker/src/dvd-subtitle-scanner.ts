import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MAX_DVD_SUBTITLES_PER_TITLE,
  MAX_DVD_SCAN_INTEGER,
} from "@rip-dvd/data-access";

import type { EncodeOutputVobSubExpectation } from "./encode-output-validator.js";

const runNodeCommand = promisify(execFile);
const SCAN_TIMEOUT_MS = 120_000;
const MAX_SCAN_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface DvdSubtitleScanner {
  scan(
    sourcePath: string,
    titleNumber: number,
    signal: AbortSignal,
  ): Promise<readonly EncodeOutputVobSubExpectation[]>;
}

type ScanCommandRunner = (
  executable: string,
  arguments_: string[],
  options: {
    encoding: "utf8";
    killSignal: "SIGKILL";
    maxBuffer: number;
    signal: AbortSignal;
    timeout: number;
  },
) => Promise<{ stdout: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidScan(): Error {
  return new Error("HandBrake DVD subtitle scan is incomplete or invalid");
}

function subtitleExpectations(
  stdout: string,
  titleNumber: number,
): readonly EncodeOutputVobSubExpectation[] {
  const markers = [...stdout.matchAll(/^JSON Title Set: /gm)];
  if (markers.length !== 1) {
    throw invalidScan();
  }
  const marker = markers[0]!;
  let result: unknown;
  try {
    result = JSON.parse(stdout.slice(marker.index + marker[0].length));
  } catch {
    throw invalidScan();
  }
  if (
    !isRecord(result) ||
    !Array.isArray(result.TitleList) ||
    result.TitleList.length !== 1
  ) {
    throw invalidScan();
  }
  const title: unknown = result.TitleList[0];
  if (
    !isRecord(title) ||
    title.Index !== titleNumber ||
    !Array.isArray(title.SubtitleList)
  ) {
    throw invalidScan();
  }
  const expectations: EncodeOutputVobSubExpectation[] = [];
  for (const [index, subtitle] of title.SubtitleList.entries()) {
    if (
      !isRecord(subtitle) ||
      subtitle.TrackNumber !== index + 1 ||
      typeof subtitle.SourceName !== "string" ||
      subtitle.SourceName.trim() === ""
    ) {
      throw invalidScan();
    }
    // DVD scans can also report closed captions, which are not VobSub.
    if (subtitle.SourceName === "CC608" || subtitle.SourceName === "CC708") {
      continue;
    }
    const name = subtitle.Name;
    if (
      subtitle.SourceName !== "VOBSUB" ||
      subtitle.Format !== "bitmap" ||
      typeof subtitle.LanguageCode !== "string" ||
      !/^[a-z]{3}$/.test(subtitle.LanguageCode) ||
      (name !== undefined && (typeof name !== "string" || name.trim() === ""))
    ) {
      throw invalidScan();
    }
    expectations.push({
      languageCode: subtitle.LanguageCode,
      title: name ?? null,
    });
  }
  if (expectations.length > MAX_DVD_SUBTITLES_PER_TITLE) {
    throw invalidScan();
  }
  return expectations;
}

export function createNodeDvdSubtitleScanner({
  runCommand = runNodeCommand,
}: { runCommand?: ScanCommandRunner } = {}): DvdSubtitleScanner {
  return {
    async scan(sourcePath, titleNumber, signal) {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(titleNumber) ||
        titleNumber < 1 ||
        titleNumber > MAX_DVD_SCAN_INTEGER
      ) {
        throw invalidScan();
      }
      let stdout: string;
      try {
        ({ stdout } = await runCommand(
          "nice",
          [
            "-n", "19", "ionice", "-c", "3", "rip-dvd-handbrake",
            "--no-dvdnav",
            "--scan",
            "--json",
            "--title", String(titleNumber),
            "--min-duration", "0",
            "--previews", "1:0",
            "-i", sourcePath,
          ],
          {
            encoding: "utf8",
            killSignal: "SIGKILL",
            maxBuffer: MAX_SCAN_OUTPUT_BYTES,
            signal,
            timeout: SCAN_TIMEOUT_MS,
          },
        ));
      } catch {
        signal.throwIfAborted();
        // execFile errors include command arguments and raw media diagnostics.
        throw new Error("HandBrake DVD subtitle scan failed");
      }
      signal.throwIfAborted();
      return subtitleExpectations(stdout, titleNumber);
    },
  };
}

export const nodeDvdSubtitleScanner = createNodeDvdSubtitleScanner();
