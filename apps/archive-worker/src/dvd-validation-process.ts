import { fileURLToPath } from "node:url";

import { decodeLsdvdNavigationMetadata } from "./dvd-metadata.js";
import type { CommandRunner } from "./optical-drive-command-runner.js";

const CLASSIFIER_OUTPUT_LIMIT_BYTES = 4_096;
const CLASSIFIER_TIMEOUT_MS = 5 * 60_000;
const NAVIGATION_OUTPUT_LIMIT_BYTES = 1_048_576;
const NAVIGATION_TIMEOUT_MS = 5 * 60_000;

export const DVD_LAYOUT_CLASSIFIER_SCRIPT_PATH = fileURLToPath(
  new URL("./dvd-layout-classifier-cli.js", import.meta.url),
);

export async function runDvdLayoutClassifier({
  arguments: classifierArguments,
  classifierScriptPath,
  failureMessage,
  runner,
  signal,
}: {
  arguments: readonly string[];
  classifierScriptPath: string;
  failureMessage: string;
  runner: CommandRunner;
  signal: AbortSignal;
}): Promise<string> {
  let classification;
  try {
    classification = await runner.run(
      process.execPath,
      [classifierScriptPath, ...classifierArguments],
      {
        maxBufferBytes: CLASSIFIER_OUTPUT_LIMIT_BYTES,
        signal,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw new Error(failureMessage, { cause: error });
  }
  if (classification.exitCode !== 0 || classification.stderr.trim() !== "") {
    throw new Error(failureMessage);
  }
  return classification.stdout.trim();
}

export async function readDvdNavigation({
  failureMessage,
  imagePath,
  runner,
  signal,
}: {
  failureMessage: string;
  imagePath: string;
  runner: CommandRunner;
  signal: AbortSignal;
}) {
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
    throw new Error(failureMessage, { cause: error });
  }
  if (navigation.exitCode !== 0) {
    throw new Error(failureMessage);
  }
  try {
    return decodeLsdvdNavigationMetadata(
      `${navigation.stdout}\n${navigation.stderr}`,
    );
  } catch (error) {
    throw new Error(failureMessage, { cause: error });
  }
}
