import { createApplicationOperations } from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import { DomainInvariantError } from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  runPreviewAcknowledgedCatalogCommand,
  type PreviewAcknowledgedCatalogCommandIO,
} from "./preview-acknowledged-catalog-command.js";

interface CompletionIO extends PreviewAcknowledgedCatalogCommandIO {
  mediaLibraryPath?(): string;
}

const completionOptions = [
  "--key",
  "--revision",
  "--preview-token",
  "--acknowledge",
  "--json",
  "--stdin",
  "--file",
] as const;

function mediaLibraryPath(io: CompletionIO): string {
  try {
    return io.mediaLibraryPath?.() ?? loadConfig().mediaLibraryPath;
  } catch {
    throw new CommandFailure(
      "CONFIGURATION_ERROR",
      "Media library configuration is unavailable.",
      1,
    );
  }
}

export function runCatalogReviewCompletion(
  rest: readonly string[],
  io: CompletionIO,
): unknown {
  return runPreviewAcknowledgedCatalogCommand(rest, io, {
    action: "complete_review",
    workflowName: "Catalog Review completion",
    previewVerb: "preview-completion",
    applyVerb: "complete",
    allowedOptions: completionOptions,
    previewForbiddenOptions: [
      "--key",
      "--revision",
      "--preview-token",
      "--acknowledge",
    ],
    missingInputMessage: "Catalog Review completion requires JSON input.",
    invalidCommandCode: "INVALID_COMPLETION_PLAN",
    expectedCommandMessage: "Expected a complete_review command.",
    previewAcknowledgementMessage:
      "Acknowledgement of a Catalog Review completion preview is required.",
    prepareContext: mediaLibraryPath,
    preview: ({ access, archiveId, command, context }) =>
      createApplicationOperations(access).previewCatalogReviewCompletion(
        archiveId,
        command,
        context,
      ),
    apply: ({ access, archiveId, command, options, context }) =>
      createApplicationOperations(access).completeCatalogReview(
        archiveId,
        command,
        {
          mediaLibraryPath: context,
          mutationKey: options.get("--key"),
          acknowledgedRevision: options.get("--revision"),
          previewToken: options.get("--preview-token"),
          acknowledge: true,
        },
      ),
    domainFailure: (error: DomainInvariantError) => new CommandFailure(
      "REVIEW_COMPLETION_REJECTED",
      error.message,
      2,
    ),
    unavailableFailure: () => new CommandFailure(
      "REVIEW_COMPLETION_UNAVAILABLE",
      "Catalog Review completion is unavailable.",
      1,
    ),
  });
}
