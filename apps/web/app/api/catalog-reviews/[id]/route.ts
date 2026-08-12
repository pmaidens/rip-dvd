import {
  decodeArchivedDvdTitles,
  DomainInvariantError,
  MEDIA_ITEM_KINDS,
  RecordNotFoundError,
  type DataAccess,
  type CreateDiscSelectionInput,
  type CreateMediaItemInput,
  type DiscSelection,
  type DiscSelectionActionAvailability,
  type DiscSelectionId,
  type MediaItem,
  type MediaItemId,
  type MediaItemMaintenance,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";

import {
  parseCatalogReviewCommand,
  type CatalogReviewMediaItemInput,
} from "../../../../lib/catalog-review-command";
import {
  calculateCatalogReviewCoverage,
} from "../../../../lib/catalog-review-coverage";
import { getDataAccess } from "../../../../lib/data-access";
import { readMediaItemsWithAncestors } from "../../../../lib/media-item-ancestor-context";
import {
  trustedMutationRequestProblem,
} from "../../../../lib/server/trusted-mutation-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CATALOG_REVIEW_SELECTION_PAGE_SIZE = 100;
const CATALOG_REVIEW_COVERAGE_SELECTION_PAGE_SIZE = 500;

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

function serializeMediaItem(
  item: MediaItem,
  maintenance?: MediaItemMaintenance,
) {
  return {
    id: item.id,
    parentId: item.parentId,
    kind: item.kind,
    title: item.title,
    year: item.year,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    ...(maintenance === undefined
      ? {}
      : {
        maintenance: {
          childCount: maintenance.childCount,
          discSelectionReferenceCount:
            maintenance.discSelectionReferenceCount,
          referencedArchiveCount: maintenance.referencedArchiveCount,
          otherArchiveCount: maintenance.otherArchiveCount,
          deletionAvailability: maintenance.deletionAvailability,
        },
      }),
  };
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
  };
}

function serializeDiscSelection(selection: DiscSelection) {
  return {
    id: selection.id,
    mediaItemId: selection.mediaItemId,
    sourceIdentity: selection.sourceIdentity,
    label: selection.label,
  };
}

function serializeReviewDiscSelection(
  selection: DiscSelection,
  availability: DiscSelectionActionAvailability,
) {
  const { discSelectionId: _discSelectionId, ...actionAvailability } =
    availability;
  return {
    ...serializeDiscSelection(selection),
    actionAvailability,
  };
}

function readCatalogReview(
  access: DataAccess,
  id: OriginalDiscArchiveId,
  discSelectionOffset: number,
) {
  return access.readConsistentSnapshot((snapshot) => {
    const archive = snapshot.catalog.listOriginalDiscArchives({ ids: [id] })[0];
    if (!archive) {
      return null;
    }
    const disc = snapshot.catalog.listDetectedDiscs(undefined, {
      ids: [archive.detectedDiscId],
    })[0];
    if (!disc) {
      throw new DomainInvariantError(
        "Original Disc Archive is missing its Detected Disc provenance",
      );
    }
    const allDiscSelections: DiscSelection[] = [];
    let coverageSelectionOffset = 0;
    while (true) {
      const coverageSelectionPage = snapshot.catalog.listDiscSelections({
        originalDiscArchiveId: id,
        limit: CATALOG_REVIEW_COVERAGE_SELECTION_PAGE_SIZE,
        offset: coverageSelectionOffset,
      });
      allDiscSelections.push(...coverageSelectionPage);
      if (
        coverageSelectionPage.length <
          CATALOG_REVIEW_COVERAGE_SELECTION_PAGE_SIZE
      ) {
        break;
      }
      coverageSelectionOffset += coverageSelectionPage.length;
    }
    const hasNextDiscSelections = allDiscSelections.length >
      discSelectionOffset + CATALOG_REVIEW_SELECTION_PAGE_SIZE;
    const discSelectionsPage = allDiscSelections.slice(
      discSelectionOffset,
      discSelectionOffset + CATALOG_REVIEW_SELECTION_PAGE_SIZE,
    );
    const actionAvailability = snapshot.catalog
      .listDiscSelectionActionAvailability({
        ids: discSelectionsPage.map((selection) => selection.id),
      });
    const actionAvailabilityById = new Map(
      actionAvailability.map((availability) => [
        availability.discSelectionId,
        availability,
      ]),
    );
    const reviewMediaItems = readMediaItemsWithAncestors(
      snapshot.catalog,
      discSelectionsPage.map((selection) => selection.mediaItemId),
    );
    const maintenanceByMediaItemId = new Map(
      snapshot.catalog.listMediaItemMaintenance({
        ids: reviewMediaItems.map((item) => item.id),
        currentArchiveId: id,
      }).map((maintenance) => [maintenance.mediaItemId, maintenance]),
    );
    const rawTitles = decodeArchivedDvdTitles(disc.scanData) ?? [];
    return {
      catalogRevision: archive.updatedAt.toISOString(),
      archive: {
        id: archive.id,
        discLabel: disc.volumeLabel ?? "Unlabeled disc",
        discKind: archive.discKind,
        archiveFormat: archive.archiveFormat,
        archivedAt: archive.archivedAt.toISOString(),
        catalogReviewedAt: archive.catalogReviewedAt?.toISOString() ?? null,
        catalogReviewOutcome: archive.catalogReviewOutcome,
      },
      reviewOutcome: archive.catalogReviewOutcome,
      rawScan: {
        titles: rawTitles,
      },
      coverage: calculateCatalogReviewCoverage(rawTitles, allDiscSelections),
      mediaItems: reviewMediaItems.map((item) =>
        serializeMediaItem(item, maintenanceByMediaItemId.get(item.id))
      ),
      discSelections: discSelectionsPage.map((selection) => {
        const availability = actionAvailabilityById.get(selection.id);
        if (!availability) {
          throw new DomainInvariantError(
            `Disc Selection ${selection.id} is missing action availability`,
          );
        }
        return serializeReviewDiscSelection(selection, availability);
      }),
      discSelectionsPage: {
        offset: discSelectionOffset,
        limit: CATALOG_REVIEW_SELECTION_PAGE_SIZE,
        hasPrevious: discSelectionOffset > 0,
        hasNext: hasNextDiscSelections,
      },
    };
  });
}

