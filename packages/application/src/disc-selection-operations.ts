import {
  DomainInvariantError,
  type DataAccess,
  type DiscSelectionAction,
  type DiscSelectionId,
  type DiscSelectionMutation,
  type MediaItemId,
  type OriginalDiscArchiveId,
  type UpdateDiscSelectionInput,
} from "@rip-dvd/data-access";

import {
  discSelectionCommandRequiresPreview,
  type DiscSelectionCommand,
} from "./catalog-review-command.js";
import { serializeDiscSelection } from "./catalog-review-read.js";
import {
  createDiscSelectionPreviewToken,
  isDiscSelectionPreviewToken,
} from "./disc-selection-preview-token.js";
import { parseMutationKey } from "./mutation-key.js";

type SelectionCommand = DiscSelectionCommand;

type PreviewSelectionCommand = Exclude<SelectionCommand, { action: "create_disc_selection" }>;

const discSelectionActionByCommand = {
  update_disc_selection: "update",
  repair_disc_selection: "repair",
  correct_disc_selection: "correct",
  delete_disc_selection: "remove",
} as const satisfies Record<PreviewSelectionCommand["action"], DiscSelectionAction>;

function isActionAvailable(
  command: PreviewSelectionCommand,
  actions: readonly DiscSelectionAction[],
): boolean {
  return actions.includes(discSelectionActionByCommand[command.action]);
}

function blockedReason(command: PreviewSelectionCommand, reason: string | null): string {
  if (reason !== null) return reason;
  if (command.action === "repair_disc_selection") {
    return "Repair is available only for an unsafe legacy Disc Selection";
  }
  if (command.action === "correct_disc_selection") {
    return "Correction requires preserved Encode Job or Disc Selection history";
  }
  return "This Disc Selection action is unavailable";
}

function readDiscSelectionPreview(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  selectionId: DiscSelectionId,
) {
  const preview = access.catalog.previewDiscSelectionMutation(archiveId, selectionId);
  return {
    details: {
      catalogRevision: preview.catalogRevision,
      discSelection: serializeDiscSelection(preview.discSelection),
      actionAvailability: preview.actionAvailability,
      affectedEncodeJobs: preview.affectedEncodeJobs,
      outputReservationReleaseJobs: preview.outputReservationReleaseJobs,
      historicalEncodeJobCount: preview.historicalEncodeJobCount,
    },
    evidenceHash: preview.evidenceHash,
  };
}

export function previewDiscSelection(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  selectionId: DiscSelectionId,
) {
  return readDiscSelectionPreview(access, archiveId, selectionId).details;
}

function discSelectionMutation(
  archiveId: OriginalDiscArchiveId,
  command: SelectionCommand,
): DiscSelectionMutation {
  let mutation: DiscSelectionMutation;
  switch (command.action) {
    case "create_disc_selection":
      mutation = { action: "create", selection: {
        originalDiscArchiveId: archiveId,
        mediaItemId: command.selection.mediaItemId as MediaItemId,
        sourceIdentity: command.selection.sourceIdentity,
        ...(command.selection.label ? { label: command.selection.label } : {}),
      } };
      break;
    case "update_disc_selection":
      mutation = { action: "update", discSelectionId: command.discSelectionId as DiscSelectionId,
        changes: { originalDiscArchiveId: archiveId,
          ...command.changes,
          ...(command.changes.mediaItemId ? { mediaItemId: command.changes.mediaItemId as MediaItemId } : {}),
        } as UpdateDiscSelectionInput,
      };
      break;
    case "repair_disc_selection":
    case "correct_disc_selection": {
      const selection = {
        originalDiscArchiveId: archiveId,
        mediaItemId: command.selection.mediaItemId as MediaItemId,
        sourceIdentity: command.selection.sourceIdentity,
        ...(command.selection.label ? { label: command.selection.label } : {}),
      };
      mutation = command.action === "repair_disc_selection"
        ? { action: "repair", discSelectionId: command.discSelectionId as DiscSelectionId, selection }
        : { action: "correct", discSelectionId: command.discSelectionId as DiscSelectionId,
          selection: { ...selection, catalogRevision: new Date(command.catalogRevision),
            ...(command.correctionReason ? { reason: command.correctionReason } : {}) },
        };
      break;
    }
    case "delete_disc_selection":
      mutation = { action: "delete", discSelectionId: command.discSelectionId as DiscSelectionId };
      break;
  }
  return mutation;
}

