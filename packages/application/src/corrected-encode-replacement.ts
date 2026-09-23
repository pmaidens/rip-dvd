import {
  DomainInvariantError,
  type CorrectedEncodeReplacementInput,
} from "@rip-dvd/data-access";

import type { CatalogReviewReplacementEncodeInput } from "./catalog-review-command.js";
import { mediaOutputPath } from "./media-output-path.js";

export function normalizeCorrectedEncodeReplacements(
  replacements: readonly CatalogReviewReplacementEncodeInput[],
  mediaLibraryPath: string,
): CorrectedEncodeReplacementInput[] {
  return replacements.map((requested) => {
    const outputPath = mediaOutputPath(requested.outputPath, mediaLibraryPath);
    if (outputPath === null) {
      throw new DomainInvariantError(
        "Corrected replacement output path is invalid",
      );
    }
    return {
      predecessorEncodeJobId: requested.predecessorEncodeJobId,
      encodingProfileId: requested.encodingProfileId,
      outputPath,
      ...(requested.priority === undefined
        ? {}
        : { priority: requested.priority }),
    };
  });
}