export async function createCatalogReviewRoute(
  request: Request,
  id: string,
  getAccess: () => DataAccess = getDataAccess,
  getTrustedOrigin: () => string = () => loadConfig().webTrustedOrigin,
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
      if (
        [...parameters.keys()].some((key) => key !== "selectionOffset") ||
        discSelectionOffset === null
      ) {
        return response({ error: "Invalid Catalog Review query" }, 400);
      }
      const review = readCatalogReview(
        getAccess(),
        archiveId,
        discSelectionOffset,
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
    const repairDiscSelectionId = parsedCommand.ok
      ? parsedCommand.command.action === "repair_disc_selection"
        ? parsedCommand.command.discSelectionId
        : null
      : parsedCommand.repairDiscSelectionId ?? null;
    if (repairDiscSelectionId !== null) {
      const existing = access.catalog.listDiscSelections({
        ids: [repairDiscSelectionId as DiscSelectionId],
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
              }
            : {
                choice: "use_existing",
                mediaItemId: command.tvShow.mediaItemId as MediaItemId,
              },
          season: command.season.choice === "create_new"
            ? command.season
            : {
                choice: "use_existing",
                mediaItemId: command.season.mediaItemId as MediaItemId,
              },
          episodes: command.episodes,
        });
        return response({
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
            }),
          discSelection: command.discSelection,
        });
        return response({
          message: "Mapping changed; review required",
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
      case "repair_disc_selection": {
        const repairSelectionId = command.action === "repair_disc_selection"
          ? command.discSelectionId as DiscSelectionId
          : null;
        const input = command.selection;
        const common = {
          originalDiscArchiveId: archiveId,
          mediaItemId: input.mediaItemId as MediaItemId,
          ...(input.label ? { label: input.label } : {}),
        };
        const saveSelection = (selectionInput: CreateDiscSelectionInput) =>
          repairSelectionId === null
            ? access.catalog.createDiscSelection(selectionInput)
            : access.catalog.repairDiscSelection(
                repairSelectionId,
                selectionInput,
              );
        const selection: DiscSelection = saveSelection({
          ...common,
          sourceIdentity: input.sourceIdentity,
        });
        return response(
          {
            message: "Mapping changed; review required",
            discSelection: serializeDiscSelection(selection),
          },
          repairSelectionId === null ? 201 : 200,
        );
      }

      case "delete_disc_selection": {
        const selectionId = command.discSelectionId as DiscSelectionId;
        const selection = access.catalog.listDiscSelections({
          ids: [selectionId],
          originalDiscArchiveId: archiveId,
        })[0];
        if (!selection) {
          return response({ error: "Disc Selection not found" }, 404);
        }
        const deletion = access.catalog.deleteDiscSelection(selectionId);
        return response({
          message: "Mapping changed; review required",
          discSelection: serializeDiscSelection(selection),
          deletedEncodeJobs: deletion.deletedEncodeJobs,
          deletionComplete: deletion.deletionComplete,
        });
      }

      case "complete_review": {
        const archive = access.catalog.completeCatalogReview(
          archiveId,
          new Date(command.catalogRevision),
          command.outcome,
        );
        return response({
          archive: {
            id: archive.id,
            catalogReviewedAt:
              archive.catalogReviewedAt?.toISOString() ?? null,
            catalogReviewOutcome: archive.catalogReviewOutcome,
          },
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
