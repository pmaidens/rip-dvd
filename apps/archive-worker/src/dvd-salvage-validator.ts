import { fileURLToPath } from "node:url";

import {
  DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  type DvdSalvageRejectionReason,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

import { decodeLsdvdNavigationMetadata } from "./dvd-metadata.js";
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
  "dvd-watchable-salvage-v2";

export interface DvdSalvageValidationRequest {
  expectedTitleMap: DvdTitleMap;
  imagePath: string;
  recoveryResult: DamagedDvdRecoveryResult;
  signal: AbortSignal;
}

export type { DvdSalvageRejectionReason } from "@rip-dvd/data-access";

export type DvdSalvageValidationResult =
  | {
    badSectorCountsByTitle: readonly {
      badSectorCount: number;
      titleNumber: number;
    }[];
    outcome: "accepted";
  }
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
  | {
    affectedTitleSetBadSectorCounts: readonly {
      badSectorCount: number;
      titleSetNumber: number;
    }[];
    outcome: "accepted";
  }
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
    parsed.protocolVersion !== 2 ||
    !("outcome" in parsed)
  ) {
    throw new Error("DVD salvage classifier returned malformed output");
  }
  if (parsed.outcome === "accepted") {
    const affectedTitleSetBadSectorCounts =
      "affectedTitleSetBadSectorCounts" in parsed
      ? parsed.affectedTitleSetBadSectorCounts
      : undefined;
    if (
      !Array.isArray(affectedTitleSetBadSectorCounts) ||
      affectedTitleSetBadSectorCounts.length > 32
    ) {
      throw new Error("DVD salvage classifier returned malformed output");
    }
    let previousTitleSetNumber = 0;
    let classifiedBadSectorCount = 0;
    const counts: Array<{ badSectorCount: number; titleSetNumber: number }> = [];
    for (const value of affectedTitleSetBadSectorCounts) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("titleSetNumber" in value) ||
        !Number.isSafeInteger(value.titleSetNumber) ||
        (value.titleSetNumber as number) <= previousTitleSetNumber ||
        (value.titleSetNumber as number) > 99 ||
        !("badSectorCount" in value) ||
        !Number.isSafeInteger(value.badSectorCount) ||
        (value.badSectorCount as number) <= 0 ||
        (value.badSectorCount as number) > 32
      ) {
        throw new Error("DVD salvage classifier returned malformed output");
      }
      previousTitleSetNumber = value.titleSetNumber as number;
      classifiedBadSectorCount += value.badSectorCount as number;
      if (classifiedBadSectorCount > 32) {
        throw new Error("DVD salvage classifier returned malformed output");
      }
      counts.push({
        badSectorCount: value.badSectorCount as number,
        titleSetNumber: value.titleSetNumber as number,
      });
    }
    return {
      affectedTitleSetBadSectorCounts: counts,
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
      const classifiedBadSectorCount = result.affectedTitleSetBadSectorCounts
        .reduce((total, evidence) => total + evidence.badSectorCount, 0);
      if (classifiedBadSectorCount > recoveryResult.badSectorCount) {
        throw new Error("DVD salvage classifier returned malformed output");
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
      let observedNavigation;
      try {
        observedNavigation = decodeLsdvdNavigationMetadata(
          `${navigation.stdout}\n${navigation.stderr}`,
        );
      } catch (error) {
        throw new Error("DVD salvage navigation validation failed", {
          cause: error,
        });
      }
      if (
        canonicalizeDvdTitles(observedNavigation.titles) !==
          canonicalizeDvdTitles(expectedTitleMap.titles)
      ) {
        throw new Error("DVD salvage navigation validation changed the title map");
      }
      if (result.affectedTitleSetBadSectorCounts.length === 0) {
        return { badSectorCountsByTitle: [], outcome: "accepted" };
      }
      const titleSets = observedNavigation.titleSetsByTitleNumber;
      if (
        observedNavigation.titles.some((title) =>
          !titleSets.has(title.number)
        ) || titleSets.size !== observedNavigation.titles.length
      ) {
        throw new Error("DVD salvage navigation validation returned malformed output");
      }
      const badSectorCountsByTitleSet = new Map(
        result.affectedTitleSetBadSectorCounts.map((evidence) =>
          [evidence.titleSetNumber, evidence.badSectorCount] as const
        ),
      );
      const affectedTitles = expectedTitleMap.titles
        .flatMap((title) => {
          const badSectorCount = badSectorCountsByTitleSet.get(
            titleSets.get(title.number)!,
          );
          return badSectorCount === undefined
            ? []
            : [{ badSectorCount, title }];
        })
        .sort((left, right) => left.title.number - right.title.number);
      if (
        affectedTitles.length === 0 ||
        new Set(
          affectedTitles.map(({ title }) => titleSets.get(title.number)!),
        ).size !== badSectorCountsByTitleSet.size
      ) {
        throw new Error("DVD salvage navigation validation changed the title map");
      }
      if (affectedTitles.some(({ badSectorCount }) => badSectorCount > 16)) {
        return { outcome: "rejected", reason: "policy_limit" };
      }
      for (const { title } of affectedTitles) {
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
      return {
        badSectorCountsByTitle: affectedTitles.map(
          ({ badSectorCount, title }) => ({
            badSectorCount,
            titleNumber: title.number,
          }),
        ),
        outcome: "accepted",
      };
    },
  };
}

export function formatRejectedDvdSalvage(
  reason: DvdSalvageRejectionReason,
  recoveryResult: DamagedDvdRecoveryResult,
): string {
  return `DVD salvage rejected: unreadable sectors affect ${DVD_SALVAGE_REJECTION_DESCRIPTIONS[reason]}; ${recoveryResult.badSectorCount} ${recoveryResult.badSectorCount === 1 ? "sector" : "sectors"} in ${recoveryResult.badAreaCount} ${recoveryResult.badAreaCount === 1 ? "area" : "areas"}; LBAs ${formatDvdDamageRanges(recoveryResult)}`;
}
