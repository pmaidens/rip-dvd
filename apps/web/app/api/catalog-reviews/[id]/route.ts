import {
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  MutationKeyConflictError,
  RecordNotFoundError,
  type DataAccess,
  type DiscSelectionId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";
import {
  applyMappingProposal,
  createApplicationOperations,
  executeDiscSelectionCommand,
  InvalidMutationKeyError,
  parseMutationKey,
  previewDiscSelectionChange,
} from "@rip-dvd/application";

import {
  discSelectionCommandRequiresPreview,
  parseCatalogReviewCommand,
} from "../../../../lib/catalog-review-command";
import { getDataAccess } from "../../../../lib/data-access";
import {
  trustedMutationRequestProblem,
} from "../../../../lib/server/trusted-mutation-request";
import { tmdbCredentialFromEnvironment } from "../../../../lib/server/tmdb-catalog-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function requestRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function requestRevision(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const revision = new Date(value);
  return Number.isSafeInteger(revision.getTime()) && revision.toISOString() === value
    ? revision : null;
}

function recordOffset(request: Request, parameter: string): number | null {
  const values = new URL(request.url).searchParams.getAll(parameter);
  if (values.length === 0) {
    return 0;
  }
  const value = values[0]!;
  if (values.length !== 1) {
    return null;
  }
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) {
    return null;
  }
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