export function previewDiscSelectionChange(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  command: SelectionCommand,
) {
  if (!discSelectionCommandRequiresPreview(command)) {
    throw new DomainInvariantError("This Disc Selection change does not require a preview");
  }
  const preview = readDiscSelectionPreview(
    access, archiveId, command.discSelectionId as DiscSelectionId,
  );
  const current = preview.details;
  if (!isActionAvailable(command, current.actionAvailability.availableActions)) {
    return {
      ...current,
      action: command.action,
      state: "blocked" as const,
      reason: blockedReason(command, current.actionAvailability.reason),
      relatedEncodeJob: current.actionAvailability.relatedEncodeJob,
    };
  }
  const mutation = discSelectionMutation(archiveId, command);
  const catalogRevision = new Date(current.catalogRevision);
  if (mutation.action === "correct" &&
      mutation.selection.catalogRevision.getTime() !== catalogRevision.getTime()) {
    throw new DomainInvariantError("Catalog review revision is stale");
  }
  const proposed = access.catalog.previewDiscSelectionChange({
    originalDiscArchiveId: archiveId,
    expectedCatalogRevision: catalogRevision,
    mutation,
  });
  const previewToken = createDiscSelectionPreviewToken();
  access.catalog.recordDiscSelectionPreviewDecision({
    previewToken,
    originalDiscArchiveId: archiveId,
    expectedCatalogRevision: catalogRevision,
    expectedPreviewEvidenceHash: preview.evidenceHash,
    mutation,
  });
  return {
    ...current,
    action: command.action,
    state: "available" as const,
    previewToken,
    proposedDiscSelection: mutation.action === "delete" ? null : {
      mediaItemId: proposed.discSelection.mediaItemId,
      sourceIdentity: proposed.discSelection.sourceIdentity,
      label: proposed.discSelection.label,
    },
    ...(proposed.deletionComplete === undefined ? {} : { deletionComplete: proposed.deletionComplete }),
    consequences: {
      currentSelection: mutation.action === "correct" ? "superseded"
        : mutation.action === "delete" ? proposed.discSelection.id === current.discSelection.id &&
          current.historicalEncodeJobCount === 0 && current.actionAvailability.state !== "correction_lineage"
          ? "deleted" : "deactivated"
        : proposed.discSelection.id === current.discSelection.id ? "updated" : "deactivated",
      createsReplacementSelection: mutation.action === "correct" ||
        (mutation.action === "repair" && proposed.discSelection.id !== current.discSelection.id),
      requestsEncodeJobCancellation: mutation.action === "correct"
        ? current.affectedEncodeJobs
          .filter((job) => job.status === "queued" || job.status === "running")
          .map((job) => job.id) : [],
      releasesOutputReservations: mutation.action === "repair" || mutation.action === "delete"
        ? current.outputReservationReleaseJobs.map((job) => job.id) : [],
      preservesEncodeJobHistory: current.historicalEncodeJobCount > 0,
      reopensCatalogReview: true,
    },
  };
}

export function executeDiscSelectionCommand(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
  command: SelectionCommand,
  options: {
    mutationKey?: string;
    expectedCatalogRevision?: Date;
    previewToken?: string;
    acknowledged?: true;
  } = {},
) {
  const mutation = discSelectionMutation(archiveId, command);
  const mutationKey = parseMutationKey(options.mutationKey);
  const requiresPreview = discSelectionCommandRequiresPreview(command);
  if (requiresPreview && (options.acknowledged !== true || !options.expectedCatalogRevision ||
      !options.previewToken)) {
    throw new DomainInvariantError("Disc Selection preview acknowledgement is required");
  }
  if (!requiresPreview && (options.acknowledged === true || options.expectedCatalogRevision ||
      options.previewToken)) {
    throw new DomainInvariantError("This Disc Selection change does not require a preview");
  }
  if (options.previewToken !== undefined) {
    if (!options.expectedCatalogRevision || mutation.action === "create") {
      throw new DomainInvariantError("Disc Selection preview does not match the proposed change");
    }
    if (!isDiscSelectionPreviewToken(options.previewToken)) {
      throw new DomainInvariantError("Disc Selection preview does not match the proposed change");
    }
  }
  const result = access.catalog.mutateDiscSelection({
    originalDiscArchiveId: archiveId,
    mutation,
    mutationKey,
    ...(options.expectedCatalogRevision ? { expectedCatalogRevision: options.expectedCatalogRevision } : {}),
    ...(options.previewToken ? { previewToken: options.previewToken } : {}),
  });
  return {
    message: "Mapping changed; review required",
    discSelection: serializeDiscSelection(result.discSelection),
    ...(result.supersession ? { supersession: {
      ...result.supersession,
      createdAt: result.supersession.createdAt.toISOString(),
    } } : {}),
    ...(result.deletedEncodeJobs === undefined ? {} : {
      deletedEncodeJobs: result.deletedEncodeJobs,
      deletionComplete: result.deletionComplete,
    }),
  };
}
