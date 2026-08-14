import { fileURLToPath } from "node:url";

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

export const DVD_UNUSED_SPACE_SALVAGE_POLICY_VERSION =
  "dvd-unused-space-v1";

export interface DvdSalvageValidationRequest {
  expectedTitleMap: DvdTitleMap;
  imagePath: string;
  recoveryResult: DamagedDvdRecoveryResult;
  signal: AbortSignal;
}

export type DvdSalvageRejectionReason =
  | "filesystem_metadata"
  | "directory_data"
  | "ifo"
  | "bup"
  | "menu"
  | "navigation"
  | "referenced_content"
  | "ambiguous"
  | "unmappable"
  | "consecutive_damage"
  | "policy_limit";

export type DvdSalvageValidationResult =
  | { outcome: "accepted" }
  | { outcome: "rejected"; reason: DvdSalvageRejectionReason };

export interface DvdSalvageValidator {
  validate(
    request: DvdSalvageValidationRequest,
  ): Promise<DvdSalvageValidationResult>;
}

const REJECTION_DESCRIPTIONS = {
  filesystem_metadata: "filesystem metadata",
  directory_data: "filesystem directory data",
  ifo: "DVD IFO data",
  bup: "DVD backup data",
  menu: "DVD menu data",
  navigation: "DVD navigation data",
  referenced_content: "referenced DVD content",
  ambiguous: "an ambiguous DVD region",
  unmappable: "an unmappable DVD region",
  consecutive_damage: "consecutive unreadable sectors",
  policy_limit: "damage beyond the automatic salvage policy limit",
} satisfies Record<DvdSalvageRejectionReason, string>;

const CLASSIFIER_OUTPUT_LIMIT_BYTES = 4_096;
const CLASSIFIER_TIMEOUT_MS = 5 * 60_000;
const NAVIGATION_OUTPUT_LIMIT_BYTES = 1_048_576;
const NAVIGATION_TIMEOUT_MS = 5 * 60_000;
const CLASSIFIER_SCRIPT_PATH = fileURLToPath(
  new URL("./dvd-layout-classifier-cli.js", import.meta.url),
);

function parseClassifierResult(payload: string): DvdSalvageValidationResult {
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
    return { outcome: "accepted" };
  }
  if (
    parsed.outcome === "rejected" &&
    "reason" in parsed &&
    typeof parsed.reason === "string" &&
    parsed.reason in REJECTION_DESCRIPTIONS
  ) {
    return {
      outcome: "rejected",
      reason: parsed.reason as DvdSalvageRejectionReason,
    };
  }
  throw new Error("DVD salvage classifier returned malformed output");
}

function normalizedTitleMap(titleMap: DvdTitleMap): string {
  return JSON.stringify(
    [...titleMap.titles].sort((left, right) => left.number - right.number),
  );
}

export function createNodeDvdSalvageValidator({
  classifierScriptPath = CLASSIFIER_SCRIPT_PATH,
  runner = nodeCommandRunner,
}: {
  classifierScriptPath?: string;
  runner?: CommandRunner;
} = {}): DvdSalvageValidator {
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
        normalizedTitleMap({
          ...expectedTitleMap,
          titles: observedTitleMap.titles,
        }) !== normalizedTitleMap(expectedTitleMap)
      ) {
        throw new Error("DVD salvage navigation validation changed the title map");
      }
      return { outcome: "accepted" };
    },
  };
}

export function formatRejectedDvdSalvage(
  reason: DvdSalvageRejectionReason,
  recoveryResult: DamagedDvdRecoveryResult,
): string {
  return `DVD salvage rejected: unreadable sectors affect ${REJECTION_DESCRIPTIONS[reason]}; ${recoveryResult.badSectorCount} ${recoveryResult.badSectorCount === 1 ? "sector" : "sectors"} in ${recoveryResult.badAreaCount} ${recoveryResult.badAreaCount === 1 ? "area" : "areas"}; LBAs ${formatDvdDamageRanges(recoveryResult)}`;
}
