import {
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  RecordNotFoundError,
  type DataAccess,
  type CreateMediaItemInput,
  type DiscSelectionId,
  type EncodeJobId,
  type EncodingProfileId,
  type MediaItemId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";
import { createApplicationOperations, executeDiscSelectionCommand, serializeDiscSelection, serializeMediaItem } from "@rip-dvd/application";

import {
  parseCatalogReviewCommand,
  type CatalogReviewMediaItemInput,
} from "../../../../lib/catalog-review-command";
import { getDataAccess } from "../../../../lib/data-access";
import {
  trustedMutationRequestProblem,
} from "../../../../lib/server/trusted-mutation-request";
import { mediaOutputPath } from "../../../../lib/server/media-output-path";
import { tmdbCredentialFromEnvironment } from "../../../../lib/server/tmdb-catalog-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

function createMediaItemInput(
  input: CatalogReviewMediaItemInput,
): CreateMediaItemInput {
  return {
    ...(input.parentId
      ? { parentId: input.parentId as MediaItemId }
      : {}),
    kind: input.kind,
    title: input.title,
    ...(input.year === null || input.year === undefined
      ? {}
      : { year: input.year }),
    ...(input.seasonNumber === null || input.seasonNumber === undefined
      ? {}
      : { seasonNumber: input.seasonNumber }),
    ...(input.episodeNumber === null || input.episodeNumber === undefined
      ? {}
      : { episodeNumber: input.episodeNumber }),
    ...(input.tmdbIdentity === undefined
      ? {}
      : { tmdbIdentity: input.tmdbIdentity }),
  };
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
    const parsedCommand = parseCatalogReviewCommand(
      await request.json().catch(() => null),
      {
        mediaItemKinds: MEDIA_ITEM_KINDS,
      },
    );
    const targetedDiscSelectionId = parsedCommand.ok
      ? parsedCommand.command.action === "update_disc_selection" ||
          parsedCommand.command.action === "repair_disc_selection" ||
          parsedCommand.command.action === "correct_disc_selection"
        ? parsedCommand.command.discSelectionId
        : null
      : parsedCommand.targetedDiscSelectionId ?? null;
    if (targetedDiscSelectionId !== null) {
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

    switch (command.action) {
      case "create_episodic_mapping_proposal": {
        const proposal = access.catalog.createEpisodicMappingProposal({
          originalDiscArchiveId: archiveId,
          catalogRevision: new Date(command.catalogRevision),
          tvShow: command.tvShow.choice === "create_new"
            ? {
                choice: "create_new",
                title: command.tvShow.title,
                ...(command.tvShow.year === null ||
                    command.tvShow.year === undefined
                  ? {}
                  : { year: command.tvShow.year }),
                ...(command.tvShow.tmdbIdentity === undefined
                  ? {}
                  : { tmdbIdentity: command.tvShow.tmdbIdentity }),
              }
            : {
                choice: "use_existing",
                mediaItemId: command.tvShow.mediaItemId as MediaItemId,
                ...(command.tvShow.tmdbIdentity === undefined
                  ? {}
                  : { tmdbIdentity: command.tvShow.tmdbIdentity }),
              },
          season: command.season.choice === "create_new"
            ? command.season
            : {
                choice: "use_existing",
                mediaItemId: command.season.mediaItemId as MediaItemId,
              },
          episodes: command.episodes.map(({
            existingMediaItemId,
            ...episode
          }) => ({
            ...episode,
            ...(existingMediaItemId === undefined
              ? {}
              : {
                existingMediaItemId: existingMediaItemId as MediaItemId,
              }),
          })),
          ...(command.completeReview ? { completeReview: true } : {}),
        });
        return response({
          message: command.completeReview
            ? "Cataloged and review completed"
            : "Mapping changed; review required",
          tvShow: serializeMediaItem(proposal.tvShow),
          season: serializeMediaItem(proposal.season),
          episodes: proposal.episodes.map((episode) => ({
            mediaItem: serializeMediaItem(episode.mediaItem),
            discSelection: serializeDiscSelection(episode.discSelection),
          })),
        }, 201);
      }

      case "create_mapping_proposal": {
        const proposal = access.catalog.createMappingProposal({
          originalDiscArchiveId: archiveId,
          catalogRevision: new Date(command.catalogRevision),
          ...(command.target.choice === "create_new"
            ? { mediaItem: createMediaItemInput(command.target.mediaItem) }
            : {
              existingMediaItemId:
                command.target.mediaItemId as MediaItemId,
              ...(command.target.tmdbIdentity === undefined
                ? {}
                : {
                  existingMediaItemTmdbIdentity:
                    command.target.tmdbIdentity,
                }),
            }),
          discSelection: command.discSelection,
          ...(command.completeReview ? { completeReview: true } : {}),
        });
        return response({
          message: command.completeReview
            ? "Cataloged and review completed"
            : "Mapping changed; review required",
          mediaItem: serializeMediaItem(proposal.mediaItem),
          discSelection: serializeDiscSelection(proposal.discSelection),
        }, 201);
      }

      case "create_media_item": {
        const item = access.catalog.createMediaItem(
          createMediaItemInput(command.mediaItem),
        );
        return response({
          message: "Media Item created",
          mediaItem: serializeMediaItem(item),
        }, 201);
      }

      case "update_media_item": {
        const update: Parameters<
          DataAccess["catalog"]["updateMediaItem"]
        >[1] = {};
        const { changes } = command;
        if ("parentId" in changes) {
          update.parentId = changes.parentId === null
            ? null
            : changes.parentId as MediaItemId;
        }
        if ("kind" in changes) {
          update.kind = changes.kind;
        }
        if ("title" in changes) {
          update.title = changes.title;
        }
        if ("year" in changes) {
          update.year = changes.year;
        }
        if ("seasonNumber" in changes) {
          update.seasonNumber = changes.seasonNumber;
        }
        if ("episodeNumber" in changes) {
          update.episodeNumber = changes.episodeNumber;
        }
        const item = access.catalog.updateMediaItem(
          command.mediaItemId as MediaItemId,
          update,
        );
        return response({
          message: "Metadata saved",
          mediaItem: serializeMediaItem(item),
        });
      }

      case "delete_media_item": {
        const item = access.catalog.deleteMediaItem(
          command.mediaItemId as MediaItemId,
        );
        return response({
          message: "Media Item deleted",
          mediaItem: serializeMediaItem(item),
        });
      }

      case "create_disc_selection":
      case "update_disc_selection":
      case "repair_disc_selection":
      case "correct_disc_selection":
      case "delete_disc_selection":
        return response(
          executeDiscSelectionCommand(access, archiveId, command),
          command.action === "create_disc_selection" ? 201 : 200,
        );

      case "complete_review": {
        let mediaLibraryPath: string | null = null;
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
        const replacements = command.replacementEncodes.map((replacement) => {
          const outputPath = mediaLibraryPath === null
            ? replacement.outputPath
            : mediaOutputPath(replacement.outputPath, mediaLibraryPath);
          if (!outputPath) {
            throw new DomainInvariantError(
              "Corrected replacement output path is invalid",
            );
          }
          return {
            predecessorEncodeJobId:
              replacement.predecessorEncodeJobId as EncodeJobId,
            encodingProfileId:
              replacement.encodingProfileId as EncodingProfileId,
            outputPath,
            ...(replacement.priority === undefined
              ? {}
              : { priority: replacement.priority }),
          };
        });
        const completion = access.catalog
          .completeCatalogReviewWithReplacements(
            archiveId,
            new Date(command.catalogRevision),
            command.outcome,
            replacements,
          );
        return response({
          archive: {
            id: completion.archive.id,
            catalogReviewedAt:
              completion.archive.catalogReviewedAt?.toISOString() ?? null,
            catalogReviewOutcome: completion.archive.catalogReviewOutcome,
          },
          ...(completion.replacementEncodeJobs.length === 0 ? {} : {
            replacementEncodeJobs: completion.replacementEncodeJobs.map(
              (job) => ({
                id: job.id,
                predecessorEncodeJobId: job.predecessorEncodeJobId,
                discSelectionId: job.discSelectionId,
                encodingProfileId: job.encodingProfileId,
                outputPath: job.outputPath,
                status: job.status,
                priority: job.priority,
                replaceExistingOutput: job.replaceExistingOutput,
              })),
          }),
        });
      }

      default:
        command satisfies never;
        throw new Error("Unhandled catalog review command");
    }
  } catch (error) {
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
