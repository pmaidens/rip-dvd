import {
  createApplicationOperations,
  type CatalogReviewCommand,
} from "@rip-dvd/application";
import { loadConfig } from "@rip-dvd/config";
import { DomainInvariantError } from "@rip-dvd/data-access";

import { CommandFailure } from "./command.js";
import {
  runPreviewAcknowledgedCatalogCommand,
  type PreviewAcknowledgedCatalogCommandIO,
} from "./preview-acknowledged-catalog-command.js";

const acceptanceOptions = [
  "--key",
  "--revision",
  "--source-revision",
  "--preview-token",
  "--acknowledge",
  "--json",
  "--stdin",
  "--file",
] as const;

interface RearchiveAcceptanceIO
  extends PreviewAcknowledgedCatalogCommandIO {
  mediaLibraryPath?(): string;
}

function mediaLibraryPath(
  io: RearchiveAcceptanceIO,
  command: Extract<
    CatalogReviewCommand,
    { action: "accept_rearchive" }
  >,
): string {
  if (command.replacementEncodes.length === 0) return "/";
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

export function runRearchiveAcceptance(
  rest: readonly string[],
  io: RearchiveAcceptanceIO,
): unknown {
  return runPreviewAcknowledgedCatalogCommand(rest, io, {
    action: "accept_rearchive",
    workflowName: "Re-archive Acceptance",
    previewVerb: "preview-rearchive-acceptance",
    applyVerb: "accept-rearchive",
    allowedOptions: acceptanceOptions,
    previewForbiddenOptions: [
      "--key",
      "--revision",
      "--source-revision",
      "--preview-token",
      "--acknowledge",
    ],
    missingInputMessage: "Re-archive Acceptance requires JSON input.",
    invalidCommandCode: "INVALID_REARCHIVE_ACCEPTANCE",
    expectedCommandMessage: "Expected an accept_rearchive command.",
    previewAcknowledgementMessage:
      "Acknowledgement of a Re-archive Acceptance preview is required.",
    prepareContext: mediaLibraryPath,
    preview: ({ access, archiveId, command, context }) =>
      createApplicationOperations(access).previewRearchiveAcceptance(
        archiveId,
        command,
        context,
      ),
    apply: ({ access, archiveId, command, options, context }) =>
      createApplicationOperations(access).acceptRearchive(
        archiveId,
        command,
        {
          mediaLibraryPath: context,
          mutationKey: options.get("--key"),
          acknowledgedRevision: options.get("--revision"),
          acknowledgedSourceRevision: options.get("--source-revision"),
          previewToken: options.get("--preview-token"),
          acknowledge: true,
        },
      ),
    domainFailure: (error: DomainInvariantError) => new CommandFailure(
      error.message.includes("preview is stale")
        ? "STALE_REARCHIVE_ACCEPTANCE_PREVIEW"
        : "REARCHIVE_ACCEPTANCE_REJECTED",
      error.message,
      2,
    ),
    unavailableFailure: () => new CommandFailure(
      "REARCHIVE_ACCEPTANCE_UNAVAILABLE",
      "Re-archive Acceptance is unavailable.",
      1,
    ),
  });
}
