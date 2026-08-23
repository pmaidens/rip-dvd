import type { DvdTitleMap } from "@rip-dvd/data-access/dvd-scan";

import {
  nodeCommandRunner,
  type CommandRunner,
} from "./optical-drive-command-runner.js";
import { dvdTitleMapsAgree } from "./dvd-title-map-verification.js";
import {
  DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH,
  readDvdNavigation,
  runDvdLayoutClassifier,
} from "./dvd-validation-process.js";

export interface DvdCompletenessProofRequest {
  candidateBoundaryLba: number;
  expectedTitleMap: DvdTitleMap;
  imagePath: string;
  signal: AbortSignal;
}

export interface DvdCompletenessProof {
  maximumReferencedLba: number;
}

export interface DvdCompletenessProver {
  prove(request: DvdCompletenessProofRequest): Promise<DvdCompletenessProof>;
}

function parseClassifierProof(
  payload: string,
  candidateBoundaryLba: number,
): DvdCompletenessProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("DVD completeness classifier returned malformed output");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("protocolVersion" in parsed) ||
    parsed.protocolVersion !== 1 ||
    !("maximumReferencedLba" in parsed) ||
    !Number.isSafeInteger(parsed.maximumReferencedLba) ||
    (parsed.maximumReferencedLba as number) < 0 ||
    (parsed.maximumReferencedLba as number) >= candidateBoundaryLba
  ) {
    throw new Error("DVD completeness classifier returned malformed output");
  }
  return {
    maximumReferencedLba: parsed.maximumReferencedLba as number,
  };
}

export function createNodeDvdCompletenessProver({
  classifierScriptPath = DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH,
  runner = nodeCommandRunner,
}: {
  classifierScriptPath?: string;
  runner?: CommandRunner;
} = {}): DvdCompletenessProver {
  return {
    async prove({
      candidateBoundaryLba,
      expectedTitleMap,
      imagePath,
      signal,
    }) {
      if (
        !Number.isSafeInteger(candidateBoundaryLba) ||
        candidateBoundaryLba <= 0
      ) {
        throw new Error("DVD completeness proof boundary is invalid");
      }
      const proof = parseClassifierProof(
        await runDvdLayoutClassifier({
          arguments: ["proof", imagePath, String(candidateBoundaryLba)],
          classifierScriptPath,
          failureMessage: "DVD completeness filesystem proof failed",
          runner,
          signal,
        }),
        candidateBoundaryLba,
      );
      const observedNavigation = await readDvdNavigation({
        failureMessage: "DVD completeness navigation proof failed",
        imagePath,
        runner,
        signal,
      });
      if (!dvdTitleMapsAgree(expectedTitleMap, observedNavigation.titles)) {
        throw new Error("DVD completeness proof changed the title map");
      }
      return proof;
    },
  };
}
