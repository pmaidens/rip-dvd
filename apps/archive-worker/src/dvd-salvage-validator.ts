import { fileURLToPath } from "node:url";

import {
  DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  type DvdSalvageRejectionReason,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

import { decodeLsdvdMetadata } from "./dvd-metadata.js";
import {
  formatDvdDamageRanges,
  type DamagedDvdRecoveryResult,
} from "./dvd-recovery-contracts.js";
import {
  nodeCommandRunner,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import {
  createNodeDvdTitlePlaybackValidator,
  type DvdTitlePlaybackValidator,
} from "./dvd-title-playback-validator.js";

export const DVD_WATCHABLE_SALVAGE_POLICY_VERSION =
  "dvd-watchable-salvage-v1";

export interface DvdSalvageValidationRequest {
  expectedTitleMap: DvdTitleMap;
  imagePath: string;
  recoveryResult: DamagedDvdRecoveryResult;
  signal: AbortSignal;
}

export type { DvdSalvageRejectionReason } from "@rip-dvd/data-access";

export type DvdSalvageValidationResult =
  | { outcome: "accepted" }
  | { outcome: "rejected"; reason: DvdSalvageRejectionReason };

export interface DvdSalvageValidator {
  validate(
    request: DvdSalvageValidationRequest,
  ): Promise<DvdSalvageValidationResult>;
}

const CLASSIFIER_OUTPUT_LIMIT_BYTES = 4_096;
const CLASSIFIER_TIMEOUT_MS = 5 * 60_000;
const NAVIGATION_OUTPUT_LIMIT_BYTES = 1_048_576;
const NAVIGATION_TIMEOUT_MS = 5 * 60_000;
const CLASSIFIER_SCRIPT_PATH = fileURLToPath(
  new URL("./dvd-layout-classifier-cli.js", import.meta.url),
);

type ClassifierResult =
  | { affectedTitleSetNumbers: readonly number[]; outcome: "accepted" }
  | { outcome: "rejected"; reason: DvdSalvageRejectionReason };

function parseClassifierResult(payload: string): ClassifierResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD salvage classifier returned malformed output");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("protocolVersion" in parsed) ||
    parsed.protocolVersion !== 1 ||
    !("outcome" in parsed)
  ) {
    throw new Error("DVD salvage classifier returned malformed output");
  }
  if (parsed.outcome === "accepted") {
    const affectedTitleSetNumbers = "affectedTitleSetNumbers" in parsed
      ? parsed.affectedTitleSetNumbers
      : [];
    if (
      !Array.isArray(affectedTitleSetNumbers) ||
      affectedTitleSetNumbers.length > 32 ||
      affectedTitleSetNumbers.some((value, index) =>
        !Number.isSafeInteger(value) ||
        (value as number) <= 0 ||
        (value as number) > 99 ||
        (index > 0 &&
          (affectedTitleSetNumbers[index - 1] as number) >= (value as number))
      )
    ) {
      throw new Error("DVD salvage classifier returned malformed output");
    }
    return {
      affectedTitleSetNumbers: affectedTitleSetNumbers as number[],
      outcome: "accepted",
    };
  }
  if (
    parsed.outcome === "rejected" &&
    "reason" in parsed &&
    typeof parsed.reason === "string" &&
    parsed.reason in DVD_SALVAGE_REJECTION_DESCRIPTIONS
  ) {
    return {
      outcome: "rejected",
      reason: parsed.reason as DvdSalvageRejectionReason,
    };
  }
  throw new Error("DVD salvage classifier returned malformed output");
}

function titleSetsByTitleNumber(
  output: string,
  expectedTitleNumbers: readonly number[],
): ReadonlyMap<number, number> {
  const titleSets = new Map<number, number>();
  let currentTitleNumber: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const title = /^\s*Title:\s*(\d+),/i.exec(line);
    if (title !== null) {
      currentTitleNumber = Number(title[1]);
      continue;
    }
    const titleSet = /^\s*VTS:\s*(\d+),\s*TTN:\s*\d+,/i.exec(line);
    if (titleSet === null) {
      continue;
    }
    const titleSetNumber = Number(titleSet[1]);
    if (
      currentTitleNumber === undefined ||
      !Number.isSafeInteger(titleSetNumber) ||
      titleSetNumber <= 0 ||
      titleSetNumber > 99 ||
      titleSets.has(currentTitleNumber)
    ) {
      throw new Error("DVD salvage navigation validation returned malformed output");
    }
    titleSets.set(currentTitleNumber, titleSetNumber);
  }
  if (
    expectedTitleNumbers.some((titleNumber) => !titleSets.has(titleNumber)) ||
    titleSets.size !== expectedTitleNumbers.length
  ) {
    throw new Error("DVD salvage navigation validation returned malformed output");
  }
  return titleSets;
}

function canonicalizeDvdTitles(titles: DvdTitleMap["titles"]): string {
  return JSON.stringify(
    [...titles].sort((left, right) => left.number - right.number),
  );
}

