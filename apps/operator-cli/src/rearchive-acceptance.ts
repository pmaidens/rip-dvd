import { createApplicationOperations } from "@rip-dvd/application";
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

export function runRearchiveAcceptance(
  rest: readonly string[],
  io: PreviewAcknowledgedCatalogCommandIO,
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
    prepareContext: () => undefined,
    preview: ({ access, archiveId, command }) =>
      createApplicationOperations(access).previewRearchiveAcceptance(
        archiveId,
        command,
      ),
    apply: ({ access, archiveId, command, options }) =>
      createApplicationOperations(access).acceptRearchive(
        archiveId,
        command,
        {
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