export async function createCatalogReviewRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
  getMediaLibraryPath: () => string = () => loadConfig().mediaLibraryPath,
  isAutomaticCatalogingConfigured: () => boolean = () =>
    tmdbCredentialFromEnvironment() !== null,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }
  if (id.trim().length === 0 || id.length > 256) {
    return response({ error: "Invalid Original Disc Archive" }, 400);
  }
  try {
    const archiveId = id as OriginalDiscArchiveId;
    if (request.method === "GET") {
      const parameters = new URL(request.url).searchParams;
      const discSelectionOffset = recordOffset(request, "selectionOffset");
      const correctionHistoryOffset = recordOffset(
        request,
        "correctionOffset",
      );
      const correctionEncodeHistoryOffset = recordOffset(
        request,
        "correctionJobOffset",
      );
      const correctionRetainedOutputHistoryOffset = recordOffset(
        request,
        "correctionOutputOffset",
      );
      const replacementOffset = recordOffset(request, "replacementOffset");
      const replacementProfileOffset = recordOffset(
        request,
        "replacementProfileOffset",
      );
      if (
        [...parameters.keys()].some((key) =>
          key !== "selectionOffset" && key !== "correctionOffset" &&
          key !== "correctionJobOffset" &&
          key !== "correctionOutputOffset" &&
          key !== "replacementOffset" &&
          key !== "replacementProfileOffset"
        ) ||
        discSelectionOffset === null || correctionHistoryOffset === null ||
        correctionEncodeHistoryOffset === null ||
        correctionRetainedOutputHistoryOffset === null ||
        replacementOffset === null || replacementProfileOffset === null
      ) {
        return response({ error: "Invalid Catalog Review query" }, 400);
      }
      const review = createApplicationOperations(getAccess()).catalogReview(
        archiveId,
        {
          discSelectionOffset,
          correctionHistoryOffset,
          correctionEncodeHistoryOffset,
          correctionRetainedOutputHistoryOffset,
          replacementOffset,
          replacementProfileOffset,
        },
        isAutomaticCatalogingConfigured(),
      );
      return review === null
        ? response({ error: "Original Disc Archive not found" }, 404)
        : response(review);
    }

    let trustedOrigin: string;
    try {
      trustedOrigin = getTrustedOrigin();
    } catch {
      return response({ error: "Catalog review mutation is unavailable" }, 503);
    }
    const problem = trustedMutationRequestProblem(request, trustedOrigin);
    if (problem) {
      return problem;
    }
    const access = getAccess();
    if (
      access.catalog.listOriginalDiscArchives({ ids: [archiveId] }).length === 0
    ) {
      return response({ error: "Original Disc Archive not found" }, 404);
    }
    const body: unknown = await request.json().catch(() => null);
    const bodyRecord = requestRecord(body);
    const parsedCommand = parseCatalogReviewCommand(
      body,
      {
        mediaItemKinds: MEDIA_ITEM_KINDS,
      },
    );
    const targetedDiscSelectionId = parsedCommand.ok
      ? parsedCommand.command.action === "update_disc_selection" ||
          parsedCommand.command.action === "repair_disc_selection" ||
          parsedCommand.command.action === "correct_disc_selection" ||
          parsedCommand.command.action === "delete_disc_selection"
        ? parsedCommand.command.discSelectionId
        : null
      : parsedCommand.targetedDiscSelectionId ?? null;
    const mayReplay = bodyRecord !== null && typeof bodyRecord.mutationKey === "string";
    if (targetedDiscSelectionId !== null && !mayReplay) {
      const existing = access.catalog.listDiscSelections({
        ids: [targetedDiscSelectionId as DiscSelectionId],
        originalDiscArchiveId: archiveId,
      })[0];
      if (!existing) {
        return response({ error: "Disc Selection not found" }, 404);
      }
    }
    if (!parsedCommand.ok) {
      return response({ error: parsedCommand.error }, 400);
    }
    const command = parsedCommand.command;

    let proposalMutationKey: string | undefined;
    if (command.action === "create_mapping_proposal" ||
        command.action === "create_episodic_mapping_proposal") {
      const value = typeof body === "object" && body !== null &&
        !Array.isArray(body) && "mutationKey" in body
        ? body.mutationKey : undefined;
      proposalMutationKey = parseMutationKey(value);
    }

    switch (command.action) {
      case "preview_rearchive_mapping_proposal":
        return response(
          createApplicationOperations(access).previewRearchiveMappingProposal({
            originalDiscArchiveId: archiveId,
            catalogRevision: command.catalogRevision,
            sourceCatalogRevision: command.sourceCatalogRevision,
            mappings: command.mappings,
          }),
        );

      case "save_rearchive_mapping_proposal":
        return response(
          createApplicationOperations(access).saveRearchiveMappingProposal({
            originalDiscArchiveId: archiveId,
            mutationKey: bodyRecord?.mutationKey,
            catalogRevision: command.catalogRevision,
            sourceCatalogRevision: command.sourceCatalogRevision,
            mappings: command.mappings,
          }),
        );

      case "create_episodic_mapping_proposal":
      case "create_mapping_proposal":
        return response(
          applyMappingProposal(access, archiveId, command, proposalMutationKey!),
          201,
        );

      case "create_media_item": {
        const mutationKey = typeof body === "object" && body !== null && "mutationKey" in body
          ? body.mutationKey : undefined;
        return response(createApplicationOperations(access).mutateMediaItem({
          mutationKey,
          command,
        }), 201);
      }

      case "update_media_item":
      case "delete_media_item": {
        const payload = typeof body === "object" && body !== null
          ? body as Record<string, unknown> : {};
        return response(createApplicationOperations(access).mutateMediaItem({
          mutationKey: payload.mutationKey,
          command,
          acknowledgedRevision: payload.acknowledgedRevision as string | undefined,
        }));
      }

      case "create_disc_selection":
      case "update_disc_selection":
      case "repair_disc_selection":
      case "correct_disc_selection":
      case "delete_disc_selection": {
        const consequential = discSelectionCommandRequiresPreview(command);
        if (bodyRecord?.preview === true) {
          if (!consequential) {
            return response({ error: "This Disc Selection change does not require a preview" }, 400);
          }
          return response(previewDiscSelectionChange(access, archiveId, command));
        }
        let mutationKey: string;
        try {
          mutationKey = parseMutationKey(bodyRecord?.mutationKey);
        } catch {
          return response({ error: "Invalid Disc Selection mutation key" }, 400);
        }
        if (!consequential) {
          return response(
            executeDiscSelectionCommand(access, archiveId, command, { mutationKey }),
            command.action === "create_disc_selection" ? 201 : 200,
          );
        }
        const expectedCatalogRevision = requestRevision(bodyRecord?.expectedCatalogRevision);
        const previewToken = bodyRecord?.previewToken;
        if (bodyRecord?.acknowledge !== true || expectedCatalogRevision === null ||
            typeof previewToken !== "string" || previewToken.length > 4_096) {
          return response({ error: "Disc Selection preview acknowledgement is required" }, 400);
        }
        return response(
          executeDiscSelectionCommand(access, archiveId, command, {
            mutationKey, expectedCatalogRevision, previewToken, acknowledged: true,
          }),
        );
      }

      case "complete_review": {
        let mediaLibraryPath = "/";
        if (command.replacementEncodes.length > 0) {
          try {
            mediaLibraryPath = getMediaLibraryPath();
          } catch {
            return response(
              { error: "Corrected replacement queueing is unavailable" },
              503,
            );
          }
        }
        const operations = createApplicationOperations(access);
        if (bodyRecord?.preview === true) {
          return response(operations.previewCatalogReviewCompletion(
            archiveId,
            command,
            mediaLibraryPath,
          ));
        }
        return response(operations.completeCatalogReview(
          archiveId,
          command,
          {
            mediaLibraryPath,
            mutationKey: bodyRecord?.mutationKey,
            acknowledgedRevision: bodyRecord?.acknowledgedRevision,
            previewToken: bodyRecord?.previewToken,
            acknowledge: bodyRecord?.acknowledge,
          },
        ));
      }

      default:
        command satisfies never;
        throw new Error("Unhandled catalog review command");
    }
  } catch (error) {
    if (error instanceof InvalidMutationKeyError) {
      return response({ error: error.message, code: "INVALID_MUTATION_KEY" }, 400);
    }
    if (error instanceof MutationKeyConflictError) {
      return response({ error: error.message, code: "MUTATION_KEY_CONFLICT" }, 409);
    }
    if (error instanceof RecordNotFoundError) {
      return response({ error: error.message }, 404);
    }
    if (error instanceof DomainInvariantError) {
      return response({ error: error.message }, 409);
    }
    return response({ error: "Catalog review is unavailable" }, 503);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createCatalogReviewRoute(request, id);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return createCatalogReviewRoute(request, id);
}