export function createNodeDvdSalvageValidator({
  classifierScriptPath = CLASSIFIER_SCRIPT_PATH,
  playbackValidator,
  runner = nodeCommandRunner,
}: {
  classifierScriptPath?: string;
  playbackValidator?: DvdTitlePlaybackValidator;
  runner?: CommandRunner;
} = {}): DvdSalvageValidator {
  const titlePlaybackValidator = playbackValidator ??
    createNodeDvdTitlePlaybackValidator({ runner });
  return {
    async validate({
      expectedTitleMap,
      imagePath,
      recoveryResult,
      signal,
    }) {
      if (recoveryResult.badSectorCount > 32) {
        return { outcome: "rejected", reason: "policy_limit" };
      }
      if (recoveryResult.unrecoveredSectorRanges.some(
        (range) => range.sectorCount !== 1,
      )) {
        return { outcome: "rejected", reason: "consecutive_damage" };
      }
      let classification;
      try {
        classification = await runner.run(
          process.execPath,
          [
            classifierScriptPath,
            imagePath,
            String(recoveryResult.declaredByteCount),
            JSON.stringify(recoveryResult.unrecoveredSectorRanges),
          ],
          {
            maxBufferBytes: CLASSIFIER_OUTPUT_LIMIT_BYTES,
            signal,
            timeoutMs: CLASSIFIER_TIMEOUT_MS,
          },
        );
      } catch (error) {
        throw new Error("DVD salvage filesystem classification failed", {
          cause: error,
        });
      }
      if (classification.exitCode !== 0 || classification.stderr.trim() !== "") {
        throw new Error("DVD salvage filesystem classification failed");
      }
      const result = parseClassifierResult(classification.stdout.trim());
      if (result.outcome === "rejected") {
        return result;
      }
      if (
        result.affectedTitleSetNumbers.length > 0 &&
        recoveryResult.badSectorCount !== 1
      ) {
        return { outcome: "rejected", reason: "policy_limit" };
      }

      let navigation;
      try {
        navigation = await runner.run(
          "rip-dvd-lsdvd",
          ["-Oh", "-a", "-c", "-s", imagePath],
          {
            maxBufferBytes: NAVIGATION_OUTPUT_LIMIT_BYTES,
            signal,
            timeoutMs: NAVIGATION_TIMEOUT_MS,
          },
        );
      } catch (error) {
        throw new Error("DVD salvage navigation validation failed", {
          cause: error,
        });
      }
      if (navigation.exitCode !== 0) {
        throw new Error("DVD salvage navigation validation failed");
      }
      let observedTitleMap;
      try {
        observedTitleMap = decodeLsdvdMetadata(
          `${navigation.stdout}\n${navigation.stderr}`,
        );
      } catch (error) {
        throw new Error("DVD salvage navigation validation failed", {
          cause: error,
        });
      }
      if (
        canonicalizeDvdTitles(observedTitleMap.titles) !==
          canonicalizeDvdTitles(expectedTitleMap.titles)
      ) {
        throw new Error("DVD salvage navigation validation changed the title map");
      }
      if (result.affectedTitleSetNumbers.length === 0) {
        return { outcome: "accepted" };
      }
      const titleSets = titleSetsByTitleNumber(
        `${navigation.stdout}\n${navigation.stderr}`,
        observedTitleMap.titles.map((title) => title.number),
      );
      const affectedTitleSetNumbers = new Set(
        result.affectedTitleSetNumbers,
      );
      const affectedTitles = expectedTitleMap.titles.filter((title) =>
        affectedTitleSetNumbers.has(titleSets.get(title.number)!)
      );
      if (
        affectedTitles.length === 0 ||
        new Set(
          affectedTitles.map((title) => titleSets.get(title.number)!),
        ).size !== affectedTitleSetNumbers.size
      ) {
        throw new Error("DVD salvage navigation validation changed the title map");
      }
      for (const title of affectedTitles) {
        const playback = await titlePlaybackValidator.validate({
          imagePath,
          signal,
          title,
        });
        if (
          playback.terminalStatus !== "completed" ||
          playback.titleNumber !== title.number
        ) {
          return { outcome: "rejected", reason: "decoder_incomplete" };
        }
        if (
          playback.videoStreamCount !== 1 ||
          playback.audioStreamCount !== title.audioStreams.length
        ) {
          return { outcome: "rejected", reason: "decoder_stream" };
        }
        if (playback.decodedDurationSeconds + 1 < title.durationSeconds) {
          return { outcome: "rejected", reason: "decoder_duration" };
        }
        const attemptedFrames = playback.decodedFrameCount +
          playback.failedFrameCount;
        if (
          attemptedFrames <= 0 ||
          playback.failedFrameCount / attemptedFrames > 0.0001
        ) {
          return { outcome: "rejected", reason: "decoder_rate" };
        }
      }
      return { outcome: "accepted" };
    },
  };
}

export function formatRejectedDvdSalvage(
  reason: DvdSalvageRejectionReason,
  recoveryResult: DamagedDvdRecoveryResult,
): string {
  return `DVD salvage rejected: unreadable sectors affect ${DVD_SALVAGE_REJECTION_DESCRIPTIONS[reason]}; ${recoveryResult.badSectorCount} ${recoveryResult.badSectorCount === 1 ? "sector" : "sectors"} in ${recoveryResult.badAreaCount} ${recoveryResult.badAreaCount === 1 ? "area" : "areas"}; LBAs ${formatDvdDamageRanges(recoveryResult)}`;
}
