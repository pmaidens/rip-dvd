import {
  DVD_SALVAGE_REJECTION_DESCRIPTIONS,
  type DvdSalvageRejectionReason,
} from "@rip-dvd/data-access";
import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

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
import { dvdTitleMapsAgree } from "./dvd-title-map-verification.js";
import {
  DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH,
  readDvdNavigation,
  runDvdLayoutClassifier,
} from "./dvd-validation-process.js";

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

type ClassifierResult =
  | {
    affectedTitleBadSectorCounts: readonly {
      badSectorCount: number;
      titleNumber: number;
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
    parsed.protocolVersion !== 3 ||
    !("outcome" in parsed)
  ) {
    throw new Error("DVD salvage classifier returned malformed output");
  }
  if (parsed.outcome === "accepted") {
    const affectedTitleBadSectorCounts =
      "affectedTitleBadSectorCounts" in parsed
      ? parsed.affectedTitleBadSectorCounts
      : undefined;
    if (
      !Array.isArray(affectedTitleBadSectorCounts) ||
      affectedTitleBadSectorCounts.length > 99
    ) {
      throw new Error("DVD salvage classifier returned malformed output");
    }
    let previousTitleNumber = 0;
    const counts: Array<{
      badSectorCount: number;
      titleNumber: number;
      titleSetNumber: number;
    }> = [];
    for (const value of affectedTitleBadSectorCounts) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("titleNumber" in value) ||
        !Number.isSafeInteger(value.titleNumber) ||
        (value.titleNumber as number) <= previousTitleNumber ||
        (value.titleNumber as number) > 99 ||
        !("titleSetNumber" in value) ||
        !Number.isSafeInteger(value.titleSetNumber) ||
        (value.titleSetNumber as number) <= 0 ||
        (value.titleSetNumber as number) > 99 ||
        !("badSectorCount" in value) ||
        !Number.isSafeInteger(value.badSectorCount) ||
        (value.badSectorCount as number) <= 0 ||
        (value.badSectorCount as number) > 32
      ) {
        throw new Error("DVD salvage classifier returned malformed output");
      }
      previousTitleNumber = value.titleNumber as number;
      counts.push({
        badSectorCount: value.badSectorCount as number,
        titleNumber: value.titleNumber as number,
        titleSetNumber: value.titleSetNumber as number,
      });
    }
    return {
      affectedTitleBadSectorCounts: counts,
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

export function createNodeDvdSalvageValidator({
  classifierScriptPath = DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH,
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
      const result = parseClassifierResult(await runDvdLayoutClassifier({
        arguments: [
          imagePath,
          String(recoveryResult.declaredByteCount),
          JSON.stringify(recoveryResult.unrecoveredSectorRanges),
        ],
        classifierScriptPath,
        failureMessage: "DVD salvage filesystem classification failed",
        runner,
        signal,
      }));
      if (result.outcome === "rejected") {
        return result;
      }
      if (result.affectedTitleBadSectorCounts.some((evidence) =>
        evidence.badSectorCount > recoveryResult.badSectorCount
      )) {
        throw new Error("DVD salvage classifier returned malformed output");
      }

      const observedNavigation = await readDvdNavigation({
        failureMessage: "DVD salvage navigation validation failed",
        imagePath,
        runner,
        signal,
      });
      if (
        !dvdTitleMapsAgree(expectedTitleMap, observedNavigation.titles)
      ) {
        throw new Error("DVD salvage navigation validation changed the title map");
      }
      if (result.affectedTitleBadSectorCounts.length === 0) {
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
      const badSectorCountsByTitle = new Map(
        result.affectedTitleBadSectorCounts.map((evidence) =>
          [evidence.titleNumber, evidence] as const
        ),
      );
      const affectedTitles = expectedTitleMap.titles
        .flatMap((title) => {
          const evidence = badSectorCountsByTitle.get(title.number);
          return evidence === undefined
            ? []
            : [{ badSectorCount: evidence.badSectorCount, title }];
        })
        .sort((left, right) => left.title.number - right.title.number);
      if (
        affectedTitles.length !== badSectorCountsByTitle.size ||
        result.affectedTitleBadSectorCounts.some((evidence) =>
          titleSets.get(evidence.titleNumber) !== evidence.titleSetNumber
        )
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
